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

---

# `dispatch_shipped` view — ADDITIVE shipped-state surface (Sprint 8, Option C)

A **separate** governed dispatch surface that corrects how "dispatched" / "boxes" are defined,
built over `semantic.grower_dispatch_shipped` (migration `0021`). It sits **alongside** the
`dispatch` view above and **never redefines** an existing metric — consumers OPT IN. The two
definitions are kept on **distinct views** (not added as ambiguous siblings on `dispatch`) so
`load_count` (actual-pickup basis) and `shipped_load_count` (Shipped-state basis) can't be confused.
See `DISPATCH_DEFINITION_PROPOSAL.md` for the why.

Consumed through the `dispatch_shipped` **view** only (base cube `dispatch_shipped_pallets` is
`public: false`; the cube and view must NOT share a name — Cube rejects that at compile).

## Corrected definitions (vs the `dispatch` view)
| | `dispatch` (existing, unchanged) | `dispatch_shipped` (new) |
|---|---|---|
| "dispatched" | `actual_pickup_on IS NOT NULL` | load reached **Shipped+** (`dim_dispatch_state.sequence >= 5`) |
| dispatch date | `actual_pickup_on` | `effective_dispatched_on` = `coalesce(actual_pickup_on, scheduled_pickup_on)` |
| boxes | (no boxes measure) | `boxes_packed` = `stock_boxes + reconsigned_boxes` (portal "Boxes Packed") |

The **Shipped gate is a single ops-tunable line** in the view (`st.sequence >= 5`), not baked into
stored data — raise it to Delivered (`>= 7`) etc. with a one-line edit to migration `0021`'s view.

## Baked-in filters (in the semantic view, inherited by every measure)
- `order_type = 'S'` — Sell only.
- `dim_dispatch_state.sequence >= 5` — Shipped-or-later (the corrected "dispatched").
- non-test consignor — `core.dim_grower.is_test = false`.

## Measures
| Metric | Grain | Definition (exact) | Null handling |
|---|---|---|---|
| `shipped_load_count` | load | `COUNT(DISTINCT load_id)` over Shipped+ Sell loads | = the semantic view's own `count(distinct load_id)` |
| `boxes_packed` | pallet | `SUM(stock_boxes + reconsigned_boxes)` (computed in the view) | never `pallet.box_count` (own-stock only) |
| `pallet_count_shipped` | pallet | `COUNT(pallet)` over Shipped+ Sell pallets | — |
| `net_weight_shipped` | pallet | `SUM(pallet.net_weight)` (kg) | **nulls excluded, never `coalesce(…,0)`** (SPEC §9.3) |

Loads with **no pallets** are absent from the view (inner pallet join), so `shipped_load_count`
counts Shipped+ Sell loads that carry ≥1 pallet.

## Dimensions (allowed slices)
`grower_key` (= consignor_id, the RLS anchor) · `grower_code` / `grower_name` (readable, internal
context) · `dispatch_state` (lifecycle code SH/IT/DE/…, Shipped+) · `effective_dispatched_on`
(`coalesce(actual, scheduled)` pickup) · `origin_shed_id` / `origin_shed_name` (the pallet's own
packing shed; distinct from the grower on reconsigned pallets).

## RLS contract
Identical to `dispatch`: enforced in `cube.js` → `queryRewrite` reading **only**
`app_metadata.consignor_id` / `app_metadata.is_internal`. **`dispatch_shipped.grower_key` is its RLS
anchor**, registered in `VIEW_GROWER_KEYS` (migration-`0010`-equivalent fail-closed contract). The
backing `semantic.grower_dispatch_shipped` is `security_invoker = true` — the SAME RLS posture as
`grower_dispatch_detail`. No dimension/filter selection can widen a grower's scope.

## Verification
- `npm run cube:shipped` (deploy-gated) → criteria 8 (RLS: single-grower scoping, NIL/forged → 0,
  internal = all, no fan-out, security_invoker parity) + 10 (`/meta` has the new members; the
  existing `dispatch` `/meta` is byte-identical 6 measures + 11 dims; `shipped_load_count` equals the
  semantic view's `count(distinct load_id)` in the same run). Report: `reports/cube_shipped_check_<date>.txt`.

# `retail` view — INTERNAL-ONLY retail shelf prices (reporting phase 1)

Source: `semantic.retail_prices` — day grain over `raw.retail_prices` (the price-reporter
scraper: Woolworths per-state pickup stores, Coles national baseline + per-store rows when
its store leg is unblocked, ALDI national + Super Savers catalogue promos). Base cube
`retail_prices` is `public:false`; consume via the `retail` view only.

## Baked-in behaviour (in the semantic view, inherited by every measure)
- Day grain: latest capture per (retailer, state, store_name, product_id) per local
  (Australia/Brisbane) capture date — multiple runs in a day collapse to the last.
- `price` / `was_price` NULLs are EXCLUDED from aggregates, never coalesced to 0 (SPEC §9.3).
- No test-data filter is needed (partial/test files are refused by the warehouse loader).

## Measures
| Measure | Contract |
|---|---|
| `observation_count` | Count of day-grain price rows in scope. |
| `avg_price` / `min_price` / `max_price` | AVG/MIN/MAX of the day-grain shelf price (AUD), nulls excluded. |
| `promo_observations` | Day-grain rows with `promo_flag = true` (badge, multibuy or was-price). |

## Dimensions (allowed slices)
`retailer`, `state`, `scope`, `store_name`, `product_label`, `product_key`, `is_watchlist`,
`promo_flag`, `promo_label`, `unit_price` (display string), `price`, `was_price` (detail),
`capture_date` (time).

**Consumer rules:** filter `scope` (`'state'` vs `'national'`) before ANY cross-state
comparison — AU is a national baseline, not a ninth state. Filter `is_watchlist = true` for
produce-line metrics; `false` rows are ALDI Super Savers catalogue items (specials signal).

## RLS contract — INTERNAL-ONLY
The inverse of the grower views: there is NO grower scope to narrow to. `cube.js`
`queryRewrite` NIL-filters every non-internal context (`INTERNAL_ONLY_VIEWS`) to zero rows;
`is_internal` (app_metadata-only) passes unscoped. The DB layer is independently fail-closed:
`semantic.retail_prices` has no `authenticated` grant. ADDITIVE-ONLY, as everywhere: never
redefine these measures' meaning, grain, or the scope/watchlist rules.

## Verification
- `sql/retail_semantic_proof.sql` — grain uniqueness, scope split, watchlist split vs the
  loaded day (first proven 2026-07-03: 37 rows = 37 grain keys; 7 watchlist / 30 specials;
  37 national / 0 state).
- `npm run cube:compile` — model compiles with the retail cube + view.
- Post-deploy: internal context returns rows; grower and no-claim contexts return 0 (the
  INTERNAL_ONLY_VIEWS gate), pattern of `npm run cube:rls`.
