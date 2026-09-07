/**
 * Renders the PDF documents in docs/ from their HTML sources.
 *
 *   npm run docs:pdf
 *
 * Kept as source rather than only as a PDF so the documents can be corrected
 * and regenerated. Uses the Playwright browser the test suite already installs.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const jobs = [
  ['docs/src/features.html', 'docs/Velozity-Business-OS-Feature-Inventory.pdf', 'Feature Inventory'],
  ['docs/src/report.html', 'docs/Velozity-Business-OS-Delivery-Report.pdf', 'Delivery Report'],
];

const browser = await chromium.launch();
for (const [src, out, title] of jobs) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.resolve(src)).href, { waitUntil: 'networkidle' });
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      `<div style="width:100%;font-size:7pt;color:#8b90a8;padding:0 16mm;` +
      `font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:space-between;">` +
      `<span>Velozity Business OS — ${title}</span>` +
      `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    margin: { top: '16mm', bottom: '18mm', left: '0', right: '0' },
  });
  await page.close();
  console.log(`  ${out}`);
}
await browser.close();
