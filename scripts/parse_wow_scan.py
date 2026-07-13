#!/usr/bin/env python3
"""
parse_wow_scan.py — Q.Checkout (Woolworths) scan data export parser
mm-data-hub raw -> core transform for the WOW scan feed.

Input : Q.Checkout "Scan data export" CSV (report wizard, weekly trend).
Output: (1) clean fact CSV at finest grain, ready for core.wow_scan_weekly
        (2) JSON metadata sidecar (export parameters + load stats)

Rules encoded (see MODULE-WOW-SCAN-SPEC.md):
  - Parse the metadata block (rows above the 'Promo Week' header) into the sidecar.
  - Keep ONLY the finest grain: drop Location='Australia', VCU='Total',
    Channel='Total', Promotion='Total' rows. Totals are derived downstream.
  - Drop rows where all metric fields are blank (sparse cross-join padding).
  - Split '0133211-KG - BANANA 1KG' into article_number, uom, description.
  - Dates DD/MM/YYYY -> ISO YYYY-MM-DD. 'Promo Week' is week-ENDING Tuesday.
  - Fail loudly (exit 1) if the header row or expected columns change.

Usage:
  python3 parse_wow_scan.py input.csv --out clean.csv --meta meta.json
  python3 parse_wow_scan.py input.csv --keep-totals   # keep Total rows, flagged
"""

import argparse
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

EXPECTED_HEADER = [
    "Promo Week", "Sub-Category", "Segment", "Product", "Location",
    "Simple VCU", "Channel", "Promotion",
]
# Metric columns carry a '- N Week(s)' suffix that varies with the wizard's
# time setting, so match on prefix.
METRIC_PREFIXES = [
    ("Volume", "volume"),
    ("Sales", "sales"),
    ("Units", "units"),
    ("Average price per volume", "avg_price_per_volume"),
    ("Average unit price", "avg_unit_price"),
]

PRODUCT_RE = re.compile(r"^(\d+)-([A-Z]+)\s+-\s+(.*)$")

OUT_COLUMNS = [
    "week_ending", "article_number", "uom", "article_description",
    "sub_category", "segment", "state", "vcu", "channel", "promotion",
    "volume", "sales", "units", "avg_price_per_volume", "avg_unit_price",
]


def parse_date_ddmmyyyy(s: str) -> str:
    return datetime.strptime(s.strip(), "%d/%m/%Y").strftime("%Y-%m-%d")


def parse_product(s: str):
    m = PRODUCT_RE.match(s.strip())
    if not m:
        return None, None, s.strip()
    return m.group(1), m.group(2), m.group(3)


NULL_MARKERS = {"", "-", "n/a", "na", "null"}


def num_or_none(s: str):
    s = s.strip().replace(",", "")
    if s.lower() in NULL_MARKERS:
        return None
    return float(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--meta", type=Path, default=None)
    ap.add_argument("--keep-totals", action="store_true",
                    help="keep Total-grain rows instead of dropping them")
    args = ap.parse_args()

    out_path = args.out or args.input.with_name("wow_scan_clean.csv")
    meta_path = args.meta or args.input.with_name("wow_scan_meta.json")

    with args.input.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))

    # ---- 1. Locate header row, capture metadata block -----------------
    hdr_i = None
    for i, row in enumerate(rows):
        if row and row[0].strip() == "Promo Week":
            hdr_i = i
            break
    if hdr_i is None:
        sys.exit("FATAL: 'Promo Week' header row not found — export format changed.")

    metadata = {}
    for row in rows[:hdr_i]:
        if len(row) >= 2 and row[0].strip() and row[0].strip() != "Global parameters":
            metadata[row[0].strip()] = row[1].strip()

    header = [c.strip() for c in rows[hdr_i]]

    # ---- 2. Validate structure ----------------------------------------
    if header[: len(EXPECTED_HEADER)] != EXPECTED_HEADER:
        sys.exit(
            "FATAL: dimension columns changed.\n"
            f"  expected: {EXPECTED_HEADER}\n"
            f"  got     : {header[:len(EXPECTED_HEADER)]}"
        )
    metric_idx = {}
    for prefix, key in METRIC_PREFIXES:
        matches = [i for i, c in enumerate(header) if c.startswith(prefix)]
        # 'Average price...' also startswith 'A' etc — prefixes here are unambiguous,
        # but 'Sales' could collide with a future 'Sales something' column: take exact-prefix, first hit.
        if not matches:
            sys.exit(f"FATAL: metric column starting with '{prefix}' not found.")
        metric_idx[key] = matches[0]

    # ---- 3. Transform ---------------------------------------------------
    stats = {
        "rows_in": 0, "rows_out": 0, "rows_blank_dropped": 0,
        "rows_total_grain_dropped": 0, "rows_unparsed_product": 0,
    }
    weeks, articles, states = set(), set(), set()

    with out_path.open("w", newline="", encoding="utf-8") as fo:
        w = csv.writer(fo)
        w.writerow(OUT_COLUMNS)

        for row in rows[hdr_i + 1:]:
            if not row or not row[0].strip():
                continue
            stats["rows_in"] += 1

            metrics = {k: num_or_none(row[i]) for k, i in metric_idx.items()}
            if all(v is None for v in metrics.values()):
                stats["rows_blank_dropped"] += 1
                continue

            location, vcu, channel, promo = (
                row[4].strip(), row[5].strip(), row[6].strip(), row[7].strip()
            )
            is_total_grain = (
                location == "Australia" or vcu == "Total"
                or channel == "Total" or promo == "Total"
            )
            if is_total_grain and not args.keep_totals:
                stats["rows_total_grain_dropped"] += 1
                continue

            article, uom, desc = parse_product(row[3])
            if article is None:
                stats["rows_unparsed_product"] += 1

            week = parse_date_ddmmyyyy(row[0])
            weeks.add(week)
            articles.add(article or desc)
            states.add(location)

            w.writerow([
                week, article or "", uom or "", desc,
                row[1].strip(), row[2].strip(),
                location, vcu, channel.upper(), promo.upper().replace(" ", "_"),
                *(("" if metrics[k] is None else metrics[k]) for k in
                  ("volume", "sales", "units", "avg_price_per_volume", "avg_unit_price")),
            ])
            stats["rows_out"] += 1

    # ---- 4. Sidecar -----------------------------------------------------
    sidecar = {
        "source_file": args.input.name,
        "parsed_at_utc": datetime.now(__import__("datetime").UTC).isoformat(timespec="seconds"),
        "export_parameters": metadata,
        "stats": stats,
        "coverage": {
            "weeks": len(weeks),
            "week_min": min(weeks) if weeks else None,
            "week_max": max(weeks) if weeks else None,
            "articles": len(articles),
            "states": sorted(states),
        },
    }
    meta_path.write_text(json.dumps(sidecar, indent=2))

    print(json.dumps(sidecar["stats"], indent=2))
    print(f"clean : {out_path}")
    print(f"meta  : {meta_path}")

    # Reconciliation guard: everything must be accounted for.
    accounted = (stats["rows_out"] + stats["rows_blank_dropped"]
                 + stats["rows_total_grain_dropped"])
    if accounted != stats["rows_in"]:
        sys.exit("FATAL: row accounting mismatch — investigate before loading.")


if __name__ == "__main__":
    main()
