import { readFileSync, writeFileSync } from 'node:fs';

// strategy-purchases.json lives in raw/ (matches inspect-purchases.mjs and
// build-tranches.mjs); the legacy script-relative path is gone.
const data = JSON.parse(readFileSync(new URL('../raw/strategy-purchases.json', import.meta.url), 'utf8'));
const rows = data.props.pageProps.bitcoinData;

const cols = [
  'row_index','date_of_purchase','count','total_purchase_price','purchase_price','average_price',
  'btc_holdings','total_acquisition_cost','basic_shares_outstanding','assumed_diluted_shares_outstanding',
  'btc_nav','btc_yield_qtd','btc_yield_ytd','btc_gain_qtd','btc_gain_ytd',
  'sec_filename','sec_url','title'
];

function esc(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replaceAll('"','""') + '"';
  return s;
}

const out = [cols.join(',')];
for (const r of rows) {
  const rec = {
    ...r,
    sec_filename: r.sec?.filename ?? '',
    sec_url: r.sec?.url ?? '',
  };
  out.push(cols.map(c => esc(rec[c])).join(','));
}
writeFileSync(new URL('../raw/purchases-timeline.csv', import.meta.url), out.join('\n') + '\n');
console.log(`wrote ${rows.length} rows`);
console.log(`first: ${rows[0].date_of_purchase}  last: ${rows[rows.length-1].date_of_purchase}`);
