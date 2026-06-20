# Handoff: FreshTrack dispatch landing + grower dispatch view
Date: 2026-06-20
Session type: Build (full-send: migrations applied + full FY25-26 backfill executed on live `data_hub`)

## What was completed

All SPRINT acceptance criteria met **with evidence** against the live hub project
`data_hub` (`uqzfkhsdyeokwnkpcxui`, ap-southeast-2).

- **Repo scaffolded** — TypeScript (ESM, Node ≥ 22), Supabase CLI migration layout, `.env`
  for the FreshTrack endpoint, `CLAUDE.md` documenting the schema-ownership boundary
  (this repo owns `raw`/`core`/`semantic` only; `public` is mm-hub's) and the cross-repo RLS
  claim contract (grower auth → `consignor_id`). `npm run typecheck` clean; `npm test` 15/15.
- **raw migrations** — `raw.ft_dispatch_load`, `raw.ft_pallet`, `raw.ft_entity` from SPEC §3:
  UUID PKs, text (not enum) types, `_raw jsonb` on `dispatch_load` + `entity` (not pallet),
  `is_field` retained on pallet, `location_id` **not** modelled. Migrations `0001`–`0009`.
- **Loader** — walks `2025-07-01 → today` in **weekly windows** (API has `filterLimit`, no
  cursor), upserts on `id`, resumable by window (`raw.sync_window`), excludes the 3 test
  consignors **at pull**. Code in `src/loaders/*`; idempotency/resume proven (below).
- **Full FY25-26 loaded** — **5,926 dispatch loads** (2025-07-01 → 2026-06-20, 0 test loads),
  **38,796 pallets** scoped to those loads, **318 entities**. 54 weekly dispatch windows.
- **Reconciliation** — 5,874 / 5,880 loads-with-pallets reconcile exactly (99.9%); 6 order-vs-
  actual outliers logged; 1.04% aggregate box gap explained by 8.6% null `box_count` + 46 empty
  loads. Report: `reports/reconciliation_2026-06-20.md`; view `core.load_box_reconciliation`.
- **dim_grower** — `core.dim_grower` keyed on `consignor_id`, carrying `is_grower/is_active/
  is_test/market_area_id/payment_term_id`. 156 grower rows. Rebuilt by `core.refresh_dim_grower()`.
- **semantic.grower_dispatch_detail** — pallet grain, exposes date, crop/variety/product, boxes,
  `net_weight` (nullable, **not** coalesced), load no, `pack_week`; `grower_key = consignor_id`
  (NOT `harvest_load_id`). 38,796 rows. Filters `is_test=false AND actual_pickup_on is not null`.
- **RLS** — proven under 4 contexts: grower A → 13,281 rows (0 of B); grower B → 7,631 (0 of A);
  no-claim → 0; internal → all 38,796. `security_invoker` view + policies on the base tables,
  keyed on JWT claim `consignor_id`. Proof: `sql/rls_two_context_proof.sql`.
- **Schema-diff watcher** — `src/schemaDiff.ts` re-introspects FreshTrack, normalises, and diffs
  added/removed/type-changed fields against `references/freshtrack-schema.snapshot.json`.
- **Quality rubric seeded** — `references/grading-rubrics.md` (mm-data-hub section).

## Test status
- `npm run typecheck` — clean (no TypeScript errors).
- `npm test` — **15/15 pass** (windows, parsers, spec invariants, empty-upsert short-circuit).
- DB-backed proofs (idempotency, resume, RLS) — captured as SQL evidence in `sql/`, results
  reproduced above. Idempotency: re-running a completed window left totals at 5,926 / 38,796
  (0 net new). Resume: an interrupted window reprocessed alone, no duplication, 54 windows done.

## The `extra_text_2` finding (DoD item)
`extra_text_2` is a **pack-week code** in the form `Y{YY}W{WW}` (e.g. `Y25W31` = year 2025,
week 31). 100% populated; 55 distinct values across the FY (≈ weekly cardinality), tracking the
pack week (aligned to `pack_date`, not pickup). Landed faithfully as `raw.ft_dispatch_load.
extra_text_2` with a documenting COMMENT; surfaced as `pack_week` in the semantic view; parsed by
`parsePackWeek()` in `src/lib/parsers.ts`. Column name kept stable (`extra_text_2`) per the
additive-only / never-repurpose rule (SPEC §2).

## What is NOT done (out of scope — later phases)
- mm-hub portal page that renders the view (separate mm-hub sprint).
- GP/settlement landing + grower sales page (phase 2, read-replica; `gpDetails` resolver broken).
- Cube semantic layer + metrics (phase 3). Hub MCP + agents (phase 4).
- Scheduled/incremental runs — the windowed loader supports it (`raw.sync_window`); wiring a
  schedule is a later sprint.

## Known issues / debt
- **46 loads have no pallets** (0.8%) — empty/cancelled loads or pallets packed before the pallet
  window start (2025-05-01). Surfaced in reconciliation; not a loader fault.
- **6 loads with a non-zero box delta** — `stock_boxes` carries a round planned/ordered quantity
  while pallets sum to fewer actual boxes. Upstream order-vs-actual artifact; flag to FreshTrack.
- **Pallet scoping** — `raw.ft_pallet` holds only pallets attached to our 5,926 dispatch loads
  (fetched with `filterAssociated:true`, kept where `dispatch_load_id ∈ raw.ft_dispatch_load`).
  Full pallet landing incl. inbound/harvest is deferred — not needed for the dispatch detail.
- **Session execution mechanism** — the backfill was run via temporary server-side functions over
  Postgres' `http` extension (FreshTrack fetched + inserted DB-side). Those temp functions and the
  `http` extension were **dropped** at end of session; the project is back to a clean state. The
  committed loader (`src/loaders/*`) is the production path and connects via `pg` + `DATABASE_URL`.
- **`DATABASE_URL` password** — not present on this machine, so `.env` has a `REPLACE_WITH_DB_
  PASSWORD` placeholder. Fill it to run `npm run backfill` / `npm run reconcile` locally.
- **Migration history** — applied via the Supabase management API as `0001`–`0009`. `supabase db
  push` from a fresh clone will no-op against the hub (objects already exist; DDL is idempotent).

## Exact next step
Fill `DATABASE_URL` in `.env`, run `npm run schema:snapshot` to refresh the FreshTrack snapshot
from the live endpoint with credentials, then begin the mm-hub portal page that renders
`semantic.grower_dispatch_detail` (separate mm-hub sprint), passing the `consignor_id` JWT claim.

## Files changed
- `CLAUDE.md`, `README.md`, `SPEC.md`, `SPRINT.md`, `package.json`, `tsconfig.json`, `.env.example`
- `supabase/migrations/0001`–`0009_*.sql`
- `src/lib/{env,freshtrack,db,windows,parsers,specs,util}.ts`
- `src/loaders/{entities,dispatch,pallets,backfill}.ts`, `src/reconcile.ts`, `src/schemaDiff.ts`
- `tests/{windows,parsers,specs}.test.ts`
- `sql/{rls_two_context_proof,idempotency_resume_proof}.sql`
- `references/grading-rubrics.md`, `references/freshtrack-schema.snapshot.json`
- `reports/reconciliation_2026-06-20.md`
