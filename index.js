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

// Server-to-server only (the app's server actions and cron call /jobs; the worker calls back).
// No browser ever talks to this service any more, so there is no CORS layer.
//
// /export-jobs carries the user's written content in its body, so that route mounts its own,
// larger parser (see EXPORT_BODY_LIMIT). Every other route keeps the 64 kB ceiling.
const smallJson = express.json({ limit: "64kb" });
app.use((req, res, next) => (req.path === "/export-jobs" ? next() : smallJson(req, res, next)));

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
    // `kind` is set only by /export-jobs; a /jobs entry has none and is an interview merge.
    await (job.kind === "export" ? processExportJob(job) : processJob(job));
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

// ── Listen ────────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // /jobs answers in milliseconds and the merge runs off-request, so Node's default HTTP
  // timeouts are right; the 5-minute overrides that the synchronous /merge needed are gone.
  app.listen(PORT, () => {
    console.log(`FFmpeg worker listening on port ${PORT}`);
    console.log(`  /jobs ${WORKER_SECRET ? "enabled" : "DISABLED (WORKER_SECRET unset)"}; callback hosts: ${ALLOWED_CALLBACK_HOSTS.join(", ")}`);
  });
} else {
  // Required as a module (tests): expose the pure helpers, do not listen.
  module.exports = { streamUidFromTusUrl, callbackHostAllowed };
}
