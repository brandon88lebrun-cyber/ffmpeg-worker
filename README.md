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

### `POST /export-jobs`

Data export: zip a set of files the app has presigned, plus one JSON document of the user's written content, and PUT the archive to a presigned URL. Same secret header as `/jobs`, same callback allow-list, same 3× callback retry. Shares the one-at-a-time queue with interview merges. No new environment variables — the worker still touches nothing but the URLs it is handed.

Body (JSON, up to 25 MB — `textContentJson` rides in the body):

```json
{
  "jobId": "uuid",
  "callbackUrl": "https://www.capsulated.app/api/export/job-callback",
  "outputPutUrl": "https://…presigned PUT for the finished zip…",
  "files": [
    { "url": "https://…presigned GET…", "zipPath": "vault/photos/2024-beach.jpg" }
  ],
  "textContentJson": "{\"letters\":[…]}"
}
```

- `zipPath` is the entry's path inside the zip: relative, forward slashes, no `.`/`..` segments, unique across the request. `content/my-content.json` is reserved — that is where `textContentJson` lands.
- `202 { "accepted": true }` — queued (`duplicate: true` if the same `jobId` is already queued or running).
- `400` — malformed body, a bad `zipPath`, or a `callbackUrl` host not on the allow-list. `401` / `503` as for `/jobs`.

The worker fetches the files **one at a time**, streaming each straight into the archive (media entries are STORED, not deflated), writes the zip to scratch disk, PUTs it with an exact `Content-Length`, deletes the scratch file, and calls back once:

```json
{ "jobId": "uuid", "ok": true,  "zipBytes": 123456789, "skippedFiles": ["vault/photos/gone.jpg"] }
{ "jobId": "uuid", "ok": false, "error": "upload returned 403: …" }
```

One dead file never kills an export. A file that fails before its headers (404, refused, timeout) is left out; one whose connection drops mid-body is kept as a truncated entry. Both are listed in `skippedFiles` so the app can tell the user. Exports keep no result memory: a re-dispatch after completion rebuilds the zip.

### `POST /life-story-jobs`

