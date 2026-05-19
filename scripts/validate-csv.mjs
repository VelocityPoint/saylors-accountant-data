// Standalone CSV validator — runs the JS side of the JS↔C# schema contract
// from issue #237 against an arbitrary CSV file. Used by the CI roundtrip
// job (.github/workflows/data-schema-roundtrip.yml) to assert fixtures
// match their declared schema BEFORE the C# parser tries to read them.
//
// Usage:
//   node data/saylors-accountant/scripts/validate-csv.mjs \
//        --schema tranche \
//        --csv data/fixtures/tranches.sample.csv
//
// Exits 0 on success, non-zero on schema mismatch (with column-level
// diagnostics on stderr).

import { readFileSync } from 'node:fs';
import { loadSchema, validateCsv, formatError } from './lib/csv-schema.mjs';

function parseCsv(text) {
  // RFC 4180-ish parser matching the C# TrancheRepository.ParseRow and the
  // emitter's csvCell. Handles quoted cells, embedded commas, embedded
  // double-quotes (escaped as ""). Stops at \n (the emitter writes LF).
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === ',') {
          cells.push(cur);
          cur = '';
        } else if (ch === '"') {
          quoted = true;
        } else {
          cur += ch;
        }
      }
    }
    cells.push(cur);
    return cells;
  });
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

const schemaName = arg('--schema');
const csvPath = arg('--csv');
if (!schemaName || !csvPath) {
  console.error('usage: validate-csv.mjs --schema <name> --csv <path>');
  process.exit(2);
}

const schema = loadSchema(schemaName);
const rows = parseCsv(readFileSync(csvPath, 'utf8'));
if (rows.length === 0) {
  console.error(`validate-csv: ${csvPath} is empty`);
  process.exit(1);
}

const header = rows[0];
const records = rows.slice(1).map((cells) => {
  const r = {};
  for (let i = 0; i < header.length; i++) r[header[i]] = cells[i] ?? '';
  return r;
});

const report = validateCsv(schema, header, records);
if (report.ok) {
  console.log(`validate-csv: OK — ${records.length} row(s) match ${schemaName}.schema.json`);
  process.exit(0);
}
console.error(`validate-csv: ${report.errors.length} error(s) against ${schemaName}.schema.json`);
for (const e of report.errors) console.error(`  - ${formatError(e)}`);
if (report.truncated) console.error('  (more errors suppressed)');
process.exit(1);
