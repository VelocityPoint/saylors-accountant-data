// Extract cash balance and cash-flow lines from a 10-K or 10-Q HTML filing.
//
// SEC filings wrap every cell in nested spans for iXBRL, so naive regex
// matching breaks. Strip tags first, collapse whitespace, then search.
//
// Usage:
//   node data/saylors-accountant/scripts/extract-financials.mjs <path-to-htm>

import { readFileSync, writeFileSync } from 'node:fs';

const inPath = process.argv[2];
if (!inPath) {
  console.error('usage: extract-financials.mjs <path>');
  process.exit(1);
}

const html = readFileSync(inPath, 'utf8');

const text = html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Write cleaned text to a sibling file so we can re-read it easily
const cleanPath = inPath.replace(/\.htm$/, '.clean.txt');
writeFileSync(cleanPath, text);
console.log(`wrote ${text.length} chars of clean text to ${cleanPath}`);

function locate(needle, windowBefore = 100, windowAfter = 1500) {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return null;
  return {
    index: idx,
    excerpt: text.slice(Math.max(0, idx - windowBefore), idx + windowAfter),
  };
}

console.log('\n=== search probes ===');
for (const probe of [
  'CONSOLIDATED BALANCE SHEETS',
  'Total current assets',
  'Cash and cash equivalents',
  'CONSOLIDATED STATEMENTS OF CASH FLOWS',
  'Net cash provided by',
  'Purchases of bitcoin',
  'Proceeds from issuance of long-term debt',
]) {
  const hit = locate(probe, 50, 300);
  console.log(`\n--- ${probe} ---`);
  console.log(hit ? `@${hit.index}: ...${hit.excerpt.slice(0, 400)}...` : '(not found)');
}
