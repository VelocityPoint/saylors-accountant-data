// Build tranches.csv from the raw strategy.com/purchases __NEXT_DATA__ dump.
//
// One row per BTC purchase disclosure (107 rows). Funding source and raise
// proceeds are mostly TBD and will be filled in as we read each 8-K; a
// handful of rows are seeded with values already verified against the
// underlying filing.
//
// Usage: node data/saylors-accountant/scripts/build-tranches.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Lazy-loaded inventory of files actually present in filings/8-K/, keyed
// by date prefix (yyyy-mm-dd) → array of full filenames sharing that date.
// Multiple files can share a date (e.g. a regular weekly tranche AND a
// special 8-K announcing an ATM expansion both filed the same day), so the
// map values are arrays not single filenames (Codex P2 caught the
// single-value version pointing rows at the wrong file when dates collide).
let _filingsByDate = null;
function filingsByDate() {
  if (_filingsByDate) return _filingsByDate;
  const dir = fileURLToPath(new URL('../filings/8-K/', import.meta.url));
  const map = new Map();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.match(/\.(pdf|htm)$/i)) continue;
      // First 10 chars are the yyyy-mm-dd date prefix our naming convention
      // mandates. Files without that prefix are ignored.
      const date = f.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!map.has(date)) map.set(date, []);
      map.get(date).push(f);
    }
  }
  _filingsByDate = map;
  return map;
}

function resolveFilingLocal(date, derivedName) {
  const candidates = filingsByDate().get(date) ?? [];
  if (candidates.length === 0) {
    // No on-disk match → fall back to the strategy.com-derived name
    // (download-8ks.mjs will create it on the next run).
    return derivedName ? `filings/8-K/${date}_${derivedName}` : '';
  }
  if (candidates.length === 1) {
    // Unambiguous — single file for this date prefix.
    return `filings/8-K/${candidates[0]}`;
  }
  // Multiple files share this date. Prefer an exact derived-basename match
  // (e.g. row's strategy.com filename matches one of the candidates).
  // Without this disambiguation, picking the alphabetically-first file
  // could send a row to the wrong 8-K (e.g. the special-event one instead
  // of the weekly tranche), and download-8ks would skip the intended
  // download because a file already exists at the chosen path.
  if (derivedName) {
    const expected = `${date}_${derivedName}`;
    if (candidates.includes(expected)) {
      return `filings/8-K/${expected}`;
    }
  }
  // Fallback: prefer .pdf over .htm (older filings were PDF-only; HTM-only
  // is the new EDGAR iXBRL pattern). Stable secondary sort by filename so
  // the choice is deterministic.
  const sorted = [...candidates].sort((a, b) => {
    const aPdf = a.endsWith('.pdf') ? 0 : 1;
    const bPdf = b.endsWith('.pdf') ? 0 : 1;
    if (aPdf !== bPdf) return aPdf - bPdf;
    return a.localeCompare(b);
  });
  return `filings/8-K/${sorted[0]}`;
}

const raw = JSON.parse(
  readFileSync(new URL('../raw/strategy-purchases.json', import.meta.url), 'utf8'),
);
const rows = raw.props.pageProps.bitcoinData;

// Per-row raise data auto-extracted from 8-K PDFs (see
// scripts/parse-8ks.mjs). Optional — falls back to TBD for rows 42+ if the
// file is absent.
const extractedPath = new URL('../raw/raises-extracted.json', import.meta.url);
const EXTRACTED = existsSync(extractedPath)
  ? Object.fromEntries(
      JSON.parse(readFileSync(extractedPath, 'utf8')).map((r) => [r.row_index, r]),
    )
  : {};

