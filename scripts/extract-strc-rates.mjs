// Harvest STRC (Variable Rate Series A Perpetual Stretch Preferred) monthly
// dividend rates from Strategy's 8-K filings on disk.
//
// The site's per-tranche page reads `data/saylors-accountant/strc-rate-history.csv`
// to compute realized BTC burn at the actual historical coupon. Until this
// script ran, that CSV was a hand-seeded linear ramp tagged "PLACEHOLDER",
// and the page rendered a banner warning. This script replaces those rows
// with real per-month rates extracted from Strategy's 8-Ks.
//
// What we extract:
//   1. The IPO 8-K (2025-07-29) — sets the "initial monthly regular dividend
//      rate per annum is 9.00%" baseline.
//   2. "Adjustment to Dividend Rate" 8-Ks — emit one announcement per filing
//      with form: `Strategy increased/decreased the regular dividend rate
//      per annum on [the STRC Stock | its Variable Rate ... Stretch Preferred
//      Stock] effective for monthly periods commencing on or after <date>
//      from <old>% to <new>%`. The "from <old>%" lets us back-fill the
//      *prior* month's rate without a separate 8-K.
//
// What we *cannot* extract:
//   - Months where Strategy has not published a primary-source STRC rate
//     setting. The committed CSV must stay primary-sourced, so the script
//     stops at the latest sourced month and fails before writing if any
//     interior row would require interpolation.
//
// Schema match (`StrcRateHistory.cs`):
//   period_start (yyyy-MM-dd), annual_rate (decimal, e.g. 0.0900), note (str)
//
// Row convention: one row per dividend month from August 2025 (the first
// STRC dividend after the 2025-07-29 IPO) through the latest primary-sourced
// rate month. The CSV grows only when a source file confirms the month's rate.
// Each row's `period_start` is the date the rate becomes effective for the
// month, matching how the loader's `RateOn(date)` lookup is used:
//   - Row 1 → period_start = 2025-07-29 (IPO declaration date, covers Aug)
//   - Rows 2-N → period_start = FIRST day of the dividend month (e.g.
//     2025-09-01 for September's rate).
//
// Why first-of-month and NOT end-of-prior-month (the prior convention):
// the loader's RateOn(date) is queried with `periodEnd` dates the burn loop
// computes via DateOnly.AddMonths(p). For a tranche purchased on day 29/30/31,
// AddMonths clamps the day into a short month (e.g. 2025-07-29 + 7 months →
// 2026-02-28). With the OLD end-of-prior-month convention the March-rate row
// also sat on 2026-02-28, so the loader's at-or-before (`<=`) tie-break
// returned March's 11.50% for what is really the FEBRUARY dividend period
// (should be 11.25%) — over-stating that period's burn. First-of-month
// anchoring is strictly less than every AddMonths-clamped period_end within
// the same calendar month (those are always ≥ day 1) and strictly greater
// than the prior month's anchor, so the `<=` lookup lands on the correct
// month for ALL day-of-month values, eliminating the clamp-collision class.
// See StrcRateHistory.RateOn and TranchePartSummarizer.Summarize.
//
// The script is idempotent and strict-exit:
//   - exits non-zero if (a) any expected month is missing, (b) any expected
//     month would require an interpolated carry-forward row, (c) any rate is
//     not a multiple of 0.0025 (sanity: Strategy moves the rate in 25bp
//     increments per the S-1 max-decrease rule and observed practice), or
//     (d) the IPO 8-K can't be parsed.
//
// Usage: node data/saylors-accountant/scripts/extract-strc-rates.mjs

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Strip HTML tags so the regex parsers below can operate on plain text from
// iXBRL HTM filings the same way they do on pdftotext .txt output.
// Entity decoding is intentionally omitted — all target patterns (STRC,
// "maintain", "commencing on or after", percentages, month names) are plain
// ASCII with no HTML entities, so decoding adds no value.
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

const FILINGS_DIR = fileURLToPath(new URL('../filings/8-K/', import.meta.url));
const OUT_CSV = fileURLToPath(new URL('../strc-rate-history.csv', import.meta.url));

