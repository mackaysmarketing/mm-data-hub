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
