const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const tus = require("tus-js-client");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { pipeline, finished } = require("stream/promises");
const Anthropic = require("@anthropic-ai/sdk");
const { generateLifeStoryBook, validatePlanJson, BOOK_MODEL } = require("./life-story/generate-book");
const { verifyBook, BOOK_VERIFIER_MODEL } = require("./life-story/verify-book");
const { renderBook } = require("./pdf/render-book");
const { resolveExecutablePath } = require("./pdf/render");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3001;

// ── Config ────────────────────────────────────────────────────────────────────────────────
// WORKER_SECRET: shared with the app (FFMPEG_WORKER_SECRET). Required for /jobs and sent back
// on every callback. The service refuses /jobs entirely when it is unset.
const WORKER_SECRET = process.env.WORKER_SECRET || "";
// Callback hosts the worker will POST results to. Anything else is rejected at /jobs time so a
// forged job cannot turn this service into a relay.
const ALLOWED_CALLBACK_HOSTS = (process.env.ALLOWED_CALLBACK_HOSTS || "capsulated.app,www.capsulated.app")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const TMP_DIR = process.env.TMP_DIR || "/tmp";
const CALLBACK_RETRIES = 3;
// ANTHROPIC_API_KEY: the model key for /life-story-jobs (the SDK reads it from the environment).
// That route is refused entirely while it is unset; /jobs and /export-jobs do not need it.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Server-to-server only (the app's server actions and cron call /jobs; the worker calls back).
// No browser ever talks to this service any more, so there is no CORS layer.
//
// /export-jobs, /life-story-jobs and /life-story-pdf-jobs carry the user's written content in
// their bodies, so each mounts its own, larger parser (EXPORT_BODY_LIMIT / LIFE_STORY_BODY_LIMIT
// / LIFE_STORY_PDF_BODY_LIMIT). Every other route keeps the 64 kB ceiling.
const OWN_PARSER_PATHS = new Set(["/export-jobs", "/life-story-jobs", "/life-story-pdf-jobs"]);
const smallJson = express.json({ limit: "64kb" });
app.use((req, res, next) => (OWN_PARSER_PATHS.has(req.path) ? next() : smallJson(req, res, next)));

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function cleanupFiles(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) { /* already gone — cleanup is best-effort */ }
  }
}

