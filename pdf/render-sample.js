// Spike CLI: render the fake sample page to a PDF on disk.
//   node pdf/render-sample.js out.pdf [--grain=svg|png] [--pages=N]
const fs = require("fs");
const { renderHtmlToPdf, resolveExecutablePath } = require("./render");
const { buildSampleHtml } = require("./sample-page");

async function main() {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith("--")) || "sample-page.pdf";
  const opt = (name, dflt) => (args.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split("=")[1];
  const grain = opt("grain", "svg");
  const pages = Number(opt("pages", "1"));
  const started = Date.now();
  console.log(`chromium: ${resolveExecutablePath() || "(puppeteer's bundled Chrome for Testing)"}; grain=${grain} pages=${pages}`);
  const pdf = await renderHtmlToPdf(buildSampleHtml({ grain, pages }));
  fs.writeFileSync(out, pdf);
  console.log(`wrote ${out}: ${pdf.length} bytes in ${Date.now() - started} ms`);
}

main().catch((err) => { console.error(err); process.exit(1); });
