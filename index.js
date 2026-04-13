const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { v4: uuidv4 } = require("uuid");
const tus = require("tus-js-client");
const fs = require("fs");
const path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: [
      "https://lineage-vault.com",
      "https://www.lineage-vault.com",
      "http://localhost:3000",
    ],
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.post(
  "/merge",
  upload.fields([
    { name: "userVideo", maxCount: 1 },
    { name: "aiAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    const id = uuidv4();
    const userPath = path.join("/tmp", `user-${id}.webm`);
    const aiPath = path.join("/tmp", `ai-${id}.webm`);
    const outPath = path.join("/tmp", `merged-${id}.mp4`);
    const tmpFiles = [userPath, aiPath, outPath];

    function cleanup() {
      for (const f of tmpFiles) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }

    try {
      if (!req.files?.userVideo?.[0] || !req.files?.aiAudio?.[0]) {
        return res.status(400).json({ success: false, error: "Both userVideo and aiAudio files are required" });
      }

      fs.writeFileSync(userPath, req.files.userVideo[0].buffer);
      fs.writeFileSync(aiPath, req.files.aiAudio[0].buffer);

      console.log(`[${id}] Starting FFmpeg merge...`);

      await new Promise((resolve, reject) => {
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

      console.log(`[${id}] Uploading to Cloudflare Stream...`);

      const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_API_TOKEN } = process.env;
      if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_STREAM_API_TOKEN) {
        cleanup();
        return res.status(500).json({ success: false, error: "Cloudflare credentials not configured" });
      }

      const fileSize = fs.statSync(outPath).size;
      const fileStream = fs.createReadStream(outPath);

      const streamUid = await new Promise((resolve, reject) => {
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
            const uid = tusUpload.url.split("/").pop();
            console.log(`[${id}] Upload complete — Stream UID: ${uid}`);
            resolve(uid);
          },
        });
        tusUpload.start();
      });

      cleanup();
      return res.json({ success: true, streamUid });
    } catch (err) {
      console.error(`[${id}] Error:`, err);
      cleanup();
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

const server = app.listen(PORT, () => {
  console.log(`FFmpeg worker listening on port ${PORT}`);
});
server.timeout = 300_000;
server.keepAliveTimeout = 300_000;
server.headersTimeout = 310_000;
