#!/usr/bin/env python3
"""
pull-edgar-index.py — Pull the full EDGAR submission index for Strategy Inc.

Downloads the EDGAR entity metadata (all filing indexes) and saves a
comprehensive filing manifest. Does NOT download filing documents —
that's handled by pull-cdn-filings.py for CDN-hosted docs and
pull-all-filings.py for EDGAR Archives.

This script OWNS raw/edgar-submissions.json (the entity metadata file) —
pull-all-filings.py no longer writes it to avoid a duplicate-writer race.

Usage:
    python3 scripts/pull-edgar-index.py [--dry-run]

--dry-run  Fetch and summarize but do not write any JSON outputs
"""

import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter

CIK = "0001050446"
ENTITY_NAME = "Strategy Inc"
DATA_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = DATA_DIR / "raw"
FILINGS_DIR = DATA_DIR / "filings"
USER_AGENT = "VelocityPoint LLC dave.lawler@velocity-point.com"


def fetch_json(url, retries=3):
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            print(f"  Attempt {attempt+1}/{retries} failed: {e}")
            if attempt == retries - 1:
                return None
            time.sleep(2 ** attempt)
    return None


def fetch_bulk_submissions(bulk_url):
    """Fetch bulk submissions file."""
    req = urllib.request.Request(bulk_url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  Failed to fetch bulk submissions: {e}")
        return None


def inventory_local_filings():
    """Count local filings by type."""
    inventory = Counter()
    if FILINGS_DIR.exists():
        for d in FILINGS_DIR.iterdir():
            if d.is_dir():
                inventory[d.name] = len([f for f in d.iterdir() if f.is_file()])
    return dict(inventory)


def main():
    dry_run = "--dry-run" in sys.argv

    print(f"=== EDGAR Index Pull: {ENTITY_NAME} (CIK {CIK}) ===")
    if dry_run:
        print("[DRY-RUN] No JSON outputs will be written.")
    print()

    # Step 1: Fetch recent filings index
    print("[1] Fetching recent filings index (last ~6 years)...")
    entity_data = fetch_json(f"https://data.sec.gov/submissions/CIK{CIK}.json")
    if not entity_data:
        print("FATAL: Could not fetch entity data")
        sys.exit(1)

    recent = entity_data.get("filings", {}).get("recent", {})
    recent_count = len(recent.get("form", []))
    print(f"  Recent filings: {recent_count}")

    # Step 2: Fetch bulk submissions (historical) — EDGAR can split a long
    # filing history across multiple bulk files (CIK*-submissions-001.json,
    # -002.json, ...), so accumulate them all instead of keeping only the last.
    print("[2] Fetching bulk historical submissions...")
    bulk_results = []
    for bulk_file in entity_data.get("filings", {}).get("files", []):
        bulk_url = f"https://data.sec.gov/submissions/{bulk_file['name']}"
        bulk = fetch_bulk_submissions(bulk_url)
        if bulk:
            bulk_count = len(bulk.get("form", []))
            print(f"  Bulk filings: {bulk_count} ({bulk_file.get('filingFrom')} to {bulk_file.get('filingTo')})")
            bulk_results.append(bulk)

    # Step 3: Build combined filing index
    print("[3] Building combined filing index...")
    all_filings = []

    # Add recent filings
    if recent:
        forms = recent.get("form", [])
        accessions = recent.get("accessionNumber", [])
        dates = recent.get("filingDate", [])
        report_dates = recent.get("reportDate", [])
        primaries = recent.get("primaryDocument", [])
        sizes = recent.get("size", [])

        for i, (form, acc, fdate, rdate, prim, size) in enumerate(
            zip(forms, accessions, dates, report_dates, primaries, sizes)
        ):
            all_filings.append({
                "form": form,
                "accessionNumber": acc,
                "filingDate": fdate,
                "reportDate": rdate,
                "primaryDocument": prim,
                "size": size,
                "source": "recent",
            })

    # Add bulk filings (from every bulk file, not just the last one)
    for bulk_data in bulk_results:
        forms = bulk_data.get("form", [])
        accessions = bulk_data.get("accessionNumber", [])
        dates = bulk_data.get("filingDate", [])
        report_dates = bulk_data.get("reportDate", [])
        primaries = bulk_data.get("primaryDocument", [])
        sizes = bulk_data.get("size", [])

        for i, (form, acc, fdate, rdate, prim, size) in enumerate(
            zip(forms, accessions, dates, report_dates, primaries, sizes)
        ):
            all_filings.append({
                "form": form,
                "accessionNumber": acc,
                "filingDate": fdate,
                "reportDate": rdate,
                "primaryDocument": prim,
                "size": size,
                "source": "bulk",
            })

    # Sort by filing date (newest first)
    all_filings.sort(key=lambda x: x["filingDate"], reverse=True)

    print(f"  Total filings indexed: {len(all_filings)}")

    # Count by form type
    form_counts = Counter(f["form"] for f in all_filings)
    print()
    print("  Filings by type:")
    for form, count in form_counts.most_common():
        print(f"    {form}: {count}")

    # Date range
    dates = [f["filingDate"] for f in all_filings if f["filingDate"]]
    print(f"  Date range: {dates[-1]} to {dates[0]}")

    # Step 4: Check local inventory
    print()
    print("[4] Local filing inventory:")
    local_inventory = inventory_local_filings()
    for ftype, count in sorted(local_inventory.items()):
        print(f"    filings/{ftype}/: {count} files")

    # Step 5: Identify gaps
    print()
    print("[5] Gaps — filing types we don't have locally:")
    local_types = set(local_inventory.keys())
    for form in sorted(form_counts.keys()):
        if form not in local_types:
            print(f"    MISSING: {form} ({form_counts[form]} in EDGAR)")

    # Step 6: Save comprehensive index
    index_data = {
        "entity": ENTITY_NAME,
        "cik": CIK,
        "pull_date": datetime.now(timezone.utc).isoformat(),
        "total_filings": len(all_filings),
        "form_counts": dict(form_counts),
        "date_range": {
            "earliest": dates[-1] if dates else None,
            "latest": dates[0] if dates else None,
        },
        "local_inventory": local_inventory,
        "filings": all_filings,
    }

    index_path = RAW_DIR / "edgar-filings-index.json"
    entity_path = RAW_DIR / "edgar-submissions.json"

    if dry_run:
        print(f"\n  [DRY-RUN] Would save index: {index_path} ({len(json.dumps(index_data)):,} bytes)")
        print(f"  [DRY-RUN] Would save entity data: {entity_path}")
    else:
        with open(index_path, "w") as f:
            json.dump(index_data, f, indent=2)
        print(f"\n  Index saved: {index_path} ({len(json.dumps(index_data)):,} bytes)")

        # Also update entity metadata — this script owns edgar-submissions.json;
        # pull-all-filings.py no longer writes it.
        with open(entity_path, "w") as f:
            json.dump(entity_data, f, indent=4)
        print(f"  Entity data saved: {entity_path}")

    return index_data


if __name__ == "__main__":
    main()
