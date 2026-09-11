// The Life Story Book as one printable HTML document: cover, half-title, title page, contents,
// then the chapters — laid out into 6x9in pages by Paged.js inside Chromium and printed by
// pdf/render.js. Replaces the one fake page of the spike (pdf/sample-page.js keeps the paper
// treatment and the font rules; both are reused here, never re-derived).
//
// WHY PAGED.JS. Chromium's print engine flows text across pages but knows nothing of books:
// no running heads, no folios, no page numbers a contents page could refer to, no gutter that
// swaps sides. The CSS that would do it (@page margin boxes, string-set, target-counter) is
// unsupported or half-supported in Chrome. Paged.js is the polyfill for exactly that spec: it
// splits the document into page boxes in the DOM, honouring @page margins per left/right page,
// break-before, break-inside: avoid. It is bundled from node_modules and inlined, so the
// document is still self-contained (setContent() at about:blank cannot fetch file:// assets).
//
// WHAT IS DONE BY HAND, NOT BY CSS. Running heads, folios and the contents page numbers are
// written into each finished page by decorate() (a script in the document, run from
// prepareBookPage after Paged.js has laid everything out). The alternative — Paged.js's own
// margin boxes with string-set / target-counter — leaves the roman/arabic split, the
// suppression on display and chapter-opening pages, and the verso/recto rule to CSS features
// whose support varies by version. Walking the pages once and writing plain elements is
// deterministic and readable, and is where recto discipline (a chapter always opens on a
// right-hand page) plugs in later: see RECTO_IS_PAGED_LEFT.
//
// SCREEN-FRIENDLY v1: every chapter and every front-matter piece starts on a fresh page, but
// no blank versos are forced. The cover is a page of this same document (page 1), which is
// what shifts the interior's parity — see RECTO_IS_PAGED_LEFT.

const fs = require("fs");
const path = require("path");
const { hyphenateSync } = require("hyphen/en-us");
const { PAPER_COLOR, GRAIN_TILE_PX, GRAIN_PNG_FILE, ASSET_DIR } = require("./sample-page");

const FONT_DIR = path.join(__dirname, "..", "fonts");
const PAGED_POLYFILL_FILE = path.join(__dirname, "..", "node_modules", "pagedjs", "dist", "paged.polyfill.js");

// STATIC instances only — see sample-page.js (a variable font embeds as Type3 outlines).
const FONT = { regular: "EBGaramond-Regular.ttf", italic: "EBGaramond-Italic.ttf" };

// ── Trim and margins (6x9in, "standard book proportions": gutter widest of the sides, bottom
//    margin the largest so the text block sits high on the page). ────────────────────────────
const TRIM = { width: "6in", height: "9in" };
const MARGIN = { top: "0.72in", bottom: "0.95in", outside: "0.62in", gutter: "0.86in" };

// Paged.js calls its first page a right-hand page and alternates from there. The COVER is that
// first page, so the half-title (interior page i, a recto in any real book) lands on what
// Paged.js calls a LEFT page: interior parity is inverted. Everything that depends on parity —
// which side the gutter goes, which page gets the subject-name head and which the chapter
// title — reads this one constant. To turn on recto discipline later: insert a blank inside-
// cover page after the cover (parity normalises), set this to false, and change the chapters'
// `break-before: page` to `break-before: right`.
const RECTO_IS_PAGED_LEFT = true;

// Interior palette — the paper and the inks are the spike's values (sample-page.js).
const INK = "#2b2115";
const INK_SOFT = "#4f3f2c";
const INK_MUTED = "#6b563a";
const RULE = "rgba(70,45,15,0.45)";
const VIGNETTE = "radial-gradient(ellipse at center, transparent 55%, rgba(70,45,15,0.12) 100%)";

// Cover palette — the app's design tokens (CLAUDE.md §4): bg, gold, cream, body.
const COVER = { bg: "#141009", gold: "#D4AF37", cream: "#f5e6c8", body: "#a89070" };

