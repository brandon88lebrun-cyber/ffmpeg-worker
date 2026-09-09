// HTML → PDF via headless Chromium (Puppeteer). One browser per call; the caller owns the HTML.
//
// Chromium comes from, in order: PUPPETEER_EXECUTABLE_PATH, a `chromium` on PATH (the nix package
// on Railway — see nixpacks.toml), or Puppeteer's own Chrome for Testing download (local dev).
const puppeteer = require("puppeteer");
const { execFileSync } = require("child_process");

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
 * Render an HTML string to a PDF Buffer. `size` is a CSS length pair for the trim, default 6x9in.
 * printBackground is what keeps the paper colour and grain — without it Chrome drops every
 * background, exactly as it does for a browser print dialog.
 */
async function renderHtmlToPdf(html, { width = "6in", height = "9in" } = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // @font-face fonts are fetched asynchronously; a PDF taken before this resolves would fall
    // back to a default face for anything not yet loaded.
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.pdf({
      width,
      height,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.from(bytes);
  });
}

module.exports = { renderHtmlToPdf, resolveExecutablePath };
