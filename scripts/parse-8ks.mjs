// Extract ATM / convert raise data from 8-K text files.
//
// Works across three format eras that show up in Strategy's weekly 8-Ks:
//
//   1. Single-ATM narrative (2024-11 through ~2025-03): prose sentences.
//   2. Transition narrative with multiple ATMs (2025-03-17 through 2025-03-24):
//      still prose but one paragraph per security.
//   3. Structured ATM Program Summary table (2025-04-21 onwards).
//
// We rely on two signals that appear in ALL three eras:
//
//   (a) "The bitcoin purchases were made using proceeds from <X>" footnote.
//       This classifies funding_source without ambiguity.
//   (b) "approximately $<N> (million|billion) in cash" / "Total $<N> million"
//       from the BTC acquisition summary — gives us raise_net_proceeds_usd
//       as long as Strategy is still running the closed-loop model (raises
//       ≈ BTC spend in the same week).
//
// For edge cases (convert-only weeks, preferred-IPO weeks, treasury-buffer
// weeks once the 3-yr buffer policy kicks in), we emit warnings so humans
// can override via the SEEDED map in build-tranches.mjs.
//
// Output: data/saylors-accountant/raw/raises-extracted.json
//
// Usage: node data/saylors-accountant/scripts/parse-8ks.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('..', import.meta.url));
const TRANCHES_CSV = new URL('../tranches.csv', import.meta.url);
const OUT_JSON = new URL('../raw/raises-extracted.json', import.meta.url);

const TICKERS = ['MSTR', 'STRK', 'STRF', 'STRD', 'STRC', 'STRE'];

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

function toUsd(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (/billion/i.test(unit)) return Math.round(n * 1e9);
  if (/million/i.test(unit)) return Math.round(n * 1e6);
  return Math.round(n);
}

// Reported BTC USD spend for the current week — extracted from the
// "BTC Update" section. We use it as a balance-check fallback when the ATM
// table's Total line can't be located reliably (pdftotext sometimes
// scatters the Total value across non-adjacent positions). Returns null
// when no BTC spend can be parsed.
function extractBtcSpent(txt) {
  // The BTC Update section's first line is shaped like
  //   "<BTC count> $ <Aggregate Purchase Price> $ <Avg Price>" — and that
  // first dollar amount IS the period's USD spend on BTC. Splitting on the
  // section header and grabbing the first `$N(.NN) [million|billion]?`
  // hits exactly that field across all 8-K eras the dataset covers.
  const btcSection = txt.split(/BTC\s+Update/i)[1];
  if (!btcSection) return null;
  const m = btcSection.match(
    /\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion)?/i,
  );
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (!Number.isFinite(num)) return null;
  if (unit === 'billion') return num * 1_000_000_000;
  return num * 1_000_000;
}

