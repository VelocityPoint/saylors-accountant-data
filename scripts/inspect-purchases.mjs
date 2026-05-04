import { readFileSync, writeFileSync } from 'node:fs';

// strategy-purchases.html lives alongside the other raw inputs in
// data/saylors-accountant/raw/. Older versions of this script read it from
// next to the script itself; that broke when the file canonically moved to
// raw/ (and broke again when the GitHub Actions workflow tried to refresh
// it). Reading + writing both via raw/ keeps everything in one place.
const HTML_PATH = new URL('../raw/strategy-purchases.html', import.meta.url);
const JSON_PATH = new URL('../raw/strategy-purchases.json', import.meta.url);

const html = readFileSync(HTML_PATH, 'utf8');
const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
if (!m) { console.error('NO __NEXT_DATA__'); process.exit(1); }
const data = JSON.parse(m[1]);
writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));

function summarize(o, depth = 0, maxDepth = 4, prefix = '') {
  const pad = '  '.repeat(depth);
  if (depth > maxDepth) return;
  if (Array.isArray(o)) {
    console.log(`${pad}${prefix}[list len=${o.length}]`);
    if (o.length) summarize(o[0], depth + 1, maxDepth, '[0] ');
  } else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') {
        const len = Array.isArray(v) ? v.length : Object.keys(v).length;
        console.log(`${pad}${prefix}${k}: ${Array.isArray(v) ? 'array' : 'object'} (len=${len})`);
        summarize(v, depth + 1, maxDepth);
      } else {
        const s = String(v).slice(0, 80);
        console.log(`${pad}${prefix}${k}: ${s}`);
      }
    }
  }
}
summarize(data, 0, 3);
