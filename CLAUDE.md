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
filter on claims under **`app_metadata`** — the server-controlled JWT namespace a grower
cannot self-set (Supabase only lets users edit `user_metadata`):

```
grower auth (mm-hub)  →  JWT claim  request.jwt.claims.app_metadata.consignor_id  (uuid)
internal staff/service →  JWT claim  request.jwt.claims.app_metadata.is_internal = true
```

- **`consignor_id` is the grower identity key** across dispatch and (phase 2) settlement.
  `supplier_id` is null on GP records; `consignor` == grower everywhere.
- `semantic.current_consignor_id()` / `is_internal_claim()` read ONLY from `app_metadata`
  (never top-level) and fail closed on a malformed value. RLS on `raw.ft_dispatch_load`,
  `raw.ft_pallet`, and `core.dim_grower` scopes every grower query to their own rows.
- mm-hub MUST set `consignor_id` / `is_internal` inside `app_metadata` (via the admin API or a
  Custom Access Token Hook) — NEVER as a top-level or `user_metadata` claim, or a grower could
  forge it. `service_role` bypasses RLS for ingestion; **Cube** reads via the least-privilege
  `cube_readonly` role (permissive read policy, migrations `0011`/`0012`) and re-applies tenant
  scope itself in `queryRewrite` (see the Cube section below).
- mm-hub must NOT re-implement this filter client-side. The hub enforces it; mm-hub only
  presents the claim.

## Semantic layer (Cube) — lives in THIS repo (`/cube`)
The dispatch **metric layer** is code-defined in `/cube` (Cube Cloud deployment "MM Data Hub").
Metrics are defined ONCE here; Steep and the future Hub MCP consume these governed definitions —
they do not redefine metrics. Consume via the `dispatch` **view** only (base cubes are `public:false`).
Full per-metric contracts: `cube/CONTRACTS.md`.
- **Metric contracts are ADDITIVE-ONLY.** Add new measures/dimensions freely; NEVER redefine an
  existing metric's meaning, grain, or baked-in filter set — it silently breaks every consumer.
- **Baked-in filters** (encoded in each cube's SQL, not per query): `order_type='S'` (Sell),
  dispatched (`actual_pickup_on` not null), non-test consignor. **Null integrity:** `net_weight`
  summed with nulls EXCLUDED, never coalesced to 0. **Grain:** nothing below pallet/line;
  `location_id` and harvest lineage not modelled.
- **RLS = security context, enforced in `cube.js` `queryRewrite`** (NOT Postgres RLS): grower scope
  from `app_metadata.consignor_id`; internal from `app_metadata.is_internal` (the same
  app_metadata-only contract as migration `0010`); neither → **fail closed**. No dimension selection
  can widen a grower's scope. Cube's DB role reads all rows; Cube narrows per query.
- **DB access:** the least-privilege `cube_readonly` role (migrations `0011`/`0012`) — SELECT on
  raw/core/semantic only, all-rows read via a permissive policy, no public/auth/storage, no writes.
  Connection via env var (`CUBE_DB_URL` / Cube Cloud data source), never in code.
- **Consumers connect to Cube, never to Postgres.** Steep uses the native Cube integration (REST
  API URL + `CUBEJS_API_SECRET` + security context `{app_metadata:{is_internal:true}}` for internal
  BI). Postgres-wire BI tools use Cube's **SQL API**, authenticated by `checkSqlAuth` in `cube.js`
  (`CUBEJS_SQL_USER`/`CUBEJS_SQL_PASSWORD`), also mapped to an internal context. Pointing a BI tool
  straight at Supabase bypasses the governed metrics + RLS — don't.
- **Proofs (runnable):** `npm run cube:reconcile` (parity vs raw SQL) · `npm run cube:rls`
  (three-context isolation). Deploy: `cd cube && npx cubejs-cli deploy --token <…>`.

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
- `HANDOFF.md` updated and committed; pushed to `mackaysmarketing/mm-data-hub` (see Git & pushing).

## Git & pushing (read before any git/gh command)
- **Never run `gh` for anything.** This machine cannot reach `api.github.com` (connectex to
  4.237.22.34:443 times out), so `gh auth login`, `gh api`, and gh-as-git-credential-helper all
  **hang**. The plain `github.com` git HTTPS endpoint works fine — use it.
- The repo is owned by the **`mackaysmarketing`** GitHub account. The local `gh` is signed in as
  `timbowilcox`, which has **no write access** — ignore it.
- To push, authenticate git directly with a `mackaysmarketing` **classic PAT (repo scope)** via the
  remote URL, push with credential helpers disabled (so git never falls back to the hanging gh
  helper), then scrub the token back out of the remote URL:
  ```
  git remote set-url origin https://mackaysmarketing:<PAT>@github.com/mackaysmarketing/mm-data-hub.git
  git -c credential.helper= push -u origin main
  git remote set-url origin https://github.com/mackaysmarketing/mm-data-hub.git
  ```
  Never commit or echo the PAT; always restore the clean remote URL afterwards.

## What NOT to do
- Do not migrate, alter, or read `public.*` (mm-hub's schema).
- Do not introduce Postgres enum types — use text + documented values.
- Do not coalesce `net_weight_value`; do not model `location_id`.
- Do not declare done without the loader run output, reconciliation report, and RLS proof.
- Do not commit `.env`.