// Values verified by reading the underlying 8-K in full. Everything else
// stays TBD. usd_spent and btc_acquired come from strategy.com; we only
// seed fields that are NOT on strategy.com (raise proceeds, funding mix,
// shares issued, etc.) or where our read confirmed an exact-precision
// number the scraped page rounded.
const SEEDED = {
  // 2020-08-10: first purchase, cash + simultaneous $250M buyback
  1: {
    funding_source: 'Cash',
    raise_net_proceeds_usd: 0,
    raise_shares_issued: 0,
    raise_debt_principal_usd: 0,
    raise_instrument: 'Cash on hand (with simultaneous $250M buyback)',
    notes: 'Out of scope per SPEC §2.2; retained for context.',
  },
  // 2024-11-11: ATM common, Aug+Oct 2024 Sales Agreements
  42: {
    funding_source: 'AtmCommon',
    raise_net_proceeds_usd: 2030000000,  // ~$2.03B per 8-K
    raise_shares_issued: 7854647,
    raise_debt_principal_usd: 0,
    raise_instrument: 'Aug 2024 + Oct 2024 Sales Agreements',
    notes: '',
  },
  // 2024-11-25: MIXED — 2029 Convertibles closed 2024-11-21 ($2.97B net)
  // + ATM under Oct 30 2024 Sales Agreement ($2.46B net from 5,597,849 sh)
  44: {
    funding_source: 'Mixed-AtmCommon+Convert2029',
    raise_net_proceeds_usd: 5430000000,  // $2.97B + $2.46B
    raise_shares_issued: 5597849,
    raise_debt_principal_usd: 3000000000,  // $3.0B upsized principal
    raise_instrument: '2029 0% Convertible Notes ($3.0B, $2.97B net) + Oct 30 2024 Sales Agreement ($2.46B net)',
    notes: 'Convert closed 2024-11-21; ATM window 2024-11-18 through 2024-11-24.',
  },
  // 2026-04-20: ATM only — STRC $2,176.3M + MSTR $366.0M = $2,542.3M
  107: {
    funding_source: 'Mixed-AtmCommon+AtmStrc',
    raise_net_proceeds_usd: 2542300000,
    raise_shares_issued: 2165000,  // MSTR shares only; STRC shares noted separately
    raise_debt_principal_usd: 0,
    raise_instrument: 'STRC ATM (21,795,389 sh, $2,176.3M net) + MSTR ATM (2,165,000 sh, $366.0M net)',
    notes: 'First fully-structured ATM-table 8-K format; see PDF for per-security breakdown.',
  },
  // 2025-07-29: STRC IPO closing 8-K, not a weekly ATM update. The regular
  // parser can't classify this one because the footnote-phrase extractor
  // doesn't fire on IPO prospectuses.
  73: {
    funding_source: 'STRCIpo',
    raise_net_proceeds_usd: 2473800000,
    raise_shares_issued: 0,  // MSTR shares only; STRC shares (28,011,111) noted separately
    raise_debt_principal_usd: 0,
    raise_instrument: 'STRC IPO (28,011,111 sh, $2,473.8M net)',
    notes: 'Per preferred-ipos.csv. $100/sh public offering price; $2.521B gross → $2,473.8M net.',
  },
  // 2025-11-17: STRE IPO proceeds ($707.1M net) + STRK/STRF/STRC ATMs. The
  // IPO closed 2025-11-13; this weekly 8-K deploys a mix. Parser sees the
  // STREIpo flag but can't extract the per-ATM breakdown from the table.
  // Raise = BTC spend is the closed-loop proxy (both ~$836M).
  87: {
    funding_source: 'Mixed-AtmStrk+AtmStrf+AtmStrc+STREIpo',
    raise_net_proceeds_usd: 836000000,
    raise_shares_issued: 0,
    raise_debt_principal_usd: 0,
    raise_instrument: 'STRE IPO portion + STRK/STRF/STRC ATMs (closed-loop proxy: raise ≈ BTC spend)',
    notes: 'STRE IPO net $707.1M closed 2025-11-13; this 8-K mixes IPO residual + ATMs.',
  },
  // 2025-12-31: 3-BTC stub purchase reported in the same 2026-01-05-filed 8-K
  // as row 93 (the 1,283-BTC main purchase). Both rows' primary_filing_local
  // resolves to byte-identical PDFs (form-8-k_01-05-2026.pdf), so parse-8ks
  // extracts the SAME $116.3M Total for both — double-counting the same
  // disclosure event (Codex P1 on PR #262). Override here with the closed-
  // loop proxy so the small stub doesn't carry the full ATM Total.
  92: {
    funding_source: 'AtmCommon',
    // strategy.com posts 280,000 (rounded $0.3M aggregate) but the 8-K
    // L1-audit value is btc × avg_price = 3 × $88,210.02 = $264,630.
    // Override usd_spent so the L1 ledger doesn't flag a 5.49% variance.
    usd_spent: 264630,
    raise_net_proceeds_usd: 264630,
    raise_shares_issued: 0,
    raise_debt_principal_usd: 0,
    raise_instrument: 'Closed-loop proxy: 3-BTC stub purchase reported alongside row 93 in same 8-K',
    notes: '8-K displays $0.3M aggregate (rounded to nearest $100K); CSV stores precise btc × avg_price = 3 × $88,210.02 = $264,630 per L1 audit. Same 8-K as row 93; raise pinned to closed-loop proxy.',
  },
  // 2026-04-27 weekly tranche — first EDGAR iXBRL HTM 8-K format.
  // pdftotext-shaped parser can't handle iXBRL, so parse-8ks skips this
  // row via HTM_SEEDED_ALLOWLIST. SEED here so build-tranches doesn't
  // regenerate it as funding_source=TBD (silent regression risk flagged
  // by Codex P1 + Copilot on PR #261). Data hand-transcribed from the
  // 8-K in PR #223; matches the ATM Update table verbatim.
  108: {
    funding_source: 'AtmCommon',
    raise_net_proceeds_usd: 255000000,
    raise_shares_issued: 1451601,
    raise_debt_principal_usd: 0,
    raise_instrument: 'MSTR ATM (1,451,601 sh, $255.0M net)',
    notes: 'EDGAR iXBRL-HTM 8-K format (no companion strategy.com IR PDF). Share counts derived as prior + ATM-issued. KPI fields not in this 8-K format; see strategy.com/purchases dashboard.',
  },
};

