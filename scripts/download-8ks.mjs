// Batch-download 8-K PDFs referenced in tranches.csv.
//
// Reads primary_filing_url + primary_filing_local from tranches.csv, skips
// rows that already have a local file, and downloads the rest to
// filings/8-K/. Re-runnable; only fetches what's missing.
//
// Usage: node data/saylors-accountant/scripts/download-8ks.mjs [--only=TBD|all]
// Default: --only=TBD (only downloads rows whose funding_source is TBD).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('..', import.meta.url));
const TRANCHES_CSV = new URL('../tranches.csv', import.meta.url);

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
}

function parseRow(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else {
      if (ch === ',') { cells.push(cur); cur = ''; }
      else if (ch === '"') quoted = true;
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k.replace(/^--/, ''), v ?? true];
  }),
);
const mode = args.only ?? 'TBD';

const rows = parseCsv(readFileSync(TRANCHES_CSV, 'utf8'));
const targets = rows.filter((r) => {
  if (!r.primary_filing_url || !r.primary_filing_local) return false;
  if (mode === 'all') return true;
  return r.funding_source === 'TBD';
});

console.log(`${rows.length} rows total; ${targets.length} selected (mode=${mode})`);

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const r of targets) {
  // path.join handles both Windows and POSIX separators correctly. The
  // earlier `replace(/\//g, '\\')` was Windows-only and produced literal
  // backslashes in filenames on Linux runners.
  const localPath = join(DATA_DIR, r.primary_filing_local);
  if (existsSync(localPath)) {
    skipped++;
    continue;
  }
  mkdirSync(dirname(localPath), { recursive: true });
  try {
    const res = await fetch(r.primary_filing_url, {
      headers: { 'User-Agent': 'SaylorsAccountant/0.1 (dave.lawler@velocity-point.com)' },
    });
    if (!res.ok) {
      console.error(`row ${r.strategy_row_index} ${r.date_of_purchase}: HTTP ${res.status}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(localPath, buf);
    console.log(`row ${r.strategy_row_index} ${r.date_of_purchase}: ${buf.length} bytes → ${r.primary_filing_local}`);
    downloaded++;
  } catch (err) {
    console.error(`row ${r.strategy_row_index} ${r.date_of_purchase}: ${err.message}`);
    failed++;
  }
}

console.log(`\ndone. downloaded=${downloaded}, skipped=${skipped}, failed=${failed}`);

// Strict by default: any download failure exits non-zero so a CI workflow
// surfaces the problem instead of silently continuing with an incomplete
// PDF set. Pass `--allow-failures` to keep the legacy best-effort behavior
// for ad-hoc local runs.
if (failed > 0 && !args['allow-failures']) {
  console.error(`download-8ks: ${failed} failure(s); exiting non-zero. Pass --allow-failures to override.`);
  process.exit(1);
}
