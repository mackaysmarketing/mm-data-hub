# mm-data-hub — Claude Code Initializer

## What this is
The **Mackays Data Hub** ingestion + modelling repo. It lands source data into the shared
Supabase hub project `data_hub` (ref `uqzfkhsdyeokwnkpcxui`, region `ap-southeast-2`) and
shapes it through `raw → core → semantic`. **FreshTrack** (packhouse, dispatch) was the first source;
**NetSuite** (finance, grower settlement / RCTIs) is the second — see the NetSuite settlement section
below. See `SPEC.md` for the full design contract and `SPRINT.md` for current scope.

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

## Hub MCP (Phase 4) — lives in THIS repo (`/mcp`)
One governed **read** MCP server (`@modelcontextprotocol/sdk`, stdio, ESM) over what's LIVE: the
Cube `dispatch` view + `semantic.grower_dispatch_detail`. It **consumes** the governed metrics —
never redefines one. Full surface + run docs: `mcp/README.md`. Start: `npm run mcp:server`.
- **Identity-propagating RLS is the central invariant.** The MCP holds **no standing elevated
  access**. Caller identity (`consignor_id` / `is_internal`) enters once from a trusted channel
  (`HUB_MCP_CALLER_TOKEN`, a signed JWT carrying **`app_metadata`**), read app_metadata-ONLY — a
  forged top-level claim is ignored (same contract as migration `0010`). **No tool argument,
  filter, group_by, or `run_select` string can assert or widen scope.** Absent/invalid identity →
  **fail closed** (0 rows).
  - **Metric path** (`query_metric`, catalog tools) → signs a short-lived **per-caller Cube JWT**
    and calls Cube REST `/load`; Cube `queryRewrite` scopes it.
  - **Detail path** (`list_grower_dispatches`, `run_select`) → connects as the least-privilege
    **`hub_mcp`** role (migration `0013`: `NOINHERIT`, member of `authenticated` ONLY, no standing
    data access) and per request does `SET ROLE authenticated` + `SET request.jwt.claims` (the
    caller) so Postgres RLS (`0008`/`0010`) scopes the row. Read-only (always rolls back).
- **Every read returns** `{ columns, rows, metric_definition, filters_applied, row_count,
  truncated }` (SPEC §5). Metric/dimension names are **registry-validated** against the Cube
  catalog (unknowns rejected). `run_select` = `semantic.*` only, no DDL/DML, single statement, row
  cap + statement timeout.
- **Deferred, stubbed (not faked):** `list_grower_sales`/settlement → Phase 2 (read-replica
  blocked). Write/action tools are NOT in this read server — they need the separate audited action
  surface (human confirmation for irreversible actions).
- **Proof (runnable):** `npm run mcp:proof` — identity propagation + parity across internal + 2
  growers + no-claim + forged, both paths (`reports/mcp_proof_<date>.txt`). Secrets via env
  (`CUBE_API_SECRET`, `MCP_DB_URL`), never in code.

## NetSuite settlement (Sprint 5) — RCTIs land in THIS repo (`raw.ns_*` → `core` → `semantic`)
The **second source**: NetSuite (account `11176992`, subsidiary **2** = Mackays Marketing). Lands grower
**settlement (RCTIs)** — gross by product, every deduction, net, and the **paid date** (which FreshTrack
can't give). Same medallion + RLS contract as FreshTrack dispatch.
- **READ-ONLY out of NetSuite — never write.** Access is SuiteQL REST over **OAuth 1.0a TBA
  (HMAC-SHA256)**; the signer is `src/lib/oauth1.ts` (dependency-free, KAT-proven). Creds in gitignored
  `.env` (`NS_ACCOUNT_ID` + `NS_CONSUMER_KEY/SECRET` + `NS_TOKEN_ID/SECRET`). The TBA role needs
  **SuiteAnalytics Workbook** (gates SuiteQL) + Lists→Vendors/Items + Transactions→Find Transaction/Bills.
  Prove auth live: `npm run ns:smoke`. The **REST SuiteQL schema is narrower** than the discovery MCP —
  no `amount`/`posting`/`account`, no `transaction.subsidiary`; use `foreignamount`/`netamount`,
  `mainline`/`taxline`, `uniquekey` line PK.
- **RCTIs = `transaction WHERE type='VendBill' AND entity IN (vendor WHERE category=110)`** (110 = Growers,
  39 vendors). Subsidiary-2 scope is transitive (all 39 are sub 2). **Incremental key = `lastmodifieddate`**
  (a bill mutates after `trandate`); `trandate` = settlement date. Run: `npm run ns:backfill`
  (`-- --since=YYYY-MM-DD` for incremental), then `npm run ns:core`.
- **Grower crosswalk — DETERMINISTIC: `vendor.entityid = core.dim_grower.code` → `consignor_id`.** Use
  `entityid`, **never** `externalid` (rotten: `LRCTU`→`LRCDR`, plus nulls). A code may map to active +
  inactive dim rows (e.g. `WADDA`) → resolve to the **active** row (`core.crosswalk_ns_grower`). Surface
  any unmapped active grower; never silently drop.
- **Line-type contract (the no-double-count guard):** `mainline='T'` = the A/P summary line (= bill total);
  clean detail = `mainline='F'`; `taxline='T'` = GST/RCTI tax. **gross vs deduction by SIGN** of
  `foreignamount` (>0 = money to grower; <0 = deduction). Invariant (proven): `SUM(foreignamount WHERE
  mainline='F') = -(mainline) = bill total`. `core.fact_settlement_bill.recon_diff` = 0 for every bill.
- **Charge taxonomy (`core.dim_ns_charge`, classifier `src/lib/ns_charges.ts`):** `itemid` prefix = category
  — `9xxxxx` PRODUCT (910 banana / 920 papaya / 930 avocado / 960 passionfruit), `1` FR (Freight),
  `2` WH (Warehouse), `3` MD (Market Deductions), `4` MI (Misc), `591xxx` LA (Larapinta — a full parallel
  sales+charge set). `displayname` = `Category - Subcategory - Detail` for charges. Unknown → OTHER (surfaced).
- **Paid date** from `VendPymt`, linked via `raw.ns_bill_payment_link` (PreviousTransactionLineLink,
  `linktype='Payment'`). Unpaid RCTIs → **null paid_date, flagged, never zero-dated**.
- **`semantic.grower_settlement`** (bill grain) — gross, deductions by category, net, **paid_date
  first-class**. `security_invoker`; RLS by `consignor_id` via the **same `app_metadata`-only, fail-closed**
  helpers as migrations `0008`/`0010`. **Cube settlement metrics are ADDED, never redefining a dispatch
  metric**; `cube.js` `queryRewrite` scopes the `settlement` view with the identical contract.
- **Proofs (runnable):** `npm run ns:reconcile` (line reconciliation + TS-oracle drift guard) ·
  `npm run ns:rls` (3 contexts + fail-closed + forgery) · `npm run ns:parity` (hub ↔ live NetSuite) ·
  `npm run cube:settlement` (live Cube metrics + RLS, after deploy).

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
