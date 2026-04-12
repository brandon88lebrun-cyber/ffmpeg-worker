# FFmpeg Worker

Standalone Node.js service that merges a user video (WebM) with an AI audio track (WebM) using FFmpeg, then uploads the result to Cloudflare Stream.

## Deploy to Railway

1. Push this folder to its own GitHub repo (e.g. `ffmpeg-worker`)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
3. Select the repo — Railway auto-detects the Procfile and Node.js runtime
4. Add environment variables in the Railway dashboard (Settings → Variables):

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_STREAM_API_TOKEN` | API token with Stream:Edit permission |
| `PORT` | Leave blank — Railway sets this automatically |

5. Deploy. Railway assigns a public URL like `https://ffmpeg-worker-production-XXXX.up.railway.app`

## Endpoints

### `GET /`
Health check. Returns `{ "status": "ok" }`.

### `POST /merge`
Accepts multipart/form-data with two fields:
- `userVideo` — WebM video blob (camera + mic)
- `aiAudio` — WebM audio blob (TTS output)

Returns `{ "success": true, "streamUid": "..." }` on success.

## Using the deployed URL in your Next.js app

Add this environment variable to your Next.js app (or Vercel dashboard):

```
NEXT_PUBLIC_FFMPEG_WORKER_URL=https://ffmpeg-worker-production-XXXX.up.railway.app
```

Then call `POST ${NEXT_PUBLIC_FFMPEG_WORKER_URL}/merge` from the browser with a FormData body containing `userVideo` and `aiAudio`.

## Local development

```bash
npm install
cp .env.example .env  # fill in your Cloudflare credentials
node index.js
```

Service runs on http://localhost:3001 by default.
