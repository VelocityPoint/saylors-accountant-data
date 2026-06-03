#!/usr/bin/env python3
"""
pull-cdn-filings.py — Pull ALL filings from Strategy Inc's CDN (contentstack.io).

Discovers all filing URLs by scanning the Strategy.com IR pages and existing data,
then downloads any missing files to the local filings/ directory.

Usage:
    python3 scripts/pull-cdn-filings.py [--force] [--dry-run]

--force    Re-download even if file exists
--dry-run  Show what would be downloaded without downloading
"""

import csv
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter

DATA_DIR = Path(__file__).resolve().parent.parent
FILINGS_DIR = DATA_DIR / "filings"
RAW_DIR = DATA_DIR / "raw"
USER_AGENT = "VelocityPoint LLC dave.lawler@velocity-point.com"

# Strategy.com IR pages to scan for filing links
IR_PAGES = [
    "https://ir.strategy.com/sec-filings",
    "https://ir.strategy.com/sec-filings/all-filings",
    "https://www.strategy.com/investors/sec-filings",
]


def discover_cdn_urls():
    """Discover all CDN filing URLs from multiple sources."""
    urls = set()
    url_pattern = re.compile(r'https?://assets\.contentstack\.io/v3/[^\"\s<>\n\r,]+(?:\.(?:pdf|htm|html|zip|json|xml))')

    # Source 1: purchases-timeline.csv (has sec_url column)
    timeline_path = RAW_DIR / "purchases-timeline.csv"
    if timeline_path.exists():
        with open(timeline_path) as f:
            reader = csv.DictReader(f)
            for row in reader:
                url = row.get("sec_url", "").strip()
                if url and url.startswith("http"):
                    urls.add(url)

    # Source 2: strategy-purchases.json
    for json_file in ["strategy-purchases.json", "raises-extracted.json"]:
        path = RAW_DIR / json_file
        if path.exists():
            try:
                with open(path) as f:
                    data = json.load(f)
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            for v in item.values():
                                if isinstance(v, str):
                                    for m in url_pattern.finditer(v):
                                        urls.add(m.group())
            except Exception as e:
                print(f"  Warning: {json_file}: {e}")

    # Source 3: preferred-prices.csv and preferred-ipos.csv
    for csv_file in ["preferred-prices.csv", "preferred-ipos.csv"]:
        path = DATA_DIR / csv_file
        if path.exists():
            try:
                with open(path) as f:
                    content = f.read()
                for m in url_pattern.finditer(content):
                    urls.add(m.group())
            except (OSError, UnicodeDecodeError) as e:
                print(f"  Warning: {csv_file}: {e}")

    # Source 4: Scan all existing data files for contentstack URLs
    for root, dirs, files in os.walk(DATA_DIR):
        if "node_modules" in root or "__pycache__" in root:
            continue
        for fn in files:
            if fn.endswith((".csv", ".json", ".md", ".html", ".htm", ".txt")):
                path = os.path.join(root, fn)
                try:
                    with open(path) as f:
                        content = f.read()
                    # Only match clean CDN URLs ending with file extensions
                    for m in re.finditer(r'https?://assets\.contentstack\.io/[^\"\s<>\n\r]+(?:\.(?:pdf|htm|html|zip|json|xml))', content):
                        url = m.group().rstrip(",;:!")
                        urls.add(url)
                except (OSError, UnicodeDecodeError) as e:
                    print(f"  Warning: {path}: {e}")

    return urls


def parse_filename(url):
    """Extract filename and form type from CDN URL."""
    parts = url.split("/")
    filename = parts[-1] if parts else "unknown"
    
    # Determine form type from filename
    if "10-k" in filename.lower():
        form_type = "10-K"
    elif "10-q" in filename.lower():
        form_type = "10-Q"
    elif "8-k" in filename.lower():
        form_type = "8-K"
    elif "def-14a" in filename.lower() or "def14a" in filename.lower():
        form_type = "DEF-14A"
    elif "pre-14a" in filename.lower() or "pre14a" in filename.lower():
        form_type = "DEF-14A"
    elif "424b" in filename.lower():
        form_type = "424B"
    elif "sc-13g" in filename.lower() or "13g" in filename.lower():
        form_type = "SC-13G"
    elif "form-4" in filename.lower() or "_4_" in filename.lower():
        form_type = "Form-4"
    elif "form-3" in filename.lower() or "_3_" in filename.lower():
        form_type = "Form-3"
    elif "form-5" in filename.lower() or "_5_" in filename.lower():
        form_type = "Form-5"
    elif "form-144" in filename.lower() or "_144_" in filename.lower():
        form_type = "Form-144"
    elif "s-8" in filename.lower():
        form_type = "S-8"
    elif "s-3asr" in filename.lower():
        form_type = "S-3ASR"
    elif "fwp" in filename.lower():
        form_type = "FWP"
    elif "ars" in filename.lower():
        form_type = "ARS"
    else:
        form_type = "other"
    
    return filename, form_type


