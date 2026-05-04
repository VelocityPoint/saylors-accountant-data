"""
Extract aggregate disclosures from Strategy 10-K and 10-Q filings on disk.

Produces strategy-disclosures.csv with one row per period-end date
(plus filing-date snapshots from cover pages where available).

Each row captures:
- BTC holdings (as disclosed in the filing's BTC narrative section)
- Share counts for all 7 classes (MSTR Class A, MSTR Class B,
  and 5 preferred classes: STRF, STRC, STRE, STRK, STRD)

Share counts are extracted from balance sheet text (in thousands by
convention, multiplied by 1000 here) and cover-page disclosures
(actual count). The script tags each row with the source so the
audit page can show provenance.

Usage:
    python extract-disclosures.py
"""

import re
import csv
import sys
import io
from pathlib import Path
from bs4 import BeautifulSoup
import warnings

warnings.filterwarnings("ignore")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parents[3]
FILINGS_ROOT = REPO_ROOT / "data" / "saylors-accountant" / "filings"
OUTPUT_CSV = REPO_ROOT / "data" / "saylors-accountant" / "strategy-disclosures.csv"

# Map preferred class names (from balance-sheet text) to ticker symbols.
# Order matters: parser walks balance sheet top-to-bottom finding
# "<class label>; X shares authorized, Y issued and outstanding".
PREFERRED_CLASSES = [
    ("Strife", "STRF"),
    ("Stretch", "STRC"),
    ("Stream", "STRE"),
    ("Strike", "STRK"),
    ("Stride", "STRD"),
]


def extract_text(path: Path) -> str:
    """Strip HTML/iXBRL tags and normalize whitespace."""
    with open(path, encoding="utf-8", errors="replace") as f:
        soup = BeautifulSoup(f.read(), "lxml")
    text = soup.get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text)


def parse_cover_common(text: str):
    """Cover-page common stock disclosure.

    Returns dict with `as_of`, `class_a`, `class_b` (actual share counts),
    or None if not found. The cover-page disclosure is at filing date,
    typically a few weeks after period end.
    """
    m = re.search(
        r"As of (\w+ \d{1,2}, \d{4})[^.]*?registrant had ([\d,]+) and ([\d,]+) shares of class A common stock and class B common stock outstanding",
        text,
    )
    if not m:
        return None
    return {
        "as_of": m.group(1),
        "class_a": int(m.group(2).replace(",", "")),
        "class_b": int(m.group(3).replace(",", "")),
    }