// Rows 1-41 pre-date the BTC-yield-reporting era and are out of scope per
// SPEC §2.2 (debt / converts / pre-ATM cash). Mark them so we don't treat
// TBD as "not yet classified" for this era.
// Hand-seeded values (SEEDED) take precedence over auto-extracted values
// (EXTRACTED) so a human-verified override never gets overwritten.
function mergedField(rowIndex, field) {
  if (SEEDED[rowIndex]?.[field] !== undefined) return SEEDED[rowIndex][field];
  if (EXTRACTED[rowIndex]?.[field] !== undefined && EXTRACTED[rowIndex][field] !== null) {
    return EXTRACTED[rowIndex][field];
  }
  return undefined;
}

function eraFundingHint(rowIndex) {
  const merged = mergedField(rowIndex, 'funding_source');
  if (merged) return merged;
  if (rowIndex <= 41) return 'PreAtm';  // out of scope, not ATM-era
  return 'TBD';
}

function seeded(rowIndex, field) {
  return mergedField(rowIndex, field) ?? '';
}

const HEADERS = [
  'strategy_row_index',
  'id',
  'security',
  'type',
  'date_of_purchase',
  'primary_filing_url',
  'primary_filing_local',
  // BTC side (from strategy.com)
  'btc_acquired',
  'usd_spent',
  'avg_btc_price_usd',
  'btc_holdings_after',
  'avg_price_lifetime_after',
  'basic_shares_outstanding',
  'diluted_shares_outstanding',
  'btc_nav_strategy',
  'btc_yield_qtd',
  'btc_yield_ytd',
  'btc_gain_qtd',
  'btc_gain_ytd',
  // Raise side (from 8-K; TBD until filing is read)
  'funding_source',
  'raise_net_proceeds_usd',
  'raise_shares_issued',
  'raise_debt_principal_usd',
  'raise_vs_btc_delta_usd',       // derived: raise_net_proceeds_usd - usd_spent
  'raise_instrument',
  'notes',
];

function csvCell(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function raiseDelta(rowIndex, btcUsd) {
  const net = mergedField(rowIndex, 'raise_net_proceeds_usd');
  if (net === undefined || net === null || net === '') return '';
  const delta = Number(net) - Number(btcUsd);
  return Number.isFinite(delta) ? delta : '';
}

const out = [HEADERS.join(',')];

for (const [i, r] of rows.entries()) {
  const rowIndex = i + 1;
  const date = r.date_of_purchase;
  const id = `mstr-${date}`;
  const filingUrl = r.sec?.url ?? '';
  const filingName = r.sec?.filename ?? '';
  const filingLocal = resolveFilingLocal(date, filingName);

  out.push([
    rowIndex,
    id,
    'MSTR',
    'Purchase',
    date,
    filingUrl,
    filingLocal,
    r.count,
    // usd_spent: SEEDED override beats strategy.com when strategy.com has a
    // transcription anomaly. Row 92 is the canonical case — strategy.com
    // posted 280,000 for a 3-BTC stub that math-verifies at $264,630
    // (3 × $88,210.02). Without the override, regen would fail the L1 audit
    // at 5.49% variance. SEEDED wins; strategy.com value is the fallback.
    mergedField(rowIndex, 'usd_spent') ?? r.total_purchase_price,
    r.purchase_price,
    r.btc_holdings,
    r.average_price,
    r.basic_shares_outstanding,
    r.assumed_diluted_shares_outstanding,
    r.btc_nav,
    r.btc_yield_qtd,
    r.btc_yield_ytd,
    r.btc_gain_qtd,
    r.btc_gain_ytd,
    eraFundingHint(rowIndex),
    seeded(rowIndex, 'raise_net_proceeds_usd'),
    seeded(rowIndex, 'raise_shares_issued'),
    seeded(rowIndex, 'raise_debt_principal_usd'),
    // Use the effective usd_spent (post-SEEDED-override) for the delta, not
    // the raw strategy.com value — otherwise rows that override usd_spent
    // (row 92) emit a phantom delta against strategy.com's stale value.
    raiseDelta(rowIndex, mergedField(rowIndex, 'usd_spent') ?? r.total_purchase_price),
    seeded(rowIndex, 'raise_instrument'),
    seeded(rowIndex, 'notes'),
  ].map(csvCell).join(','));
}

const outPath = new URL('../tranches.csv', import.meta.url);
writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
console.log(`wrote ${out.length - 1} rows to ${outPath.pathname}`);
