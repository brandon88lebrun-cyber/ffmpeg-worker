// ONE interior page of the Life Story Book with FAKE content — the rendering-path spike.
// 6x9in trim (memoir standard). Fonts are inlined as data URIs so the document is self-contained:
// a page set with setContent() lives at about:blank and cannot fetch file:// resources.
const fs = require("fs");
const path = require("path");

const FONT_DIR = path.join(__dirname, "..", "fonts");
const ASSET_DIR = path.join(__dirname, "assets");

// STATIC instances only — never the variable [wght] files. Chrome's PDF backend (Skia) cannot
// embed a variable font and falls back to Type3 outline fonts: no real font in the file, no
// /BaseFont, every glyph drawn as a path (verified 2026-09-08 with EBGaramond[wght].ttf). Static
// TrueType embeds as a proper subset font (/FontFile2).
const FONT = { regular: "EBGaramond-Regular.ttf", italic: "EBGaramond-Italic.ttf", weight: "400" };

function fileDataUri(dir, file, mime) {
  return `data:${mime};base64,${fs.readFileSync(path.join(dir, file)).toString("base64")}`;
}

// Paper treatment — the same values as the app's letter surfaces (letter-composer.tsx and the
// letters view page): #E0D5B8, fractalNoise grain at baseFrequency 0.9 / 2 octaves / stitch,
// alpha 0.14, and the vignette at 0.12. Read from those files 2026-09-08; do not tune here first.
const PAPER_COLOR = "#E0D5B8";
const GRAIN_TILE_PX = 180;
const GRAIN_SVG =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.14 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>";
const VIGNETTE = "radial-gradient(ellipse at center, transparent 55%, rgba(70,45,15,0.12) 100%)";
// Pre-rasterised tile of the SAME grain over the paper colour (see make-grain-tile.js). Chrome
// rasterises the live SVG filter to a full-page bitmap at 72 dpi on every page; a PNG tile is
// embedded once and tiled as a pattern instead.
const GRAIN_PNG_FILE = "grain-tile.png";

const PARAGRAPHS = [
  "The house on Maple Street had a porch that wrapped around two sides, and in the summers it was where everything happened. My grandmother kept a rocking chair at the far corner, the one that caught the last of the evening light, and she would sit there shelling peas into a chipped enamel bowl while the rest of us came and went.",
  "My father built the swing that hung from the porch ceiling the year I turned six. He was not a carpenter, and it showed: the chains were uneven, and the seat listed to the left so that anyone who sat on it slid gently toward the railing. We loved it anyway.",
  "Sunday dinners were the rule, not the exception. There were never fewer than nine of us at the table, and my uncle told the same three stories every week. We knew every word, and we laughed every time, because the laughing was the point and the stories were only the excuse.",
  "I did not understand, then, that I was being given something. It was only years later, with my own children underfoot, that I recognised the shape of what she had built, one slow evening at a time, and understood that it had been meant for me to carry.",
];

/**
 * @param {object} [o]
 * @param {number} [o.pageNumber]
 * @param {"svg"|"png"} [o.grain]          live SVG filter (as the app) or the pre-rasterised tile
 * @param {number} [o.pages]               repeat the page N times (file-size scaling test)
 */
