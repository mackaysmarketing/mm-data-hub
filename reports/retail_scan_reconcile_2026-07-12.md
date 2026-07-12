# Retail-scan reconciliation — 2026-07-12

PASS  every SCAN_MEASURE_COLUMNS name is a numeric raw column — 57/57 present
PASS  re-parsed distinct natural keys == raw.retail_scan rows — files=3 parsed_rows=19089 distinct_keys=13228 raw=13228
  raw_all | raw_weekly | raw_latest | fact
  13228 | 12224 | 1004 | 12224
PASS  fact == raw weekly rows — raw_weekly=12224 fact=12224 (latest-N raw-only=1004)
  groups | units_bad | dollars_bad | volume_bad
  4679 | 0 | 0 | 0
PASS  0 checksum mismatches across units/dollars/volume — groups=4679 units_bad=0 dollars_bad=0 volume_bad=0
  unmapped | weeks_without_dimdate | distinct_weeks | min_week | max_week
  0 | 0 | 55 | 2025-06-24 | 2026-07-07
PASS  0 unmapped segment/geography/causal — unmapped=0
PASS  every fact week joins core.dim_date — weeks=55 span=2025-06-24..2026-07-07
  raw_vol_nulls | fact_vol_nulls | raw_acv_nulls | fact_acv_nulls | suspicious_zero_vol
  404 | 404 | 7732 | 7732 | 0
PASS  NULLs preserved raw→fact (volume, acv) — vol 404==404, acv 7732==7732
PASS  0 suspicious zero-volume rows (independent coalesce guard) — volume_kg=0 with units>0: 0

## Ties (informational)
  weeks | avg_state_gap_pct | avg_segment_gap_pct
  55 | 0.000 | 94.434
PASS  [core.fact_retail_scan] internal>0; grower/no-claim/forged/user_meta = 0 — internal=12224 grower=0 none=0 forged=0 user_meta=0
PASS  [semantic.retail_scan] internal>0; grower/no-claim/forged/user_meta = 0 — internal=12224 grower=0 none=0 forged=0 user_meta=0