// Calendar months we expect to cover. STRC IPO'd 2025-07-29 -> first
// dividend month is August 2025. We extend through the latest month backed by
// a rate-change 8-K, maintenance-confirmation 8-K, or explicit known primary
// source. Dates beyond the final row naturally use the last known sourced rate
// via StrcRateHistory.RateOn; they do not need an unsourced current-month row.
const FIRST_DIV_MONTH = '2025-08'; // August 2025

// Primary-source rates that are NOT extractable from the 8-K regex patterns
// below, because Strategy announced these particular monthly resets only via
// the strategy.com/strc website rate card (no standalone "Adjustment to
// Dividend Rate" 8-K with "from X% to Y%" prose). They ARE documented in
// other primary filings, so we treat them as known-good and let them override
// the carry-forward interpolation (but NOT a direct rate-change 8-K, which
// stays authoritative if one ever appears for these months).
//
// Sources:
//   2025-09 (10.00%) — Q3-2025 10-Q (filed 2025-09-30) declaration table:
//     "STRC Month ended September 30, 2025 ... 10.00% $0.833333333"; also the
//     rate-progression chart in the 8-K dated 2025-12-01 (9.00 / 10.00 /
//     10.25 / 10.50 / 10.75).
//   2025-10 (10.25%) — Q3-2025 10-Q: "increased the monthly regular dividend
//     rate per annum on STRC Stock from 10.00% to 10.25% effective for monthly
//     periods commencing on or after October 1, 2025"; same 2025-12-01 chart.
// Without these, the carry-forward gap-fill would seed both months at 9.00%,
// under-stating realized STRC burn by ~46 BTC on the IPO tranche. (#466)
const KNOWN_RATES = new Map([
  ['2025-09', { rate: 0.1000, source: 'Q3-2025 10-Q declaration table + 2025-12-01 8-K rate chart' }],
  ['2025-10', { rate: 0.1025, source: 'Q3-2025 10-Q ("from 10.00% to 10.25% ... October 1, 2025") + 2025-12-01 8-K rate chart' }],
]);

// ── Date helpers ────────────────────────────────────────────────────────────

