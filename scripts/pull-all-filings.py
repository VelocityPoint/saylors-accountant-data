#!/usr/bin/env python3
"""
pull-all-filings.py — Pull ALL EDGAR filings for Strategy Inc (CIK 0001050446).

Fetches the full submission index from EDGAR, organizes filings by type,
and downloads any that are missing from the local store.

Usage:
    python3 scripts/pull-all-filings.py [--force] [--dry-run]

--force    Re-download even if file exists (use for updates)
--dry-run  Show what would be downloaded without downloading

Outputs to: filings/{FORM_TYPE}/
Updates:    raw/edgar-submissions.json with latest entity data
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

CIK = "0001050446"
ENTITY_NAME = "Strategy Inc"
DATA_DIR = Path(__file__).resolve().parent.parent
FILINGS_DIR = DATA_DIR / "filings"
RAW_DIR = DATA_DIR / "raw"
USER_AGENT = f"SaylorsAccountant/0.2 (dave.lawler@velocity-point.com)"

# EDGAR API endpoints
ENTITY_URL = f"https://data.sec.gov/submissions/CIK{CIK}.json"
FULL_SUB_URL = f"https://data.sec.gov/submissions/CIK{CIK}.json"

# Forms we care about — organized into meaningful directories
FORM_DIRS = {
    "10-K": "10-K",
    "10-Q": "10-Q",
    "8-K": "8-K",
    "4": "Form-4",
    "3": "Form-3",
    "5": "Form-5",
    "144": "Form-144",
    "144/A": "Form-144",
    "SC 13G": "SC-13G",
    "SC 13G/A": "SC-13G",
    "SCHEDULE 13G": "SC-13G",
    "SCHEDULE 13G/A": "SC-13G",
    "SC TO-I": "SC-TO-I",
    "SC TO-I/A": "SC-TO-I",
    "DEF 14A": "DEF-14A",
    "DEFA14A": "DEF-14A",
    "PRE 14A": "DEF-14A",
    "424B2": "424B",
    "424B5": "424B",
    "S-8": "S-8",
    "S-8 POS": "S-8",
    "S-3ASR": "S-3ASR",
    "FWP": "FWP",
    "ARS": "ARS",
    "CERT": "CERT",
    "8-A12B": "8-A12B",
    "CORRESP": "CORRESP",
    "UPLOAD": "UPLOAD",
}


def fetch_json(url, retries=3):
    """Fetch JSON from EDGAR with retries."""
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            print(f"  Attempt {attempt+1}/{retries} failed for {url}: {e}")
            if attempt == retries - 1:
                raise
    return None


def sanitize_filename(form, accession, primary_doc, filing_date):
    """Create a clean, collision-free filename from filing metadata."""
    clean_doc = re.sub(r'[^a-zA-Z0-9_.\-]', '_', primary_doc)
    # Prefix with date + accession tail so multiple same-day filings sharing the
    # same primaryDocument name (e.g. an 8-K and a Form-4 both named mstr.htm)
    # don't collide on disk.
    acc_short = accession.split("-")[-1] if "-" in accession else accession
    return f"{filing_date}_{acc_short}_{clean_doc}"


def get_filing_url(accession_number, primary_document):
    """Build the EDGAR URL for a filing's primary document (HTML)."""
    # EDGAR Archives path requires CIK without leading zeros and the accession
    # number with dashes stripped, e.g.
    # /Archives/edgar/data/1050446/000195917326004149/<primary_document>
    cik_no_zeros = str(int(CIK))
    accession_no_dashes = accession_number.replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/{primary_document}"


def get_full_text_url(accession_number):
    """Get the full-text HTML submission page from EDGAR."""
    cik_no_zeros = str(int(CIK))
    accession_no_dashes = accession_number.replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{cik_no_zeros}/{accession_no_dashes}/full-submission.html"


