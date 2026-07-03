> **Addendum (2026-07-03):** Migration `0027_raw_retail_prices.sql` applied to the hub (ledger
> entry `0027_raw_retail_prices`) — retail shelf-price landing for the **price-reporter** scraper
> (separate repo; its `scripts/load-to-warehouse.ts` writes via pg using `DATABASE_URL`). raw-only,
> RLS ON, cube_readonly-only read (0012 pattern), natural key `run_id+retailer+state+product_id`.
>
> **Addendum 2 (2026-07-03, retail metric layer — SPRINT-retail-metrics.md):** `0028`
> (core.dim_retail_product, seeded) + `0029` (semantic.retail_prices day-grain view, NO
> authenticated grant — fail closed, proven) applied with ledger entries. Cube: `retail_prices`
> base cube (public:false) + `retail` view + **INTERNAL_ONLY_VIEWS gate in cube.js queryRewrite**
> (non-internal → NIL → 0 rows; additive). Proven pre-deploy: semantic proof
> (sql/retail_semantic_proof.sql — 37=37 grain, 7/30 watchlist split), compile 0 errors,
> typecheck clean, tests 91/91. **Cube DEPLOYED (Tim, 2026-07-03) and live-proven:**
> `scripts/cube_retail_check.ts` → **7/7** (internal parity 37/30/8.5228 exact; real grower
> MMPRO 0 rows incl. group_by; no-claim 0; forged 0). Commits **not yet pushed**
> (mackaysmarketing PAT per CLAUDE.md).

# Handoff (2026-07-01): Grower RLS — single consignor_id → consignor SET (multi-farm)

Status: **✅ DONE — A0–B3 proven with pasted evidence.** Migration `0026` applied to the hub;
Cube change is code-only (**awaiting manual Cube deploy** — no deploy token in session).
**Portal sprint deferred as instructed:** no group reference table, grants, grower-admin role,
delegated user creation, subset check, grant resolver, or JWT stamping — mm-hub still stamps
`app_metadata`.

## What changed
One grower login can now carry **multiple farms**. RLS anchor widened from a single `consignor_id`
to a **SET**, in both Postgres policies and the Cube filter, backward-compatible, `app_metadata`-only,
fail-closed.

- **Migration `0026_grower_rls_consignor_set.sql`** (raw/core/semantic only — grep-proven, no
  public/auth/storage):
  - New `semantic.current_consignor_ids() → uuid[]`: union of `app_metadata.consignor_ids[]`
    (multi-farm) + legacy scalar `app_metadata.consignor_id`, de-duplicated, valid-only, fail-closed
    (empty on missing/malformed; never raises).
  - `semantic.current_consignor_id()` is now a **first-element shim** over the set — kept only for
    non-policy callers; **no grower policy references it**.
  - All **6** `grower_own_*` policies rewritten to `consignor_id = ANY(semantic.current_consignor_ids())
    OR is_internal_claim()` (the `raw.ft_pallet` load subquery too).
- **`cube/cube.js`**: `readClaims` returns the consignor SET; `queryRewrite` appends an
  `equals`/multi-value (IN) filter = set membership; internal unscoped; empty/invalid → NIL (0 rows).
  `contextToAppId`/`contextToOrchestratorId` now key on the **whole sorted set** so `[A]` and `[A,B]`
  never share a cache bucket.

## Test set (real multi-farm grower)
**L & R Collins** — A=`LRCLA` (Lakeland) `019439a6-…517087`, B=`LRCTU` (Tully) `019439a8-…dba6c`;
unrelated third C=`ZONTA` `019439d4-…7ed6a`. Snapshot: `reports/rls_multi_farm_a0_snapshot_2026-07-01.md`.

## Proofs (runnable)
- `npm run rls:multifarm` — A2–A7, **45/45 pass** (`reports/rls_multi_farm_proof_2026-07-01.txt`):
  legacy token == A0 baseline (backward compat); `[A,B]` → A+B only, unrelated C = 0; A sees 0 of B;
  no-claim/empty-set/forged top-level → 0; internal → full; functions never error on malformed.
- `npm run cube:compile` — whole schema, **0 errors** (B1).
- `npm test` — **91/91** incl. new `tests/cube_rls_multifarm.test.ts` (set membership + multi-farm
  isolation) and unchanged `cube_rls_public_guard` (B2/B3).

---

# Handoff (2026-07-01): Order-Domain Ingest — order / order_version / order_item

Status: **✅ DONE — all acceptance criteria proven with pasted evidence.** Last step: **awaiting manual
Cube deploy** (no deploy token in session, per B4). Source: FreshTrack read-replica, internal-only.

## What landed
`raw → core → semantic → Cube` for the commercial **order** layer (the sell side — ordered
quantities, unit prices, line dollars). Migrations `0023`–`0025`.

- **raw** (`0023`): `raw.ft_order` (20,920), `raw.ft_order_version` (35,482), `raw.ft_order_item`
  (72,601). UUID PKs; `_raw jsonb` on order+order_version, NOT order_item; enums as text; RLS
  internal-only + cube read-all.
- **core** (`0024`): `core.fact_order_item` (35,572 authoritative-version lines) + `core.dim_order`
  (20,920, one per order). Header dollar total DERIVED from current-version lines; `latest_version_no
  = max(version_no)`. Refresh fns idempotent. RLS internal-only + cube read-all.
- **semantic** (`0025`): `semantic.order_headers` / `order_detail` / `order_sales` (S-only), all
  `security_invoker`, internal-only, join keys exposed.
