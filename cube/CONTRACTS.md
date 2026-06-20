# Dispatch metric contracts (Cube)

Every metric below is a **contract**: one meaning (which column, summed how), one grain, a fixed
set of baked-in filters, and an allowed set of dimensions. **Additive only** — you may add new
measures/dimensions freely, but you must **never redefine** the meaning, grain, or baked-in filter
set of an existing metric (doing so silently breaks every Steep dashboard and MCP answer built on it).

Consumed through the `dispatch` **view** only (base cubes are `public: false`).

## Baked-in filters (inherited by every measure, encoded in each cube's SQL)
- `order_type = 'S'` — **Sell** dispatches only (Buy excluded). Text, never an enum (SPEC §9.6).
- `actual_pickup_on IS NOT NULL` — **dispatched** only; the dispatch date is `actual_pickup_on`.
- non-test consignor — `core.dim_grower.is_test = false` (excludes `*TEST` sites, SPEC §9.4).

No consumer can drop these — they live in the cube SQL, below the view.

## Measures
| Metric | Grain | Definition (exact) | Null handling |
|---|---|---|---|
| `load_count` | load | `COUNT(DISTINCT dispatch_load.id)` over dispatched Sell loads | — |
| `pallet_count` | pallet | `COUNT(pallet)` over dispatched Sell pallets | — |
| `net_weight_dispatched` | pallet | `SUM(pallet.net_weight_value)` (kg) | **nulls excluded, never `coalesce(…,0)`** (SPEC §9.8) |
| `line_count` | pallet | `COUNT(DISTINCT (dispatch_load_id, product_id))` — a "line" = a product on a load | — |
| `pallets_with_net_weight` | pallet | `COUNT(pallet) WHERE net_weight_value IS NOT NULL` | capture-rate numerator |
| `net_weight_capture_rate` | pallet | `pallets_with_net_weight / pallet_count` | null-safe ratio |

`load_count` is **true load grain** — it includes the ~45 dispatched Sell loads that carry no pallet
rows (some are loads whose pallets predate the pallet backfill window). The view is rooted on
`dispatch_loads` (one→many to pallets) so this stays honest; pallet measures aggregate over the join.

## Dimensions (allowed slices)
`grower_key` (= consignor_id, the RLS anchor) · `grower_code` / `grower_name` (readable, internal
context) · `pack_week` (parsed `YxxWxx`, e.g. `Y25W31`; null for the degenerate `YW`) ·
`crop` / `variety` / `product` (product may carry caret display-format codes, SPEC §9.9 — parse
before display) · `consignee_key` (customer DC) · `dispatched_on` (`actual_pickup_on`).

## Grain safety
Nothing is sliceable below pallet/line grain. `pallet.location_id` (SPEC §9.2) and harvest-load
lineage (`harvest_load_id`, null outbound, SPEC §9.1) are **not modelled**.

## RLS contract
Tenant scope is enforced in `cube.js` → `queryRewrite`, reading **only** `app_metadata.consignor_id`
/ `app_metadata.is_internal` (identical to DB migration `0010`). Grower context → filtered to that
consignor; internal → unscoped; neither → fail closed (no rows). No dimension/filter selection can
widen a grower's scope. Cube's DB role (`cube_readonly`) reads all rows; Cube narrows per query.

## Verification (this sprint)
- Parity: `npm run cube:reconcile` → **336/336** group comparisons match (overall + 28 growers +
  55 pack-weeks + capture rates). See `reports/reconciliation_cube_2026-06-20.md`.
- RLS: `npm run cube:rls` → **12/12** (3 contexts + fail-closed + 3 forgery rejections).
  See `reports/rls_proof_cube_2026-06-21.txt`.
