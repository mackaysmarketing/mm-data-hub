# Reconciliation report — 2026-06-20

Source: `core.load_box_reconciliation` over the full FY25-26 backfill.
Reconciles each load's `stock_boxes` against the sum of its pallets' `box_count`.

## Summary

| Metric | Value |
|---|---|
| Loads (FY25-26, non-test, `actual_pickup_on` set) | 5,926 |
| Loads with ≥1 pallet | 5,880 |
| Loads with no pallets | 46 (0.8%) |
| **Loads-with-pallets reconciling exactly** (`delta = 0`) | **5,874 / 5,880 = 99.9%** |
| Loads with a non-zero box delta | 6 (0.1%) |
| Total pallets | 38,796 |
| Pallets with null `box_count` | 3,328 (8.6%) |
| Σ load `stock_boxes` | 1,714,805 |
| Σ pallet `box_count` | 1,697,011 |
| Aggregate box gap | 17,794 (1.04%) |

The 1.04% aggregate gap is almost entirely explained by **null `box_count`** (3,328 pallets,
SPEC §3 — box_count is null on reconsigned / in-place pallets, so those boxes don't sum) and
the **46 empty loads**. Excluding those, line-level reconciliation is effectively exact.

> `net_weight_value` is never used to reconcile box counts (produce-dependent & nullable, SPEC §9.8).

## The 6 loads with a non-zero box delta

These are order-vs-actual artifacts: `stock_boxes` carries a round planned/ordered quantity
(e.g. 3024, 1008) while the pallets on the load sum to far fewer actual boxes. None have null
box_count — the delta is real and upstream. Flagged for FreshTrack review, not a loader fault.

| Load | Pickup | Type | stock_boxes | pallets | null box | Σ box_count | delta |
|---|---|---|---:|---:|---:|---:|---:|
| 5005773 | 2025-09-25 | S | 3024 | 5 | 0 | 240 | 2784 |
| 5005036 | 2025-08-28 | S | 3024 | 17 | 0 | 816 | 2208 |
| 5005775 | 2025-10-31 | S | 3024 | 37 | 0 | 1776 | 1248 |
| 5004216 | 2025-08-11 | S | 288 | 2 | 0 | 96 | 192 |
| 5005776 | 2025-10-31 | S | 1008 | 18 | 0 | 864 | 144 |
| 5006066 | 2025-09-15 | S | 192 | 3 | 0 | 144 | 48 |

## Method

`box_count_delta = load_stock_boxes − Σ pallet.box_count` per load, grouped from
`raw.ft_dispatch_load ⟕ raw.ft_pallet`. Reproduce with `npm run reconcile` (writes a fresh
`reports/reconciliation_<date>.md`) or query `core.load_box_reconciliation` directly.