/** Stream a URL to disk. No buffering in memory. Follows up to 3 redirects. */
function downloadToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`bad download url: ${e.message}`)); }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.get(parsed, { timeout: 120_000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(downloadToFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download returned ${res.statusCode}`));
      }
      pipeline(res, fs.createWriteStream(dest)).then(resolve, reject);
    });
    req.on("timeout", () => req.destroy(new Error("download timeout")));
    req.on("error", reject);
  });
}

/**
 * Small JSON POST with a timeout. Resolves { status, body }. Follows ONE method-preserving
 * redirect (307/308) — capsulated.app redirects to www.capsulated.app, and a callback that
 * stops at the redirect would look like a failure. The redirect target must still pass the
 * callback host allow-list.
 */
function postJson(url, headers, payload, redirected = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "http:" ? http : https;
    const data = Buffer.from(JSON.stringify(payload));
    const req = lib.request(
      parsed,
      {
        method: "POST",
        timeout: 30_000,
        headers: { "Content-Type": "application/json", "Content-Length": data.length, ...headers },
      },
      (res) => {
        if ((res.statusCode === 307 || res.statusCode === 308) && res.headers.location && !redirected) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          if (!callbackHostAllowed(next)) return resolve({ status: res.statusCode, body: `redirect to disallowed host ${next}` });
          console.warn(`[callback] ${res.statusCode} → following once to ${next}`);
          return resolve(postJson(next, headers, payload, true));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("callback timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream UID from the TUS upload URL: the last PATH segment only. Cloudflare now returns
 * `…/stream/<uid>?tusv2=true`, so a naive split("/").pop() carried the query string and the
 * app rejected it ("streamUid missing or malformed"). Anything that is not a uid character
 * is stripped; an empty result is an error, never a callback.
 */
function streamUidFromTusUrl(url) {
  let seg = "";
  try {
    seg = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
  } catch (_) {
    seg = String(url || "").split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || "";
  }
  return seg.replace(/[^A-Za-z0-9_-]/g, "");
}

// ── The pipeline: FFmpeg merge → TUS upload to Stream ─────────────────────────────────────

function runFfmpegMerge(id, userPath, aiPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(userPath)
      .input(aiPath)
      .complexFilter([
        "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
      ])
      .outputOptions([
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "libx264",
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
      ])
      .output(outPath)
      .on("start", (cmd) => console.log(`[${id}] FFmpeg command: ${cmd}`))
      .on("progress", (p) => {
        if (p.percent) console.log(`[${id}] Progress: ${Math.round(p.percent)}%`);
      })
      .on("end", () => {
        console.log(`[${id}] FFmpeg merge complete`);
        resolve();
      })
      .on("error", (err) => {
        console.error(`[${id}] FFmpeg error:`, err.message);
        reject(err);
      })
      .run();
  });
}

function uploadToStream(id, outPath) {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_API_TOKEN } = process.env;
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_STREAM_API_TOKEN) {
    return Promise.reject(new Error("Cloudflare credentials not configured"));
  }
  const fileSize = fs.statSync(outPath).size;
  const fileStream = fs.createReadStream(outPath);

  return new Promise((resolve, reject) => {
    const tusUpload = new tus.Upload(fileStream, {
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream`,
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_STREAM_API_TOKEN}`,
      },
      chunkSize: 50 * 1024 * 1024,
      metadata: {
        name: `interview-${id}.mp4`,
        type: "video/mp4",
      },
      uploadSize: fileSize,
      onError: (err) => {
        console.error(`[${id}] TUS upload error:`, err);
        reject(err);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = Math.round((bytesUploaded / bytesTotal) * 100);
        console.log(`[${id}] Upload progress: ${pct}%`);
      },
      onSuccess: () => {
        const uid = streamUidFromTusUrl(tusUpload.url);
        if (!uid) {
          console.error(`[${id}] TUS upload finished but no uid in URL:`, tusUpload.url);
          return reject(new Error(`no Stream uid in upload URL ${tusUpload.url}`));
        }
        console.log(`[${id}] Upload complete — Stream UID: ${uid} (from ${tusUpload.url})`);
        resolve({ streamUid: uid, bytesUploaded: fileSize });
      },
    });
    tusUpload.start();
  });
}

/** Merge two local files and upload the result. Caller owns cleanup of the inputs. */
async function mergeAndUpload(id, userPath, aiPath) {
  const outPath = path.join(TMP_DIR, `merged-${id}.mp4`);
  try {
    console.log(`[${id}] Starting FFmpeg merge...`);
    await runFfmpegMerge(id, userPath, aiPath, outPath);
    console.log(`[${id}] Uploading to Cloudflare Stream...`);
    return await uploadToStream(id, outPath);
  } finally {
    cleanupFiles([outPath]);
  }
}

// ── Health ────────────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({ status: "ok", jobs: { queued: jobQueue.length, running: runningJob ? runningJob.jobId : null } });
});

// ── /jobs — durable, asynchronous. The app owns the job record; this process keeps nothing
//    it needs to survive a restart (the app's cron re-dispatches anything that stalls). ───────

const jobQueue = [];
let runningJob = null;

// Results of finished jobs, kept in memory for a while. If the app re-dispatches a job whose
// merge already succeeded here (its callback was lost, or rejected by a since-fixed bug), the
// SAME Stream video is reported again instead of re-merging and orphaning a second upload.
// Lost on restart — then a re-merge is unavoidable and the app's callback dedups by job.
const RESULT_MEMORY_MS = 6 * 60 * 60 * 1000;
const RESULT_MEMORY_MAX = 200;
const completedResults = new Map(); // jobId → { payload, at }

function rememberResult(jobId, payload) {
  completedResults.set(jobId, { payload, at: Date.now() });
  if (completedResults.size > RESULT_MEMORY_MAX) {
    const cutoff = Date.now() - RESULT_MEMORY_MS;
    for (const [k, v] of completedResults) if (v.at < cutoff) completedResults.delete(k);
    while (completedResults.size > RESULT_MEMORY_MAX) completedResults.delete(completedResults.keys().next().value);
  }
}

function recallResult(jobId) {
  const hit = completedResults.get(jobId);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_MEMORY_MS) { completedResults.delete(jobId); return null; }
  return hit.payload;
}

function callbackHostAllowed(callbackUrl) {
  let parsed;
  try { parsed = new URL(callbackUrl); } catch (_) { return false; }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) return false;
  return ALLOWED_CALLBACK_HOSTS.includes(parsed.hostname.toLowerCase());
}

app.post("/jobs", (req, res) => {
  if (!WORKER_SECRET) {
    console.error("[jobs] WORKER_SECRET is not set — refusing all jobs");
    return res.status(503).json({ error: "worker secret not configured" });
  }
  if (!safeEqual(req.get("x-worker-secret"), WORKER_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { jobId, videoUrl, audioUrl, callbackUrl } = req.body || {};
  const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u) && u.length < 4096;
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: "jobId must be a uuid" });
  }
  if (!isHttpUrl(videoUrl) || !isHttpUrl(audioUrl)) {
    return res.status(400).json({ error: "videoUrl and audioUrl must be http(s) urls" });
  }
  if (!isHttpUrl(callbackUrl) || !callbackHostAllowed(callbackUrl)) {
    return res.status(400).json({ error: "callbackUrl host not allowed" });
  }

  // Already merged and uploaded here? Re-send the stored result — do not merge again.
  const remembered = recallResult(jobId);
  if (remembered) {
    console.log(`[${jobId}] re-dispatched after a completed merge — re-sending stored result (uid ${remembered.streamUid})`);
    res.status(202).json({ accepted: true, reused: true });
    sendCallback(callbackUrl, remembered).catch((err) => console.error(`[${jobId}] re-send failed:`, err.message));
    return;
  }

  // A re-dispatch of a job already queued or running here is a no-op (the app's cron only
  // re-sends after 20–30 min, so this mostly guards a double-click of the same dispatch).
  const duplicate = (runningJob && runningJob.jobId === jobId) || jobQueue.some((j) => j.jobId === jobId);
  if (duplicate) {
    console.log(`[${jobId}] already queued/running — ignoring duplicate dispatch`);
    return res.status(202).json({ accepted: true, duplicate: true });
  }

  jobQueue.push({ jobId, videoUrl, audioUrl, callbackUrl });
  console.log(`[${jobId}] accepted (queue length ${jobQueue.length})`);
  res.status(202).json({ accepted: true });
  setImmediate(drainQueue);
});

async function drainQueue() {
  if (runningJob || jobQueue.length === 0) return;
  runningJob = jobQueue.shift();
  const job = runningJob;
  try {
    // `kind` is set by /export-jobs ("export"), /life-story-jobs ("life-story") and
    // /life-story-pdf-jobs ("life-story-pdf"); a /jobs entry has none and is an interview merge.
    if (job.kind === "export") await processExportJob(job);
    else if (job.kind === "life-story") await processLifeStoryJob(job);
    else if (job.kind === "life-story-pdf") await processLifeStoryPdfJob(job);
    else await processJob(job);
  } catch (err) {
    // processJob reports its own failures; this only catches a bug in the reporting itself.
    console.error(`[${job.jobId}] unhandled:`, err);
  } finally {
    runningJob = null;
    setImmediate(drainQueue);
  }
}

async function processJob(job) {
  const { jobId, videoUrl, audioUrl, callbackUrl } = job;
  const userPath = path.join(TMP_DIR, `user-${jobId}.webm`);
  const aiPath = path.join(TMP_DIR, `ai-${jobId}.wav`);
  const started = Date.now();
  let payload;

  try {
    console.log(`[${jobId}] downloading raw files...`);
    await Promise.all([downloadToFile(videoUrl, userPath), downloadToFile(audioUrl, aiPath)]);
    const vSize = fs.statSync(userPath).size;
    const aSize = fs.statSync(aiPath).size;
    console.log(`[${jobId}] downloaded video=${vSize}B audio=${aSize}B`);
    if (vSize === 0) throw new Error("downloaded video is empty");

    const { streamUid, bytesUploaded } = await mergeAndUpload(jobId, userPath, aiPath);
    payload = { jobId, ok: true, streamUid, bytesUploaded };
    rememberResult(jobId, payload);
    // The video is on Stream but the app does not know it yet, and this process's memory is
    // the only place the uid exists. Tell the app NOW ({phase:'uploaded'}, advisory — one small
    // durable write on its side) so a restart before the final callback lands cannot orphan the
    // upload: the app's cron completes from the stored uid instead of re-dispatching a merge.
    // Awaited so it always precedes the final; its outcome is ignored (a 4xx means an app that
    // does not know the phase yet, and the final still carries everything).
    await sendCallback(callbackUrl, { jobId, phase: "uploaded", streamUid, bytesUploaded });
    console.log(`[${jobId}] done in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error(`[${jobId}] failed:`, err.message);
    payload = { jobId, ok: false, error: String(err.message || err).slice(0, 1000) };
  } finally {
    cleanupFiles([userPath, aiPath]);
  }

  await sendCallback(callbackUrl, payload);
}

