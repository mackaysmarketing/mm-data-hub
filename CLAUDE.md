# mm-data-hub — Claude Code Initializer

## What this is
The **Mackays Data Hub** ingestion + modelling repo. It lands source data into the shared
Supabase hub project `data_hub` (ref `uqzfkhsdyeokwnkpcxui`, region `ap-southeast-2`) and
shapes it through `raw → core → semantic`. FreshTrack (packhouse) is the first and only
source in v1. See `SPEC.md` for the full design contract and `SPRINT.md` for current scope.

## Schema-ownership boundary (NON-NEGOTIABLE)
The `data_hub` Supabase project is **shared**. Ownership is split by schema:

| Schema | Owner | This repo may… |
|---|---|---|
| `raw`, `core`, `semantic` | **mm-data-hub (this repo)** | create, migrate, own freely |
| `public` (mm-hub app tables: `farms`, `hub_users`, `ft_pallets`, `remittances`, …) | **mm-hub** (separate repo) | **never** migrate, drop, or alter |
| `auth`, `storage`, … | Supabase platform | never touch |

- This repo's migrations only ever touch `raw` / `core` / `semantic`.
- mm-hub's legacy `public.ft_*` tables are its own landing — do **not** read or write them here.
- Never `DROP`, `ALTER`, or `TRUNCATE` anything in `public`.

## Cross-repo RLS claim contract (with mm-hub)
mm-hub authenticates growers (email auth) and issues a JWT. The hub's grower-scoped objects
filter on a single claim:

```
grower auth (mm-hub)  →  JWT claim  request.jwt.claims.consignor_id  (uuid)
```

- **`consignor_id` is the grower identity key** across dispatch and (phase 2) settlement.
  `supplier_id` is null on GP records; `consignor` == grower everywhere.
- `semantic.current_consignor_id()` reads that claim. RLS on `raw.ft_dispatch_load`,
  `raw.ft_pallet`, and `core.dim_grower` scopes every grower query to their own rows.
- An internal claim `request.jwt.claims.is_internal = true` (hub staff / service) sees all.
  `service_role` bypasses RLS for ingestion + Cube/Steep reads.
- mm-hub must NOT re-implement this filter client-side. The hub enforces it; mm-hub only
  presents the claim.

## Stack
- TypeScript (ESM, Node ≥ 22 — run `.ts` directly via `--experimental-strip-types`).
- Supabase Postgres 17 (`data_hub`). Loaders write via `pg` (direct), never PostgREST.
- FreshTrack GraphQL: `filterLimit`-only (no cursor) → windowed loaders, paginate by time.
- Migrations: Supabase CLI layout (`supabase/migrations/NNNN_*.sql`); applied to the hub.

## Data-quality invariants (from SPEC §9 — encode, don't re-discover)
1. `pallet.harvest_load_id` is null on outbound → grower attribution = **load's consignor**,
   never the pallet harvest link.
2. `pallet.location_id` is declared non-null but returns null → **not modelled**.
3. `net_weight_value` is produce-dependent & nullable → **never coalesce to 0** in averages.
4. Test consignors `TRUGTEST`, `LARATEST`, `ANNRTEST` (inactive, `*TEST` code) → **excluded at pull**.
5. `extra_text_2` is a **pack-week code** (`Y{YY}W{WW}`, e.g. `Y25W31`) → land faithfully, derive `pack_week`.
6. `order_type` is `S`/`B` (Sell/Buy) → **text, never a Postgres enum** (additive-only schema evolution).
7. `product_description` / `supplier_highlights` carry display format codes (`^{b}^{c blue}[36]…`) → parse, don't display raw.

## Before you start
1. Read `SPRINT.md` for this session's scope and acceptance criteria.
2. Confirm any migration touches only `raw` / `core` / `semantic`.
3. Confirm the live target is `uqzfkhsdyeokwnkpcxui` (never the `Analytics Agent` project).

## Definition of done
- Acceptance criteria in `SPRINT.md` all checked **with evidence**.
- `npm run typecheck` clean; `npm test` green.
- Idempotency, window-resume, and two-context RLS isolation proven (SQL evidence).
- `HANDOFF.md` updated and committed; pushed to `mackaysmarketing/mm-data-hub`.

## What NOT to do
- Do not migrate, alter, or read `public.*` (mm-hub's schema).
- Do not introduce Postgres enum types — use text + documented values.
- Do not coalesce `net_weight_value`; do not model `location_id`.
- Do not declare done without the loader run output, reconciliation report, and RLS proof.
- Do not commit `.env`.
