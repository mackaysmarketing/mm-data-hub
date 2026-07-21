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

## Auth0 third-party auth (grower-portal) — the SECOND grower identity path (0050, 2026-07-16)
**grower-portal** (grower-facing UI rebuild, separate repo) authenticates growers with **Auth0**
(tenant `grower-portal`, AU region; issuer `https://grower-portal.au.auth0.com/`). Supabase
third-party auth (project config) accepts those RS256 JWTs beside mm-hub's own; grower identity
arrives as the NAMESPACED TOP-LEVEL claim **`https://grower-portal.mackays.com.au/consignor_ids`**
(string array, set by the tenant's post-login Action). Renaming claim/issuer = breaking for both
repos — coordinate first; full contract: `docs/mm-hub-auth0-integration.md`.
- **⚠ TENANT CUTOVER IN PROGRESS (0057, 2026-07-20):** the properly-named production tenant
  **`mackaysmarketing`** (AU; issuer `https://mackaysmarketing.au.auth0.com/`; claim namespace
  `https://mackaysmarketing.com.au`) is replacing `grower-portal` (tenants can't be renamed).
  All four claim helpers resolve namespace BY ISSUER and honor each issuer's claims ONLY under
  its own namespace; the app_metadata deny guards refuse BOTH Auth0 issuers (the FUTURE-ISSUER
  invariant compliance case). Runbook + remaining steps: `docs/auth0-tenant-cutover.md`. After
  cutover, **0060** drops the old issuer/namespace from all FIVE claim helpers and this section
  is rewritten single-tenant (0058/0059 were taken by the directory-hierarchy and activation
  asks).
- **`semantic.auth0_consignor_ids()`** honors that claim ONLY when `iss` equals the Auth0 issuer
  EXACTLY (incl. trailing slash); any other/missing issuer → empty set. Array-only, per-element
  uuid-validated, de-duplicated, fail-closed — the 0026 parsing rigor.
- **ADDITIVE `auth0_grower_own_*` policies** on every grower-scoped relation — the 0026 six plus
  `core.fact_load_sale` (0054, grower-portal fix pack); the mm-hub `grower_own_*` policies are
  untouched (permissive policies OR). NO internal branch — Auth0 tokens are grower-OR-STAFF
  (0056, below), `is_internal` stays an mm-hub-only assertion. **Every new grower-scoped relation
  needs ALL THREE policies (grower_own_* + auth0_grower_own_* + auth0_staff_read_*) + the
  pinned-set updates in rls_posture / rls_multifarm / auth0:rls (they hard-pin the set — that is
  the point).**
- **STAFF claim (0056, Tim-approved 2026-07-18; direction = ALL user auth moves to Auth0):**
  `https://grower-portal.mackays.com.au/staff` = boolean `true` (absence IS the negative), minted
  by the same Action from Auth0 `app_metadata.mm_staff === true`. `semantic.auth0_is_staff()` —
  issuer-pinned, STRICT boolean-true, fail-closed — quals the additive `auth0_staff_read_*`
  policies (third permissive set, the 7 grower relations) + gates staff-only
  `semantic.grower_directory` (explicit WHERE gate, 0035 pattern — grower/mm-hub/Cube/MCP
  contexts get 0 rows). Directory v2 (0058): + `entity_id`/`parent_entity_id`/`parent_name` —
  the FreshTrack parent hierarchy (raw.ft_entity.parent_id, denormalized onto dim_grower at
  refresh because raw is ungranted); the portal groups by immediate parent. Proof: portal:verify
  F8. Directory v3 (0059): + `portal_enabled` — admin-curated activation from
  `core.portal_grower_activation` (SEPARATE table, not a dim column: the dim is rebuilt and
  curated state on a rebuilt dim gets silently reset — the revenue_class lesson). Absence of a
  row = false, so a new FreshTrack consignor never auto-appears. Seeded: LRCOL+LRCLA+LRCTU,
  MACKF+5 farms.
- **ADMIN tier + the FIRST write path (0059):** `semantic.auth0_is_admin()` — `hub_role` claim ∈
  {admin, hub_admin}, JSON string, issuer-pinned/namespace-by-issuer, fail-closed — gates
  `semantic.set_grower_portal_enabled(uuid[], boolean)`, this repo's FIRST **SECURITY DEFINER**
  function. **Admin ≠ staff ≠ internal:** admin is a WRITE gate only (an admin-without-staff
  token reads 0 rows everywhere — proven); staff cannot toggle activation (42501). Definer rules
  now enforced by **rls_posture A7**: every security-definer function in raw/core/semantic must
  be on the pinned list, pin an EMPTY `search_path`, and never be PUBLIC/anon-executable —
  extend the pin in the same change or the sweep fails. Proof: `auth0:rls` S6 (authorization
  matrix, every call rolled back), `portal:verify` F9. **Staff ≠ internal:** the claim NEVER opens internal-only surfaces
  (customer book, AR, scan, insight). Accepted residual: an Auth0 tenant admin flipping
  `mm_staff` = read of the whole grower surface — keep the tenant admin set small + MFA'd.
  Moving the internal staff hub (mm-hub) itself onto Auth0 is the stated direction but a
  SEPARATE future change (it would need an Auth0→internal claim design; not 0056).
- **Trust partition (0050 guards):** `current_consignor_ids()` / `is_internal_claim()` now REFUSE
  `app_metadata` on an Auth0-issued token — a tenant Action can never assert `is_internal` or the
  mm-hub claim shape. Each issuer's claims flow ONLY through its own helper; both fail closed.
  No existing mm-hub / Cube / Hub-MCP / proof context carries the Auth0 iss → byte-identical.
- **⚠ FUTURE-ISSUER INVARIANT:** the deny guards deny ONLY the grower-portal issuer. Enabling
  ANY additional third-party issuer on the project re-opens the app_metadata path for that
  issuer — extending the deny guards (or inverting to an issuer allow-list) is REQUIRED in the
  same change.
- **Platform-level residuals (the DB cannot defend):** (1) the JWT `role` claim maps to the
  Postgres role, so the tenant Action must set `role=authenticated` ONLY — an Action emitting
  `role=service_role` would bypass RLS entirely; keep the Auth0 tenant locked down. (2) Enabling
  third-party auth is PROJECT-level: Auth0 tokens become valid `authenticated` sessions for
  mm-hub's `public` schema + storage too — mm-hub must audit its authenticated policies against
  Auth0-issued tokens BEFORE enablement (this repo cannot guard `public`).
- **Ordering:** `rls:posture` (grower-scoped class) and `auth0:rls` hard-require 0050 live —
  apply the migration before running the standing suite; land migration + script together.
- **Grower-readable surface via Auth0 = identical to via mm-hub** (proven parity): the grower
  semantic views + shared-reference lookups; internal-only/etl-only/ungranted stay closed. REST
  access from grower-portal additionally needs `semantic` in the API's exposed schemas.
- **Proof:** `npm run auth0:rls` (self-deriving: identity-path parity, wrong-iss + supabase-iss
  forgery, hostile-hybrid app_metadata, mm-hub-untouched) · `rls:multifarm` · `rls:posture`
  (grower-scoped class now also REQUIRES the additive auth0 policy).

## Grower-portal fix pack (0053/0054/0055, 2026-07-18) — the portal-facing surface upgrades
Delivered against grower-portal's handover doc (FIX 1–7). Proof: **`npm run portal:verify`**
(24 checks, self-deriving; test pair resolved by grower code LRCLA/LRCTU).
- **GP settlement period (0053):** `raw.ft_gp_schedule.date_from/date_to` are null at the SOURCE
  (3/1,332, all self-inconsistent TEST rows) → `core.refresh_fact_gp_settlement()` DERIVES them
  from `week_no` (Monday of that ISO week — the pack-week calendar; year picked as the latest
  week-start ≤ coalesce(payable_on, created_on)). `dates_derived` flags it; the 5 null-week AG*
  schedules stay null, surfaced. Never trust source `date_from/date_to`.
- **Product labels (0055):** cleaned in the SEMANTIC views only (raw lands faithfully, SPEC §9.7)
  via `semantic.clean_product_label()` — strips `^{...}` + leading `[N]`, falls back
  variety → crop → NULL (484 in-scope pallets have none of the three; surfaced). Verbatim kept as
  `product_raw`. Trailing "- WOW" retailer hints KEPT (still load-bearing until retailer field
  adoption). Applies to `grower_dispatch_shipped` + `grower_dispatch_detail`.
- **`core.fact_load_sale` (0054) — the 7th grower-scoped relation:** load × customer grain,
  denormalised AT BUILD TIME from internal-only `fact_customer_invoice` × `crosswalk_customer_retail`
  (the 0020 pattern — grower invoker views must never touch internal relations). Carries
  `retailer_group` (never `consignee_name`); CN invoices subtract. Rebuilt by **`ar:core`**
  (run `insight:core` first after consignee churn or retailer_group goes stale). 141 invoices
  whose loads predate the dispatch landing drop out (surfaced in `portal:verify`).
- **`semantic.grower_dispatch_load` (0055):** one row per shipped load (non-archived pallets) +
  **`consignment_status`** — Tim's grower lifecycle replacing dispatch/PD-PA states: Not Consigned →
  Consigned → Sold → Paid. **Connote = `manifest_no` — CONFIRMED by Tim 2026-07-17** (FreshTrack has
  NO connote column anywhere — replica searched; manifest_no carries carrier con-note numbers, 100%
  populated on the pair's shipped loads). Sold = state seq ≥ 10 OR landed invoice OR settled; Paid = ALL the load's
  schedules PD (cash evidence wins), state ≥ 13 fallback only where GP lineage predates the landing.
  All signals exposed as columns — every status count must stay explainable.
- **`semantic.grower_load_sale` (0055):** load × customer for growers — retailer_group + gross +
  share_of_load_gross; join `grower_gp_settlement_load` on `dispatch_load_id` for the FIX 7
  drill-down (deduction_* columns were already there).
- **⚠ ARCHIVED PALLETS ARE A LOAD-LEVEL FLAG (0061, 2026-07-21):** `raw.ft_pallet.is_archived` is
  all-or-nothing per load — of 19,205 shipped Sell loads, 14,577 are wholly live, **4,628 wholly
  archived, and only 3 mixed**. So `where not is_archived` in a pallet rollup does not drop
  pallets, it **deletes whole loads** — which is what hid 4,628 loads carrying **$58.7M of customer
  invoices and $8.95M of settlement** from `grower_dispatch_load` (the portal's "Not linked to a
  load" bucket). Archived loads are reconsignment **destinations** (4.2% origins vs 26.1% for live
  loads), so their boxes are terminal and safe to count. `grower_dispatch_load` now keeps the
  exclusion for MEASURES, falls back to the load's own pallets when none are live, and exposes
  **`is_archived`**. NEVER use `pallet_no` as pallet identity — it is reused across loads (48,338
  collide among live pallets alone).
- **Settlement origin lineage (0061):** `core.fact_gp_settlement_load` /
  `semantic.grower_gp_settlement_load` carry **`origin_dispatch_load_id` / `origin_load_no` /
  `origin_load_count`** — the load the GROWER dispatched (`coalesce(original_dispatch_load_id,
  dispatch_load_id)` PER DETAIL ROW), denormalised at build time (the 0020/0054 pattern). The
  sale-load `load_no` means nothing to a grower — 10,147 lines carry an origin ≠ the sale load.
  **1,158 of 19,005 groups draw from >1 origin → `origin_*` are NULL, `origin_load_count` says so;
  never pick a winner** (`original_dispatch_load_id` is a legacy `max()` — prefer `origin_*`).
  Exact per-origin money needs a sibling fact at origin grain — `raw.ft_charge_applied` carries
  `original_dispatch_load_id` too, so deductions split exactly with no apportioning.
- **The residual 1,043 settlement lines ($4.04M) are `order_type='B'` (Buy) loads** — present,
  shipped, with pallets, but outside the Sell-only governed gate. Exposing them is a business
  decision that would redefine an existing metric; do not relax the gate silently.
- **NetSuite RCTI ↔ GP schedule key (evidence 2026-07-21, crosswalk NOT built):**
  `ns_vendor_bill.tranid` is structured **`yyww-CODE[-CROP][-N]`** where `ww` = `ft_gp_schedule.week_no`.
  **(grower_code, date) is NOT 1:1** — 152 crop-split bills, 78 side bills. At (code, year, week):
  781 of 912 cells tie to the cent, 131 differ ($12.1M). Produce-grain money is ALREADY landed and
  reconciles to the cent from `raw.ns_vendor_bill_line`; only `quantity`/`rate`/`item.parent` are
  missing from the loader. `PA` = Payable, NOT unpaid (all 33 have a paid date; 7 PD have none).
- **`public` REST audit (FIX 3, 2026-07-17):** anon = zero policies (fail-closed; grants dead).
  Auth0/grower tokens: identity-scoped mm-hub policies fail closed (`auth.uid()` cast errors on an
  Auth0 sub); residual = five `using(true)` authenticated-read reference tables (retailers=3 rows,
  distribution_centres=15, others empty). mm-hub's call to accept or tighten — NOT this repo's schema.

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
- **Multi-farm identity (closeout 2026-07-11):** the MCP carries the 0026 consignor SET —
  `app_metadata.consignor_ids[]` (per-element UUID-validated, fail-closed) with scalar fallback;
  a single-farm claim payload stays byte-identical to pre-0026. **`list_grower_sales` is LIVE**
  (schedule-grain settlement over `semantic.grower_gp_settlement`, RLS detail funnel, paid_date
  first-class). Cube reads send **`renewQuery: true`** (low-QPS governed surface: Cube's
  per-query-shape result cache was observed serving pre-ingest counts; freshness beats cache).
  Write/action tools are NOT in this read server — they need the separate audited action surface.
- **Proof (runnable):** `npm run mcp:proof` — SELF-DERIVING (no count/uuid constants; expectations
  computed in-run from source SQL; fixtures resolved by grower code incl. the real multi-farm
  grower). Identity propagation + parity across internal + growers + multi-farm UNION + no-claim +
  forged, all paths (`reports/mcp_proof_<date>.txt`). Run with loaders QUIESCENT. Secrets via env
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

## FreshTrack GP settlement (Sprint 6) — GP schedules land in THIS repo (`raw.ft_gp_*`/`ft_charge*` → `core` → `semantic`)
The **third source** and the **second view of grower settlement** (NetSuite RCTIs are the accounting
mirror). Its unique value over NetSuite is **load-grain lineage**: every settlement line carries
`dispatch_load_id`, so settlement joins back to dispatch. Landed via FreshTrack's **direct Postgres
read-replica** (the first non-GraphQL ingress). Same medallion + `app_metadata` RLS contract.
- **READ-ONLY out of the replica — never write.** `FRESHTRACK_DATABASE_URL`, role
  `cloud_mackaysmarketing_readonly`; the session pins `default_transaction_read_only`. Connector
  `src/lib/freshtrack_db.ts`. Probes: `ft:db:smoke`/`explore`/`gp-profile`/`charge-profile`.
- **THE DEDUCTION MODEL = `charge_applied`** (the normalized ledger), NOT `gp_detail.extra_*`.
  Settlement scope = **`charge_applied.gp_schedule_id IS NOT NULL`** (the ~24k null-schedule rows are
  unsettled; excluded). Dims: `charge` (rate card) + `charge_type` (`scope`, `account_code`) + `gp_status`
  (PA/PD/DR). Migration `0018` (raw), `0019` (core), `0020` (semantic). Loader `src/loaders/ft_gp.ts`:
  full backfill / **incremental by `last_modified_on`** (`-- --since=YYYY-MM-DD`) / slice; idempotent
  (upsert on `id`), resumable via `raw.sync_window`. Then `npm run ft:gp:core`.
- **Net = gross − deductions − GST** (validated live: 97% of paid schedules within 1% of `gp_payment`).
  `gross = Σ gp_detail.box_quantity × price_invoiced_value`; `deductions = Σ charge_applied
  (is_deductible)` by category; `GST` from `vat_info` (**`EX`→×0.10, `INC`→×1/11, `FREE`→0**, matching
  FreshTrack's own `public.v_power_bi_charge_split`). **Anchored on `gp_payment`** (the cash); the
  **original-load split apportionment is NOT replicated** (`quantity_value/text_2` explodes; the residual
  is surfaced, not hidden). **`gp_schedule.invoiced_amount_value` is UNRELIABLE** ($33M vs true gross
  $177M) — do not anchor on it.
- **Charge taxonomy (`core.dim_gp_charge`, classifier `src/lib/ft_gp_charges.ts`):** `charge_applied.account_code`
  first digit is PRIMARY — `1` FR · `2` WH · `3` MD · `4` MI · `5` LA — with `charge_type.scope`/`charge.name`
  as fallback (messy: `'WH  - Handling'`, `'MD- Levy'`, null scope). **⚠ GP `LA` = "Load Adjustment"
  (account 5xxxxx), NOT NetSuite's LA = Larapinta** — shared code, different meaning, documented.
  Unknown → OTHER (surfaced; currently $0). ~5k applied rows carry **no `charge_id` but DO carry
  `account_code`** → classify by the LINE account_code (dim is the fallback).
- **Grower crosswalk — DETERMINISTIC: `gp_schedule.consignor_id` = `core.dim_grower.consignor_id`** (no
  code-matching, unlike NetSuite). **RLS anchors on the SCHEDULE consignor** (`core.crosswalk_gp_grower`),
  **NOT `gp_detail.consignor_id`** — which can be the ORIGINAL grower on a reconsigned load (the 45-vs-35
  gap; 10 detail-only originals surfaced, never settled). Source quirks **surfaced, not dropped**: 52
  schedules with null consignor (internal-only via RLS), 48 with no `gp_payment` row (null paid_date,
  flagged, never zero-dated).
- **Facts:** `core.fact_gp_settlement` (schedule grain) + `core.fact_gp_settlement_load` (**load grain**
  via `dispatch_load_id` — the lineage NetSuite cannot provide). Deduction/GST columns signed; `net =
  gross + deductions + gst`. **`netsuite_id` is UNUSABLE** as a cross-source key (2/155 charges, 0/30
  charge_types populated) → cross-source join is by **grower (`consignor_id`) + the shared FR/WH/MD
  taxonomy**, not `charge.netsuite_id`.
- **`semantic.grower_gp_settlement`** (schedule) **+ `semantic.grower_gp_settlement_load`** (load) —
  `security_invoker`; RLS by **schedule `consignor_id`** via the **same `app_metadata`-only, fail-closed**
  helpers as `0008`/`0010`/`0016`; `cube_readonly` read-all (mirror `0012`). **Paid date first-class.**
  **Cube GP metrics are ADDED** (`gp_settlement` + `gp_settlement_load` views, `gp_*` measures), never
  redefining a dispatch/NetSuite-settlement metric; `cube.js` `queryRewrite` scopes both with the
  identical contract.
- **Proofs (runnable):** `npm run ft:gp:reconcile` (TS-oracle drift guard + cash recon to `gp_payment` +
  PBI/NetSuite anchors) · `npm run ft:gp:parity` (cross-source GP↔NetSuite per grower; grand net 0.6%,
  deductions 0.1%) · `npm run ft:gp:rls` (both views × 5 contexts) · `npm run cube:gp` (live Cube, after
  deploy). **Cross-source ties:** GP paid **$140.5M** ≈ NetSuite net **$139.7M**; GP deductions
  **$32.53M** ≈ NetSuite **$32.50M**. Per-grower differences = GP's finer consignor granularity (AG*
  sub-entities + null-consignor aggregates NetSuite rolls into vendor RCTIs) — surfaced, accounting closes.

## Conformed dimensions + cross-source tie + governance (closeout sprint, 2026-07-11)
- **Dims (0033/0034):** `core.dim_customer` (consignee grain; names via the `raw.ft_entity`
  **BACKLINK** `e.consignee_id` — NEVER `e.id`; INTERNAL-ONLY: the customer list is commercially
  sensitive) · `core.dim_product` (from the replica product master + crop/variety/pack_type;
  SHARED REFERENCE) · `core.dim_date` (**pack-week rule, verified 98.91%: `extra_text_2` = ISO week
  of `scheduled_pickup_on`, NOT pack_date (~47%)**; SHARED REFERENCE). Load: `npm run ft:ref:load`
  (replica full-sync) then the `core.refresh_dim_*()` functions. Proof: `npm run dims:verify`.
- **Settlement tie (0035):** `semantic.recon_settlement_source` — GP ↔ NetSuite at grower × month,
  FULL OUTER with `match_status` buckets, STRICT internal-only (explicit `is_internal_claim()`
  gate). Proof: `npm run settle:tie` — every dollar of the cross-source delta partitions into named
  buckets with $0 unexplained; report committed per run.
- **RLS posture registry (`npm run rls:posture`):** EVERY raw/core/semantic relation is asserted
  against an explicit posture class {grower-scoped, internal-only, shared-reference, cube-only,
  etl-only, semantic-invoker, shared-reference-view, ungranted-view}. **A new relation MUST be
  added to the registry in scripts/rls_posture.ts or the sweep fails** — that is the point.
  0036 lore: `dim_gp_charge`/`dim_ns_charge` policies were dead without grants (fixed);
  `core.dim_shed` is a VIEW whose authenticated grant is load-bearing for grower views.
- **Retail proof:** `npm run retail:reconcile` (day-grain dedupe, watchlist, parity derived from
  raw in-run, NULL preservation). Woolworths has landed ZERO rows to date — a scraper gap,
  surfaced there, not a hub bug.
- **Proof style contract: hardcoded baselines are FORBIDDEN.** Every proof derives its expected
  numbers in-run from source SQL (mcp_proof + rls_multi_farm_proof were converted after their
  hardcoded snapshots rotted on the first freshness load). Never assert an absolute count constant.
- **⚠ revenue_class persistence:** `ft:gp:core` rebuilds `core.dim_gp_charge` DELETE+INSERT and
  RESETS `revenue_class` to NULL. Harmless while unmarked — but the post-checkpoint wiring MUST
  persist Tim's marking through rebuilds (seed table or classifier rules re-applied in the loader),
  never a one-off UPDATE.

## Accounts receivable — customer invoices + remittance reconciliation (AR sprint, 2026-07-12)
The **receivable mirror** of grower settlement. INTERNAL-ONLY throughout (customer book is
commercially sensitive; no grower RLS). Two sources land the same money: FreshTrack = invoice ORIGIN
(dispatch/order lineage), NetSuite = debtor/cash STATUS. READ-ONLY out of both — never write.
- **Landing (0037/0038/0039):** `raw.ft_invoice` + `raw.ft_dispatch_load_invoice` (FreshTrack replica,
  `ft:invoice:load`, 1 load/invoice) · `raw.ns_customer_invoice`/`_line`/`_payment`/`_credit` +
  `ns_ar_apply_link` + `ns_customer` (SuiteQL, `ns:ar:load`, subsidiary-2 scope) · `raw.remittance` +
  `raw.remittance_line` (`remit:load`). All raw = etl-only posture.
- **THE CROSSWALK is `ns_customer_invoice.externalid = ft_invoice.invoice_no` (FTxxxxx)** — deterministic
  (NOT `ext_link`, which is sparse on recent invoices). FreshTrack `payment_status` is STALE (PB on
  already-paid invoices) — **paid status comes from NetSuite**: apply-link
  (`ns_ar_apply_link`, previoustype CustInvc) → CustPymt gives paid_amount + paid_date, CustCred gives
  credits. ⚠ the AR apply-link synthetic key needs **linktype+nexttype** (a CustInvc line links to both
  a payment AND a credit with the same doc/line numbers — the RCTI 4-part key collides on AR).
- **Core (0040):** `core.fact_customer_invoice` (invoice grain, customer AR = invoice_type IN
  PI/SI/CN/DR — RCTI excluded; paid_status paid[has cash]/credited[credit-memo only]/part/unpaid/
  no_ns_match; paid_status + open_amount BOTH anchor on coalesce(ns_amount,amount_value)) + `core.fact_remittance_line`
  (Coles line reconciled to the invoice by **literal** invoice_no — NEVER strip a suffix, FT003402A ≠
  FT003402; recon_status matched/amount_mismatch/claim/unmatched). `ar:core`.
- **Coles remittance = text PDF** (pure parser `src/lib/remittance_coles.ts`, PDF→text via pypdf in the
  loader; checksum Σ line payment = header total). Line = `Invoice/Claim No | Doc Type KD/LJ | Date |
  Store (C+b2b_code) | Document$ | Discount$ (Coles 2.5% = the retail rebate) | Payment$ | GST | WT`.
  Claims (LJ / REV… / bare numbers) match no invoice = the deductions bucket. **Woolworths/ALDI parsers
  + auto-ingestion channel are DEFERRED** (need samples / channel); the parser is per-retailer pluggable.
- **Semantic (0041, internal-only, security_invoker):** `ar_customer_invoice`, `ar_debtor_open` (aged
  open receivables), `ar_remittance_reconciliation` (the discrepancy report — the headline surface).
- **Proofs (runnable):** `npm run ar:reconcile` (landing parity + NS↔FT crosswalk + cash tie Σ
  paid==Σ applied CustPymt, all derived in-run) · `npm run remit:reconcile` (checksum + recon buckets +
  2.5% discount; report committed) · `npm run ar:rls` (internal-only fail-closed, 2 facts + 3 views).

## Retail scan — Coles weekly sell-through (scan sprint, 2026-07-12)
The DEMAND signal (SPEC §1's "retail scan"): actual units/kg/dollars sold through Coles checkouts,
weekly, by geography × banana segment × channel — beside the shelf-price domain (`raw.retail_prices`).
Source = the Circana "Weekly Sales (Scan)_SUP" CSV Tim downloads from Coles (manual drop for now).
INTERNAL-ONLY exposure; category-level (NO EAN/SKU).
- **Parser `src/lib/retail_scan_coles.ts`** — PURE, header signature pinned exactly (98 cols, 19
  measures × 5 variants; casing quirks pinned); ANY drift throws (the loader run fails loudly —
  update MEASURE_GROUPS in one place). 3 variants landed per measure: current / `_ya` /
  `_pct_2ya` (vs-YA deltas are pure derivations, discarded) = **`SCAN_MEASURE_COLUMNS` (57) — the
  single source of truth shared by parser, loader spec, and drift-guard proof**.
- **Product is a HIERARCHY PATH `<child>-<parent>`** (split on FIRST '-'): own-brand export → child
  = segment, parent = BANANAS; **manufacturer-split export → child = SUPPLIER, parent = segment**
  (market share by supplier: FRESHMAX, PERFECTION FRESH, ROCK RIDGE, PRIVATE LABEL, OTHER MFRS…).
  Core conforms to segment (ALL/REGULAR/PRE_PACK/LADY_FINGER/OTHER) × supplier (NULL = no split);
  unknowns land verbatim, surfaced. Unique grain guard is NULLS NOT DISTINCT.
- **Landing (0042):** `raw.retail_scan`, natural key retailer|geography|product|time_label|causal;
  weekly re-drops of the rolling 52-week window UPSERT — loader (`scan:load`) sorts files
  **oldest-first by mtime so the newest export's revisions win**. `Latest N W/E` snapshot rows stay
  raw-only. **The channel checksum (in_store + online == TOTAL on units/dollars/volume) is enforced
  pre-write**; null legs = incomplete (surfaced, skipped — data absence ≠ additivity violation).
- **Core (0043, `scan:core`):** `core.fact_retail_scan` weekly grain (week_ending parsed DD-MM-YY →
  20yy; geography AU/NSW+ACT/QLD/SA+NT/TAS/VIC/WA). **Semantic (0044):** `semantic.retail_scan`
  joins `core.dim_date` → pack_week_code (scan weeks ↔ pack weeks), promo share + YoY derived
  null-safe. Both internal-only (0040 posture).
- **Proofs:** `npm run scan:reconcile` — column drift-guard vs SCAN_MEASURE_COLUMNS, raw↔fact
  parity, channel checksum 0-mismatch, conformance, NULL preservation, internal-only RLS behavioral.
- **Woolworths scan (0049, WOW sprint 2026-07-13):** the Q.Checkout counterpart —
  `scripts/parse_wow_scan.py` (Python, fail-loud, finest-grain-only to dodge the 8× total-grain
  trap) → `raw.wow_scan_loads`+`raw.wow_scan_export` (etl-only) → `core.wow_scan_weekly` (typed,
  PK = week×article×state×VCU×channel×promotion, UPSERT for Quantium restatements, internal-only) →
  `semantic.v_wow_scan_national`/`_promo`/`v_scan_cross_retailer`. **BOTH scans end TUESDAY** → the
  cross-retailer union aligns exact-date. `npm run wow:load` (runs the parser) · `npm run wow:verify`.
  Full-scale AC numbers await the real 303k export.
- **Deferred:** ALDI scan (per-retailer pluggable), auto-ingestion channel, SKU-level scan, the
  Coles↔WOW article-mapping table, Cube exposure.

## Insight layer + NL foundation (insight sprint, 2026-07-12)
The first CROSS-domain analytics (all INTERNAL-ONLY) + the business-vocabulary layer.
- **Crosswalks (0045):** `core.crosswalk_customer_retail` (consignee → retailer_group × state;
  INTERNAL rULE FIRES BEFORE retailer prefixes — MM %/test/QPI/shed names; 100% of retail dispatch
  volume mapped) · `core.crosswalk_product_segment` (product → scan segment; Lady Finger BEFORE
  organic; bins/value-added → OUT_OF_SCOPE; kg_per_box = net_weight_value). Rebuilt by
  `insight:core` — re-run after any dim refresh.
- **`core.fact_market_week` (0046):** week_ending × retailer_group × state_code × segment — Coles
  demand (scan) vs OUR supply (dispatch) vs farm-gate $/kg (GP). **Scan weeks end TUESDAY: alignment
  is date-range (week_ending−6..week_ending), NEVER ISO equality.** Farm-gate anchor =
  coalesce(pack_date, pickup) — pack_date is null on ~98% of GP rows. Supply-only woolworths/aldi
  cells ready for their scan. National Coles share observed 0.001..0.541.
- **Semantic (0047):** `market_week` (price ladder farm→wholesale→till; farm ≈ wholesale BY AGENCY
  CONSTRUCTION — the interesting spread is wholesale→till) · `customer_margin` (PRE-FREIGHT,
  mixed month anchors — directional until freight lands; **DR invoices = POSITIVE revenue**,
  verified debit notes) · `grower_scorecard` (**explicitly is_internal-gated** — pool averages must
  never compute over a grower's own-rows-only view) · `retail_supplier_share`.
- **Share sanity is THREE-TIER** (stock timing makes weekly cells legitimately exceed 1): H1
  national ≤1.05 · H2 pooled state×segment ≤1.10 · H3 weekly ≤2.0 (unit-error ceiling). Weekly
  >1.05 = DC-receipts-lead-till-sales, surfaced not failed.
- **NL glossary (0048):** `core.business_term` + `core.nl_phrase` (internal-only; seed function
  re-runnable — deletes seed/derived only, NEVER source='tim' rows) + `semantic.business_glossary`.
  1,436 seeded terms (products/customers/growers/sheds/segments/geographies/charges/93 metrics).
  `nl:tool` regenerates Tim's vocabulary engagement HTML; `nl:load` lands his returned JSON.
  ⚠ after adding Cube/mart measures, update the 0048 metric seed list AND re-run
  `select core.seed_business_terms()`.
- **Proofs:** `npm run insight:reconcile` (21 checks, both-sides-derived parity, share bounds,
  ladder, RLS behavioral). Registry: 88 relations.

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