/**
 * The callback is the only thing that turns work into a record — retry it with backoff.
 * Used for the final result AND the advisory {phase:'uploaded'} message; the log tag carries
 * the phase so the two read apart.
 */
async function sendCallback(callbackUrl, payload) {
  const tag = payload.phase ? `${payload.jobId} ${payload.phase}` : payload.jobId;
  for (let attempt = 1; attempt <= CALLBACK_RETRIES; attempt++) {
    try {
      const { status, body } = await postJson(callbackUrl, { "x-worker-secret": WORKER_SECRET }, payload);
      if (status >= 200 && status < 300) {
        console.log(`[${tag}] callback delivered (${status}) ${body.slice(0, 200)}`);
        return true;
      }
      // 4xx means the app rejected the payload itself (or the secret) — retrying the same
      // body cannot help. Log and stop; the app's cron will re-dispatch if the job stalls.
      if (status >= 400 && status < 500) {
        console.error(`[${tag}] callback rejected (${status}) ${body.slice(0, 300)} — not retrying`);
        return false;
      }
      console.error(`[${tag}] callback attempt ${attempt} returned ${status}: ${body.slice(0, 300)}`);
    } catch (err) {
      console.error(`[${tag}] callback attempt ${attempt} error:`, err.message);
    }
    if (attempt < CALLBACK_RETRIES) await sleep(5_000 * 2 ** (attempt - 1)); // 5s, 10s
  }
  console.error(`[${tag}] callback NOT delivered after ${CALLBACK_RETRIES} attempts — the app's cron will re-dispatch`);
  return false;
}

// ── /export-jobs — data export. Zips a set of presigned GET URLs plus one JSON document and
//    PUTs the archive to a presigned URL. Shares the queue with /jobs (one job at a time);
//    the same secret, the same callback allow-list, the same callback retry. Nothing here
//    touches FFmpeg, Stream, or /jobs. ─────────────────────────────────────────────────────

// textContentJson (the user's written content, already serialized) rides in the body.
const EXPORT_BODY_LIMIT = "25mb";
const EXPORT_MAX_FILES = 20000;
// Where textContentJson lands inside the zip. A file entry may not claim this path.
const EXPORT_CONTENT_ENTRY = "content/my-content.json";
const exportJson = express.json({ limit: EXPORT_BODY_LIMIT });

const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u) && u.length < 4096;
// A refused connection surfaces as an AggregateError with an empty message; fall back to the code.
const errText = (err) => (err && (err.message || err.code)) || String(err);

/** A relative path inside the zip: no leading slash, no backslash, no "." / ".." segments. */
function validZipPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