Life Story Book generation. The app gathers everything the user recorded (under the user's own RLS) and hands the serialized `LifeStoryContent` blob over; the worker plans the chapters, writes them, runs the invention verifier, and posts the finished book back. The worker reads nothing but the body it is given — no Supabase, no storage. Same secret header, same callback allow-list, same 3× callback retry, same one-at-a-time queue as `/jobs` and `/export-jobs`.

Needs `ANTHROPIC_API_KEY` on the worker (the route answers `503` while it is unset). Optional `ANTHROPIC_BOOK_MODEL` / `ANTHROPIC_BOOK_VERIFIER_MODEL` override the models (default `claude-opus-5`; the verifier defaults to the book model). The prompts in `life-story/book-prompts.js` are a verbatim copy of the app's — re-copy when the app's change, never tune them here.

Body (JSON, up to 10 MB):

```json
{
  "jobId": "uuid",
  "callbackUrl": "https://www.capsulated.app/api/life-story/job-callback",
  "content": { "subject": {…}, "dated": […], "undated": […], "totalWordCount": 6021, … },
  "plan": { "book_title": "…", "chapters": [ { "chapter_number": 1, "title": "…", "arc_stage": "…", "brief": "…", "source_ids": ["…"] } ] }
}
```

- `content` is the app's `LifeStoryContent` (gather-content.ts) as JSON. Items need `sourceId`, `sourceType`, `text`, `wordCount`; at most 5000 items; `sourceId` unique.
- `plan` is optional: a frozen plan in the planner's own JSON shape skips Stage 1 (tuning only). It is validated at accept time with the same rules a generated plan gets; a bad plan is a `400`, never a queued job.
- `202 { "accepted": true }` — queued (`duplicate: true` if the same `jobId` is already queued or running; `reused: true` if this job already finished here and the stored book is being re-sent instead of regenerated).
- `400` — malformed body, bad content, bad plan, or a `callbackUrl` host not on the allow-list. `401` as for `/jobs`. `503` — `WORKER_SECRET` or `ANTHROPIC_API_KEY` unset.

The worker then, in the background: one planning call → one writing call per chapter, in order → one verifier call per chapter → callback. Minutes, not seconds; the app's cron treats a job as stalled well after that. A finished book is remembered in memory for six hours (as `/jobs` remembers a Stream uid) because regenerating is neither free nor idempotent.

```json
{
  "jobId": "uuid",
  "ok": true,
  "book": {
    "title": "One True Thing",
    "chapters": [
      {
        "number": 1, "title": "…", "arc_stage": "childhood", "prose": "…",
        "source_ids": ["iv-1", "le-1"], "photo_refs": ["…"],
        "paragraph_provenance": [{ "paragraph": 1, "sourceIds": ["iv-1"] }],
        "verification_status": "verified"
      }
    ],
    "flags": [
      { "chapter_number": 7, "paragraph_number": 3, "flagged_text": "…", "category": "reason", "reason": "…", "nearest_source": "card-1:hobbies" }
    ]
  },
  "model": "claude-opus-5", "verifierModel": "claude-opus-5",
  "usage": { "generate": { "calls": 8, "inputTokens": 0, "outputTokens": 0 }, "verify": { "calls": 7, "inputTokens": 0, "outputTokens": 0 } },
  "warnings": ["…"]
}
{ "jobId": "uuid", "ok": false, "error": "generation failed at chapter 3: …" }
```

`verification_status` per chapter is `verified` (no flags), `flagged`, or `unchecked` (the verifier call failed; the prose still stands). `paragraph_number` is `null` when the verifier could not place a flag. `model`, `verifierModel`, `usage`, and `warnings` are diagnostics for the app's logs, not for storage. A generation failure sends `ok: false` with nothing partial — a half-written book is never a book.

### `POST /life-story-pdf-jobs`

Life Story Book PDF render. Once the owner approves an edition, the app sends its text — title, subject, the chapters in order with any photo URLs already resolved — plus a presigned PUT for the finished file; the worker lays it out as a 6×9 in book (`pdf/book.js`: cover, half-title, title page, contents with page numbers, chapters with sinkage, drop caps, running heads and folios), prints it through Chromium (`pdf/render.js`), PUTs the PDF to that URL and calls back **status only** — the `/export-jobs` pattern, because a PDF is megabytes. Same secret header, same callback allow-list, same 3× callback retry, same one-at-a-time queue. Nothing read but the body.

Body (JSON, up to 8 MB):

```json
{
  "jobId": "uuid",
  "callbackUrl": "https://www.capsulated.app/api/life-story/render-callback",
  "outputPutUrl": "https://<r2 presigned PUT>",
  "book": {
    "title": "One True Thing",
    "subject": { "name": "Margaret Ellen Whitfield", "birthYear": 1938, "deathYear": 2024 },
    "chapters": [
      { "number": 1, "title": "…", "arc": "childhood", "prose": "…\n\n…", "photos": [ { "url": "https://…", "caption": "…" } ] }
    ]
  }
}
```

- `jobId` is the edition's id (the same id its generation job used; the worker keeps the two kinds apart).
- `book.chapters` need `number` (positive, unique), `title`, `prose` (paragraphs separated by blank lines); `arc` optional; at most 200 chapters. `photos` optional, at most 40 per chapter; `url` must be `https` or `null` (a `null` or unreachable photo prints as a placeholder frame, never a broken-image glyph); `caption` optional.
- `202 { "accepted": true }` — queued (`duplicate: true` if the same job is already queued or running). `400` — malformed body or a `callbackUrl` host not on the allow-list. `401` as for `/jobs`. `503` — `WORKER_SECRET` unset.

A render is deterministic and costs seconds, so no result memory: a re-dispatch renders again and overwrites the same object.

```json
{ "jobId": "uuid", "ok": true, "pdfBytes": 465997, "pages": 17, "photos": 4, "placeholders": 3 }
{ "jobId": "uuid", "ok": false, "error": "…" }
```

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

## PDF rendering (Life Story Book)

`pdf/render.js` turns an HTML string into a PDF with headless Chromium (Puppeteer), `printBackground: true`, no page margins, page size from the document's `@page` rule; `renderDocument()` takes a `prepare(page)` hook that runs between load and print. `pdf/book.js` builds the whole book as one document and, in that hook, paginates it with **Paged.js** (`pagedjs`, inlined from `node_modules` so the document stays self-contained): Chromium alone flows text but has no running heads, folios or contents page numbers. After Paged.js has laid the pages out, a script in the document walks them once and writes the running head (subject name verso / chapter title recto), the folio (roman in front matter, arabic from chapter 1, none on display and chapter-opening pages) and the contents numbers into each page — deterministic, and where recto discipline plugs in later (`RECTO_IS_PAGED_LEFT` in `pdf/book.js`). Prose is pre-hyphenated with soft hyphens (`hyphen/en-us`) because the nix Chromium carries no hyphenation dictionaries. `pdf/sample-page.js` is the spike's single fake page; the paper treatment and font rules live there and are reused.

```bash
node pdf/render-book.js book.json out.pdf [--preview=DIR] [--pages=1,2,3]   # book.json = the `book` of a /life-story-pdf-jobs body
```

`--preview` screenshots the laid-out pages as PNGs — the way to check a layout change without a PDF viewer.

- **Chromium on Railway** comes from the nix `chromium` package (`nixpacks.toml`). Puppeteer's own Chrome download is skipped there (`PUPPETEER_SKIP_DOWNLOAD=true`) because the Nixpacks runtime lacks its shared libraries. Locally, `npm install` downloads Chrome for Testing and the renderer uses that. Resolution order: `PUPPETEER_EXECUTABLE_PATH` → `chromium` on PATH → Puppeteer's download.
- **Fonts** are bundled in `fonts/` (EB Garamond, OFL) and inlined as data URIs. Use the **static** instances (`EBGaramond-Regular.ttf`, `-Italic.ttf`): Chrome embeds a *variable* font (`[wght]`) as Type3 outline glyphs — no real font in the PDF. Static TrueType embeds as a proper subset (`/FontFile2`).
- **Paper grain**: `--grain=svg` draws the app's live `feTurbulence` filter (Chrome rasterises it to a full-page bitmap at 72 dpi on every page); `--grain=png` uses `pdf/assets/grain-tile.png`, the same filter pre-rasterised at 3× by `pdf/make-grain-tile.js`, embedded once per document and tiled.

```bash
node pdf/render-sample.js out.pdf [--grain=svg|png] [--pages=N]
```

`GET /pdf-sample[?grain=png]` returns the sample PDF inline — mounted only while `PDF_SAMPLE_ENABLED=true` (set it on Railway to check the deployed build's output, then unset it). No secret, no inputs, no queue. The real endpoint is `POST /life-story-pdf-jobs` above.
