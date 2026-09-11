// HTML → PDF via headless Chromium (Puppeteer). One browser per call; the caller owns the HTML.
//
// Chromium comes from, in order: PUPPETEER_EXECUTABLE_PATH, a `chromium` on PATH (the nix package
// on Railway — see nixpacks.toml), or Puppeteer's own Chrome for Testing download (local dev).
const puppeteer = require("puppeteer");
const { execFileSync } = require("child_process");

// A whole book — a few MB of inlined fonts, script and grain, then Paged.js laying out a few
// hundred pages, then Chrome serialising them — takes longer than Puppeteer's 30 s defaults.
const NAVIGATION_TIMEOUT_MS = 120_000;
const PDF_TIMEOUT_MS = 300_000;
const PROTOCOL_TIMEOUT_MS = 600_000;

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch (_) { /* not on PATH — try the next name, then fall through to Puppeteer's download */ }
  }
  return undefined;
}

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveExecutablePath(),
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    // Railway runs the process as root inside the container; Chromium refuses to start as root
    // with its sandbox on. The pages rendered here are our own generated HTML, never user-supplied
    // markup, so the sandbox is not load-bearing.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/**
 * Render an HTML string to a PDF. `size` is a CSS length pair for the trim, default 6x9in.
 * printBackground is what keeps the paper colour and grain — without it Chrome drops every
 * background, exactly as it does for a browser print dialog.
 *
 * `prepare(page)`, when given, runs after the document and its fonts have loaded and before
 * the PDF is taken — the book uses it to paginate with Paged.js and write running heads and
 * folios (pdf/book.js prepareBookPage). Whatever it returns comes back as `meta`.
 *
 * `waitUntil` is setContent's: "load" (default) also waits for every <img>; a document whose
 * images are fetched from elsewhere and settled by its own deadline (the book) passes
 * "domcontentloaded" so a slow photo host cannot hold the whole render to the navigation
 * timeout.
 *
 * Resolves { pdf: Buffer, meta }.
 */
async function renderDocument(html, { width = "6in", height = "9in", prepare, waitUntil = "load" } = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.on("pageerror", (err) => console.error("[render] page error:", err && err.message ? err.message : err));
    await page.setContent(html, { waitUntil });
    // @font-face fonts are fetched asynchronously; a PDF taken before this resolves would fall
    // back to a default face for anything not yet loaded.
    await page.evaluate(() => document.fonts.ready);
    const meta = prepare ? await prepare(page) : null;
    const bytes = await page.pdf({
      width,
      height,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: PDF_TIMEOUT_MS,
    });
    return { pdf: Buffer.from(bytes), meta };
  });
}

/** The spike's entry point, unchanged in behaviour: a Buffer of the PDF. */
async function renderHtmlToPdf(html, options) {
  const { pdf } = await renderDocument(html, options);
  return pdf;
}

module.exports = { renderHtmlToPdf, renderDocument, resolveExecutablePath };