const NUMBER_WORDS = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
  "Twenty-One", "Twenty-Two", "Twenty-Three", "Twenty-Four", "Twenty-Five", "Twenty-Six", "Twenty-Seven", "Twenty-Eight", "Twenty-Nine", "Thirty",
];

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

function fileDataUri(dir, file, mime) {
  return `data:${mime};base64,${fs.readFileSync(path.join(dir, file)).toString("base64")}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function chapterKicker(n) {
  return n > 0 && n < NUMBER_WORDS.length ? `Chapter ${NUMBER_WORDS[n]}` : `Chapter ${n}`;
}

/** 'later_years' → 'Later years'. The arc label is the planner's free text. */
function arcLabel(arc) {
  if (!arc || typeof arc !== "string") return "";
  const words = arc.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** "1938 – 2024", "b. 1938", "d. 2024", or "". */
function yearsLine(subject) {
  const b = subject && Number.isInteger(subject.birthYear) ? subject.birthYear : null;
  const d = subject && Number.isInteger(subject.deathYear) ? subject.deathYear : null;
  if (b && d) return `${b} – ${d}`;
  if (b) return `b. ${b}`;
  if (d) return `d. ${d}`;
  return "";
}

/**
 * Print typography for prose the model wrote with a keyboard's punctuation: curly quotes, an
 * em dash for a spaced or doubled hyphen, an ellipsis for three dots. Conservative on purpose —
 * a rule that guesses wrong is worse than a straight quote in a memoir.
 */
function smarten(text) {
  return text
    .replace(/(^|[\s(\[“‘—-])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s(\[“‘—-])'/g, "$1‘")
    .replace(/'/g, "’")
    .replace(/\s+--?\s+|--/g, "—")
    .replace(/\.\.\./g, "…");
}

/** Same split the app's reader and verifier use (paragraphsOf). */
function paragraphsOf(prose) {
  return String(prose).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * A "paragraph" that is only a rule — `-----`, `***`, `———` — is a separator the writer put in
 * the text, not prose (every chapter of the margaret-run4 fixture opens with a sixty-dash
 * line). At the start or end of a chapter it is dropped; inside one it becomes a scene break.
 * Left in, it would take the drop cap and print as a line of em dashes.
 */
function isRuleLine(paragraph) {
  return /^[\s\-—–*_=~·•.]{3,}$/.test(paragraph);
}

function proseBlocks(prose) {
  const blocks = paragraphsOf(prose).map((p) => (isRuleLine(p) ? { kind: "break" } : { kind: "p", text: p }));
  while (blocks.length && blocks[0].kind === "break") blocks.shift();
  while (blocks.length && blocks[blocks.length - 1].kind === "break") blocks.pop();
  return blocks.filter((b, i) => b.kind === "p" || blocks[i - 1].kind !== "break");
}

/** One prose paragraph → HTML: smart punctuation, soft hyphens, then escaped. */
function paragraphHtml(text) {
  return esc(hyphenateSync(smarten(text.replace(/\s*\n\s*/g, " "))));
}

function romanLower(n) {
  const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

// ── Pieces ────────────────────────────────────────────────────────────────────────────────

const ORNAMENT_SVG = (color) => `<svg class="ornament" viewBox="0 0 220 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="0" y1="10" x2="84" y2="10" stroke="${color}" stroke-width="0.9"/>
  <circle cx="91" cy="10" r="1.5" fill="${color}"/>
  <path d="M110 2.5 L117.5 10 L110 17.5 L102.5 10 Z" fill="none" stroke="${color}" stroke-width="1"/>
  <path d="M110 6.5 L113.5 10 L110 13.5 L106.5 10 Z" fill="${color}"/>
  <circle cx="129" cy="10" r="1.5" fill="${color}"/>
  <line x1="136" y1="10" x2="220" y2="10" stroke="${color}" stroke-width="0.9"/>
</svg>`;

function coverHtml(book) {
  const years = yearsLine(book.subject);
  const name = book.subject && book.subject.name ? book.subject.name : "";
  return `<section class="cover">
  <div class="cover-keyline outer"></div>
  <div class="cover-keyline inner"></div>
  <div class="cover-content">
    ${ORNAMENT_SVG(COVER.gold)}
    <h1 class="cover-title">${esc(book.title)}</h1>
    <div class="cover-rule"></div>
    ${name ? `<p class="cover-name">${esc(name)}</p>` : ""}
    ${years ? `<p class="cover-years">${esc(years)}</p>` : ""}
    ${ORNAMENT_SVG(COVER.gold)}
  </div>
</section>`;
}

function halfTitleHtml(book) {
  return `<section class="front display half-title">
  <div class="centered"><p class="half-title-text">${esc(book.title)}</p></div>
</section>`;
}

function titlePageHtml(book) {
  const years = yearsLine(book.subject);
  const name = book.subject && book.subject.name ? book.subject.name : "";
  return `<section class="front display title-page">
  <div class="centered">
    <h1 class="title-page-title">${esc(book.title)}</h1>
    ${ORNAMENT_SVG(INK_MUTED)}
    ${name ? `<p class="title-page-name">${esc(name)}</p>` : ""}
    ${years ? `<p class="title-page-years">${esc(years)}</p>` : ""}
  </div>
</section>`;
}

function contentsHtml(book) {
  const entries = book.chapters.map((c) => {
    const arc = arcLabel(c.arc);
    return `    <li class="toc-entry" data-number="${c.number}">
      <span class="toc-num">${c.number}</span>
      <span class="toc-body"><span class="toc-line"><span class="toc-title">${esc(c.title)}</span><span class="toc-leader"></span><span class="toc-page"></span></span>${arc ? `<span class="toc-arc">${esc(arc)}</span>` : ""}</span>
    </li>`;
  });
  return `<section class="front toc">
  <h2 class="toc-head">Contents</h2>
  <ol class="toc-list">
${entries.join("\n")}
  </ol>
</section>`;
}

function figureHtml(photo) {
  const caption = photo.caption ? `<figcaption>${esc(smarten(photo.caption))}</figcaption>` : "";
  // A photograph that cannot be fetched (a seeded placeholder ref, a deleted object) must not
  // print as Chrome's broken-image glyph: the error handler swaps in the placeholder frame. The
  // frame has fixed proportions so the page layout never depends on whether the image loaded.
  const img = photo.url
    ? `<img src="${esc(photo.url)}" alt="" onerror="this.parentNode.classList.add('missing')">`
    : "";
  return `<figure class="photo"><div class="frame${photo.url ? "" : " missing"}">${img}<div class="placeholder">photograph</div></div>${caption}</figure>`;
}

function chapterHtml(chapter) {
  const blocks = proseBlocks(chapter.prose);
  const paragraphCount = blocks.filter((b) => b.kind === "p").length;
  const photos = Array.isArray(chapter.photos) ? chapter.photos : [];
  // Photos are spread through the chapter: photo i goes after paragraph round((i+1)·P/(N+1)),
  // never before the opening paragraph (the drop cap stays first). More photos than paragraphs
  // simply stack.
  const after = new Map();
  photos.forEach((photo, i) => {
    const at = Math.max(1, Math.min(paragraphCount, Math.round(((i + 1) * paragraphCount) / (photos.length + 1))));
    if (!after.has(at)) after.set(at, []);
    after.get(at).push(photo);
  });
  const body = [];
  let seen = 0;
  for (const block of blocks) {
    if (block.kind === "break") { body.push('<div class="scene-break" aria-hidden="true">❦</div>'); continue; }
    seen += 1;
    body.push(`<p${seen === 1 ? ' class="opening"' : ""}>${paragraphHtml(block.text)}</p>`);
    for (const photo of after.get(seen) || []) body.push(figureHtml(photo));
  }
  return `<section class="chapter" data-number="${chapter.number}">
  <header class="chapter-head" data-number="${chapter.number}" data-title="${esc(chapter.title)}">
    <p class="kicker">${esc(chapterKicker(chapter.number))}</p>
    <h1>${esc(chapter.title)}</h1>
    <hr>
  </header>
  <div class="prose">
${body.join("\n")}
  </div>
</section>`;
}

// ── The script that runs in the page after Paged.js: running heads, folios, contents numbers ──
//
// Runs in the browser. Kept as a string so the whole document is one self-contained file;
// prepareBookPage() drives it after window.PagedPolyfill.preview() resolves.
const PAGE_SCRIPT = `
window.__book = (function () {
  function roman(n) {
    var t = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']];
    var s = ''; for (var i = 0; i < t.length; i++) { while (n >= t[i][0]) { s += t[i][1]; n -= t[i][0]; } } return s;
  }
  function add(box, cls, text) {
    var el = document.createElement('div'); el.className = cls; el.textContent = text; box.appendChild(el);
  }
  // Fonts are registered through the FontFace API (not @font-face) so Paged.js's stylesheet
  // pass never has to parse a megabyte of base64.
  function loadFonts(faces) {
    return Promise.all(faces.map(function (f) {
      var face = new FontFace('Book', 'url(' + f.src + ')', { style: f.style, weight: '400' });
      return face.load().then(function (loaded) { document.fonts.add(loaded); });
    }));
  }
  // Every <img> settled (loaded or failed) or the deadline passed; a straggler is shown as the
  // placeholder rather than printed half-decoded.
  function waitForImages(ms) {
    var imgs = Array.prototype.slice.call(document.images);
    var settle = imgs.map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (r) { img.addEventListener('load', r); img.addEventListener('error', r); });
    });
    var timeout = new Promise(function (r) { setTimeout(r, ms); });
    return Promise.race([Promise.all(settle), timeout]).then(function () {
      var missing = 0;
      imgs.forEach(function (img) {
        if (!img.complete || img.naturalWidth === 0) { img.parentNode.classList.add('missing'); missing++; }
      });
      return { images: imgs.length, missing: missing };
    });
  }
  function decorate(opts) {
    var pages = Array.prototype.slice.call(document.querySelectorAll('.pagedjs_page'));
    var firstChapter = -1;
    for (var i = 0; i < pages.length; i++) { if (pages[i].querySelector('.chapter')) { firstChapter = i; break; } }
    var interior = 0, chapterTitle = null, front = 0, chapterFolio = {};
    pages.forEach(function (page, i) {
      var box = page.querySelector('.pagedjs_pagebox');
      if (page.querySelector('.cover')) { page.classList.add('is-cover'); return; }
      interior += 1;
      var recto = opts.rectoIsPagedLeft ? page.classList.contains('pagedjs_left_page') : page.classList.contains('pagedjs_right_page');
      page.classList.add(recto ? 'is-recto' : 'is-verso');
      var head = page.querySelector('.chapter-head');
      if (head) chapterTitle = head.getAttribute('data-title');
      var folio = null, running = null;
      if (firstChapter === -1 || i < firstChapter) {
        front += 1;
        // Display pages (half-title, title) and the contents opener carry no folio; a contents
        // page that runs on does, in roman.
        var display = page.querySelector('.display') || page.querySelector('.toc-head');
        if (!display) folio = roman(interior);
      } else {
        var n = i - firstChapter + 1;
        if (head) {
          chapterFolio[head.getAttribute('data-number')] = String(n);
          page.classList.add('is-opener');
        } else {
          folio = String(n);
          running = recto ? chapterTitle : opts.versoHead;
        }
      }
      if (running) add(box, 'running-head', running);
      if (folio) add(box, 'folio', folio);
    });
    var entries = document.querySelectorAll('.toc-entry');
    for (var j = 0; j < entries.length; j++) {
      var n2 = chapterFolio[entries[j].getAttribute('data-number')];
      var slot = entries[j].querySelector('.toc-page');
      if (slot && n2) slot.textContent = n2;
    }
    return { pages: pages.length, frontMatterPages: front, chapterPages: firstChapter === -1 ? 0 : pages.length - firstChapter };
  }
  return { loadFonts: loadFonts, waitForImages: waitForImages, decorate: decorate };
})();
`;

// ── The document ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} book                       validated by index.js (lifeStoryPdfBookError)
 * @param {string} book.title
 * @param {{name: string|null, birthYear: number|null, deathYear: number|null}} book.subject
 * @param {{number: number, title: string, arc: string|null, prose: string,
 *          photos: {url: string|null, caption: string}[]}[]} book.chapters   in order
 */
function buildBookHtml(book) {
  const regular = fileDataUri(FONT_DIR, FONT.regular, "font/ttf");
  const italic = fileDataUri(FONT_DIR, FONT.italic, "font/ttf");
  const grain = fileDataUri(ASSET_DIR, GRAIN_PNG_FILE, "image/png");
  const polyfill = fs.readFileSync(PAGED_POLYFILL_FILE, "utf8");
  const gutterOnLeft = RECTO_IS_PAGED_LEFT; // a Paged.js LEFT page is a recto: gutter on its left

  const chapters = [...book.chapters].sort((a, b) => a.number - b.number);
  const doc = { ...book, chapters };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(book.title)}</title>
<script>
  window.PagedConfig = { auto: false };
  window.__bookFonts = [
    { style: "normal", src: ${JSON.stringify(regular)} },
    { style: "italic", src: ${JSON.stringify(italic)} }
  ];
</script>
<script>${PAGE_SCRIPT}</script>
<script>${polyfill}</script>
<style>
  /* ── Page geometry (Paged.js reads these) ─────────────────────────────────────────── */
  @page {
    size: ${TRIM.width} ${TRIM.height};
    margin: ${MARGIN.top} ${MARGIN.outside} ${MARGIN.bottom} ${MARGIN.gutter};
  }
  @page :left  { margin-left: ${gutterOnLeft ? MARGIN.gutter : MARGIN.outside}; margin-right: ${gutterOnLeft ? MARGIN.outside : MARGIN.gutter}; }
  @page :right { margin-left: ${gutterOnLeft ? MARGIN.outside : MARGIN.gutter}; margin-right: ${gutterOnLeft ? MARGIN.gutter : MARGIN.outside}; }
  @page cover { margin: 0; }
  @page cover:left { margin: 0; }
  @page cover:right { margin: 0; }

  html, body { margin: 0; padding: 0; }
  body {
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    color: ${INK};
    font-family: "Book", Georgia, serif;
    font-size: 11pt; line-height: 1.45;
    font-kerning: normal; font-variant-ligatures: common-ligatures;
    text-rendering: optimizeLegibility;
  }

  /* ── Paper: every page carries the letter-surface treatment (sample-page.js) ───────── */
  .pagedjs_page {
    background-color: ${PAPER_COLOR};
    background-image: ${VIGNETTE}, url("${grain}");
    background-size: auto, ${GRAIN_TILE_PX}px ${GRAIN_TILE_PX}px;
  }
  .pagedjs_page.is-cover { background: ${COVER.bg}; }
  .pagedjs_pagebox { position: relative; }

  /* Running heads and folios are placed by __book.decorate() after layout. */
  .running-head {
    position: absolute; top: 0.36in; left: 0.6in; right: 0.6in; text-align: center;
    font-size: 8.5pt; letter-spacing: 0.16em; text-transform: uppercase; color: ${INK_MUTED};
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .folio {
    position: absolute; bottom: 0.48in; left: 0; right: 0; text-align: center;
    font-size: 9.5pt; letter-spacing: 0.08em; color: #5a4832;
  }

  /* ── Cover ────────────────────────────────────────────────────────────────────────── */
  .cover {
    page: cover; break-after: page;
    position: relative; box-sizing: border-box; width: ${TRIM.width}; height: ${TRIM.height}; overflow: hidden;
    background: ${COVER.bg};
    background-image: radial-gradient(ellipse at 50% 42%, rgba(212,175,55,0.07), transparent 62%);
    color: ${COVER.cream};
  }
  .cover-keyline { position: absolute; border: 1px solid ${COVER.gold}; pointer-events: none; }
  .cover-keyline.outer { inset: 0.34in; }
  .cover-keyline.inner { inset: 0.42in; border-width: 0.5px; opacity: 0.55; }
  .cover-content {
    position: absolute; inset: 0.42in; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; padding: 0 0.45in; box-sizing: border-box;
  }
  .cover .ornament { width: 1.9in; height: auto; display: block; margin: 0 auto; }
  .cover-title {
    font-weight: 400; font-size: 27pt; line-height: 1.18; letter-spacing: 0.015em;
    margin: 0.42in 0 0.28in; color: ${COVER.cream};
  }
  .cover-rule { width: 0.55in; height: 0; border-top: 1px solid ${COVER.gold}; margin: 0 auto 0.3in; opacity: 0.85; }
  .cover-name {
    margin: 0; font-size: 12.5pt; letter-spacing: 0.22em; text-transform: uppercase; color: ${COVER.gold};
  }
  .cover-years { margin: 0.1in 0 0; font-size: 11pt; letter-spacing: 0.12em; color: ${COVER.body}; }
  .cover-content > .ornament:last-child { margin-top: 0.46in; }

  /* ── Front matter ─────────────────────────────────────────────────────────────────── */
  .front { break-before: page; }
  /* A display page fills the text area exactly (a hair under, so rounding never spills a
     second page) and centres its block. */
  .display .centered {
    box-sizing: border-box; height: 7.25in; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center;
  }
  .half-title-text { margin: 0; font-size: 15pt; letter-spacing: 0.14em; text-transform: uppercase; color: ${INK_SOFT}; }
  .title-page-title { font-weight: 400; font-size: 25pt; line-height: 1.2; margin: 0 0 0.32in; letter-spacing: 0.01em; }
  .title-page .ornament { width: 1.7in; height: auto; display: block; margin: 0 auto 0.34in; }
  .title-page-name { margin: 0; font-size: 12pt; letter-spacing: 0.2em; text-transform: uppercase; color: ${INK_SOFT}; }
  .title-page-years { margin: 0.1in 0 0; font-size: 10.5pt; letter-spacing: 0.1em; color: ${INK_MUTED}; }

  .toc-head {
    font-weight: 400; font-size: 20pt; letter-spacing: 0.06em; text-align: center;
    margin: 1.3in 0 0.45in; break-after: avoid;
  }
  .toc-list { list-style: none; margin: 0; padding: 0; }
  .toc-entry { display: flex; align-items: flex-start; margin: 0 0 0.16in; break-inside: avoid; }
  .toc-num { flex: 0 0 0.38in; font-size: 10.5pt; color: ${INK_MUTED}; padding-top: 0.01in; }
  .toc-body { flex: 1 1 auto; min-width: 0; }
  .toc-line { display: flex; align-items: baseline; }
  .toc-title { flex: 0 1 auto; font-size: 11.5pt; }
  .toc-leader { flex: 1 1 0.3in; min-width: 0.3in; border-bottom: 1px dotted ${RULE}; margin: 0 0.08in; transform: translateY(-0.3em); }
  .toc-page { flex: 0 0 0.36in; text-align: right; font-size: 10.5pt; font-variant-numeric: lining-nums; }
  .toc-arc { display: block; font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; color: ${INK_MUTED}; margin-top: 0.02in; }

  /* ── Chapters ─────────────────────────────────────────────────────────────────────── */
  .chapter { break-before: page; }
  .chapter-head { text-align: center; padding-top: 1.85in; margin: 0 0 0.38in; break-after: avoid; break-inside: avoid; }
  .chapter-head .kicker {
    font-size: 9pt; letter-spacing: 0.24em; text-transform: uppercase; color: ${INK_MUTED}; margin: 0 0 0.14in;
  }
  .chapter-head h1 {
    font-weight: 400; font-size: 23pt; line-height: 1.15; letter-spacing: 0.01em; margin: 0 0 0.2in; color: ${INK};
  }
  .chapter-head hr { width: 1.35in; height: 0; margin: 0 auto; border: 0; border-top: 1px solid ${RULE}; }

  .prose p {
    margin: 0; text-align: justify; hyphens: manual; -webkit-hyphens: manual;
    text-indent: 1.3em; orphans: 2; widows: 2;
  }
  .prose p.opening { text-indent: 0; }
  /* A paragraph continued from the previous page is not a new paragraph. */
  .prose p[data-split-from] { text-indent: 0; }
  .prose p.opening::first-letter {
    float: left; font-size: 3.7em; line-height: 0.78; padding: 0.07em 0.09em 0 0; color: #3f3122;
  }
  .prose p.opening[data-split-from]::first-letter { float: none; font-size: inherit; line-height: inherit; padding: 0; color: inherit; }
  /* A separator the writer left in the prose, set as a fleuron with a line's space around it. */
  .scene-break { text-align: center; font-size: 12pt; line-height: 1; color: ${INK_MUTED}; margin: 0.18in 0; break-after: avoid; }
  .scene-break + p { text-indent: 0; }

  figure.photo { break-inside: avoid; width: 3.3in; margin: 0.24in auto 0.26in; }
  figure.photo .frame {
    position: relative; box-sizing: border-box; width: 100%; aspect-ratio: 3 / 2;
    border: 1px solid rgba(70,45,15,0.5); padding: 0.07in; background: rgba(255,250,235,0.35);
  }
  figure.photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
  figure.photo .placeholder {
    display: none; box-sizing: border-box; width: 100%; height: 100%;
    border: 1px solid rgba(70,45,15,0.28); background: rgba(70,45,15,0.08);
    align-items: center; justify-content: center;
    color: #7a6549; font-style: italic; font-size: 9pt; letter-spacing: 0.04em;
  }
  figure.photo .frame.missing img { display: none; }
  figure.photo .frame.missing .placeholder { display: flex; }
  figcaption { margin-top: 0.09in; text-align: center; font-style: italic; font-size: 9pt; line-height: 1.4; color: ${INK_SOFT}; }
</style>
</head>
<body>
${coverHtml(doc)}
${halfTitleHtml(doc)}
${titlePageHtml(doc)}
${contentsHtml(doc)}
${chapters.map(chapterHtml).join("\n")}
</body>
</html>`;
}

/**
 * The in-page steps between "document loaded" and "print": fonts, pagination, images,
 * decoration. Returns the layout summary decorate() computes. Used by render-book.js as the
 * `prepare` hook of pdf/render.js.
 */
async function prepareBookPage(page, book, { imageTimeoutMs = 60_000 } = {}) {
  const versoHead = (book.subject && book.subject.name) || book.title;
  return page.evaluate(async (opts) => {
    await window.__book.loadFonts(window.__bookFonts);
    await window.PagedPolyfill.preview();
    const images = await window.__book.waitForImages(opts.imageTimeoutMs);
    const layout = window.__book.decorate({ rectoIsPagedLeft: opts.rectoIsPagedLeft, versoHead: opts.versoHead });
    return { ...layout, ...images };
  }, { imageTimeoutMs, rectoIsPagedLeft: RECTO_IS_PAGED_LEFT, versoHead });
}

module.exports = { buildBookHtml, prepareBookPage, TRIM, RECTO_IS_PAGED_LEFT, chapterKicker, arcLabel, yearsLine, smarten, romanLower };