- **Cube**: `order_items` (base cube, `public:false`) + `sales_orders` (view, `public:false`),
  internal-only, additive. Reads `semantic.order_sales`.
- Loader `src/loaders/ft_order.ts` (full/incremental/slice, keyset paged, `assertHubTarget`,
  test-entity exclusion, `sync_window` resume) + core builder `src/loaders/ft_order_core.ts`.
- Oracle `src/lib/ft_order.ts` + specs `src/lib/ft_order_specs.ts`; proofs
  `scripts/ft_order_{profile,reconcile,verify}.ts`, `scripts/order_{rls_proof,idempotency}.ts`,
  `cube/compile_check.ts`, `scripts/apply_migration.ts`.

## A0 findings (build gate — SPRINT.md updated before any loader)
The replica has **no `order.total_price_value`** and **no `order.latest_version_no`** — the header
carries no dollar total and no version pointer. So the header total is **derived** from the
current-version lines; the authoritative version is `max(order_version.version_no)`. The source holds
**only `type='S'`** (21,192 S, 0 B) — `type` still lands as text (both admissible). `price_currency`
100% AUD; `price_per` ∈ {BOX, WEIGHT_UNIT}. Snapshot: `reconciliation/replica_order_schema_2026-07-01.md`.

## Evidence (all commands re-runnable)
| # | Criterion | Result |
|---|---|---|
| A0 | Replica schema snapshot + depended-on columns | `npm run ft:order:profile` → snapshot committed; two absent columns documented, design derived |
| A1 | Migrations touch only raw/core/semantic | grep over `0023`–`0025`: 0 public/auth/storage refs |
| A2 | Three raw tables, UUID PK, `_raw` shape | order/order_version have `_raw`, order_item does not; counts 20,920 / 35,482 / 72,601 |
| A3 | Enums text; 0 new enum types | enum types in raw/core/semantic = **0** (only auth/realtime/storage platform enums exist) |
| A4 | Idempotent, resumable | fixed-set re-upsert ×2: 72,602 → 72,602 → 72,602 (0 net new); `sync_window` carries all 3 streams |
| A5 | Test-entity exclusion | `raw.ft_order` joined to `raw.ft_entity.is_test` = **0** test-linked orders (272 excluded at pull) |
| A6 | Current-version integrity | `core.fact_order_item` non-latest-version rows = **0** / 35,572 |
| A7 | Header ↔ line ↔ source reconciliation | 500 priced orders: **500/500** on all four checks; `reconciliation/order_reconciliation_2026-07-01.md` |
| A8 | DQ invariants | AUD asserted (non-AUD=0); join keys present; raw type=S; `order_sales`=S only; 11,328 unpriced orders keep NULL total (never coalesced) |
| A9/A10 | Semantic internal; raw RLS | views `security_invoker`, no grower grant; raw RLS enabled + policies pasted |
| A11 | Typecheck clean | `npm run typecheck` exit 0 |
| B1 | Cube compiles whole schema | `npm run cube:compile` → **0 errors**, 8 cubes + 6 views incl. order_items + sales_orders |
| B2 | RLS internal-only | `npm run ft:order:rls` → **18/18**: internal sees rows; grower / no-claim / forged / seller-consignor-match all → **0** |
| B3 | Public-guard + suite green | guard passes (no VIEW_GROWER_KEYS anchor needed, view is public:false); **81 pass / 0 fail** (74 baseline + 7 new) |
| B4 | Manual deploy | No Cube token in session. **Awaiting manual Cube deploy** by Tim. |

## Run order (reproduce)
```
npm run ft:order:profile           # A0 snapshot + profile
node --experimental-strip-types scripts/apply_migration.ts supabase/migrations/0023_raw_ft_order.sql supabase/migrations/0024_core_order.sql supabase/migrations/0025_semantic_order.sql
npm run ft:order:load              # full backfill (or -- --since=YYYY-MM-DD / -- --orders=N)
npm run ft:order:core              # build fact + dim
npm run ft:order:reconcile         # A7 report
npm run ft:order:rls               # B2 RLS proof
node --experimental-strip-types scripts/order_idempotency.ts   # A4 zero-drift
node --experimental-strip-types scripts/ft_order_verify.ts     # A2/A3/A5/A6/A8/A10 evidence
npm run cube:compile               # B1 gate
npm test && npm run typecheck      # B3 / A11
```

## Manual next step (B4) — Cube deploy
Deploy is performed by Tim (token intentionally absent from this session):
`cd cube && npx cubejs-cli deploy --token <…>`. After deploy, `sales_orders`/`order_items` are
`public:false` (staged, internal-only) — a follow-on sprint adds an internal-only rewrite rule if the
order view is ever exposed to a consumer.

## Notes / not in scope (unchanged)
- Origin-grower / Sales-by-farm bridge, `primary_origin_consignor_id`, variance view, charges,
  invoices — **not built** (join keys `dispatch_load_id`/`po_no`/`order_id`/`latest_version_no`
  exposed for the follow-on).
- Fixed in passing: 4 pre-existing `noUncheckedIndexedAccess` type errors in
  `tests/cube_rls_public_guard.test.ts` (type-only null guards; behavior identical; test still passes).
- `dispatch_load_id` is present on only ~261/35,572 current sales lines today (the order→dispatch link
  is sparse on live/open orders) — surfaced, not hidden; the bridge sprint handles attribution.
- Git: committed locally on branch `feat/order-domain-ingest` (not pushed — no push requested; push via
  the `mackaysmarketing` PAT flow in CLAUDE.md when ready).
