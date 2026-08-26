const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { v4: uuidv4 } = require("uuid");
const tus = require("tus-js-client");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

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

app.use(
  cors({
    origin: [
      "https://lineage-vault.com",
      "https://www.lineage-vault.com",
      "https://capsulated.app",
      "https://www.capsulated.app",
      "http://localhost:3000",
    ],
  })
);
app.use(express.json({ limit: "64kb" }));

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

// ── The pipeline (unchanged from /merge): FFmpeg merge → TUS upload to Stream ──────────────

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

// ── /merge — LEGACY, synchronous. Kept for one deploy cycle so an already-open old client
//    still works; remove (with multer) once the app's /jobs flow is deployed. ────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post(
  "/merge",
  upload.fields([
    { name: "userVideo", maxCount: 1 },
    { name: "aiAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    const id = uuidv4();
    const userPath = path.join(TMP_DIR, `user-${id}.webm`);
    const aiPath = path.join(TMP_DIR, `ai-${id}.webm`);

    try {
      if (!req.files?.userVideo?.[0] || !req.files?.aiAudio?.[0]) {
        return res.status(400).json({ success: false, error: "Both userVideo and aiAudio files are required" });
      }

      fs.writeFileSync(userPath, req.files.userVideo[0].buffer);
      fs.writeFileSync(aiPath, req.files.aiAudio[0].buffer);

      const { streamUid, bytesUploaded } = await mergeAndUpload(id, userPath, aiPath);
      return res.json({ success: true, streamUid, bytesUploaded });
    } catch (err) {
      console.error(`[${id}] Error:`, err);
      return res.status(500).json({ success: false, error: err.message });
    } finally {
      cleanupFiles([userPath, aiPath]);
    }
  }
);

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
    await processJob(job);
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
    console.log(`[${jobId}] done in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error(`[${jobId}] failed:`, err.message);
    payload = { jobId, ok: false, error: String(err.message || err).slice(0, 1000) };
  } finally {
    cleanupFiles([userPath, aiPath]);
  }

  await sendCallback(callbackUrl, payload);
}

/** The callback is the only thing that turns work into a record — retry it with backoff. */
async function sendCallback(callbackUrl, payload) {
  for (let attempt = 1; attempt <= CALLBACK_RETRIES; attempt++) {
    try {
      const { status, body } = await postJson(callbackUrl, { "x-worker-secret": WORKER_SECRET }, payload);
      if (status >= 200 && status < 300) {
        console.log(`[${payload.jobId}] callback delivered (${status}) ${body.slice(0, 200)}`);
        return true;
      }
      // 4xx means the app rejected the payload itself (or the secret) — retrying the same
      // body cannot help. Log and stop; the app's cron will re-dispatch if the job stalls.
      if (status >= 400 && status < 500) {
        console.error(`[${payload.jobId}] callback rejected (${status}) ${body.slice(0, 300)} — not retrying`);
        return false;
      }
      console.error(`[${payload.jobId}] callback attempt ${attempt} returned ${status}: ${body.slice(0, 300)}`);
    } catch (err) {
      console.error(`[${payload.jobId}] callback attempt ${attempt} error:`, err.message);
    }
    if (attempt < CALLBACK_RETRIES) await sleep(5_000 * 2 ** (attempt - 1)); // 5s, 10s
  }
  console.error(`[${payload.jobId}] callback NOT delivered after ${CALLBACK_RETRIES} attempts — the app's cron will re-dispatch`);
  return false;
}

// ── Listen ────────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`FFmpeg worker listening on port ${PORT}`);
    console.log(`  /jobs ${WORKER_SECRET ? "enabled" : "DISABLED (WORKER_SECRET unset)"}; callback hosts: ${ALLOWED_CALLBACK_HOSTS.join(", ")}`);
  });
  // These only matter for the legacy synchronous /merge; /jobs answers in milliseconds.
  server.timeout = 300_000;
  server.keepAliveTimeout = 300_000;
  server.headersTimeout = 310_000;
} else {
  // Required as a module (tests): expose the pure helpers, do not listen.
  module.exports = { streamUidFromTusUrl, callbackHostAllowed };
}
