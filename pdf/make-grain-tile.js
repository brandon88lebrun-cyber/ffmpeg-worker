// Pre-rasterise the paper grain: the SAME SVG feTurbulence tile as the app, drawn over the paper
// colour at 3x (180 CSS px → 540 px, i.e. ~288 dpi on the page), saved as an opaque PNG.
// Run once, commit the output: node pdf/make-grain-tile.js
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { resolveExecutablePath } = require("./render");
const { PAPER_COLOR, GRAIN_SVG, GRAIN_TILE_PX, GRAIN_PNG_FILE, ASSET_DIR } = require("./sample-page");

const SCALE = 3;

async function main() {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const out = path.join(ASSET_DIR, GRAIN_PNG_FILE);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveExecutablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: GRAIN_TILE_PX, height: GRAIN_TILE_PX, deviceScaleFactor: SCALE });
    await page.setContent(
      `<!DOCTYPE html><html><body style="margin:0"><div id="t" style="width:${GRAIN_TILE_PX}px;height:${GRAIN_TILE_PX}px;background-color:${PAPER_COLOR};background-image:url(&quot;${GRAIN_SVG}&quot;)"></div></body></html>`
    );
    const el = await page.$("#t");
    await el.screenshot({ path: out, type: "png", omitBackground: false });
    const { size } = fs.statSync(out);
    console.log(`wrote ${out}: ${GRAIN_TILE_PX * SCALE}x${GRAIN_TILE_PX * SCALE} px, ${size} bytes`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
