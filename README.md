# FFmpeg Worker

Standalone Node.js service that merges a user video (WebM) with an AI audio track using FFmpeg, then uploads the result to Cloudflare Stream.

Two ways in:

- **`POST /jobs`** — the durable, asynchronous path the app uses. Accepts a job (two signed download URLs + a callback URL), answers `202` immediately, processes in the background, and POSTs the result to the callback.
- **`POST /merge`** — the legacy synchronous path (multipart upload, response after the merge). Kept for one deploy cycle; remove once the app's `/jobs` flow is live.

## Deploy to Railway

1. Push this folder to its own GitHub repo (e.g. `ffmpeg-worker`)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
3. Select the repo — Railway auto-detects the Procfile and Node.js runtime
4. Add environment variables in the Railway dashboard (Settings → Variables):

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_STREAM_API_TOKEN` | API token with Stream:Edit permission |
| `WORKER_SECRET` | 32 random bytes as hex. **Must equal the app's `FFMPEG_WORKER_SECRET`.** `/jobs` is disabled while unset. |
| `ALLOWED_CALLBACK_HOSTS` | Optional. Comma-separated hostnames the worker may call back. Default `capsulated.app,www.capsulated.app`. |
| `PORT` | Leave blank — Railway sets this automatically |

5. Deploy. Railway assigns a public URL like `https://ffmpeg-worker-production-XXXX.up.railway.app`

Scratch files go to `/tmp` (override with `TMP_DIR`). Nothing is kept between jobs; if the process restarts mid-job the app's cron re-dispatches it.

## Endpoints

### `GET /`
Health check. Returns `{ "status": "ok", "jobs": { "queued": 0, "running": null } }`.

### `POST /jobs`

Header: `x-worker-secret: <WORKER_SECRET>` — required; wrong or missing → `401`.

Body (JSON):

```json
{
  "jobId": "uuid",
  "videoUrl": "https://…presigned GET for camera.webm…",
  "audioUrl": "https://…presigned GET for ai_audio.wav…",
  "callbackUrl": "https://capsulated.app/api/interview/job-callback"
}
```

- `202 { "accepted": true }` — queued. Jobs run one at a time, in order.
- `400` — malformed body, or `callbackUrl` host not in `ALLOWED_CALLBACK_HOSTS`.
- `503` — `WORKER_SECRET` unset on the worker.

The worker then, in the background: streams both URLs to disk (no in-memory buffering) → FFmpeg merge (libx264 / aac, `amix` of both audio tracks) → TUS upload to Cloudflare Stream → deletes its scratch files → POSTs the callback.

### Callback contract

`POST <callbackUrl>` with header `x-worker-secret: <WORKER_SECRET>` and one of:

```json
{ "jobId": "uuid", "ok": true,  "streamUid": "…", "bytesUploaded": 123456789 }
{ "jobId": "uuid", "ok": false, "error": "FFmpeg error: …" }
```

The callback is retried 3× (5 s, 10 s backoff) on network errors or 5xx. A 4xx is treated as final (the app rejected the payload; retrying cannot help). If the callback never lands, the app's cron re-dispatches the job after 30 min — the app's callback route is idempotent, so a duplicate result is a no-op there.

### `POST /merge` (legacy)
Multipart form with `userVideo` (WebM) and `aiAudio` (WebM/WAV). Returns `{ "success": true, "streamUid": "…", "bytesUploaded": n }` after the whole merge — the caller must keep the connection open (5-minute server timeout). In-memory upload, 500 MB cap.

## Smoke test

```bash
# health
curl -s https://<worker>/

# reject without secret → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<worker>/jobs \
  -H "Content-Type: application/json" -d '{}'

# reject a foreign callback host → 400
curl -s -X POST https://<worker>/jobs \
  -H "Content-Type: application/json" -H "x-worker-secret: $WORKER_SECRET" \
  -d '{"jobId":"00000000-0000-4000-8000-000000000000","videoUrl":"https://example.com/a","audioUrl":"https://example.com/b","callbackUrl":"https://evil.example/cb"}'
```

## Local development

```bash
npm install
cp .env.example .env  # fill in your Cloudflare credentials + WORKER_SECRET
node index.js
```

Service runs on http://localhost:3001 by default. For local callbacks add `localhost` to `ALLOWED_CALLBACK_HOSTS` (plain `http://localhost` is accepted for that host only).
