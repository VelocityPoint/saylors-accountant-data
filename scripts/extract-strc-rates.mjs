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
//   - Months between known rate points where Strategy adjusted the rate but
//     filed only a website-rate-card update (no 8-K). For those we
//     interpolate from the bracketing announcements and tag the note as
//     "interpolated — no rate-change 8-K found". The script flags these in
//     stderr so a human can spot-check.
//
// Schema match (`StrcRateHistory.cs`):
//   period_start (yyyy-MM-dd), annual_rate (decimal, e.g. 0.0900), note (str)
//
// Row convention: one row per dividend month from August 2025 (the first
// STRC dividend after the 2025-07-29 IPO) through whichever is later: the
// latest 8-K-effective month, or the current calendar month. The CSV grows
// by one row per month going forward; date helpers below handle leap years
// correctly so the auto-extension is safe past Feb 2028. Each row's
// `period_start` is the date the rate becomes effective for the month,
// matching how the loader's `RateOn(date)` lookup is used:
//   - Row 1 → period_start = 2025-07-29 (IPO declaration date, covers Aug)
//   - Rows 2-N → period_start = end-of-prior-month (e.g. 2025-08-31 for
//     September's rate). This matches the seeded-PLACEHOLDER cadence and
//     keeps the loader's at-or-before semantics intact.
//
// The script is idempotent and strict-exit:
//   - exits non-zero if (a) any expected month is missing, (b) any rate is
//     not a multiple of 0.0025 (sanity: Strategy moves the rate in 25bp
//     increments per the S-1 max-decrease rule and observed practice), or
//     (c) the IPO 8-K can't be parsed.
//
// Usage: node data/saylors-accountant/scripts/extract-strc-rates.mjs

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILINGS_DIR = fileURLToPath(new URL('../filings/8-K/', import.meta.url));
const OUT_CSV = fileURLToPath(new URL('../strc-rate-history.csv', import.meta.url));

// Calendar months we expect to cover. STRC IPO'd 2025-07-29 → first
// dividend month is August 2025. We extend through one month past the
// latest 8-K-effective date so the table always has a "current month"
// row, even if a rate-change 8-K hasn't dropped for it yet.
const FIRST_DIV_MONTH = '2025-08'; // August 2025

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

function lastDayOfPriorMonth(yyyymm) {
  // "2025-09" → "2025-08-31" (last day of August). Used to pick the
  // period_start for September's rate: announcement-grade date that's
  // the end of the prior month.
  //
  // Uses the JS Date trick: day 0 of month N is the last day of month N-1.
  // Handles leap years correctly (Feb 2028 → 29 days). The prior hardcoded
  // 28-day February broke for any year with Feb 29 once the script's end
  // month started auto-extending forward via the dynamic floor (#250 PR;
  // Copilot caught the leap-year regression on review).
  const prev = prevMonth(yyyymm);
  const [y, m] = prev.split('-').map(Number);
  // new Date(year, monthIndex, 0) returns the last day of the prior month
  // (monthIndex is 0-based, so passing 1-based m here gives us "day 0 of
  // month m+1" = last day of month m). UTC to avoid local-timezone drift.
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(days).padStart(2, '0')}`;
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

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(FILINGS_DIR)) {
    console.error(`extract-strc-rates: no 8-K filings dir at ${FILINGS_DIR}`);
    process.exit(2);
  }

  const txtFiles = readdirSync(FILINGS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort();

  if (txtFiles.length === 0) {
    console.error('extract-strc-rates: no .txt files found. Run pdftotext-8ks.mjs first.');
    process.exit(2);
  }

  // ── Find IPO 8-K and rate-change 8-Ks ──
  let ipo = null;
  const announcements = [];

  for (const f of txtFiles) {
    const path = FILINGS_DIR + f;
    const text = readFileSync(path, 'utf8');
    if (!text.includes('STRC')) continue;

    if (f.startsWith('2025-07-29_') && !ipo) {
      ipo = parseIpo(f, text);
    }
    const adj = parseAdjustment(f, text);
    if (adj) announcements.push(adj);
  }

  if (!ipo) {
    console.error('extract-strc-rates: failed to parse IPO 8-K (2025-07-29). Aborting.');
    process.exit(1);
  }

  announcements.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  console.log(`extract-strc-rates: found IPO rate ${(ipo.initialRate * 100).toFixed(2)}% from ${ipo.sourceFile}`);
  for (const a of announcements) {
    console.log(`  rate-change 8-K ${a.sourceFile}: ${(a.oldRate * 100).toFixed(2)}% → ${(a.newRate * 100).toFixed(2)}% effective ${a.effectiveDate}`);
  }

  // ── Determine end month ──
  // Extend the table out to whichever is later: the latest announcement's
  // effective month, or the current calendar month. The current-month
  // floor ensures the "current month" row always exists in the CSV even
  // before that month's rate-change 8-K is filed (the page's RateOn(date)
  // lookup would otherwise fall off the end of the table).
  //
  // Used to be hardcoded '2026-05' (#250 sub-item 3) — that worked when
  // the script first shipped in early 2026 but doesn't auto-extend, so
  // the floor stops doing useful work as soon as the calendar advances
  // past it. Replaced with a clock-derived current-month value so the
  // floor moves forward each month without touching this script.
  let endMonth = FIRST_DIV_MONTH;
  for (const a of announcements) {
    if (a.effectiveMonth > endMonth) endMonth = a.effectiveMonth;
  }
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (endMonth < currentMonth) endMonth = currentMonth;

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
  //   - Subsequent months → use the last day of the prior calendar month
  //     (the announcement-date pattern Strategy follows: rate-change 8-Ks
  //     are filed the day before the new monthly period commences).
  const rows = [];
  for (const month of months) {
    const entry = ratesByMonth.get(month);
    const periodStart = month === FIRST_DIV_MONTH ? '2025-07-29' : lastDayOfPriorMonth(month);
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
  const interpolated = months.filter((m) => ratesByMonth.get(m).source === 'interpolated');
  console.log(`\nWrote ${rows.length} monthly rows to ${OUT_CSV}`);
  for (const m of months) {
    const entry = ratesByMonth.get(m);
    console.log(`  ${m}: ${(entry.rate * 100).toFixed(2)}% [${entry.source}]`);
  }
  if (interpolated.length > 0) {
    console.error(`\nInterpolated months (no rate-change 8-K found, prior rate carried forward):`);
    for (const m of interpolated) {
      const entry = ratesByMonth.get(m);
      console.error(`  ${m}: ${(entry.rate * 100).toFixed(2)}%`);
    }
    console.error(`\nNote: where two adjacent known rates differ by more than 25 bp,`);
    console.error(`the carry-forward strategy produces a single large step at the next`);
    console.error(`announced rate. Strategy moves the rate in 25 bp increments per the`);
    console.error(`S-1 max-decrease formula and observed practice; the actual monthly`);
    console.error(`trajectory between bracketing announcements is not knowable from 8-Ks`);
    console.error(`alone (intermediate adjustments may have been pushed only via the`);
    console.error(`strategy.com/strc rate card). Spot-check against external sources`);
    console.error(`if you need monthly fidelity for the interpolated rows.`);
  }
}

function csvQuote(s) {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main();