def download_filing(filing_url, local_path, dry_run=False):
    """Download a filing to local_path. Returns True on success."""
    if dry_run:
        print(f"  [DRY-RUN] Would download: {filing_url}")
        print(f"           To: {local_path}")
        return True

    req = urllib.request.Request(filing_url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            content = resp.read()
            content_type = resp.headers.get("Content-Type", "")

            # Ensure extension matches content
            if "html" in content_type and not local_path.name.endswith((".htm", ".html")):
                local_path = local_path.with_suffix(".htm")
            
            os.makedirs(local_path.parent, exist_ok=True)
            with open(local_path, "wb") as f:
                f.write(content)
            print(f"  [OK] {local_path.name} ({len(content):,} bytes)")
            return True
    except Exception as e:
        print(f"  [FAIL] {local_path.name}: {e}")
        return False


def main():
    force = "--force" in sys.argv
    dry_run = "--dry-run" in sys.argv

    print(f"=== EDGAR Filing Puller: {ENTITY_NAME} (CIK {CIK}) ===")
    print(f"Data dir: {DATA_DIR}")
    print(f"Filings dir: {FILINGS_DIR}")
    print(f"Force: {force}, Dry-run: {dry_run}")
    print()

    # Step 1: Fetch entity submissions index
    print("[1] Fetching EDGAR entity data...")
    entity_data = fetch_json(ENTITY_URL)
    if not entity_data:
        print("FATAL: Could not fetch entity data from EDGAR")
        sys.exit(1)

    # Save raw entity data
    os.makedirs(RAW_DIR, exist_ok=True)
    entity_path = RAW_DIR / "edgar-submissions.json"
    with open(entity_path, "w") as f:
        json.dump(entity_data, f, indent=4)
    print(f"  Saved entity data: {entity_path}")

    filings = entity_data.get("filings", {})
    recent = filings.get("recent", {})
    forms = recent.get("form", [])
    accession_numbers = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])
    filing_dates = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])

    print(f"  Total filings in index: {len(forms)}")
    print()

    # Step 2: Categorize and download filings
    stats = {"downloaded": 0, "skipped": 0, "failed": 0, "new_dirs": set(), "forms_found": set()}
    
    print("[2] Processing filings...")
    for i, (form, accession, pdoc, fdate, rdate) in enumerate(
        zip(forms, accession_numbers, primary_docs, filing_dates, report_dates)
    ):
        form = form.strip()
        stats["forms_found"].add(form)
        
        # Determine directory
        target_dir = FORM_DIRS.get(form, "other")
        dir_path = FILINGS_DIR / target_dir
        stats["new_dirs"].add(target_dir)

        # Build filename
        filename = sanitize_filename(form, accession, pdoc, fdate)
        local_path = dir_path / filename

        # Skip if exists and not forcing
        if local_path.exists() and not force:
            stats["skipped"] += 1
            continue

        # Try to download the primary document
        filing_url = get_filing_url(accession, pdoc)
        if download_filing(filing_url, local_path, dry_run):
            stats["downloaded"] += 1
        else:
            stats["failed"] += 1

        # SEC fair-access policy caps automated traffic at 10 req/s.
        if not dry_run:
            time.sleep(0.1)

        # Progress indicator
        if (i + 1) % 100 == 0:
            print(f"  ... processed {i+1}/{len(forms)} filings")

    # Step 3: Summary
    print()
    print("=== SUMMARY ===")
    print(f"  Total filings in EDGAR index: {len(forms)}")
    print(f"  Form types found: {len(stats['forms_found'])}")
    for form in sorted(stats['forms_found']):
        count = forms.count(form)
        print(f"    {form}: {count}")
    
    print(f"  Target directories: {len(stats['new_dirs'])}")
    for d in sorted(stats['new_dirs']):
        print(f"    filings/{d}/")
    
    print()
    if dry_run:
        print(f"  [DRY-RUN] Would download: {stats['downloaded']}, Skip existing: {stats['skipped']}")
    else:
        print(f"  Downloaded: {stats['downloaded']}")
        print(f"  Skipped (existing): {stats['skipped']}")
        print(f"  Failed: {stats['failed']}")
    
    # Save manifest
    manifest = {
        "cik": CIK,
        "entity_name": ENTITY_NAME,
        "pull_date": datetime.now(timezone.utc).isoformat(),
        "total_filings_indexed": len(forms),
        "forms_processed": dict(Counter(forms)),
        "stats": {
            "downloaded": stats["downloaded"],
            "skipped": stats["skipped"],
            "failed": stats["failed"],
        }
    }
    manifest_path = RAW_DIR / "edgar-pull-manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=4, default=str)
    print(f"\n  Manifest saved: {manifest_path}")


if __name__ == "__main__":
    main()
