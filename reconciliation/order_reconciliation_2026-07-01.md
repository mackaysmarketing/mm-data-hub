# Order reconciliation — header ↔ line ↔ source (A7)

Date: 2026-07-01 · Project: data_hub (uqzfkhsdyeokwnkpcxui) · Source: FreshTrack read-replica
Sample: 500 PRICED sell orders (type=S, non-null header total, ≥1 current-version line). Tolerance: ±0.01.

Null integrity (SPEC §9.3): 11328 of 20920 sell orders with lines are entirely
UNPRICED (quote/pending) and keep a NULL total_price_value — never coalesced to 0 — faithful to
the source (only ~47% of replica current-version lines carry total_price_value).

The replica has NO order-header dollar total — the header total is DERIVED from the
current-version lines. This report reconciles the derived header to its own lines AND to the
native replica current-version line sum for the same orders.

| Check | Pass / Sample |
|---|---|
| 1. dim_order.total_price_value == Σ current-version fact_order_item.total_price_value | 500/500 |
| 2. hub line sum == NATIVE replica current-version line sum | 500/500 |
| 3. total_box_count (header==native AND line==native) | 500/500 |
| 4. native total_price_value == derived extended value (BOX→box×price) | 500/500 |
| orders not found on replica (should be 0) | 0 |

## Variances
None — every sampled order reconciled on all four checks (header↔line↔source, native↔derived).

Derived extended-line-value rule (per price_per): BOX → total_box_count × price_value;
PALLET → pallet_count × price_value; WEIGHT_UNIT/other → defer to native total_price_value.