app.post("/export-jobs", exportJson, (req, res) => {
  if (!WORKER_SECRET) {
    console.error("[export-jobs] WORKER_SECRET is not set — refusing all jobs");
    return res.status(503).json({ error: "worker secret not configured" });
  }
  if (!safeEqual(req.get("x-worker-secret"), WORKER_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { jobId, callbackUrl, outputPutUrl, files, textContentJson } = req.body || {};
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: "jobId must be a uuid" });
  }
  if (!isHttpUrl(callbackUrl) || !callbackHostAllowed(callbackUrl)) {
    return res.status(400).json({ error: "callbackUrl host not allowed" });
  }
  if (!isHttpUrl(outputPutUrl)) {
    return res.status(400).json({ error: "outputPutUrl must be an http(s) url" });
  }
  if (typeof textContentJson !== "string") {
    return res.status(400).json({ error: "textContentJson must be a string" });
  }
  if (!Array.isArray(files) || files.length > EXPORT_MAX_FILES) {
    return res.status(400).json({ error: `files must be an array of at most ${EXPORT_MAX_FILES} entries` });
  }
  const seen = new Set([EXPORT_CONTENT_ENTRY]);
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f || !isHttpUrl(f.url) || !validZipPath(f.zipPath)) {
      return res.status(400).json({ error: `files[${i}] needs an http(s) url and a relative zipPath` });
    }
    if (seen.has(f.zipPath)) {
      return res.status(400).json({ error: `files[${i}] zipPath is duplicated or reserved: ${f.zipPath}` });
    }
    seen.add(f.zipPath);
    entries.push({ url: f.url, zipPath: f.zipPath });
  }

  // Same guard as /jobs: a job already queued or running here is not queued twice. Exports keep
  // no result memory — a re-dispatch after completion simply builds the zip again, which is
  // idempotent (the app hands out the same output key).
  const duplicate = (runningJob && runningJob.jobId === jobId) || jobQueue.some((j) => j.jobId === jobId);
  if (duplicate) {
    console.log(`[${jobId}] export already queued/running — ignoring duplicate dispatch`);
    return res.status(202).json({ accepted: true, duplicate: true });
  }

  jobQueue.push({ kind: "export", jobId, callbackUrl, outputPutUrl, files: entries, textContentJson });
  console.log(`[${jobId}] export accepted: ${entries.length} files (queue length ${jobQueue.length})`);
  res.status(202).json({ accepted: true });
  setImmediate(drainQueue);
});

/**
 * Open a URL as a readable stream. Resolves with the response once a 200 arrives; any other
 * status, a bad URL, or a connection failure rejects. Follows up to 3 redirects. The caller
 * owns the response from then on — a failure AFTER the headers surfaces on the response
 * ('error' / 'close' with res.complete === false), not here.
 */
function openDownloadStream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`bad download url: ${e.message}`)); }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.get(parsed, { timeout: 120_000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(openDownloadStream(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download returned ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("download timeout")));
    req.on("error", reject);
  });
}

/** PUT a file from disk to a presigned URL, streamed with an exact Content-Length. */
function putFile(url, filePath, size, contentType) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`bad upload url: ${e.message}`)); }
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(
      parsed,
      {
        method: "PUT",
        timeout: 120_000,
        headers: { "Content-Type": contentType, "Content-Length": size },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 1000) body += c; });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          reject(new Error(`upload returned ${res.statusCode}: ${body.slice(0, 300)}`));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("upload timeout")));
    req.on("error", reject);
    pipeline(fs.createReadStream(filePath), req).catch(reject);
  });
}

/**
 * Build the zip on disk. Entries are fetched ONE AT A TIME and streamed straight into the
 * archive — nothing is buffered whole in memory, and only one download connection is open at
 * any moment (thousands of presigned URLs would otherwise be opened at once).
 *
 * A dead file must not kill the export. archiver aborts the whole archive if an appended
 * source emits 'error', so a download is never handed to it directly: it is piped through a
 * PassThrough that only ever ENDS. A file that fails before its headers (404, refused) is
 * skipped outright; one that fails mid-body is ended where it stopped, leaves a truncated
 * entry, and is reported in skippedFiles so the app can say so.
 */
async function buildExportZip(id, zipPath, files, textContentJson, skippedFiles) {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const output = fs.createWriteStream(zipPath);
  // Rejects on an archive error or a disk error. The no-op catch keeps a rejection that lands
  // while nothing is awaiting it (e.g. during a download's connect) from being "unhandled";
  // every await below still sees it through the race.
  const outputDone = pipeline(archive, output);
  outputDone.catch(() => {});
  archive.on("warning", (err) => console.warn(`[${id}] archiver warning:`, err.message));

  archive.append(textContentJson, { name: EXPORT_CONTENT_ENTRY });

  for (const { url, zipPath: name } of files) {
    let res;
    try {
      res = await openDownloadStream(url);
    } catch (err) {
      console.warn(`[${id}] skipping ${name}: ${errText(err)}`);
      skippedFiles.push(name);
      continue;
    }

    const body = new PassThrough();
    res.on("error", (err) => console.warn(`[${id}] ${name}: download error after headers: ${errText(err)}`));
    // pipe() unpipes on a source error without ending the destination — end it ourselves so the
    // entry closes and the loop moves on. 'close' fires after 'error'/'aborted' in every case.
    res.on("close", () => { if (!res.complete) body.end(); });
    res.pipe(body);
    // Media is already compressed; STORE it so the CPU goes to I/O, not deflate.
    archive.append(body, { name, store: true });

    // Resolves when archiver has consumed this entry; rejects if the archive itself died.
    await Promise.race([finished(body), outputDone]);
    if (!res.complete) {
      console.warn(`[${id}] ${name}: truncated (connection ended before the body did)`);
      skippedFiles.push(name);
    }
  }

  archive.finalize();
  await outputDone;
}

