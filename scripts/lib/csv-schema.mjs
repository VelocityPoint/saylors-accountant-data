// Tiny CSV-against-JSON-schema validator used by the SA pipeline.
//
// Zero deps (no ajv) so the cron environment doesn't need a node_modules.
// Scope is intentionally narrow: header presence + per-cell x-csvType +
// optional `enum` / `pattern` / `minimum` checks. That's exactly the
// surface that bit us in PR #190 — a column gets renamed, reordered, or
// silently dropped and the C# side reads the wrong cell. Anything richer
// than that (nested objects, anyOf, $ref) is out of scope; if the schema
// grows that complex, swap this for ajv and add a package.json.
//
// Usage:
//   import { loadSchema, validateRows } from './lib/csv-schema.mjs';
//   const schema = loadSchema('tranche');
//   const report = validateRows(schema, rowsAsRecords);
//   if (!report.ok) {
//     console.error(report.errors.map(formatError).join('\n'));
//     process.exit(1);
//   }
//
// Header order is enforced against `x-csvColumns` when present, since the
// SA emitter writes a fixed header line and downstream consumers (and
// human reviewers diffing the CSV) depend on stable ordering. Pure
// presence-only validation would let a column reorder slip through.

import { readFileSync } from 'node:fs';

const SCHEMA_DIR = new URL('../../../schemas/', import.meta.url);

export function loadSchema(name) {
  const url = new URL(`${name}.schema.json`, SCHEMA_DIR);
  return JSON.parse(readFileSync(url, 'utf8'));
}

export function validateHeader(schema, header) {
  const errors = [];
  const expected = schema['x-csvColumns'];
  if (!Array.isArray(expected)) {
    errors.push({
      kind: 'schema-config',
      message: `schema ${schema.$id ?? schema.title}: missing x-csvColumns array`,
    });
    return { ok: false, errors };
  }
  if (header.length !== expected.length) {
    errors.push({
      kind: 'header-length',
      message: `header has ${header.length} columns, schema expects ${expected.length}`,
      expected,
      actual: header,
    });
  }
  for (let i = 0; i < Math.max(header.length, expected.length); i++) {
    if (header[i] !== expected[i]) {
      errors.push({
        kind: 'header-mismatch',
        column: i,
        expected: expected[i] ?? '(none)',
        actual: header[i] ?? '(none)',
        message: `column ${i}: expected '${expected[i] ?? '(none)'}', got '${header[i] ?? '(none)'}'`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const INT_RE = /^-?\d+$/;

function checkCell(propSchema, columnName, raw, rowIndex) {
  const errors = [];
  const csvType = propSchema?.['x-csvType'];
  const value = raw ?? '';

  // Empty-cell semantics: "nullable-*" allow blank; required string fields
  // do not (caller decides what's required via the schema's `required`).
  if (value === '') {
    if (csvType && csvType.startsWith('nullable-')) return errors;
    // Bare string types accept empty unless caller marks as required at
    // the row level (handled by the required-keys pass).
    return errors;
  }

  // Sentinel values declared per-column allow a numeric column to also
  // carry a documented non-numeric placeholder. parse-8ks.mjs emits
  // 'UNKNOWN_PRINCIPAL' in raise_debt_principal_usd when the 8-K narrative
  // mentions a convertible-notes offering but the table-extractor couldn't
  // pin down the principal. We allow the sentinel here; the C# side reads
  // these columns with TryParse and falls back to 0, so the existing
  // downstream behavior is unchanged.
  const sentinels = propSchema?.['x-csvSentinels'];
  if (Array.isArray(sentinels) && sentinels.includes(value)) {
    return errors;
  }

  switch (csvType) {
    case 'number':
    case 'nullable-number':
      if (!NUMBER_RE.test(value)) {
        errors.push({
          kind: 'cell-type',
          row: rowIndex,
          column: columnName,
          expected: 'number',
          actual: value,
          message: `row ${rowIndex} column '${columnName}': expected number, got '${value}'`,
        });
      }
      break;
    case 'integer':
    case 'nullable-integer':
      if (!INT_RE.test(value)) {
        errors.push({
          kind: 'cell-type',
          row: rowIndex,
          column: columnName,
          expected: 'integer',
          actual: value,
          message: `row ${rowIndex} column '${columnName}': expected integer, got '${value}'`,
        });
      }
      break;
    default:
      // No x-csvType ⇒ string; only check declared pattern / enum below.
      break;
  }

  if (Array.isArray(propSchema?.enum) && !propSchema.enum.includes(value)) {
    errors.push({
      kind: 'cell-enum',
      row: rowIndex,
      column: columnName,
      expected: propSchema.enum,
      actual: value,
      message: `row ${rowIndex} column '${columnName}': '${value}' not in [${propSchema.enum.join(', ')}]`,
    });
  }
  if (typeof propSchema?.pattern === 'string') {
    const re = new RegExp(propSchema.pattern);
    if (!re.test(value)) {
      errors.push({
        kind: 'cell-pattern',
        row: rowIndex,
        column: columnName,
        expected: propSchema.pattern,
        actual: value,
        message: `row ${rowIndex} column '${columnName}': '${value}' fails pattern /${propSchema.pattern}/`,
      });
    }
  }
  if (typeof propSchema?.minimum === 'number') {
    const n = Number(value);
    if (Number.isFinite(n) && n < propSchema.minimum) {
      errors.push({
        kind: 'cell-minimum',
        row: rowIndex,
        column: columnName,
        expected: `>= ${propSchema.minimum}`,
        actual: value,
        message: `row ${rowIndex} column '${columnName}': ${value} < minimum ${propSchema.minimum}`,
      });
    }
  }
  return errors;
}

/**
 * Validate an array of row objects (header→value maps) against the schema.
 * Returns { ok, errors }. Up to maxErrors (default 25) are collected; the
 * 26th forces an early stop so a fully-broken CSV doesn't dump a megabyte
 * of identical errors.
 */
export function validateRows(schema, rows, opts = {}) {
  const maxErrors = opts.maxErrors ?? 25;
  const errors = [];
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const columns = schema['x-csvColumns'] ?? Object.keys(props);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const oneBased = i + 1;

    for (const r of required) {
      const v = row[r];
      if (v === undefined || v === null || v === '') {
        errors.push({
          kind: 'row-required',
          row: oneBased,
          column: r,
          message: `row ${oneBased} column '${r}': required but empty`,
        });
        if (errors.length >= maxErrors) return { ok: false, errors, truncated: true };
      }
    }

    for (const col of columns) {
      const cellErrors = checkCell(props[col], col, row[col], oneBased);
      for (const e of cellErrors) {
        errors.push(e);
        if (errors.length >= maxErrors) return { ok: false, errors, truncated: true };
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a complete CSV emit before writing. Header + body in one pass.
 * Returns { ok, errors }. Stops on header errors; doesn't continue into
 * row validation when the header itself is wrong (the row indices would
 * be meaningless against the actual schema).
 */
export function validateCsv(schema, header, rows) {
  const hd = validateHeader(schema, header);
  if (!hd.ok) return hd;
  return validateRows(schema, rows);
}

export function formatError(e) {
  return e.message;
}