function buildSampleHtml({ pageNumber = 47, grain = "svg", pages = 1 } = {}) {
  const f = FONT;
  const regular = fileDataUri(FONT_DIR, f.regular, "font/ttf");
  const italic = fileDataUri(FONT_DIR, f.italic, "font/ttf");

  let grainLayer;
  if (grain === "svg") {
    grainLayer = `url("${GRAIN_SVG}")`;
  } else if (grain === "png") {
    grainLayer = `url("${fileDataUri(ASSET_DIR, GRAIN_PNG_FILE, "image/png")}")`;
  } else {
    throw new Error(`unknown grain option: ${grain}`);
  }
  const body = PARAGRAPHS.map((p) => `<p>${p}</p>`).join("\n");
  const pageBlock = (n) => `  <div class="page">
    <header class="chapter">
      <p class="kicker">Chapter Three</p>
      <h1>The House on Maple Street</h1>
      <hr>
    </header>
    <div class="text">
    ${body}
    </div>
    <figure>
      <div class="photo"><div class="frame">photo placeholder</div></div>
      <figcaption>The porch at Maple Street, the summer the swing went up. Grandmother’s chair is just out of frame, as it always was.</figcaption>
    </figure>
    <div class="folio">${n}</div>
  </div>`;
  const pageBlocks = Array.from({ length: pages }, (_, i) => pageBlock(pageNumber + i)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Life Story Book — sample page</title>
<style>
  @font-face { font-family: "Book"; font-style: normal; font-weight: ${f.weight}; src: url(${regular}) format('truetype'); }
  @font-face { font-family: "Book"; font-style: italic; font-weight: ${f.weight}; src: url(${italic}) format('truetype'); }

  @page { size: 6in 9in; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 6in;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    background-color: ${PAPER_COLOR};
    background-image: ${VIGNETTE}, ${grainLayer};
    background-size: auto, ${GRAIN_TILE_PX}px ${GRAIN_TILE_PX}px;
    color: #2b2115;
    font-family: "Book", Georgia, serif;
    font-size: 10.5pt; line-height: 1.5;
    font-kerning: normal; font-variant-ligatures: common-ligatures;
    text-rendering: optimizeLegibility;
  }
  /* Recto page: inside (gutter) margin on the left, outside margin on the right. */
  .page {
    position: relative; box-sizing: border-box; width: 6in; height: 9in; overflow: hidden;
    padding: 0.7in 0.65in 0.8in 0.875in;
  }
  .page + .page { break-before: page; }
  .chapter { text-align: center; margin: 0.1in 0 0.3in; }
  .chapter .kicker {
    font-size: 9pt; letter-spacing: 0.24em; text-transform: uppercase;
    color: #6b563a; margin: 0 0 0.12in;
  }
  .chapter h1 {
    font-weight: 400; font-size: 23pt; line-height: 1.15; letter-spacing: 0.01em;
    margin: 0 0 0.18in; color: #2b2115;
  }
  .chapter hr {
    width: 1.35in; height: 0; margin: 0 auto; border: 0;
    border-top: 1px solid rgba(70,45,15,0.45);
  }
  .text p {
    margin: 0; text-align: justify; hyphens: auto; -webkit-hyphens: auto;
    hyphenate-limit-chars: 7 4 3; orphans: 2; widows: 2;
  }
  .text p + p { text-indent: 1.3em; }
  .text > p:first-child::first-letter {
    float: left; font-size: 3.05em; line-height: 0.82; padding: 0.06em 0.08em 0 0; color: #3f3122;
  }
  figure { margin: 0.26in auto 0; width: 2.9in; }
  .photo {
    box-sizing: border-box; width: 100%; aspect-ratio: 3 / 2;
    border: 1px solid rgba(70,45,15,0.5); padding: 0.07in;
    background: rgba(255,250,235,0.35);
  }
  .photo .frame {
    box-sizing: border-box; width: 100%; height: 100%;
    border: 1px solid rgba(70,45,15,0.28);
    background: rgba(70,45,15,0.08);
    display: flex; align-items: center; justify-content: center;
    color: #7a6549; font-style: italic; font-size: 9pt; letter-spacing: 0.04em;
  }
  figcaption {
    margin-top: 0.09in; text-align: center; font-style: italic; font-size: 9pt;
    line-height: 1.4; color: #4f3f2c;
  }
  .folio {
    position: absolute; left: 0; right: 0; bottom: 0.45in; text-align: center;
    font-size: 9.5pt; letter-spacing: 0.08em; color: #5a4832;
  }
</style>
</head>
<body>
${pageBlocks}
</body>
</html>`;
}

module.exports = { buildSampleHtml, PAPER_COLOR, GRAIN_SVG, GRAIN_TILE_PX, GRAIN_PNG_FILE, ASSET_DIR };
