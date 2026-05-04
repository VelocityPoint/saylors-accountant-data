// Convert all downloaded 8-K PDFs to plain text via pdftotext.
//
// Outputs `<pdf_path>.txt` next to each PDF. Uses pdftotext -layout for
// tables. Re-runnable; skips files whose .txt already exists and is newer
// than the PDF. All .txt files are gitignored (regenerable artifacts).
//
// Usage: node data/saylors-accountant/scripts/pdftotext-8ks.mjs

import { readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EIGHT_K_DIR = fileURLToPath(new URL('../filings/8-K/', import.meta.url));

const pdfs = readdirSync(EIGHT_K_DIR).filter((f) => f.endsWith('.pdf'));
console.log(`${pdfs.length} PDFs found`);

let converted = 0;
let skipped = 0;
let failed = 0;

for (const pdf of pdfs) {
  const pdfPath = EIGHT_K_DIR + pdf;
  const txtPath = pdfPath.replace(/\.pdf$/, '.txt');
  if (existsSync(txtPath) && statSync(txtPath).mtimeMs > statSync(pdfPath).mtimeMs) {
    skipped++;
    continue;
  }
  const result = spawnSync('pdftotext', ['-layout', pdfPath, txtPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`FAILED ${pdf}: ${result.stderr}`);
    failed++;
  } else {
    converted++;
  }
}

console.log(`\ndone. converted=${converted}, skipped=${skipped}, failed=${failed}`);

// Strict by default: any pdftotext failure exits non-zero. Without this,
// downstream parse-8ks.mjs would silently skip the missing .txt file and
// the second build-tranches pass could downgrade real raise data to
// fallback values, opening a "successful" PR with regressed data. Pass
// `--allow-failures` to keep the legacy best-effort behavior for local
// debugging when one PDF is known to be malformed.
const allowFailures = process.argv.includes('--allow-failures');
if (failed > 0 && !allowFailures) {
  console.error(`pdftotext-8ks: ${failed} failure(s); exiting non-zero. Pass --allow-failures to override.`);
  process.exit(1);
}