const MONTH_NAMES = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseMonthDate(text) {
  // "December 1, 2025" → "2025-12-01"
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const month = MONTH_NAMES[m[1].toLowerCase()];
  const day = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

function monthOf(isoDate) {
  return isoDate.slice(0, 7); // "yyyy-MM"
}

function nextMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  if (m === 12) return `${y + 1}-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function prevMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

function* monthRange(start, end) {
  let cur = start;
  while (cur <= end) {
    yield cur;
    cur = nextMonth(cur);
  }
}

function firstOfMonth(yyyymm) {
  // "2025-09" → "2025-09-01" (first day of the dividend month). This is the
  // period_start anchor for a month's rate.
  //
  // Replaces the prior `lastDayOfPriorMonth` (end-of-prior-month) anchor,
  // which collided with DateOnly.AddMonths day-clamping in the burn loop and
  // mis-attributed the Feb dividend period to March's rate for day-29+
  // tranches (the `<=` tie-break in StrcRateHistory.RateOn matched the
  // next month's row when AddMonths clamped a day-29/30/31 purchase into a
  // short month). First-of-month is strictly inside the dividend month and
  // strictly before any AddMonths-clamped period_end in that month, so the
  // loader's at-or-before lookup lands on the correct month for every
  // day-of-month value. See the Row-convention block at the top of this file.
  //
  // No leap-year hazard here (day is always 01), but the helper is kept pure
  // string-math for symmetry with monthRange/nextMonth/prevMonth.
  return `${yyyymm}-01`;
}

// ── 8-K parsing ────────────────────────────────────────────────────────────

// Returns { effectiveDate, effectiveMonth, oldRate, newRate, sourceFile }
function parseAdjustment(filename, text) {
  // Pattern: "... commencing on or after <Month Day, Year> from <X>% to <Y>%."
  // pdftotext line-wraps; collapse whitespace before matching.
  const flat = text.replace(/\s+/g, ' ');
  const re = /commencing\s+on\s+or\s+after\s+(\w+\s+\d{1,2},\s*\d{4})\s+from\s+(\d+(?:\.\d+)?)%\s+to\s+(\d+(?:\.\d+)?)%/i;
  const m = flat.match(re);
  if (!m) return null;
  const effectiveDate = parseMonthDate(m[1]);
  if (!effectiveDate) return null;
  return {
    effectiveDate,
    effectiveMonth: monthOf(effectiveDate),
    oldRate: Number(m[2]) / 100,
    newRate: Number(m[3]) / 100,
    sourceFile: filename,
  };
}

// Parses the IPO 8-K's "initial monthly regular dividend rate per annum is X%"
function parseIpo(filename, text) {
  const flat = text.replace(/\s+/g, ' ');
  const m = flat.match(/initial\s+monthly\s+regular\s+dividend\s+rate\s+per\s+annum\s+is\s+(\d+(?:\.\d+)?)%/i);
  if (!m) return null;
  return {
    initialRate: Number(m[1]) / 100,
    sourceFile: filename,
  };
}

// Returns { effectiveDate, effectiveMonth, newRate, sourceFile } for
// "maintain...commencing on or after <date> at <rate>%" 8-Ks.
// Strategy files this format when the rate is held unchanged month-to-month;
// instead of "from X% to Y%", the announcement reads "at Y%" with no prior
// rate cited. Seen first in the 2026-05-01 8-K (iXBRL HTM format).
function parseMaintenance(filename, text) {
  const flat = text.replace(/\s+/g, ' ');
  const re = /maintain\s+the\s+regular\s+dividend\s+rate[^.]*?commencing\s+on\s+or\s+after\s+(\w+\s+\d{1,2},\s*\d{4})\s+at\s+(\d+(?:\.\d+)?)%/i;
  const m = flat.match(re);
  if (!m) return null;
  const effectiveDate = parseMonthDate(m[1]);
  if (!effectiveDate) return null;
  return {
    effectiveDate,
    effectiveMonth: monthOf(effectiveDate),
    newRate: Number(m[2]) / 100,
    sourceFile: filename,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(FILINGS_DIR)) {
    console.error(`extract-strc-rates: no 8-K filings dir at ${FILINGS_DIR}`);
    process.exit(2);
  }

  // Process both pdftotext .txt files AND iXBRL .htm files. HTM filings
  // started appearing in early 2026; pdftotext can't convert them, but their
  // STRC rate announcements are plain prose inside the HTML that stripHtml()
  // can expose for the same regex patterns.
  const allFiles = readdirSync(FILINGS_DIR)
    .filter((f) => f.endsWith('.txt') || f.endsWith('.htm'))
    .sort();

  const txtFiles = allFiles.filter((f) => f.endsWith('.txt'));
  if (txtFiles.length === 0) {
    console.error('extract-strc-rates: no .txt files found. Run pdftotext-8ks.mjs first.');
    process.exit(2);
  }

  // ── Find IPO 8-K and rate-change 8-Ks ──
  let ipo = null;
  const announcements = [];
  const maintenances = [];

  for (const f of allFiles) {
    const raw = readFileSync(FILINGS_DIR + f, 'utf8');
    const text = f.endsWith('.htm') ? stripHtml(raw) : raw;
    if (!text.includes('STRC')) continue;

    if (f.startsWith('2025-07-29_') && !ipo) {
      ipo = parseIpo(f, text);
    }
    const adj = parseAdjustment(f, text);
    if (adj) announcements.push(adj);
    const maint = parseMaintenance(f, text);
    if (maint) maintenances.push(maint);
  }

  if (!ipo) {
    console.error('extract-strc-rates: failed to parse IPO 8-K (2025-07-29). Aborting.');
    process.exit(1);
  }

  announcements.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  maintenances.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  console.log(`extract-strc-rates: found IPO rate ${(ipo.initialRate * 100).toFixed(2)}% from ${ipo.sourceFile}`);
  for (const a of announcements) {
    console.log(`  rate-change 8-K ${a.sourceFile}: ${(a.oldRate * 100).toFixed(2)}% → ${(a.newRate * 100).toFixed(2)}% effective ${a.effectiveDate}`);
  }
  for (const m of maintenances) {
    console.log(`  maintenance 8-K ${m.sourceFile}: ${(m.newRate * 100).toFixed(2)}% maintained effective ${m.effectiveDate}`);
  }

  // ── Determine end month ──
  // Extend only through the latest primary-sourced month. Do not add a
  // clock-derived current-month floor here: if Strategy has not published a
  // source for the current month, writing an interpolated row would trip the
  // committed-data guard and make the historical rate table look sourced when
  // it is not.
  let endMonth = FIRST_DIV_MONTH;
  for (const a of announcements) {
    if (a.effectiveMonth > endMonth) endMonth = a.effectiveMonth;
  }
  for (const m of maintenances) {
    if (m.effectiveMonth > endMonth) endMonth = m.effectiveMonth;
  }
  for (const [month] of KNOWN_RATES) {
    if (month > endMonth) endMonth = month;
  }

  const months = [...monthRange(FIRST_DIV_MONTH, endMonth)];

  // ── Build per-month rate map ──
  //
  // For each dividend month from Aug 2025 to endMonth, decide the rate:
  //   1. If an announcement's effectiveMonth == this month: use newRate.
  //   2. If a future announcement says "from X%" and this is the month
  //      immediately preceding it: use that X% (back-fill).
  //   3. Else: carry forward the previous month's rate (sustain).
  //
  // Source priority: announcement > backref > ipo > interpolated.
  const ratesByMonth = new Map();

  // Seed with IPO rate for the first dividend month.
  ratesByMonth.set(FIRST_DIV_MONTH, {
    rate: ipo.initialRate,
    source: 'ipo',
    note: `Initial rate per IPO 8-K dated ${ipo.sourceFile.slice(0, 10)} ("initial monthly regular dividend rate per annum is ${(ipo.initialRate * 100).toFixed(2)}%").`,
  });

  // Direct hits + back-refs from rate-change 8-Ks.
  for (const a of announcements) {
    ratesByMonth.set(a.effectiveMonth, {
      rate: a.newRate,
      source: 'announcement',
      note: `Rate increased from ${(a.oldRate * 100).toFixed(2)}% to ${(a.newRate * 100).toFixed(2)}% effective ${a.effectiveDate} per 8-K dated ${a.sourceFile.slice(0, 10)}.`,
    });
    const prior = prevMonth(a.effectiveMonth);
    if (prior >= FIRST_DIV_MONTH) {
      const existing = ratesByMonth.get(prior);
      if (!existing || (existing.source !== 'announcement' && existing.source !== 'backref')) {
        ratesByMonth.set(prior, {
          rate: a.oldRate,
          source: 'backref',
          note: `Rate of ${(a.oldRate * 100).toFixed(2)}% back-derived from "from ${(a.oldRate * 100).toFixed(2)}%" reference in 8-K dated ${a.sourceFile.slice(0, 10)}.`,
        });
      }
    }
  }

  // Maintenance confirmations — "maintain...at X%" 8-Ks. Strategy files
  // these when the rate is held unchanged; there's no "from" rate to cite.
  // Treat the effective month as a confirmed-rate row (source: 'maintenance')
  // and also confirm the prior month via back-ref if it's still interpolated.
  // A rate-change announcement for the same month takes priority.
  for (const m of maintenances) {
    const existing = ratesByMonth.get(m.effectiveMonth);
    if (!existing || existing.source !== 'announcement') {
      ratesByMonth.set(m.effectiveMonth, {
        rate: m.newRate,
        source: 'maintenance',
        note: `Rate of ${(m.newRate * 100).toFixed(2)}% explicitly maintained effective ${m.effectiveDate} onwards per 8-K dated ${m.sourceFile.slice(0, 10)} ("maintain the regular dividend rate per annum ... at ${(m.newRate * 100).toFixed(2)}%").`,
      });
    }
    const prior = prevMonth(m.effectiveMonth);
    if (prior >= FIRST_DIV_MONTH) {
      const existingPrior = ratesByMonth.get(prior);
      if (!existingPrior || existingPrior.source === 'interpolated') {
        ratesByMonth.set(prior, {
          rate: m.newRate,
          source: 'backref',
          note: `Rate of ${(m.newRate * 100).toFixed(2)}% back-derived from maintenance-confirmation "at ${(m.newRate * 100).toFixed(2)}%" reference in 8-K dated ${m.sourceFile.slice(0, 10)}.`,
        });
      }
    }
  }

  // Known rates from non-8-K primary sources (10-Q declaration tables, the
  // 2025-12-01 rate-progression chart). These override carry-forward
  // interpolation but defer to a direct rate-change 8-K (source 'announcement')
  // or a maintenance-confirmation 8-K, both of which are more specific.
  for (const [month, known] of KNOWN_RATES) {
    const existing = ratesByMonth.get(month);
    if (!existing || (existing.source !== 'announcement' && existing.source !== 'maintenance')) {
      ratesByMonth.set(month, {
        rate: known.rate,
        source: 'known-primary-source',
        note: `Rate of ${(known.rate * 100).toFixed(2)}% per primary source: ${known.source}. (No standalone rate-change 8-K; announced via strategy.com/strc rate card.)`,
      });
    }
  }

  // Fill gaps by carrying forward the previous month's rate.
  let prevRate = ipo.initialRate;
  for (const month of months) {
    if (ratesByMonth.has(month)) {
      prevRate = ratesByMonth.get(month).rate;
    } else {
      ratesByMonth.set(month, {
        rate: prevRate,
        source: 'interpolated',
        note: `interpolated — no rate-change 8-K found; carried forward prior month rate of ${(prevRate * 100).toFixed(2)}%.`,
      });
    }
  }

  // ── Sanity checks ──
  let bad = 0;
  for (const month of months) {
    const entry = ratesByMonth.get(month);
    if (!entry) {
      console.error(`extract-strc-rates: missing month ${month}`);
      bad++;
      continue;
    }
    if (entry.source === 'interpolated') {
      console.error(`extract-strc-rates: ${month} would be interpolated; add a primary source or cap the range before writing.`);
      bad++;
    }
    // 25 bp granularity. Strategy moves the rate in 25bp increments per the
    // S-1 max-decrease rule and observed practice (every announcement to
    // date has been a clean +25bp).
    const stepped = Math.round(entry.rate * 10000);
    if (stepped % 25 !== 0) {
      console.error(`extract-strc-rates: ${month} rate ${entry.rate} not a multiple of 0.0025`);
      bad++;
    }
  }
  if (bad > 0) {
    console.error(`extract-strc-rates: ${bad} sanity-check failure(s); aborting before write.`);
    process.exit(1);
  }

  // ── Emit CSV ──
  // period_start convention:
  //   - First dividend month → use the IPO declaration date (2025-07-29)
  //     so RateOn(any date ≥ IPO) returns the initial rate.
  //   - Subsequent months → use the FIRST day of the dividend month
  //     (2025-09-01 for September's rate). This avoids the DateOnly.AddMonths
  //     day-clamp collision the prior end-of-prior-month anchor had with the
  //     loader's `<=` tie-break — see the Row-convention block at the top of
  //     this file and StrcRateHistory.RateOn.
  const rows = [];
  for (const month of months) {
    const entry = ratesByMonth.get(month);
    const periodStart = month === FIRST_DIV_MONTH ? '2025-07-29' : firstOfMonth(month);
    rows.push({
      period_start: periodStart,
      annual_rate: entry.rate.toFixed(4),
      note: entry.note,
    });
  }

  const header = 'period_start,annual_rate,note\n';
  const body = rows
    .map((r) => `${r.period_start},${r.annual_rate},${csvQuote(r.note)}`)
    .join('\n');
  writeFileSync(OUT_CSV, header + body + '\n');

  // ── Report ──
  console.log(`\nWrote ${rows.length} monthly rows to ${OUT_CSV}`);
  for (const m of months) {
    const entry = ratesByMonth.get(m);
    console.log(`  ${m}: ${(entry.rate * 100).toFixed(2)}% [${entry.source}]`);
  }
}

function csvQuote(s) {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main();