// Anchor-based per-leg extractor for the ATM Program Summary table.
//
// pdftotext -layout scrambles the multi-column table because the leftmost
// column's multi-line description text wraps in unpredictable ways relative
// to the numeric cells. The legacy regex assumed shares + dollar value
// appeared within one or two adjacent lines — fine for early-2025 tables,
// breaks on the multi-row-description tables that became standard mid-2025
// and again in 2026.
//
// Approach:
//   1. Locate the ATM section: from the "ATM Program Summary" / "ATM Update"
//      header through to the "Total" row or "BTC Update" — that's the
//      bounded region we care about.
//   2. For each ticker, find the share count anchor "<digits> TICKER (Shares|Stock)".
//      The current anchor requires whitespace between the digits and ticker,
//      so it matches rows where those fields remain text-adjacent after
//      pdftotext -layout output, rather than allowing arbitrary intervening text.
//   3. Within that section, extract every dollar amount.
//   4. Categorize by magnitude and the share-count × $100 = notional invariant:
//        - amounts > $1,000.0 are "Available for Issuance" (skip)
//        - amounts ≈ shares × $100 / 1M are notional (skip)
//        - the smallest remaining amount is net proceeds
//      For MSTR (no $100 par), notional column is always "-", so we just take
//      the smallest sub-$1,000 amount that isn't "0".
//   5. Validate Σ legs ≈ Total or usd_spent (within the implementation's
//      tolerances: 2% vs. table Total, 5% vs. usd_spent). If yes, return the
//      leg map. If no, return what we have but flag unbalanced.
//
// Caller can use the balanced flag to decide whether to trust the extraction
// or fall back to the legacy bundled-tranche behavior.
function extractTableLegs(txt) {
  const sectionStart = txt.search(/ATM\s+(Program\s+Summary|Update)/i);
  if (sectionStart < 0) return null;
  // End the section at whichever comes first: the "Total" row, the BTC Update
  // header, or end-of-text. Bounding before "Total" ensures the last ticker's
  // region doesn't sweep up the Total value as its own net proceeds.
  // Search for "Total" within the post-sectionStart slice so an earlier "Total"
  // elsewhere in the doc (e.g. a BTC table that precedes the ATM section)
  // doesn't get returned and then filtered out, leaving us with no upper bound.
  const totalRel = txt.slice(sectionStart).search(/^\s*Total\b/m);
  const candidateEnds = [
    totalRel >= 0 ? sectionStart + totalRel : -1,
    txt.indexOf('BTC Update', sectionStart),
  ].filter((i) => i > sectionStart);
  const sectionEnd = candidateEnds.length > 0 ? Math.min(...candidateEnds) : txt.length;
  const rawSection = txt.slice(sectionStart, sectionEnd);

  // Strip the boilerplate description fragments that contain dollar amounts
  // unrelated to ATM data — they trip up the per-row dollar-amount scanner
  // downstream. The data values we want are in the right-hand table columns;
  // these are all in the left-hand description column.
  //
  //   "Size: $21 billion"          → ATM authorization size, not weekly data
  //   "Established: October ..."   → date, sometimes parses as numeric
  //   "$0.001 par value per share" → securities-law boilerplate
  const section = rawSection
    .replace(/Size:\s*\$\s*[\d,]+(?:\.\d+)?\s*(?:million|billion)?/gi, '')
    .replace(/Established:[^\n]*/gi, '')
    .replace(/\$\s*0\.\d+\s+par\s+value[^\n]*/gi, '');

  // Find each ticker's data-row anchor. The shares-sold value is a digit
  // run separated from the ticker label by whitespace (which spans newlines).
  // We don't require "Shares" or "Stock" to follow immediately — pdftotext's
  // column wrap routinely interleaves dollar values between the ticker and
  // the "Shares" word on a subsequent line.
  //
  // The `\s+` separator (whitespace only) is what filters out description
  // matches like "$21 billion of MSTR Shares" — there's "billion of " (text)
  // between the digits and the ticker, so the anchor doesn't match.
  const legs = {};
  const anchorPositions = [];
  for (const t of TICKERS) {
    const anchor = new RegExp(
      `([\\d]{1,3}(?:,\\d{3})+|\\d{4,})\\s+${t}\\b`,
      'g',
    );
    let m;
    while ((m = anchor.exec(section)) !== null) {
      const shares = Number(m[1].replace(/,/g, ''));
      // Threshold of 10,000: filters out year references ("2,025" from
      // "Established: May 1, 2025") without dropping real low-volume weeks
      // — the smallest observed ATM leg in the dataset sells ~13K shares
      // (e.g. 12,973 STRD on 2025-09-02), so 10K is a safe floor.
      if (!Number.isFinite(shares) || shares < 10_000) continue;
      anchorPositions.push({ ticker: t, idx: m.index, len: m[0].length, shares });
    }
  }
  anchorPositions.sort((a, b) => a.idx - b.idx);
  if (anchorPositions.length === 0) return null;

  for (let i = 0; i < anchorPositions.length; i++) {
    const { ticker, idx, len, shares } = anchorPositions[i];
    if (legs[ticker]) continue; // first occurrence wins

    const nextIdx = anchorPositions[i + 1]?.idx ?? section.length;
    const region = section.slice(idx + len, nextIdx);

    // Dollar amounts with optional "million|billion" suffix and an optional
    // " of " trailing word that marks Available-for-Issuance descriptions
    // (e.g. "$1.53 billion of MSTR Shares"). Net Proceeds and Notional Value
    // values never have "of" after them — they're terminated by whitespace,
    // newline, or another $-amount. All values are normalized to millions:
    // "$1.40 billion" → 1400, "$547.7 million" → 547.7, "$10.4" with no
    // unit (headers carry "(in millions)") → 10.4.
    const dollarMatches = [
      ...region.matchAll(
        /\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion)?\b(\s+of\b)?/gi,
      ),
    ];
    const candidates = dollarMatches
      .filter((m) => !m[3]) // drop "$X (million|billion) of …" — Available column with explicit suffix
      // Drop values written with a thousands-comma (e.g. "$1,783.6" or
      // "$20,386.1") — that's the Available column when the "of TICKER
      // Shares" suffix is split onto another line out of regex reach. Data
      // values (Net, Notional) for any leg are always either "$X.X" with no
      // comma or "$X.XX billion" with a decimal but no thousands-comma.
      .filter((m) => !/^\d{1,3}(?:,\d{3})+/.test(m[1]))
      .map((m) => {
        const num = Number(m[1].replace(/,/g, ''));
        const unit = (m[2] || '').toLowerCase();
        return unit === 'billion' ? num * 1000 : num;
      })
      .filter((n) => Number.isFinite(n) && n >= 0.5); // drop par values like $0.001

    let net = 0;
    if (candidates.length > 0) {
      if (ticker === 'MSTR') {
        // Common has no $100 par. Description-suffix filter has already
        // removed the Available column. What remains is the Net Proceeds
        // (and possibly the Total if section bounding missed it). Take the
        // single value if exactly one, else the largest — Net is typically
        // larger than any stray Notional which doesn't apply to MSTR anyway.
        net = candidates.length === 1 ? candidates[0] : Math.max(...candidates);
      } else {
        // Preferreds: notional ≈ shares × $100 / 1M. Filter it out, take the
        // remaining amount as net. If notional and net are equal (pref at
        // par), filter leaves zero candidates and we fall back to the
        // single value.
        const expectedNotional = (shares * 100) / 1_000_000;
        const notNotional = candidates.filter(
          (n) => Math.abs(n - expectedNotional) > Math.max(0.5, expectedNotional * 0.02),
        );
        net = notNotional.length > 0
          ? Math.min(...notNotional)
          : Math.min(...candidates);
      }
    }

    // Always populate the leg once we found an anchor, even if net = 0
    // (the data row had all-dashes for this ticker that week). This
    // prevents the legacy regex fallback from picking up a description-text
    // dollar amount and treating it as net proceeds — historically the
    // source of the spurious $21B STRD legs that the downstream sanity
    // filter had to discard.
    legs[ticker] = {
      shares,
      net_proceeds_usd: Math.round(net * 1_000_000),
    };
  }

  // Balance check: extracted legs should sum to the in-section Total. The
  // Total line lives just past `sectionEnd` (we deliberately bounded the
  // section before it to prevent Total from being absorbed into the last
  // leg's region), so look it up in `rawSection`. Tolerance is 2% to absorb
  // rounding — table values are quoted to 0.1M and the Total to 0.1M too.
  // Both "$555.5 million" (early-2025) and "$60.2" with no unit (newer
  // tables, "(in millions)" header) shapes are handled.
  const sumNet = Object.values(legs).reduce((s, l) => s + l.net_proceeds_usd, 0);
  let balanced = false;
  let deltaPct = null;
  // Look for the in-table Total line first — that's the tightest invariant.
  // 400 chars after sectionEnd absorbs the column-padding pdftotext applies
  // before the dollar value lands on the same logical line.
  const totalSearch = txt.slice(sectionEnd, sectionEnd + 400);
  const totalMatch = totalSearch.match(
    /Total\b[^\n$]*?\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion)?/i,
  );
  if (totalMatch) {
    const totalNum = Number(totalMatch[1].replace(/,/g, ''));
    const unit = (totalMatch[2] || '').toLowerCase();
    const totalUsd = unit === 'billion'
      ? totalNum * 1_000_000_000
      : totalNum * 1_000_000;
    if (totalUsd > 0) {
      deltaPct = (sumNet - totalUsd) / totalUsd;
      balanced = Math.abs(deltaPct) < 0.02;
      if (balanced) return { legs, balanced, deltaPct };
    }
  }

  // Fallback: validate against BTC USD spend. Strategy's closed-loop pattern
  // has Σ raise ≈ Σ BTC spend in the same week — true through 2025; can
  // drift up to ~5% in early-2026 once the cash-buffer policy kicks in.
  // Looser tolerance (5%) accommodates that drift.
  const btcSpent = extractBtcSpent(txt);
  if (btcSpent && btcSpent > 0) {
    const fallbackDelta = (sumNet - btcSpent) / btcSpent;
    if (Math.abs(fallbackDelta) < 0.05) {
      return { legs, balanced: true, deltaPct: fallbackDelta };
    }
    // If we couldn't validate against Total, fall back to BTC delta as
    // diagnostic info even though we won't trust the legs.
    if (deltaPct === null) deltaPct = fallbackDelta;
  }
  return { legs, balanced, deltaPct };
}

