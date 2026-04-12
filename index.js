const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const FormData = require("form-data");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3001;

// CORS
app.use(
  cors({
    origin: [
      "https://lineage-vault.com",
      "https://www.lineage-vault.com",
      "http://localhost:3000",
    ],
  })
);

// Multer — memory storage, 500MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

// Merge endpoint
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
        try {
          fs.unlinkSync(f);
        } catch (_) {}
      }
    }

    try {
      // Validate files are present
      if (!req.files?.userVideo?.[0] || !req.files?.aiAudio?.[0]) {
        return res
          .status(400)
          .json({ success: false, error: "Both userVideo and aiAudio files are required" });
      }

      // Write buffers to /tmp
      fs.writeFileSync(userPath, req.files.userVideo[0].buffer);
      fs.writeFileSync(aiPath, req.files.aiAudio[0].buffer);

      console.log(`[${id}] Starting FFmpeg merge...`);

      // FFmpeg merge: keep user video, mix both audio tracks
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(userPath)
          .input(aiPath)
          .complexFilter([
            // Extract audio from user video (index 0) and AI audio (index 1), mix them
            "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
          ])
          .outputOptions([
            "-map", "0:v",        // video from user recording
            "-map", "[aout]",     // mixed audio
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

      // Upload to Cloudflare Stream
      console.log(`[${id}] Uploading to Cloudflare Stream...`);

      const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_API_TOKEN } = process.env;
      if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_STREAM_API_TOKEN) {
        cleanup();
        return res
          .status(500)
          .json({ success: false, error: "Cloudflare credentials not configured" });
      }

      const form = new FormData();
      form.append("file", fs.createReadStream(outPath), {
        filename: `merged-${id}.mp4`,
        contentType: "video/mp4",
      });

      const cfResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CLOUDFLARE_STREAM_API_TOKEN}`,
            ...form.getHeaders(),
          },
          body: form,
        }
      );

      const cfData = await cfResponse.json();

      if (!cfResponse.ok || !cfData.success) {
        console.error(`[${id}] Cloudflare Stream error:`, JSON.stringify(cfData));
        cleanup();
        return res.status(502).json({
          success: false,
          error: "Cloudflare Stream upload failed",
        });
      }

      const streamUid = cfData.result.uid;
      console.log(`[${id}] Upload complete — Stream UID: ${streamUid}`);

      cleanup();
      return res.json({ success: true, streamUid });
    } catch (err) {
      console.error(`[${id}] Error:`, err);
      cleanup();
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Set generous timeout for long merges (5 minutes)
const server = app.listen(PORT, () => {
  console.log(`FFmpeg worker listening on port ${PORT}`);
});
server.timeout = 300_000;
server.keepAliveTimeout = 300_000;
server.headersTimeout = 310_000;
