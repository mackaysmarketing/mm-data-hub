# Handoff (2026-06-30): Sprint 8 Phase A — additive shipped-dispatch SEMANTIC surface (Option C)
Branch: `feat/dispatch-shipped-semantic` (NOT pushed to main). Phase A = Supabase only (no Cube/deploy).
Migration: `supabase/migrations/0021_semantic_grower_dispatch_shipped.sql` (NEW; takes the 0021 slot that 0022 already reserved).

## What was built (purely additive — Option C, not B)
1. **`raw.ft_dispatch_load_state`** — faithful mirror of the FreshTrack `DispatchLoadState` lookup (14 states),
   **seeded in-migration** from the live `dispatchLoadStates` GraphQL query (captured 2026-06-30; id/code/name/sequence
   are stable). Idempotent upsert. A future loader can re-upsert with no schema change. (SPRINT permits the seed
   when the lookup isn't readily ingestable this sprint; we mirror the `gp_status` raw→core pattern.)
2. **`core.dim_dispatch_state`** — conformed dim keyed on `state_id` (= `raw.ft_dispatch_load.state_id`), built by the
   idempotent `core.refresh_dim_dispatch_state()` (search_path '' hardened, fully-qualified). Pure lookup — the
   threshold is **NOT** stored here.
3. **`semantic.grower_dispatch_shipped`** — NEW view, pallet grain, `security_invoker`:
   - `dispatched_on = coalesce(actual_pickup_on, scheduled_pickup_on)::date`
   - `boxes = coalesce(stock_boxes,0) + coalesce(reconsigned_boxes,0)` ("Boxes Packed"); `boxes_own_stock` kept for transparency
   - gate = **single literal line** `WHERE st.sequence >= 5` (◀ clearly marked, ops one-line edit to 7=Delivered etc.)
   - baked: `order_type = 'S'` (Sell), `is_test = false`. `grower_key = load consignor` (RLS anchor).
   - RLS: inherits the base-table policies from 0008/0010 via `security_invoker` (same contract as `grower_dispatch_detail`).

**Untouched (the point of C):** `semantic.grower_dispatch_detail` (0008/0022), the `dispatch` Cube surface, all raw tables'
data. No existing migration edited. `git diff` of the existing view = empty.

## Migration apply gate — APPLIED TO PROD (approved 2026-06-30)
No Supabase **dev branch** exists (`list_branches` → only the default project). Per the gate, the migration was built +
committed + proved read-only (incl. a `BEGIN … ROLLBACK` dry-run), then **approval was requested and granted by Tim**, and
**`0021` was applied to prod** (`uqzfkhsdyeokwnkpcxui`) via `apply_migration` → `{"success":true}`.

### Post-apply verification against the PERSISTED objects
- **C1** `core.dim_dispatch_state` = 14 rows: `OP=1,WO=2,FI=3,RTCO=4,SH=5,IT=6,DE=7,PDEL=8,RI=9,IN=10,CAPP=11,RP=12,PA=13,CL=14`.
- **C2** `semantic.grower_dispatch_shipped` distinct loads (2026) = **8,035**; old basis = **3,152**.
- **C5** `box_count <> stock_boxes` = **0** (invariant holds on persisted data).
- **C7** `semantic.grower_dispatch_detail` = **45,782** rows — **identical** to the pre-apply count → existing surface unchanged.
- **C9 (refined on full data — see below)** only **3** loads are truly dateless, **all carry `pack_date`**.
- **RLS posture** (`pg_class`): `grower_dispatch_shipped` is a `security_invoker` view (= `grower_dispatch_detail`); base tables
  `raw.ft_dispatch_load` / `raw.ft_pallet` / `core.dim_grower` have RLS **enabled**; the two new lookups
  (`raw.ft_dispatch_load_state`, `core.dim_dispatch_state`) carry no grower data and are RLS-free by design. The new view
  inherits the same base-table RLS contract as the existing dispatch surface (full governed `/load` RLS proof = Phase B / crit 8).

## Acceptance criteria — Phase A (2026 Sell loads)
The proposal's blast-radius numbers are a **2026-06-23 snapshot**; today is 2026-06-30. I split the deltas into two kinds and
proved each:
> **(a) Drift-sensitive criteria (2, 3, 7-old-basis)** — reproduce the proposal almost exactly when the surface is restricted
> to the proposal's data window (effective dispatch date ≤ 2026-06-23); the gap to today's value is one week of new loads.
> **(b) Definition-precise criteria (4, 6)** — STABLE regardless of date window (boundary value == today's value). These are
> NOT drift: they are the exact values of the governed view definition, and differ slightly from the proposal author's
> *separate ad-hoc validation script* (`scripts/ft_dispatch_cross_grower_validation.ts`) estimates. The governed-view value is
> the corrected ground truth; the criterion's *intent* (growers made visible / gate is clean at ~0.2%) holds in full.

| # | Criterion | Today | At ≤2026-06-23 boundary | Proposal | Verdict |
|---|---|---|---|---|---|
| 1 | 14 states, correct seq | Open=1 … **Shipped=5** … Paid=13 … Closed=14 | — | 14 | **PASS (exact)** |
| 2 | shipped vs old (×2.6) | new **8,044** / old **3,152** (2.55×) | new **7,783** / old **3,000** | 7,681 / 2,953 | **PASS — drift, reproduced at boundary** |
| 3 | LMB loads & boxes | **259** / **308,080** | **250** / **299,224** | 250(prose)/248(table) / 296,824 | **PASS — drift; 248-vs-250 resolved below** |
| 4 | flip 0→>0 | **21** of **47** | **21** of **47** (stable) | 22 of 49 | **PASS (intent) — definition-precise, see below** |
| 5 | box_count==stock_boxes; targeted | **0** mismatches/127,618; MMTRU/MMANN **1.00×**; LMBCO **14.81×**, LMBEP **16.87×** | — | 1.0× / 15.8× / 21.6× | **PASS (exact invariant)** |
| 6 | ≤6 no-pallet / ≤16 zero-box | **9** (0.11%) / **19** (0.24%) | **9** / **19** (stable) | ≤6 / ≤16 (~0.2%) | **PASS (intent) — definition-precise, see below** |
| 7 | existing surface UNCHANGED | not edited; old-basis **3,152**; LMB single **2025-07-15** row | old-basis **3,000** | 2,953 | **PASS — additive (new objects can't move it)** |
| 9 | date fallback; dateless | 4,908 null-actual loads (2026) **all** carry scheduled date → dated. Full data: **3** loads truly dateless (no actual+no scheduled), excluded from any year-filtered query; **all 3 carry `pack_date`** | — | — | **PASS — see refined note** |

### 248-vs-250 resolution (criterion 3)
The proposal is **internally inconsistent**: its prose says "all **250** of LMB's 2026 loads sit in Shipped-or-later states"
while its blast-radius table cell says **248**. Reproduced at the proposal's data window, the governed definition gives
**250 LMB shipped loads, all seq ≥ 5, all with pallets (0 pallet-less)** — matching the prose. **250 is correct**; the table's
248 was a stale/earlier undercount, not reproducible. (Today: 259, +9 from a week of new loads.)

### Criteria 4 & 6 — why definition-precise, not drift (the honest finding)
Both are **invariant to the date window** (boundary == today), so they cannot be data growth. They are the exact output of the
SPRINT-specified definition (`seq ≥ 5`, `order_type='S'`, `is_test=false`, joined to `core.dim_grower`):
- **(4)** The governed-view universe is **47** non-test, dim-mapped growers with 2026 Sell activity (every one of which has a
  seq ≥ 5 load); **21** flip 0→>0 and **0** lose visibility (monotonic). The proposal's "22 of 49" came from a different
  ad-hoc cross-grower script with a looser universe (e.g. unmapped/Buy consignors); the governed surface — the thing we ship —
  yields 47 and 21. Intent (most active growers, incl. all of LMB/Serra/Nourish, made visible) fully met.
- **(6)** The 9 no-pallet and 19 zero-box gated loads all sit in **genuinely-shipped states** (DE/RI/IN/CAPP/CL) — real shipped
  loads with missing pallet/box records (data gaps), at **0.11% / 0.24%** of 8,044, matching the proposal's "≈0.2%, the gate
  does not sweep in non-shipped loads" claim. The absolute ≤6/≤16 were lower estimates on the smaller earlier dataset.
- **I did NOT alter the definition to hit 22/49 or ≤6/≤16** — that would violate the single-condition gate and the spec. The
  numbers above are the truthful governed values.

### Why 22/49 and ≤6/≤16 are NOT reproducible (exhaustive check)
- `raw.ft_dispatch_load._synced_at` has exactly two batches: **21,156 rows synced 2026-06-23** (the proposal's data) and
  **1,245 synced 2026-06-29** (added after). I reconstructed every contested criterion against (i) effective dispatch date
  ≤ 2026-06-23 and (ii) the 2026-06-23 sync batch.
- **Drift criteria reproduce the proposal** at the date boundary: old basis **3,000** (≈2,953), new shipped **7,783** (≈7,681),
  LMB **250** loads / **299,224** boxes (≈296,824). Confirmed = one week of new loads.
- **Criterion 4 is invariant to every basis**: consignor-level, including unmapped consignors, the universe is **47** (never 49),
  flips **21**, unmapped-shipped **0**. Since the dataset only grows, a past universe of 49 is impossible — the proposal's "49"
  is the looser universe of its ad-hoc script (`scripts/ft_dispatch_cross_grower_validation.ts`), not the governed view.
- **Criterion 6**: the 9 no-pallet / 19 zero-box loads are all in real shipped states (DE/RI/IN/CAPP/CL) = shipped loads with
  missing pallet records, 0.11% / 0.24%. Filtering pallets by sync date is invalid (loads & pallets sync independently).
- **Conclusion:** the migration is correct per the SPRINT spec; 4 & 6's literal targets were a different script's point-in-time
  estimates and cannot be reproduced from live data without falsification. Governed values (21/47, 9/19) are the ground truth.

## Notes / threshold parameterisation
- The `seq >= 5` gate is the **single source of truth** for "shipped" — one literal, commented line in the view. Moving the
  dispatch line (e.g. Delivered = 7) is a one-line edit; nothing is baked into stored data.
- `npm run typecheck` / `npm test`: **N/A this branch** — the change is SQL-only (no TypeScript touched), and `typescript`
  is not installed in this working tree so the gates aren't runnable here; they cannot be affected by a `.sql` migration.

### Criterion 9 refined (the `pack_date` decision — now answerable)
Within a 2026 query, every shipped load is dated (4,908 null-`actual` loads inherit `scheduled_pickup_on`). Across **all** years
the persisted view has **488 pallet-rows / 3 distinct loads** with neither actual nor scheduled pickup (`dispatched_on` null) —
these are excluded from any date-filtered consumer query (year of null = null). **All 3 carry a non-null `pack_date`**, so adding
`pack_date` as a third `coalesce(actual, scheduled, pack_date)` fallback would date 100% of them. **Recommendation:** add the
`pack_date` fallback (tiny, fully-covered population) — deferred to a follow-up as it's not required for the 2026 surface.

## Next (separate goals — NOT this session)
- **Phase B (Cube):** `dispatch_shipped` cube+view over `semantic.grower_dispatch_shipped`, `VIEW_GROWER_KEYS` RLS anchor,
  deploy-gated. Draft `cube/model/views/dispatch_shipped.yml` + `scripts/ft_dispatch_shipped_reconcile.ts` exist on branch
  `sprint-8-dispatch-shipped` (review/redo there).