async function processExportJob(job) {
  const { jobId, callbackUrl, outputPutUrl, files, textContentJson } = job;
  const zipPath = path.join(TMP_DIR, `export-${jobId}.zip`);
  const started = Date.now();
  const skippedFiles = [];
  let payload;

  try {
    console.log(`[${jobId}] export: zipping ${files.length} files + ${EXPORT_CONTENT_ENTRY}`);
    await buildExportZip(jobId, zipPath, files, textContentJson, skippedFiles);
    const zipBytes = fs.statSync(zipPath).size;
    console.log(`[${jobId}] export: zip ${zipBytes}B, ${skippedFiles.length} skipped — uploading`);
    await putFile(outputPutUrl, zipPath, zipBytes, "application/zip");
    payload = { jobId, ok: true, zipBytes, skippedFiles };
    console.log(`[${jobId}] export done in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error(`[${jobId}] export failed:`, errText(err));
    payload = { jobId, ok: false, error: errText(err).slice(0, 1000) };
  } finally {
    cleanupFiles([zipPath]);
  }

  await sendCallback(callbackUrl, payload);
}

// ── /life-story-jobs — Life Story Book generation. The app gathers the user's content under
//    the user's own RLS and hands the serialized blob over; this service plans, writes, and
//    verifies the book with the model and posts the finished book JSON back. Dumb compute:
//    no Supabase, no storage, nothing read but the body it was given. Same secret header,
//    same callback allow-list, same 3× callback retry, same one-at-a-time queue as /jobs and
//    /export-jobs. The book is a few KB, so it rides in the callback body — no presigned PUT.
//
//    Unlike an export, a re-run is NOT idempotent (different prose, a dozen paid model calls),
//    so a finished book is remembered the way /jobs remembers a Stream uid: a re-dispatch of a
//    completed job re-sends the stored result instead of generating again. ────────────────────

// The content blob is every narrative item the user recorded (interview transcripts included).
const LIFE_STORY_BODY_LIMIT = "10mb";
const LIFE_STORY_MAX_ITEMS = 5000;
const lifeStoryJson = express.json({ limit: LIFE_STORY_BODY_LIMIT });

/**
 * Shape check on the handed-over LifeStoryContent (the app's gather-content.ts model): only
 * what the engine reads. Returns an error string, or null when the blob is usable.
 */
function lifeStoryContentError(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "content must be an object";
  if (!content.subject || typeof content.subject !== "object") return "content.subject must be an object";
  if (!Array.isArray(content.dated) || !Array.isArray(content.undated)) return "content.dated and content.undated must be arrays";
  if (typeof content.totalWordCount !== "number") return "content.totalWordCount must be a number";
  const total = content.dated.length + content.undated.length;
  if (total > LIFE_STORY_MAX_ITEMS) return `content has ${total} items; the limit is ${LIFE_STORY_MAX_ITEMS}`;
  const seen = new Set();
  for (const [list, items] of [["dated", content.dated], ["undated", content.undated]]) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || typeof it !== "object") return `content.${list}[${i}] must be an object`;
      if (typeof it.sourceId !== "string" || !it.sourceId) return `content.${list}[${i}].sourceId must be a non-empty string`;
      if (typeof it.sourceType !== "string" || !it.sourceType) return `content.${list}[${i}].sourceType must be a non-empty string`;
      if (typeof it.text !== "string") return `content.${list}[${i}].text must be a string`;
      if (typeof it.wordCount !== "number") return `content.${list}[${i}].wordCount must be a number`;
      if (it.label != null && typeof it.label !== "string") return `content.${list}[${i}].label must be a string or null`;
      if (it.date != null && typeof it.date !== "string") return `content.${list}[${i}].date must be a string or null`;
      if (it.year != null && typeof it.year !== "number") return `content.${list}[${i}].year must be a number or null`;
      if (it.photoRef != null && typeof it.photoRef !== "string") return `content.${list}[${i}].photoRef must be a string or null`;
      if (it.relation != null && typeof it.relation !== "object") return `content.${list}[${i}].relation must be an object`;
      if (seen.has(it.sourceId)) return `content: duplicate sourceId ${it.sourceId}`;
      seen.add(it.sourceId);
    }
  }
  return null;
}

app.post("/life-story-jobs", lifeStoryJson, (req, res) => {
  if (!WORKER_SECRET) {
    console.error("[life-story-jobs] WORKER_SECRET is not set — refusing all jobs");
    return res.status(503).json({ error: "worker secret not configured" });
  }
  if (!safeEqual(req.get("x-worker-secret"), WORKER_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("[life-story-jobs] ANTHROPIC_API_KEY is not set — refusing all jobs");
    return res.status(503).json({ error: "anthropic key not configured" });
  }

  const { jobId, callbackUrl, content, plan } = req.body || {};
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: "jobId must be a uuid" });
  }
  if (!isHttpUrl(callbackUrl) || !callbackHostAllowed(callbackUrl)) {
    return res.status(400).json({ error: "callbackUrl host not allowed" });
  }
  const contentError = lifeStoryContentError(content);
  if (contentError) {
    return res.status(400).json({ error: contentError });
  }
  // An optional frozen plan (the JSON shape the planner emits) skips Stage 1. Validated now,
  // with the same rules a generated plan gets, so a bad plan is a 400 and never a queued job.
  let frozenPlan = null;
  let planWarnings = [];
  if (plan !== undefined && plan !== null) {
    if (typeof plan !== "object" || Array.isArray(plan)) return res.status(400).json({ error: "plan must be an object" });
    const validated = validatePlanJson(JSON.stringify(plan), content);
    if ("error" in validated) return res.status(400).json({ error: `plan rejected: ${validated.error}` });
    frozenPlan = validated.plan;
    planWarnings = validated.warnings;
  }

  // Already generated here? Re-send the stored book — do not generate again.
  const remembered = recallResult(jobId);
  if (remembered) {
    console.log(`[${jobId}] re-dispatched after a completed generation — re-sending stored book (${remembered.book.chapters.length} chapters)`);
    res.status(202).json({ accepted: true, reused: true });
    sendCallback(callbackUrl, remembered).catch((err) => console.error(`[${jobId}] re-send failed:`, err.message));
    return;
  }

  // Same guard as /jobs: a job already queued or running here is not queued twice.
  const duplicate = (runningJob && runningJob.jobId === jobId) || jobQueue.some((j) => j.jobId === jobId);
  if (duplicate) {
    console.log(`[${jobId}] life story already queued/running — ignoring duplicate dispatch`);
    return res.status(202).json({ accepted: true, duplicate: true });
  }

  const itemCount = content.dated.length + content.undated.length;
  jobQueue.push({ kind: "life-story", jobId, callbackUrl, content, plan: frozenPlan, planWarnings });
  console.log(`[${jobId}] life story accepted: ${itemCount} items, ${content.totalWordCount} words${frozenPlan ? `, frozen plan (${frozenPlan.chapters.length} chapters)` : ""} (queue length ${jobQueue.length})`);
  res.status(202).json({ accepted: true });
  setImmediate(drainQueue);
});

/**
 * The callback's `book`: the app's column names, one entry per chapter and one per verifier
 * flag. paragraph_provenance is the writer's ChapterProvenance[] untouched (migration 234
 * stores it as-is). A flag the verifier could not place (paragraph 0) is sent with
 * paragraph_number null, which is what the flags table accepts.
 */
function lifeStoryCallbackBook(book, verification) {
  const byChapter = new Map(verification.results.map((r) => [r.chapterNumber, r]));
  return {
    title: book.plan.bookTitle,
    chapters: book.chapters.map((c) => ({
      number: c.chapterNumber,
      title: c.title,
      arc_stage: c.arcStage,
      prose: c.prose,
      source_ids: c.sourceIds,
      photo_refs: c.photoRefs,
      paragraph_provenance: c.provenance,
      verification_status: (byChapter.get(c.chapterNumber) || {}).status || "unchecked",
    })),
    flags: verification.results.flatMap((r) =>
      r.flags.map((f) => ({
        chapter_number: f.chapterNumber,
        paragraph_number: f.paragraph > 0 ? f.paragraph : null,
        flagged_text: f.text,
        category: f.category,
        reason: f.reason,
        nearest_source: f.nearestSourceId,
      })),
    ),
  };
}

async function processLifeStoryJob(job) {
  const { jobId, callbackUrl, content, plan, planWarnings } = job;
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  let payload;

  try {
    const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from the environment
    console.log(`[${jobId}] life story: generating with ${BOOK_MODEL}${plan ? " (frozen plan)" : ""}`);
    const generated = await generateLifeStoryBook(anthropic, content, {
      plan: plan || undefined,
      onProgress: (e) => {
        if (e.kind === "plan_start") console.log(`[${jobId}] ${elapsed()} planning…`);
        if (e.kind === "plan_done") console.log(`[${jobId}] ${elapsed()} plan: ${e.plan.chapters.length} chapters — "${e.plan.bookTitle}"`);
        if (e.kind === "chapter_start") console.log(`[${jobId}] ${elapsed()} writing ${e.chapterNumber}. ${e.title}…`);
        if (e.kind === "chapter_done") console.log(`[${jobId}] ${elapsed()}   chapter ${e.chapter.chapterNumber} done (${e.chapter.wordCount} words)`);
      },
    });
    if (generated.status !== "ok") {
      const where = generated.stage === "chapter" ? `chapter ${generated.chapterNumber}` : "plan";
      throw new Error(`generation failed at ${where}: ${generated.error}`);
    }
    const { book } = generated;

    console.log(`[${jobId}] ${elapsed()} verifying ${book.chapters.length} chapters with ${BOOK_VERIFIER_MODEL}`);
    const verification = await verifyBook(anthropic, content, book.chapters, {
      onChapter: (r) => console.log(`[${jobId}] ${elapsed()}   verify chapter ${r.chapterNumber}: ${r.status}${r.flags.length ? ` (${r.flags.length} flags)` : ""}${r.error ? ` — ${r.error}` : ""}`),
    });

    payload = {
      jobId,
      ok: true,
      book: lifeStoryCallbackBook(book, verification),
      // Diagnostics only — the app logs these; nothing below is persisted.
      model: book.model,
      verifierModel: verification.model,
      usage: { generate: book.usage, verify: verification.usage },
      warnings: [...planWarnings, ...book.warnings, ...verification.warnings],
    };
    rememberResult(jobId, payload);
    console.log(`[${jobId}] life story done in ${elapsed()}: ${payload.book.chapters.length} chapters, ${payload.book.flags.length} flags, ${book.usage.calls + verification.usage.calls} model calls`);
  } catch (err) {
    console.error(`[${jobId}] life story failed:`, errText(err));
    payload = { jobId, ok: false, error: errText(err).slice(0, 1000) };
  }

  await sendCallback(callbackUrl, payload);
}

// ── /life-story-pdf-jobs — Life Story Book PDF render. The app sends the APPROVED edition's
//    text (title, subject, chapters in order, each with its photo URLs already resolved) plus
//    a presigned PUT; this service lays it out as a 6x9 book (pdf/book.js), prints it through
//    Chromium (pdf/render.js), PUTs the PDF to R2 and calls back status only — the EXPORT
//    pattern (a PDF is megabytes; a callback body is not), not the generation's in-body one.
//    Same secret, same callback allow-list, same 3× callback retry, same one-at-a-time queue.
//    Dumb compute: nothing read but the body it is given.
//
//    A render is deterministic and costs seconds, not model calls, so a finished PDF is NOT
//    remembered the way a generated book is: a re-dispatch renders again and overwrites the
//    same R2 object (the app hands out the same key). It could not share completedResults
//    anyway — the generation of the same edition is remembered under the same jobId, and a
//    book payload must never be re-sent to the render callback. A job already queued or
//    running here is still deduplicated, by kind AND id. ─────────────────────────────────────

const LIFE_STORY_PDF_BODY_LIMIT = "8mb";
const LIFE_STORY_PDF_MAX_CHAPTERS = 200;
const LIFE_STORY_PDF_MAX_PHOTOS_PER_CHAPTER = 40;
const lifeStoryPdfJson = express.json({ limit: LIFE_STORY_PDF_BODY_LIMIT });

const isHttpsUrl = (u) => typeof u === "string" && /^https:\/\//i.test(u) && u.length < 4096;

/**
 * Shape check on the `book` the template consumes (pdf/book.js buildBookHtml). Returns an
 * error string, or null when the book is printable. Strict: a malformed chapter is a 400 at
 * accept time, never a half-printed book.
 */
function lifeStoryPdfBookError(book) {
  if (!book || typeof book !== "object" || Array.isArray(book)) return "book must be an object";
  if (typeof book.title !== "string" || !book.title.trim()) return "book.title must be a non-empty string";
  const s = book.subject;
  if (!s || typeof s !== "object" || Array.isArray(s)) return "book.subject must be an object";
  if (s.name != null && typeof s.name !== "string") return "book.subject.name must be a string or null";
  for (const k of ["birthYear", "deathYear"]) {
    if (s[k] != null && !Number.isInteger(s[k])) return `book.subject.${k} must be an integer or null`;
  }
  if (!Array.isArray(book.chapters) || book.chapters.length === 0) return "book.chapters must be a non-empty array";
  if (book.chapters.length > LIFE_STORY_PDF_MAX_CHAPTERS) return `book has ${book.chapters.length} chapters; the limit is ${LIFE_STORY_PDF_MAX_CHAPTERS}`;
  const seen = new Set();
  for (let i = 0; i < book.chapters.length; i++) {
    const c = book.chapters[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) return `book.chapters[${i}] must be an object`;
    if (!Number.isInteger(c.number) || c.number <= 0) return `book.chapters[${i}].number must be a positive integer`;
    if (seen.has(c.number)) return `book.chapters: number ${c.number} appears twice`;
    seen.add(c.number);
    if (typeof c.title !== "string" || !c.title.trim()) return `book.chapters[${i}].title must be a non-empty string`;
    if (c.arc != null && typeof c.arc !== "string") return `book.chapters[${i}].arc must be a string or null`;
    if (typeof c.prose !== "string" || !c.prose.trim()) return `book.chapters[${i}].prose must be a non-empty string`;
    if (c.photos == null) continue;
    if (!Array.isArray(c.photos)) return `book.chapters[${i}].photos must be an array`;
    if (c.photos.length > LIFE_STORY_PDF_MAX_PHOTOS_PER_CHAPTER) return `book.chapters[${i}] has ${c.photos.length} photos; the limit is ${LIFE_STORY_PDF_MAX_PHOTOS_PER_CHAPTER}`;
    for (let j = 0; j < c.photos.length; j++) {
      const p = c.photos[j];
      if (!p || typeof p !== "object" || Array.isArray(p)) return `book.chapters[${i}].photos[${j}] must be an object`;
      if (p.url != null && !isHttpsUrl(p.url)) return `book.chapters[${i}].photos[${j}].url must be an https url or null`;
      if (p.caption != null && typeof p.caption !== "string") return `book.chapters[${i}].photos[${j}].caption must be a string or null`;
    }
  }
  return null;
}

app.post("/life-story-pdf-jobs", lifeStoryPdfJson, (req, res) => {
  if (!WORKER_SECRET) {
    console.error("[life-story-pdf-jobs] WORKER_SECRET is not set — refusing all jobs");
    return res.status(503).json({ error: "worker secret not configured" });
  }
  if (!safeEqual(req.get("x-worker-secret"), WORKER_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { jobId, callbackUrl, outputPutUrl, book } = req.body || {};
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: "jobId must be a uuid" });
  }
  if (!isHttpUrl(callbackUrl) || !callbackHostAllowed(callbackUrl)) {
    return res.status(400).json({ error: "callbackUrl host not allowed" });
  }
  if (!isHttpUrl(outputPutUrl)) {
    return res.status(400).json({ error: "outputPutUrl must be an http(s) url" });
  }
  const bookError = lifeStoryPdfBookError(book);
  if (bookError) {
    return res.status(400).json({ error: bookError });
  }

  const isSame = (j) => j.kind === "life-story-pdf" && j.jobId === jobId;
  const duplicate = (runningJob && isSame(runningJob)) || jobQueue.some(isSame);
  if (duplicate) {
    console.log(`[${jobId}] life story pdf already queued/running — ignoring duplicate dispatch`);
    return res.status(202).json({ accepted: true, duplicate: true });
  }

  const photos = book.chapters.reduce((n, c) => n + (c.photos ? c.photos.length : 0), 0);
  jobQueue.push({ kind: "life-story-pdf", jobId, callbackUrl, outputPutUrl, book });
  console.log(`[${jobId}] life story pdf accepted: "${book.title}", ${book.chapters.length} chapters, ${photos} photos (queue length ${jobQueue.length})`);
  res.status(202).json({ accepted: true });
  setImmediate(drainQueue);
});

async function processLifeStoryPdfJob(job) {
  const { jobId, callbackUrl, outputPutUrl, book } = job;
  const pdfPath = path.join(TMP_DIR, `life-story-${jobId}.pdf`);
  const started = Date.now();
  let payload;

  try {
    console.log(`[${jobId}] life story pdf: rendering "${book.title}", ${book.chapters.length} chapters`);
    const { pdf, meta } = await renderBook(book);
    fs.writeFileSync(pdfPath, pdf);
    console.log(`[${jobId}] life story pdf: ${pdf.length}B, ${meta.pages} pages (${meta.images} photos, ${meta.missing} placeholders) in ${Math.round((Date.now() - started) / 1000)}s — uploading`);
    await putFile(outputPutUrl, pdfPath, pdf.length, "application/pdf");
    payload = { jobId, ok: true, pdfBytes: pdf.length, pages: meta.pages, photos: meta.images, placeholders: meta.missing };
    console.log(`[${jobId}] life story pdf done in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error(`[${jobId}] life story pdf failed:`, errText(err));
    payload = { jobId, ok: false, error: errText(err).slice(0, 1000) };
  } finally {
    cleanupFiles([pdfPath]);
  }

  await sendCallback(callbackUrl, payload);
}

// ── /pdf-sample — Life Story Book rendering-path SPIKE. Renders the FAKE sample page
//    (pdf/sample-page.js) through this service's Chromium and returns the PDF inline, so the
//    output of the Railway build can be eyeballed in a browser. Mounted only while
//    PDF_SAMPLE_ENABLED=true; fixed content, no inputs, no callback, no queue. Superseded by
//    /life-story-pdf-jobs above; kept as the quickest "does Chromium run on this build" probe.
//    ────────────────────────────────────────────────────────────────────────────────────────

const PDF_SAMPLE_ENABLED = process.env.PDF_SAMPLE_ENABLED === "true";

if (PDF_SAMPLE_ENABLED) {
  const { renderHtmlToPdf } = require("./pdf/render");
  const { buildSampleHtml } = require("./pdf/sample-page");

  app.get("/pdf-sample", async (req, res) => {
    const grain = req.query.grain === "png" ? "png" : "svg";
    const started = Date.now();
    try {
      const pdf = await renderHtmlToPdf(buildSampleHtml({ grain }));
      console.log(`[pdf-sample] rendered grain=${grain}: ${pdf.length}B in ${Date.now() - started}ms`);
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="sample-6x9-${grain}-grain.pdf"`,
        "Cache-Control": "no-store",
      });
      res.send(pdf);
    } catch (err) {
      console.error("[pdf-sample] failed:", errText(err));
      res.status(500).json({ error: errText(err).slice(0, 1000) });
    }
  });
}

// ── Listen ────────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // /jobs answers in milliseconds and the merge runs off-request, so Node's default HTTP
  // timeouts are right; the 5-minute overrides that the synchronous /merge needed are gone.
  app.listen(PORT, () => {
    console.log(`FFmpeg worker listening on port ${PORT}`);
    console.log(`  /jobs ${WORKER_SECRET ? "enabled" : "DISABLED (WORKER_SECRET unset)"}; callback hosts: ${ALLOWED_CALLBACK_HOSTS.join(", ")}`);
    console.log(`  /life-story-jobs ${!WORKER_SECRET ? "DISABLED (WORKER_SECRET unset)" : ANTHROPIC_API_KEY ? `enabled; model ${BOOK_MODEL}, verifier ${BOOK_VERIFIER_MODEL}` : "DISABLED (ANTHROPIC_API_KEY unset)"}`);
    console.log(`  /life-story-pdf-jobs ${WORKER_SECRET ? "enabled" : "DISABLED (WORKER_SECRET unset)"}; chromium: ${resolveExecutablePath() || "(puppeteer's bundled Chrome for Testing)"}`);
    if (PDF_SAMPLE_ENABLED) console.log("  /pdf-sample enabled");
  });
} else {
  // Required as a module (tests): expose the pure helpers, do not listen.
  module.exports = { streamUidFromTusUrl, callbackHostAllowed };
}