def get_local_path(form_type, filename):
    """Get the local path where the filing should be stored."""
    dir_path = FILINGS_DIR / form_type
    return dir_path / filename


def download_filing(url, local_path, dry_run=False):
    """Download a filing from CDN. Returns (ok, error) — error is None on success."""
    if dry_run:
        print(f"  [DRY-RUN] {url.split('/')[-1]}")
        return True, None

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            content = resp.read()
            os.makedirs(local_path.parent, exist_ok=True)
            with open(local_path, "wb") as f:
                f.write(content)
            print(f"  [OK] {local_path.name} ({len(content):,} bytes)")
            return True, None
    except Exception as e:
        print(f"  [FAIL] {local_path.name}: {e}")
        return False, str(e)


def main():
    force = "--force" in sys.argv
    dry_run = "--dry-run" in sys.argv

    print(f"=== Strategy Inc CDN Filing Puller ===")
    print(f"Data dir: {DATA_DIR}")
    print(f"Filings dir: {FILINGS_DIR}")
    print(f"Force: {force}, Dry-run: {dry_run}")
    print()

    # Step 1: Discover all CDN URLs
    print("[1] Discovering CDN filing URLs...")
    urls = discover_cdn_urls()
    print(f"  Found {len(urls)} unique CDN URLs")
    print()

    # Step 2: Categorize and download
    stats = {"downloaded": 0, "skipped": 0, "failed": 0, "forms": Counter()}
    failed_urls = []

    print("[2] Processing filings...")
    for i, url in enumerate(sorted(urls)):
        filename, form_type = parse_filename(url)
        local_path = get_local_path(form_type, filename)
        stats["forms"][form_type] += 1

        if local_path.exists() and not force:
            stats["skipped"] += 1
            continue

        ok, err = download_filing(url, local_path, dry_run)
        if ok:
            stats["downloaded"] += 1
        else:
            stats["failed"] += 1
            failed_urls.append({"url": url, "form": form_type, "error": err})

        time.sleep(0.2)  # Rate limit for CDN

    # Step 3: Summary
    print()
    print("=== SUMMARY ===")
    print(f"  Total CDN URLs: {len(urls)}")
    print(f"  Form types found: {len(stats['forms'])}")
    for form, count in stats["forms"].most_common():
        print(f"    {form}: {count}")
    print()
    if dry_run:
        print(f"  [DRY-RUN] Would download: {stats['downloaded']}, Skip existing: {stats['skipped']}")
    else:
        print(f"  Downloaded: {stats['downloaded']}")
        print(f"  Skipped (existing): {stats['skipped']}")
        print(f"  Failed: {stats['failed']}")

    # Save manifest — include failed_urls so the next run can target them
    # with --force and reviewers can diff what's still missing.
    # Skip the write in dry-run: stats.failed is always 0 and failed_urls is
    # always [], so writing would wipe the audit trail of which URLs need
    # --force on the next real run.
    manifest = {
        "entity": "Strategy Inc",
        "cik": "0001050446",
        "pull_date": datetime.now(timezone.utc).isoformat(),
        "source": "contentstack.io CDN",
        "total_urls": len(urls),
        "stats": {
            "downloaded": stats["downloaded"],
            "skipped": stats["skipped"],
            "failed": stats["failed"],
        },
        "forms": dict(stats["forms"]),
        "failed_urls": failed_urls,
    }
    manifest_path = RAW_DIR / "cdn-filings-manifest.json"
    if dry_run:
        print(f"\n  [DRY-RUN] Would have written manifest with {len(urls)} entries to: {manifest_path}")
    else:
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=4)
        print(f"\n  Manifest saved: {manifest_path}")


if __name__ == "__main__":
    main()