def parse_btc_holdings(text: str, period_end: str):
    """Find BTC holdings disclosed for the period end date.

    Looks for patterns like 'As of December 31, 2025... approximately
    672,500 bitcoins' OR 'December 31, 2025 and 2024, we held
    approximately 672,500 and 447,470 bitcoins'.
    Returns int (BTC count) or None.
    """
    # Period-end specific patterns (most reliable)
    patterns = [
        # "December 31, 2025 and 2024, we held approximately X and Y bitcoins"
        rf"{re.escape(period_end)} and \d{{4}}, we held approximately ([\d,]+)\s*(?:and ([\d,]+))? bitcoins",
        # "as of [period_end], we held approximately X bitcoins"
        rf"[Aa]s of {re.escape(period_end)}[^.]*?(?:held|holding|holds) approximately ([\d,]+) bitcoins",
        # "X bitcoins as of [period_end]"
        rf"approximately ([\d,]+) bitcoins[^.]*?as of {re.escape(period_end)}",
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            return int(m.group(1).replace(",", ""))
    return None


def loose_period_pattern(period_end_short: str) -> str:
    """Build a regex that matches the period-end date even when the filing
    has typos like "March, 31, 2025" (extra comma after the month). Also
    tolerates extra whitespace inside the date string.
    """
    # "December 31, 2025" -> tolerate "December[,]?\s+31[,]?\s+2025"
    parts = period_end_short.replace(",", "").split()
    # parts = ['December', '31', '2025']
    return rf"{re.escape(parts[0])}[,]?\s+{re.escape(parts[1])}\s*,\s+{re.escape(parts[2])}"


def parse_balance_sheet_preferreds(text: str, period_end_short: str):
    """Extract preferred share counts at the period end from the balance sheet.

    Balance sheet entries look like (note variable whitespace around commas
    and the occasional Strategy typo of an extra comma after the month):
        "10.00 % Series A Perpetual Strife Preferred Stock, $ 0.001 par value;
         33,200 shares authorized, 12,840 shares issued and outstanding at
         December 31, 2025"

    The "; X shares authorized" portion is what distinguishes the balance-sheet
    occurrence from the cover-page registered-securities listing.

    Values in thousands per the balance sheet's units convention (multiplied
    by 1000 here). Returns dict mapping ticker -> int share count or None.
    """
    result = {ticker: None for _, ticker in PREFERRED_CLASSES}
    period_pat = loose_period_pattern(period_end_short)
    for class_keyword, ticker in PREFERRED_CLASSES:
        # Shape A — separate authorized + issued counts (typical post-IPO):
        #   "33,200 shares authorized, 12,840 shares issued and outstanding"
        pat_two_counts = (
            rf"Series A Perpetual\s+{class_keyword}\s+Preferred [Ss]tock"
            rf"[^;]{{0,80}};\s*"
            rf"[\d,]+\s+shares authorized\s*,\s+"
            rf"([\d,]+)\s+shares issued and outstanding"
            rf"\s+at\s+{period_pat}"
        )
        m = re.search(pat_two_counts, text, re.IGNORECASE)
        if m:
            result[ticker] = int(m.group(1).replace(",", "")) * 1000
            continue
        # Shape B — fully-subscribed condensed form (right after IPO before
        # any ATM activity): "8,500 shares authorized, issued and outstanding"
        # (one number serves as both authorized AND issued/outstanding).
        pat_condensed = (
            rf"Series A Perpetual\s+{class_keyword}\s+Preferred [Ss]tock"
            rf"[^;]{{0,80}};\s*"
            rf"([\d,]+)\s+shares authorized\s*,\s+"
            rf"issued and outstanding"
            rf"\s+at\s+{period_pat}"
        )
        m = re.search(pat_condensed, text, re.IGNORECASE)
        if m:
            result[ticker] = int(m.group(1).replace(",", "")) * 1000
    return result


def parse_balance_sheet_common(text: str, period_end_short: str):
    """Extract MSTR Class A and Class B share counts at period end.

    Two text shapes observed across filings (both anchor on the
    balance-sheet "shares authorized" → "shares issued" pattern, NOT just
    the bare class name — the cover page also says "Class A common stock"
    but has no share-count clause, so we filter on the structure):

      1. "Class A common stock, $0.001 par value; 10,330,000 and 330,000
          shares authorized, 292,422 and 226,138 shares issued and
          outstanding at December 31, 2025 and December 31, 2024"
         → period-end is the FIRST number (292,422 for Dec 31, 2025).

      2. "Class B common stock, $0.001 par value; 165,000 shares authorized,
          19,640 shares issued and outstanding at December 31, 2025"
         → period-end is the only number (no "and X" comparative).

    Values in thousands per the balance sheet's units convention.
    """
    # The 2024 10-K labels Class B as "Class B convertible common stock";
    # 2025+ filings drop the "convertible" word. Try both.
    common_classes = [
        ("Class A common stock", "MSTR_A"),
        ("Class B convertible common stock", "MSTR_B"),
        ("Class B common stock", "MSTR_B"),
    ]
    result = {"MSTR_A": None, "MSTR_B": None}
    for cls, key in common_classes:
        if result[key] is not None:
            continue  # already filled by a more-specific match
        # Shape A — 2025+ format: "X and Y shares authorized, A and B shares
        # issued and outstanding" (one number for each comparative year).
        pat_compare = (
            rf"{re.escape(cls)}[^;]{{0,80}};\s*"
            rf"[\d,]+\s+and\s+[\d,]+\s+shares authorized\s*,\s+"
            rf"([\d,]+)\s+and\s+([\d,]+)\s+shares issued and outstanding"
        )
        m = re.search(pat_compare, text, re.IGNORECASE)
        if m:
            result[key] = int(m.group(1).replace(",", "")) * 1000
            continue
        # Shape B — 2024 10-K format with semicolon separator AND distinct
        # issued/outstanding counts: "X shares authorized; Y shares issued
        # and Z shares outstanding, and Y2 shares issued and Z2 shares
        # outstanding, respectively"
        pat_2024_separated = (
            rf"{re.escape(cls)}[^;]{{0,80}};\s*"
            rf"[\d,]+\s+shares authorized;\s*"
            rf"([\d,]+)\s+shares issued and ([\d,]+)\s+shares outstanding"
        )
        m = re.search(pat_2024_separated, text, re.IGNORECASE)
        if m:
            # Use the OUTSTANDING count (group 2), which is what investors
            # care about for share-count audits.
            result[key] = int(m.group(2).replace(",", "")) * 1000
            continue
        # Shape B' — 2024 10-K Class B format: semicolon separator AND
        # combined "issued and outstanding" (no distinct counts), with
        # ", and X shares issued and outstanding, respectively" tail for
        # the comparative year. The first count is the period-end value.
        pat_2024_combined = (
            rf"{re.escape(cls)}[^;]{{0,80}};\s*"
            rf"[\d,]+\s+shares authorized;\s*"
            rf"([\d,]+)\s+shares issued and outstanding,?\s+"
            rf"and\s+[\d,]+\s+shares issued and outstanding"
        )
        m = re.search(pat_2024_combined, text, re.IGNORECASE)
        if m:
            result[key] = int(m.group(1).replace(",", "")) * 1000
            continue
        # Shape C — single-year (no comparative): "X shares authorized,
        # Y shares issued and outstanding at <period>"
        pat_single = (
            rf"{re.escape(cls)}[^;]{{0,80}};\s*"
            rf"[\d,]+\s+shares authorized\s*,\s+"
            rf"([\d,]+)\s+shares issued and outstanding"
        )
        m = re.search(pat_single, text, re.IGNORECASE)
        if m:
            result[key] = int(m.group(1).replace(",", "")) * 1000
    return result


def short_period_end(period_end_iso: str) -> str:
    """ISO date 2025-12-31 -> 'December 31, 2025' (matches filing prose)."""
    months = ["January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December"]
    y, m, d = period_end_iso.split("-")
    return f"{months[int(m)-1]} {int(d)}, {y}"


def main():
    # Filing inventory: (period_end_iso, form_type, htm_filename, source_url, accession-no-dashes)
    filings = [
        ("2024-09-30", "10-Q",
         "10-Q/2024-09-30_mstr-10-q.htm",
         "https://www.sec.gov/Archives/edgar/data/1050446/000095017024119263/mstr-20240930.htm"),
        ("2024-12-31", "10-K",
         "10-K/2024-12-31_mstr-10-k.htm",
         "https://www.sec.gov/Archives/edgar/data/1050446/000095017025021814/mstr-20241231.htm"),
        ("2025-03-31", "10-Q",
         "10-Q/2025-03-31_mstr-10-q.htm",
         "https://www.sec.gov/Archives/edgar/data/1050446/000095017025063536/mstr-20250331.htm"),
        ("2025-06-30", "10-Q",
         "10-Q/2025-06-30_mstr-10-q.htm",
         "https://www.sec.gov/Archives/edgar/data/1050446/000095017025102209/mstr-20250630.htm"),
        ("2025-09-30", "10-Q",
         "10-Q/2025-09-30_mstr-10-q.htm",
         "https://www.sec.gov/Archives/edgar/data/1050446/000119312525262568/mstr-20250930.htm"),
        ("2025-12-31", "10-K",
         "10-K/2025-12-31_mstr-10-k.htm",
         "https://www.sec.gov/Archives/edgar/data/1050446/000105044626000020/mstr-20251231.htm"),
    ]

    rows = []
    for period_end, form, rel_path, url in filings:
        path = FILINGS_ROOT / rel_path
        if not path.exists():
            print(f"SKIP: {path} not on disk")
            continue
        print(f"Parsing {form} {period_end}...")
        text = extract_text(path)
        period_end_short = short_period_end(period_end)

        btc = parse_btc_holdings(text, period_end_short)
        prefs = parse_balance_sheet_preferreds(text, period_end_short)
        common = parse_balance_sheet_common(text, period_end_short)
        cover = parse_cover_common(text)

        row = {
            "as_of_date": period_end,
            "filing_type": form,
            "source_filing_url": url,
            "source_filing_local": f"filings/{rel_path}",
            "cumulative_btc": btc if btc is not None else "",
            "shares_mstr_class_a": common["MSTR_A"] if common["MSTR_A"] else "",
            "shares_mstr_class_b": common["MSTR_B"] if common["MSTR_B"] else "",
            "shares_strk": prefs["STRK"] if prefs["STRK"] is not None else "",
            "shares_strf": prefs["STRF"] if prefs["STRF"] is not None else "",
            "shares_strd": prefs["STRD"] if prefs["STRD"] is not None else "",
            "shares_strc": prefs["STRC"] if prefs["STRC"] is not None else "",
            "shares_stre": prefs["STRE"] if prefs["STRE"] is not None else "",
            "cover_page_as_of": cover["as_of"] if cover else "",
            "cover_page_class_a": cover["class_a"] if cover else "",
            "cover_page_class_b": cover["class_b"] if cover else "",
            "notes": "",
        }
        rows.append(row)

        # Print summary for visual check (None-safe)
        def fmt(v):
            return f"{v:,}" if v is not None else "—"
        print(f"  BTC: {fmt(btc)}")
        print(f"  Common  A: {fmt(common['MSTR_A'])}  B: {fmt(common['MSTR_B'])}")
        print(f"  Pref    STRK: {fmt(prefs['STRK'])}  STRF: {fmt(prefs['STRF'])}  STRD: {fmt(prefs['STRD'])}  STRC: {fmt(prefs['STRC'])}  STRE: {fmt(prefs['STRE'])}")
        if cover:
            print(f"  Cover page (filing-date snapshot): A={fmt(cover['class_a'])} B={fmt(cover['class_b'])} as of {cover['as_of']}")
        print()

    # Write CSV
    if rows:
        with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"Wrote {len(rows)} rows to {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
