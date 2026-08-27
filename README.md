# FFmpeg Worker

Standalone Node.js service that merges a user video (WebM) with an AI audio track using FFmpeg, then uploads the result to Cloudflare Stream.

One way in: **`POST /jobs`** — durable and asynchronous. The app hands over a job (two signed download URLs + a callback URL), gets `202` immediately, and the worker processes in the background and POSTs the result to the callback. Server-to-server only; no browser ever calls this service (there is no CORS layer).

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

The worker then, in the background: streams both URLs to disk (no in-memory buffering) → FFmpeg merge (libx264 / aac, `amix` of both audio tracks) → TUS upload to Cloudflare Stream → deletes its scratch files → POSTs the `uploaded` callback, then the final callback.

### Callback contract

`POST <callbackUrl>` with header `x-worker-secret: <WORKER_SECRET>`. Two messages per successful job, one per failed job:

```json
{ "jobId": "uuid", "phase": "uploaded", "streamUid": "…", "bytesUploaded": 123456789 }
{ "jobId": "uuid", "ok": true,  "streamUid": "…", "bytesUploaded": 123456789 }
{ "jobId": "uuid", "ok": false, "error": "FFmpeg error: …" }
```

- `phase: "uploaded"` is sent the moment the Stream upload finishes, **before** the final. It is advisory: the app stores the uid on the job row so that if this process restarts (or the final callback is lost) before the final lands, the app completes the job from the stored uid instead of re-dispatching a merge that would orphan the first upload. The worker awaits it (so it always precedes the final) but ignores its outcome — an app that does not know the phase answers `400`, which is fine; the final still carries everything.
- The final (`ok`) message completes the interview or fails the attempt. The app also stores the uid from it before completing.

Use the canonical host in `callbackUrl` (`https://www.capsulated.app/...` — the bare domain redirects to www). The worker follows a single 307/308 redirect as a safety net, but only to a host on the allow-list.

The callback is retried 3× (5 s, 10 s backoff) on network errors or 5xx. A 4xx is treated as final (the app rejected the payload; retrying cannot help). If the callback never lands, the app's cron re-dispatches the job after 30 min — the app's callback route is idempotent, so a duplicate result is a no-op there.

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