function parseOne(txt, rowIndex) {
  const warnings = [];
  const notes = [];

  // --- Funding source from BTC footnote ----------------------------------
  //
  // The BTC section always ends with a (1) footnote like:
  //   "The bitcoin purchases were made using proceeds from the Common ATM
  //    and STRK ATM."
  // That sentence is our ground truth for funding_source classification.
  // `from\s*` (not `from\s+`) tolerates a typo seen in the 2026-04-06 8-K
  // where the source text reads "proceeds fromthe sale" (no space).
  const footnoteMatch = txt.match(
    /bitcoin purchases?\s+were\s+made\s+using\s+proceeds\s+from\s*([^.]+?)\./i,
  );
  const fundingPhrase = footnoteMatch?.[1]?.trim() ?? '';

  // --- Per-security ATM sentences (narrative era) -----------------------
  //
  // Pattern matches both:
  //   "sold an aggregate of 13,593,865 Shares under the Sales Agreement for
  //    aggregate net proceeds ... of approximately $4.6 billion"
  //   "sold an aggregate of 1,975,000 MSTR Shares under the Common ATM, for
  //    aggregate net proceeds ... of approximately $X million"
  const narrativeMatches = [
    ...txt.matchAll(
      /sold\s+an\s+aggregate\s+of\s+([\d,]+)\s+(?:(MSTR|STRK|STRF|STRD|STRC|STRE)\s+)?Shares?(?:\s+under\s+(?:the|its)\s+(Sales Agreement|Common ATM|STRK ATM|STRF ATM|STRD ATM|STRC ATM|STRE ATM))?[^$]*?for\s+aggregate\s+net\s+proceeds[^$]*?approximately\s+\$([\d.,]+)\s+(million|billion)/gis,
    ),
  ];

  // --- "Did not sell" detection ----------------------------------------
  const didNotSell = /did\s+not\s+sell\s+any\s+shares\s+of\s+(?:class A\s+)?common\s+stock/i.test(txt);

  // --- Table-era "Total" extraction ------------------------------------
  //
  // Matches: "Total                                $555.5 million"
  // We take the LAST Total match in the ATM section (sometimes there's a
  // Total in the BTC table too — not what we want).
  //
  // Two variants seen in the wild:
  //   2025-04 .. 2025-10: "Total   $555.5 million"  (explicit unit)
  //   2025-11+          : "Total   $   50.0"         (unit is in column header)
  // If the Total line omits the unit, we infer "million" from the context —
  // the header row above always says "(in millions)" for ATM totals.
  let tableTotal = null;
  const totalMatchesExplicit = [
    ...txt.matchAll(/^\s*Total\s+[^\n]*?\$\s*([\d,.]+)\s+(million|billion)/gim),
  ];
  if (totalMatchesExplicit.length > 0) {
    const last = totalMatchesExplicit[totalMatchesExplicit.length - 1];
    tableTotal = toUsd(last[1].replace(/,/g, ''), last[2]);
  } else {
    // Fallback: capture "Total <whitespace> $ <whitespace> NNN.N" with no unit.
    // Only trust this when we've seen an "(in millions)" header nearby.
    const totalBare = [
      ...txt.matchAll(/^\s*Total\s+[^\n]*?\$\s*([\d,.]+)\s*$/gim),
    ];
    const hasInMillionsHeader = /\(in millions\)/i.test(txt);
    if (totalBare.length > 0 && hasInMillionsHeader) {
      const last = totalBare[totalBare.length - 1];
      tableTotal = toUsd(last[1].replace(/,/g, ''), 'million');
    }
  }

  // --- Table-era per-security rows -------------------------------------
  //
  // Two extraction paths:
  //   (a) The legacy regex below catches simple cases where shares + a $-with-
  //       unit appear close together. Works for the early table era where
  //       "$N.N million" was always written out.
  //   (b) extractTableLegs() handles the harder cases where pdftotext-layout
  //       scrambles multi-column tables (shares on one line, dollars several
  //       lines away with no "million" suffix). It uses anchor-based scanning
  //       and the share-count × $100 = notional invariant to identify net
  //       proceeds vs. notional vs. available.
  //
  // The new extractor runs first; if its result balances against the Total or
  // usd_spent (Σ legs within tolerance), we trust it and skip the legacy path.
  const perSecurity = {};
  let tableLegsBalanced = false;
  const tableLegs = extractTableLegs(txt);
  if (tableLegs) {
    if (tableLegs.balanced) {
      // Trust the extracted legs only when they sum to the in-section Total
      // line — that's the parser's self-validation. If they don't balance,
      // one or more leg amounts is wrong (description noise leaked in, row
      // alignment got scrambled, etc) and writing them would produce visible
      // garbage. Skip and let the closed-loop proxy fill in.
      for (const [t, leg] of Object.entries(tableLegs.legs)) {
        perSecurity[t] = leg;
      }
      tableLegsBalanced = true;
      // The "extracted N legs" note is added AFTER the sanity-check pass
      // below so the count reflects what actually survives — if the sanity
      // check drops a misassigned leg, the note shouldn't claim it counted.
    } else if (tableLegs.deltaPct !== null) {
      notes.push(`ATM table legs unbalanced (Σ off by ${(tableLegs.deltaPct * 100).toFixed(1)}%); discarded`);
    }
  }
  // Legacy regex fallback — only when the new extractor didn't find any
  // anchors at all (tableLegs === null). When extractTableLegs DID anchor
  // tickers but their values failed the balance check, legacy would just
  // mis-attribute on the same scrambled output, so we'd rather emit nothing
  // and let the closed-loop proxy / sidecar override fill in.
  // Restricted to same-line matches: "<digits> TICKER ... $<amount> <unit>"
  // with no newline between the ticker and the dollar value, useful for the
  // early-2025 narrative-style 8-Ks where each leg is a single sentence.
  if (tableLegs === null) {
    for (const t of TICKERS) {
      const re = new RegExp(
        `([\\d,]+)[ \\t]+${t}[ \\t]*(?:Shares?)?[^\\n$]{0,40}?\\$[ \\t]*([\\d.,]+)[ \\t]+(million|billion)`,
        'gi',
      );
      const m = re.exec(txt);
      if (m) {
        perSecurity[t] = {
          shares: Number(m[1].replace(/,/g, '')),
          net_proceeds_usd: toUsd(m[2].replace(/,/g, ''), m[3]),
        };
      }
    }
  }

  // Per-leg sanity check: drop any leg whose implied $/share is outside the
  // plausible range for its security. Common (MSTR) trades $200-$500 in this
  // dataset; the four perpetual preferreds (STRK/STRF/STRD/STRC/STRE) trade
  // $80-$140; convert/cash legs aren't tracked here. A leg with $/share far
  // outside its band almost certainly came from a misassigned table cell —
  // shipping it to the CSV would surface as visibly-wrong data
  // (e.g. STRD $425M / 12,973 sh = $32,765/share, the prior 2025-09-02 bug).
  // Also drops shares-but-zero-net legs (the extractor's "anchor found but no
  // valid $ candidate" outcome) since those provide no signal and only inflate
  // the leg count in raise_instrument.
  const PER_SHARE_BANDS = {
    MSTR: { min: 50,  max: 1500 },
    STRK: { min: 50,  max: 250 },
    STRF: { min: 50,  max: 250 },
    STRD: { min: 50,  max: 250 },
    STRC: { min: 50,  max: 250 },
    STRE: { min: 50,  max: 250 },
  };
  for (const [t, leg] of Object.entries(perSecurity)) {
    if (!leg.net_proceeds_usd || !leg.shares) {
      delete perSecurity[t];
      continue;
    }
    const perShare = leg.net_proceeds_usd / leg.shares;
    const band = PER_SHARE_BANDS[t];
    if (band && (perShare < band.min || perShare > band.max)) {
      delete perSecurity[t];
      warnings.push(
        `dropped ${t} leg with implausible $${perShare.toFixed(0)}/share ` +
        `(${leg.shares.toLocaleString()} sh, $${(leg.net_proceeds_usd / 1e6).toFixed(1)}M)`,
      );
    }
  }
  // Now that sanity-checking is done, log the surviving leg count and
  // whether the extracted legs *still* balance after potential drops. The
  // "Σ balances" claim was made on the pre-drop set; if the sanity pass
  // removed a leg, Σ may no longer match the in-section Total, so we
  // re-derive the post-drop status here rather than carrying the stale flag.
  if (tableLegsBalanced) {
    const surviving = Object.keys(perSecurity).length;
    const survivingLabel = surviving === 1 ? 'leg' : 'legs';
    if (surviving === 0) {
      notes.push('ATM table balanced but all legs failed per-share sanity check; discarded');
    } else if (surviving === Object.keys(tableLegs.legs).length) {
      // No legs dropped — the original "Σ balances" still holds.
      notes.push(`extracted ${surviving} ${survivingLabel} from ATM table; Σ balances`);
    } else {
      // At least one leg was dropped. Surviving legs are individually
      // correct (per-share band) but their sum is now incomplete.
      const dropped = Object.keys(tableLegs.legs).length - surviving;
      notes.push(
        `extracted ${surviving} ${survivingLabel} from ATM table; ${dropped} dropped on sanity check (Σ now incomplete)`,
      );
    }
  }

  // --- Convertible-notes detection -------------------------------------
  //
  // Pattern in the body: "the Company issued $X billion aggregate principal
  // amount of its N.NN% Convertible Senior Notes due YYYY" — not always in
  // the weekly 8-K (separate closing 8-K for the convert).
  //
  // Weekly 8-Ks more commonly cite it via the funding-footnote "using
  // proceeds from the Convertible Notes Offering" + remaining cash language.
  const convertMatch = txt.match(
    /\$\s*([\d.,]+)\s+(million|billion)\s+(?:aggregate\s+)?principal\s+amount[^.]*?Convertible\s+Senior\s+Notes\s+due\s+(\d{4})/i,
  );
  let convertPrincipal = null;
  let convertYear = null;
  if (convertMatch) {
    convertPrincipal = toUsd(convertMatch[1].replace(/,/g, ''), convertMatch[2]);
    convertYear = convertMatch[3];
  }

  // --- Classify funding_source -----------------------------------------
  //
  // Priority:
  //   1. If footnote mentions Convertible Notes → include Convert
  //   2. If footnote mentions preferred IPO ("STR? Offering") → IPO
  //   3. Otherwise: join ATM programs mentioned
  //
  // Footnote phrasings across eras:
  //   2024-11 .. 2025-03: "Sales Agreement" / "Common ATM"
  //   2025-04 .. 2025-10: "the Common ATM and STRK ATM" / etc.
  //   2025-11+          : "the sale of shares of STRF Stock, STRC Stock,
  //                        STRK Stock and STRD Stock under Strategy's ATM"
  // Handle all three by detecting TICKER before either "ATM" or "Stock".
  const tickersInPhrase = new Set();
  if (/Sales Agreement|Common ATM|MSTR\s+(?:ATM|Stock)/i.test(fundingPhrase)) {
    tickersInPhrase.add('MSTR');
  }
  for (const t of ['STRK', 'STRF', 'STRD', 'STRC', 'STRE']) {
    if (new RegExp(`${t}\\s+(?:ATM|Stock)`, 'i').test(fundingPhrase)) {
      tickersInPhrase.add(t);
    }
  }
  const mentionsConvert = /Convertible\s+Notes\s+Offering/i.test(fundingPhrase);
  const mentionsIpo = /(STRK|STRF|STRD|STRC|STRE)\s+Offering/i.exec(fundingPhrase);
  const mentionsCashOnHand = /excess\s+cash|cash\s+on\s+hand|Company'?s\s+cash/i.test(fundingPhrase);

  let fundingSource;
  const parts = [];
  if (tickersInPhrase.has('MSTR')) parts.push('AtmCommon');
  for (const t of ['STRK', 'STRF', 'STRD', 'STRC', 'STRE']) {
    if (tickersInPhrase.has(t)) parts.push(`Atm${t[0]}${t.slice(1).toLowerCase()}`);
  }
  if (mentionsConvert) parts.push('Convert');
  if (mentionsIpo) parts.push(`${mentionsIpo[1]}Ipo`);
  if (mentionsCashOnHand) parts.push('CashOnHand');

  //
  // Special case: the 2026+ "vague" phrasing "the sale of shares under the
  // ATM" (no per-security tickers) means ATM was used but the footnote
  // doesn't say which. We fall back to per_security table rows if available,
  // and to AtmMixed if not.
  // Either phrasing seen in 2026+ 8-Ks:
  //   "the sale of shares under the ATM"
  //   "the sale of shares under Strategy's ATM"
  const vagueAtmPhrase =
    /sale\s+of\s+shares\s+under\s+(?:the|Strategy'?s)\s+ATM/i.test(fundingPhrase) &&
    parts.length === 0;

  if (parts.length === 0 && !vagueAtmPhrase) {
    fundingSource = 'Unknown';
    warnings.push(`no funding source detected; raw phrase: "${fundingPhrase}"`);
  } else if (vagueAtmPhrase) {
    fundingSource = 'AtmMixed';
    notes.push('footnote says "under the ATM" without per-security attribution; see PDF table');
  } else if (parts.length === 1) {
    fundingSource = parts[0];
  } else {
    fundingSource = `Mixed-${parts.join('+')}`;
  }

  // --- Compute raise_net_proceeds_usd ----------------------------------
  let raiseNetUsd = null;
  if (narrativeMatches.length === 1 && !tableTotal) {
    raiseNetUsd = toUsd(narrativeMatches[0][4].replace(/,/g, ''), narrativeMatches[0][5]);
    notes.push('from narrative sentence (single-ATM era)');
  } else if (narrativeMatches.length > 1 && !tableTotal) {
    raiseNetUsd = narrativeMatches.reduce(
      (sum, m) => sum + (toUsd(m[4].replace(/,/g, ''), m[5]) || 0),
      0,
    );
    notes.push(`sum of ${narrativeMatches.length} narrative sentences`);
  } else if (tableTotal) {
    raiseNetUsd = tableTotal;
    notes.push('from ATM Program Summary "Total" row');
  } else if (didNotSell
      && !Object.keys(perSecurity).length
      && !mentionsConvert
      && !mentionsIpo) {
    // "Did not sell any shares" is only true-zero if the week was ATM-only.
    // If a convert or IPO funded the week, ATM=0 but raise > 0 → leave
    // null so the closed-loop proxy can fill it from usd_spent.
    raiseNetUsd = 0;
    notes.push('zero ATM week per "did not sell"');
  } else {
    warnings.push('could not extract raise_net_proceeds_usd from ATM table');
  }

  // --- raise_shares_issued (MSTR only) ---------------------------------
  let raiseSharesIssued = null;
  const mstrNarrative = narrativeMatches.find(
    (m) => !m[2] || m[2] === 'MSTR',
  );
  if (mstrNarrative) {
    raiseSharesIssued = Number(mstrNarrative[1].replace(/,/g, ''));
  } else if (perSecurity.MSTR) {
    raiseSharesIssued = perSecurity.MSTR.shares;
  } else if (didNotSell) {
    raiseSharesIssued = 0;
  }

  // --- raise_instrument description ------------------------------------
  const instrumentParts = [];
  for (const t of TICKERS) {
    if (perSecurity[t]) {
      instrumentParts.push(
        `${t} ATM (${perSecurity[t].shares.toLocaleString()} sh, $${(perSecurity[t].net_proceeds_usd / 1e6).toFixed(1)}M net)`,
      );
    }
  }
  if (narrativeMatches.length && !instrumentParts.length) {
    for (const m of narrativeMatches) {
      const ticker = m[2] ?? 'MSTR';
      const shares = Number(m[1].replace(/,/g, '')).toLocaleString();
      const net = toUsd(m[4].replace(/,/g, ''), m[5]);
      instrumentParts.push(
        `${ticker} ATM (${shares} sh, $${(net / 1e6).toFixed(1)}M net)`,
      );
    }
  }
  if (mentionsConvert && convertPrincipal) {
    instrumentParts.push(
      `${convertYear} Convertible Notes ($${(convertPrincipal / 1e9).toFixed(2)}B principal)`,
    );
  } else if (mentionsConvert) {
    instrumentParts.push('Convertible Notes Offering');
  }
  if (mentionsIpo) {
    instrumentParts.push(`${mentionsIpo[1]} IPO proceeds`);
  }
  const raiseInstrument = instrumentParts.join(' + ');

  return {
    row_index: rowIndex,
    funding_source: fundingSource,
    funding_phrase: fundingPhrase,
    raise_net_proceeds_usd: raiseNetUsd,
    raise_shares_issued: raiseSharesIssued,
    raise_debt_principal_usd: convertPrincipal ?? (mentionsConvert ? 'UNKNOWN_PRINCIPAL' : 0),
    raise_instrument: raiseInstrument,
    per_security: perSecurity,
    narrative_match_count: narrativeMatches.length,
    used_table_total: tableTotal !== null,
    did_not_sell: didNotSell,
    notes: notes.join('; '),
    warnings,
  };
}

// ----------------------------------------------------------------------

// We process every post-ATM-era row (index 42+) regardless of current
// funding_source in the CSV. The build-tranches step layers SEEDED
// overrides on top, so hand-verified rows won't be clobbered even if the
// parser produces a value for them.
const rows = parseCsv(readFileSync(TRANCHES_CSV, 'utf8'));
const targetRows = rows.filter((r) => Number(r.strategy_row_index) >= 42);

console.log(`parsing ${targetRows.length} post-ATM-era rows...`);

const results = [];
let missingTxt = 0;
for (const r of targetRows) {
  // path.join handles both Windows and POSIX separators correctly. The
  // earlier `replace(/\//g, '\\')` was Windows-only and produced literal
  // backslashes in filenames on Linux runners.
  const txtPath = join(DATA_DIR, r.primary_filing_local.replace(/\.pdf$/, '.txt'));
  let txt;
  try {
    txt = readFileSync(txtPath, 'utf8');
  } catch (err) {
    console.error(`row ${r.strategy_row_index} ${r.date_of_purchase}: missing .txt`);
    missingTxt++;
    continue;
  }
  const parsed = parseOne(txt, Number(r.strategy_row_index));
  parsed.date_of_purchase = r.date_of_purchase;
  parsed.usd_spent_reported = Number(r.usd_spent);
  // Reconcile against reported BTC spend for that week.
  if (parsed.raise_net_proceeds_usd !== null && parsed.usd_spent_reported) {
    parsed.raise_vs_btc_delta_usd =
      parsed.raise_net_proceeds_usd - parsed.usd_spent_reported;
  }
  //
  // Closed-loop proxy: for rows where the 8-K is ATM- or Convert-funded
  // but the table parser couldn't extract a Total, assume
  // raise_net_proceeds ≈ usd_spent. This is the "Strategy matches inflows
  // to BTC purchases in the same week" pattern which holds for every
  // parsed row through 2025 including convert-deployment weeks. IPO-week
  // rows are excluded (proceeds held in escrow / multi-week deployment).
  // Starting earlier in 2026 the 3-year cash buffer policy introduces
  // drift; weeks where raise ≠ BTC spend need individual overrides once
  // we decompose the 10-K financing line per week.
  const closedLoopEligible = parsed.funding_source !== 'Unknown'
    && !/Ipo/.test(parsed.funding_source);
  if (parsed.raise_net_proceeds_usd === null
      && closedLoopEligible
      && parsed.usd_spent_reported > 0) {
    parsed.raise_net_proceeds_usd = parsed.usd_spent_reported;
    parsed.raise_vs_btc_delta_usd = 0;
    parsed.notes = [parsed.notes, 'closed-loop proxy: raise_net_proceeds assumed = usd_spent']
      .filter(Boolean).join('; ');
    parsed.proxy_used = true;
  }
  results.push(parsed);
}

writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');

// Summary report
const withRaise = results.filter((r) => r.raise_net_proceeds_usd !== null).length;
const withWarnings = results.filter((r) => r.warnings.length > 0).length;
const byFunding = {};
for (const r of results) {
  byFunding[r.funding_source] = (byFunding[r.funding_source] ?? 0) + 1;
}

console.log(`\nparsed ${results.length}`);
console.log(`  with raise_net_proceeds_usd: ${withRaise}`);
console.log(`  with warnings: ${withWarnings}`);
console.log(`  funding_source distribution:`);
for (const [k, v] of Object.entries(byFunding).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k}: ${v}`);
}

// Per-leg balance check: every dollar IN through ATMs/IPOs should equal
// every dollar OUT on BTC for the same week (Strategy's "closed-loop"
// pattern). Compare Σ per-leg net proceeds to usd_spent. Three failure modes
// surface here:
//   1. Σ legs = 0 with usd_spent > 0 — table extraction failed entirely;
//      these rows need a sidecar override (or, in the narrative-era 8-Ks,
//      their leg data lives in `narrativeMatches` and is summed into the
//      top-level raise_net_proceeds_usd already, so we skip them).
//   2. Σ legs > 0 but well off usd_spent — partial extraction (one or more
//      legs dropped on sanity check, or the week genuinely held proceeds in
//      the cash buffer per the 3-yr buffer policy).
//   3. Σ legs ≈ usd_spent — clean.
// IPO-only weeks legitimately have zero ATM legs (the funding came from a
// preferred IPO that's tracked separately in the catalog), so we skip them.
const legBalanceFailures = [];
for (const r of results) {
  if (!r.usd_spent_reported || r.usd_spent_reported <= 0) continue;
  // IPO and Convert-only weeks legitimately have no ATM table — funding
  // came from a preferred IPO or convertible-notes offering, both tracked
  // outside per_security. Skip them so the report stays focused on the
  // ATM-era weeks where per-leg attribution is the real invariant.
  if (/Ipo|Convert/.test(r.funding_source)) continue;
  // Narrative-era rows (single-ATM, early 2025) have valid per-leg data in
  // `narrative_match_count` that already feeds raise_instrument and the
  // top-level raise_net_proceeds_usd. Their per_security map being empty is
  // structural, not a failure to flag here.
  if (r.narrative_match_count > 0 && Object.keys(r.per_security ?? {}).length === 0) {
    continue;
  }
  const sumLegs = Object.values(r.per_security ?? {})
    .reduce((s, l) => s + (l.net_proceeds_usd || 0), 0);
  const deltaPct = (sumLegs - r.usd_spent_reported) / r.usd_spent_reported;
  if (Math.abs(deltaPct) > 0.05) {
    legBalanceFailures.push({
      date: r.date_of_purchase,
      sumLegs,
      usdSpent: r.usd_spent_reported,
      deltaPct,
    });
  }
}
if (legBalanceFailures.length > 0) {
  console.log(`\n  per-leg balance failures (>5% delta): ${legBalanceFailures.length}`);
  for (const f of legBalanceFailures.slice(0, 10)) {
    console.log(`    ${f.date}: Σ legs $${(f.sumLegs / 1e6).toFixed(1)}M vs spent $${(f.usdSpent / 1e6).toFixed(1)}M (${(f.deltaPct * 100).toFixed(1)}%)`);
  }
}

console.log(`\nwrote ${OUT_JSON.pathname}`);

// Strict by default: any missing .txt indicates pdftotext didn't run for
// that row (or its output was deleted). Skipping those rows would silently
// downgrade tranches.csv on the second build pass — that's exactly the
// regressed-data scenario Codex flagged. Exit non-zero so the workflow
// surfaces the gap. Pass `--allow-failures` to override for local debugging.
const allowFailures = process.argv.includes('--allow-failures');
if (missingTxt > 0 && !allowFailures) {
  console.error(`parse-8ks: ${missingTxt} row(s) missing .txt; exiting non-zero. Pass --allow-failures to override.`);
  process.exit(1);
}
