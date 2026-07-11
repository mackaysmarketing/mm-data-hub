# Retail raw→semantic reconciliation — 2026-07-11T13:33:41.682Z

raw.retail_prices → semantic.retail_prices (0027/0028/0029). All expectations derived from raw in the same run — no hardcoded baselines.

| Check | Result | Detail |
|---|---|---|
| semantic.retail_prices has NO authenticated grant (fail-closed by design, 0029) | PASS | authenticated=false anon=false |
| raw.retail_prices + core.dim_retail_product are cube-only (no authenticated grant, RLS on) | PASS | auth_raw=false auth_dim=false raw_rls=true dim_rls=true |
| cube_readonly CAN read the view; view is security_invoker | PASS | cube=true reloptions={security_invoker=true} |
| exactly one view row per (retailer, state, store, product, local day) | PASS | duplicate groups=0 |
| view rows == raw day-groups (nothing dropped, nothing invented) | PASS | expected=148 view=148 |
| every view row is the LATEST capture of its day-group | PASS | stale=0 orphans=0 (multi-capture groups today=0) |
| spot-check: 20 sampled day-groups match raw latest exactly | PASS | sampled=20 expected=20 mismatched=0 |
| is_watchlist / product_key match a fresh dim join on every view row | PASS | flag_mismatches=0 key_mismatches=0 (watchlist rows=28/148) |
| every (retailer, state) bucket: view rows == raw day-groups | PASS | buckets=2 mismatched=0 |
| NULL prices preserved — 0 rows coalesced to 0, 0 value mutations | PASS | view_nulls=0 raw_latest_nulls=0 mutations=0 coalesced_zeros=0 |

## Per-retailer/state parity
| retailer | state | expected (raw day-groups) | actual (view rows) |
|---|---|---:|---:|
| aldi | AU | 132 | 132 |
| coles | AU | 16 | 16 |

## Watchlist dim coverage (surfaced, not failed)
| product_key | woolworths | coles | aldi |
|---|---|---|---|
| bananas-kids-5-pack | NEVER SEEN | seen | no listing |
| cavendish-bananas-each | NEVER SEEN | seen | seen |
| eat-later-cavendish-bananas | NEVER SEEN | no listing | no listing |
| hass-avocado | NEVER SEEN | seen | seen |
| papaya-red-whole | NEVER SEEN | seen | seen |

## Surfaced facts
- Multi-capture day-groups (where the latest-wins dedupe actually bites): **0**
- View rows / raw day-groups: **148 / 148** · watchlist rows: **28**
- NULL prices in view: **0** (== raw latest) · NULL was_price: **148** — passed through, never coalesced.
- Posture: semantic.retail_prices has NO authenticated grant (fail-closed, 0029); raw/dim are RLS-on cube-only.
