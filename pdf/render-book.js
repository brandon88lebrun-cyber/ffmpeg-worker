// Render one Life Story Book to a PDF. The one place the pieces meet: pdf/book.js builds the
// document and drives Paged.js inside the page; pdf/render.js owns Chromium and the print.
// Used by /life-story-pdf-jobs (index.js) and by the CLI at the bottom:
//
//   node pdf/render-book.js book.json out.pdf [--preview=DIR] [--pages=1,2,3]
//
// book.json is the `book` object of a /life-story-pdf-jobs body (README). --preview screenshots
// the laid-out pages (all of them, or the 1-based list in --pages) as PNGs into DIR — the way to
// eyeball a layout change without a PDF viewer.
const fs = require("fs");
const path = require("path");
const { renderDocument } = require("./render");
const { buildBookHtml, prepareBookPage } = require("./book");

/**
 * @returns {Promise<{ pdf: Buffer, meta: { pages, frontMatterPages, chapterPages, images, missing } }>}
 */
async function renderBook(book, { preview } = {}) {
  const html = buildBookHtml(book);
  return renderDocument(html, {
    // Photos are settled by prepareBookPage's own deadline (placeholder after it), not by load.
    waitUntil: "domcontentloaded",
    prepare: async (page) => {
      const meta = await prepareBookPage(page, book);
      if (preview) await screenshotPages(page, preview.dir, preview.pages);
      return meta;
    },
  });
}

async function screenshotPages(page, dir, which) {
  fs.mkdirSync(dir, { recursive: true });
  const handles = await page.$$(".pagedjs_page");
  const wanted = which && which.length ? new Set(which) : null;
  for (let i = 0; i < handles.length; i++) {
    if (wanted && !wanted.has(i + 1)) continue;
    await handles[i].screenshot({ path: path.join(dir, `page-${String(i + 1).padStart(3, "0")}.png`) });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length < 1) {
    console.error("usage: node pdf/render-book.js book.json [out.pdf] [--preview=DIR] [--pages=1,2,3]");
    process.exit(2);
  }
  const [input, out = "book.pdf"] = positional;
  const opt = (name) => { const hit = args.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null; };
  const previewDir = opt("preview");
  const pages = (opt("pages") || "").split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);

  const book = JSON.parse(fs.readFileSync(input, "utf8"));
  const started = Date.now();
  const { pdf, meta } = await renderBook(book, previewDir ? { preview: { dir: previewDir, pages } } : {});
  fs.writeFileSync(out, pdf);
  console.log(`wrote ${out}: ${pdf.length} bytes, ${JSON.stringify(meta)}, in ${Date.now() - started} ms`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { renderBook };
