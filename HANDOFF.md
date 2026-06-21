# Handoff (Sprint 3 / Phase 4): Hub MCP over the dispatch semantic/metric layer
Date: 2026-06-21
Session type: Build (governed read MCP server authored in-repo; identity-propagation + parity proven live)

## What was completed
All Sprint-3 acceptance criteria met **with evidence** against the LIVE layer (Cube `dispatch`
view + `semantic.grower_dispatch_detail`, project `data_hub` / `uqzfkhsdyeokwnkpcxui`).

- **MCP server in-repo** at `/mcp` — TypeScript (`@modelcontextprotocol/sdk` 1.29, stdio, ESM, run
  via `--experimental-strip-types`). Start: `npm run mcp:server`; docs in `mcp/README.md`.
  Modules: `config`, `errors`, `identity`, `output`, `cube`, `db`, `registry`, `runSelect`,
  `tools`, `deps`, `server`.
- **Read tools over the LIVE layer:** `get_catalog`, `list_metrics`, `get_definition`,
  `list_dimension_values`, `query_metric` (Cube `dispatch` — group_by / filters / time_range /
  time_grain / order / limit), `list_grower_dispatches` (`semantic.grower_dispatch_detail`),
  `resolve_entity`, `run_select` (escape hatch). Every read returns the SPEC §5 shape
  `{ columns, rows, metric_definition, filters_applied, row_count, truncated }`. Metric/dimension
  names are **registry-validated against the Cube `/meta` catalog** — unknowns rejected. No metric
  is redefined in the MCP.
- **THE IDENTITY-PROPAGATION MECHANISM chosen (and proven):** the MCP holds **no standing elevated
  access**. Caller identity enters once from a trusted channel — `HUB_MCP_CALLER_TOKEN`, a signed
  HS256 JWT carrying **`app_metadata`** (verified into a fixed session identity; read
  app_metadata-ONLY, so a forged top-level claim is ignored, same as migration `0010`). No tool
  argument can assert/widen it. Two paths:
  - **Metric** → signs a short-lived **per-caller Cube JWT** and calls Cube REST `/load`; Cube
    `queryRewrite` scopes it.
  - **Detail / run_select** → new least-privilege role **`hub_mcp`** (migration `0013`:
    `NOINHERIT`, member of `authenticated` ONLY, no standing data access) connects and, per request,
    `SET ROLE authenticated` + `SET request.jwt.claims` (the caller) so Postgres RLS (`0008`/`0010`)
    scopes the row. Read-only (every request rolls back).
  - **Fail closed** is structural: no/invalid claims ⇒ `authenticated` sees 0 rows.
- **RLS-propagation + parity proof — 25/25** (`npm run mcp:proof`,
  `reports/mcp_proof_2026-06-21.txt`), driving the REAL handlers under 5 contexts:
  - metric `pallet_count`: **internal 38322 · A(MMLAR) 13186 · B(MMTRU) 7631 · no-claim 0 ·
    forged-top-level 0**; `A == internal-filtered-to-A`; A→B filter = 0; A group_by grower_key =
    {A} only.
  - detail `count(*)`: **internal 38796 · A 13281 · B 7631 · no-claim 0 · forged 0**;
    `list_grower_dispatches` A sees only A, internal sees many, no-claim 0 rows, A passing
    `grower=B` still 0 (no widening).
  - governed output shape on every read; registry rejects unknown metric/dimension; `run_select`
    rejects non-`semantic.*`, DML, and multi-statement.
  - **Parity baselines match** exactly: internal `pallet_count` = 38322 (= Cube/raw); grower A
    scoped `pallet_count` = 13186 (its Cube-filtered total).
- **Guardrails:** `run_select` = single read-only SELECT, `semantic.*` only, no DDL/DML, row cap
  (`MAX_ROWS=5000`) + statement timeout (15 s). Defense in depth: it runs as `authenticated`, which
  has SELECT on `semantic.grower_dispatch_detail` ONLY and is fully RLS-scoped.

## Why the two surfaces differ (logged, not hidden)
`query_metric pallet_count` for grower A = **13186** but `list_grower_dispatches` / detail rows for
A = **13281**. Intentional: the Cube view bakes `order_type='S'` (Sell-only); the detail view
(`semantic.grower_dispatch_detail`, migration 0008) bakes only `dispatched + non-test` and so
includes the 95 Buy pallets. Each surface is proven against its OWN baseline — never conflated.

## Test status
- `npm run typecheck` clean · `npm test` **30/30** (15 new MCP unit tests: identity/app_metadata
  contract, registry validation, output shape, run_select guard, handler validation with injected
  fakes — no live deps) · `npm run mcp:proof` **25/25** (exit 0).
- **No Sprint-2 regression:** `npm run cube:reconcile` **347/347** · `npm run cube:rls` **12/12**.

## What is NOT done (deferred — stubbed, not faked)
- `list_grower_sales` + all settlement/GP tools → **Phase 2** (FreshTrack read-replica still
  blocked: `readonlyDatabaseCredentials` returns null). Registered as a guarded stub that throws
  `UnavailableError` ("unavailable until Phase 2").
- Write/action tools (`create_grower`, `update_grower_contact`, `raise_rcti`, `send_grower_notice`)
  — **not registered** in this read server; they belong to a separate audited action surface with
  human confirmation for irreversible actions.
- Agents on top of the MCP (SPEC §10) — later phase; the MCP is the substrate.

## Known issues / notes
- **`hub_mcp` password set out-of-band** (`ALTER ROLE … PASSWORD`, not committed) and stored in the
  gitignored `.env` as `MCP_DB_URL`. To run the detail path / `mcp:proof` on another machine, set
  it the same way (or rotate). `.env.example` documents both.
- **Identity ingress for stdio** is the env-provided signed token (`HUB_MCP_CALLER_TOKEN`). A future
  HTTP transport would carry it per-connection; the in-process handler boundary (`(args, identity,
  deps)`) already isolates identity from tool arguments, which is what the proof exercises.
- **Secret hygiene carried over from Sprint 2:** the CLI deploy token + `CUBEJS_API_SECRET` were
  chat-shared; rotating them remains TODO (would require re-running `mcp:proof` + the cube proofs
  with the new `CUBE_API_SECRET`).

## Files changed (Sprint 3 / Phase 4)
- `mcp/{config,errors,identity,output,cube,db,registry,runSelect,tools,deps,server}.ts`, `mcp/README.md`
- `supabase/migrations/0013_hub_mcp_role.sql`
- `scripts/mcp_proof.ts`, `tests/mcp.test.ts`
- `package.json` (`@modelcontextprotocol/sdk` dep + `mcp:server`/`mcp:proof` scripts),
  `tsconfig.json` (`mcp/**`), `.env.example`, `CLAUDE.md`, `HANDOFF.md`
- `reports/mcp_proof_2026-06-21.txt`

## Exact next step
Phase 2 (GP/settlement) when the read-replica unblocks: land `gp_schedule`/`gp_detail`, add the
sales Cube metrics (additive-only), then slot `list_grower_sales` into the MCP behind the
`can_view_sales` capability (already threaded through `CallerIdentity`). Separately: stand up the
audited write/action surface, and rotate the chat-shared Cube secrets.

---

# Handoff (Sprint 2): Cube semantic layer over the dispatch model
Date: 2026-06-21
Session type: Build (Cube project authored in-repo + deployed live to Cube Cloud; parity + RLS proven)

## What was completed
All Sprint-2 acceptance criteria met **with evidence** against the live deployment.

- **Cube project in-repo** at `/cube` — `cube.js` (config + RLS) and YAML models
  (`model/cubes/*`, `model/views/dispatch.yml`). Deployed to Cube Cloud deployment **"MM Data
  Hub"** (id 1), REST API host `lime-lamprey.aws-us-west-2.cubecloudapp.dev`, via
  `npx cubejs-cli deploy --token …`. The auto-generated **public-schema starter model**
  (`consignments_view` / `remittances_view` / `remittance_lines_view` / `retail_prices_view`,
  all built on mm-hub's `public.*`) was **replaced** by the `dispatch` view.
- **Measures shipped** (over `raw.ft_dispatch_load` + `raw.ft_pallet` + `core.dim_grower`):
  `load_count`, `pallet_count`, `net_weight_dispatched`, `line_count` (+ `pallets_with_net_weight`
  and `net_weight_capture_rate` for null-integrity proof). **Dimensions:** `grower_key`
  (consignor_id) + readable `grower_code`/`grower_name`, `pack_week` (parsed `YxxWxx`),
  `crop`/`variety`/`product`, `consignee_key`, `dispatched_on`. Contracts: `cube/CONTRACTS.md`.
- **Baked-in filters** (in each cube's SQL, not per query): `order_type='S'` (Sell), dispatched
  (`actual_pickup_on` not null), non-test consignor. **Null integrity:** `net_weight_dispatched`
  sums with nulls excluded, never coalesced. **Grain safety:** nothing below pallet/line;
  `location_id` + harvest lineage not modelled. Base cubes `public:false` — all access via the view.
- **Metric parity — 336/336** (`npm run cube:reconcile`, `reports/reconciliation_cube_2026-06-20.md`):
  every measure reconciles to a direct SQL aggregate over raw/core — overall, by **28 growers**,
  by **55 pack-weeks**, plus capture rates by crop. Counts exact; net weight within 0.01 kg.
  - `load_count`=5621 · `pallet_count`=38322 · `net_weight_dispatched`=27,822,146 kg · `line_count`=8849.
- **RLS — 12/12** (`npm run cube:rls`, `reports/rls_proof_cube_2026-06-21.txt`): grower A (MMLAR) and
  grower B (MMTRU) each see ONLY their own rows (exact match to internal-filtered-to-that-grower);
  internal sees all 28 growers; a filter cannot widen scope (A→B = 0); **fail-closed** on no-claim;
  and **all three forgery vectors rejected** (forged top-level `is_internal` / `consignor_id` → 0
  rows — proving the `app_metadata`-only contract identical to migration `0010`).
- **Read-only role** (criterion #4) — migrations `0011` (role + grants) and `0012` (permissive
  read policy). `cube_readonly` proven LIVE through the session pooler: reads all rows in
  raw/core/semantic, **0 of 36 `public` tables readable**, writes denied. Creds in `.env`
  (`CUBE_DB_URL`).

## Reconciliation deltas (logged, not hidden)
1. **`load_count` = 5,621 vs 5,576.** `load_count` is TRUE load grain (all dispatched Sell loads).
   45 of those carry **no pallet rows** (loads-with-pallets = 5,576) — some are loads whose pallets
   predate the pallet backfill window. The view is rooted on `dispatch_loads` so `load_count` counts
   them; pallet measures correctly exclude them (they contribute 0 pallets/weight/lines).
2. **Produce capture rates differ from the SPEC §9.8 hints.** Against the full FY25–26 **Sell
   dispatch** population: banana **97.5%**, papaya **100%**, avocado **83.1%**, passionfruit 93.5%,
   **mango 0%** (591 pallets, all null — sold by count). SPEC's "banana ~88%, avocado ~41%" were
   scoping-era estimates on a different/broader population. Cube reproduces the raw SQL **exactly**
   on the same population, and **mango 0%** proves null is never coerced to 0.
3. Order-type split: `S`=5,621 / `B`=305 — the 305 Buy loads (and their 474 pallets) are excluded
   by the baked Sell filter (38,796 total pallets → 38,322 dispatched Sell pallets).

## Open decision for next sprint
1. **Cube production deployment target** — currently the Cube Cloud deployment "MM Data Hub"
   (dev-mode proof, sufficient for this sprint). Choose Cube Cloud (dedicated) vs self-host on
   Railway as usage grows. *Not decided here, by SPRINT scope.*

## Operationalized after the build (2026-06-21)
- **Data source repointed to `cube_readonly`** — verified live: `pg_stat_activity` showed Cube's
  sessions under `cube_readonly` (not the superuser), and the RLS re-proof stayed 12/12 through it.
- **Steep wired** to the governed `dispatch` view via Steep's native **Cube integration** (REST API
  URL + `CUBEJS_API_SECRET` + security context `{app_metadata:{is_internal:true}}` — internal/
  unscoped, correct for internal BI). All 6 metrics imported with their CONTRACT descriptions.
  Verified end-to-end via the Steep MCP: `load_count`=5621, `pallet_count`=38322,
  `net_weight_dispatched`=27,822,146 — matching the raw baselines.
- **`cube.js` gained `checkSqlAuth`** so BI tools using Cube's **SQL API** (Postgres-wire) get an
  internal security context (else queryRewrite fails closed → 0 rows). Steep uses the REST path, so
  this is available-but-unused; to enable it, set `CUBEJS_SQL_USER`/`CUBEJS_SQL_PASSWORD` env vars.
- **Hygiene still TODO:** rotate the CLI deploy token + `CUBEJS_API_SECRET` (shared in chat); then
  update Steep's integration + `.env` (and re-run `cube:rls`/`cube:reconcile` to confirm).

## Test status
- `npm run typecheck` clean · `npm test` **16/16** · `npm run cube:rls` **12/12** ·
  `npm run cube:reconcile` **336/336** (exit 0).

## Known issues / notes
- **Data source now on `cube_readonly`** (repointed + verified live 2026-06-21 — see
  "Operationalized" above). The original superuser role is no longer used by Cube.
- **CLI-deploy dependency.** `cube/package.json` depends on `@cubejs-backend/server-core` — needed
  ONLY by the `cubejs-cli deploy` bundler. `cube/node_modules` is gitignored; `cube/package-lock.json`
  pins it.
- **Cube YAML f-strings.** Cube treats `{…}` in YAML string VALUES as Python f-strings — keep curly
  braces out of descriptions/titles (use `Y25W31`, not `Y{YY}W{WW}`). `{CUBE}`/`{member}` in `sql:`
  are the intended references and are fine.

## Files changed (Sprint 2)
- `cube/cube.js`, `cube/model/cubes/{dispatch_loads,dispatch_pallets,dim_grower}.yml`,
  `cube/model/views/dispatch.yml`, `cube/{README,CONTRACTS}.md`, `cube/package.json`,
  `cube/.env.example`, `cube/.gitignore`
- `supabase/migrations/0011_cube_readonly_role.sql`, `0012_cube_readonly_rls_read.sql`
- `scripts/{cube_lib,cube_rls_proof,cube_reconcile}.ts`, `package.json` (cube:* scripts),
  `tsconfig.json` (scripts/**), `.env.example`, `CLAUDE.md`
- `reports/reconciliation_cube_2026-06-20.md`, `reports/rls_proof_cube_2026-06-21.txt`

## Exact next step
Decide the Cube production deployment target (Cube Cloud dedicated vs Railway), then rotate the
chat-shared secrets (CLI deploy token + `CUBEJS_API_SECRET`) and update Steep + `.env`.
GP/settlement metrics remain Phase 2 (blocked on read-replica creds).

---

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
week 31). 100% non-null; 54 of 55 distinct values match the format — **2 loads carry a degenerate
`'YW'` placeholder** (→ 22 view rows with `pack_week='YW'`), for which `parsePackWeek()` correctly
returns null (no crash). Tracks the pack week (aligned to `pack_date`, not pickup). Landed
faithfully as `raw.ft_dispatch_load.extra_text_2` with a documenting COMMENT; surfaced as
`pack_week` in the semantic view; parsed by `parsePackWeek()` in `src/lib/parsers.ts`. Column name
kept stable per the additive-only / never-repurpose rule (SPEC §2).

## Post-build adversarial audit + hardening
A 5-dimension adversarial review (migrations, RLS, loader, data, completeness) ran after the build:
16 confirmed findings, **0 blockers**. Fixes applied this session (migration `0010` + code):
- **[HIGH → fixed]** RLS internal-access bypass: `is_internal` / `consignor_id` were read from
  top-level JWT claims, so a forged `is_internal:true` returned all 38,796 rows. `0010` now reads
  both ONLY from `app_metadata` (server-controlled) with fail-closed casts. Re-proven: forged
  top-level → **0**; `app_metadata` grower → own rows only; `app_metadata.is_internal` → all;
  malformed → 0, no error. See `sql/rls_two_context_proof.sql`.
- **[low → fixed]** `core.load_box_reconciliation` is now `security_invoker` (RLS-safe if ever granted).
- **[low → fixed]** Pallet loader gained a `filterLimit` truncation guard (parity with dispatch).
- **[DoD → added]** `tests/integration/loader.integration.test.ts` — automated idempotency / resume /
  RLS tests (`npm run test:integration`; self-skip without `DATABASE_URL`).
- Doc fixes: SPEC `order_type ('S'/'B')`; CLAUDE.md claim contract → `app_metadata`; the
  idempotency proof script now rolls back (self-restoring).
- **[bug → fixed]** Running the committed loader end-to-end (via a temporary scoped pooler role)
  surfaced a real runtime bug `tsc`/unit-tests missed: `src/lib/freshtrack.ts` used a TS
  **parameter property** (`constructor(…, readonly errors)`), which is non-erasable and crashes
  Node `--experimental-strip-types` — so every loader would fail on startup. Fixed (explicit
  field + assignment) and guarded by `tests/imports.test.ts` (imports every `src` module so
  `npm test` parses them all under strip-types). The committed `load:entities` then ran clean
  against the live hub: `entities upserted=318 dim_grower=156 test_consignors=3`, rc=0 — so the
  committed `pg` path (`makePool`/`upsertNodes`/`refresh_dim_grower`) is now PROVEN, not inferred.
  Connection note: use the **session pooler** `aws-1-ap-southeast-2.pooler.supabase.com:5432`
  (`postgres.<ref>`) — the direct host is IPv6-only and doesn't resolve here.

Status: the push is complete (all commits on the remote); the only thing still needing you is the
DB password in `.env` if you want to run the loaders yourself.

## What is NOT done (out of scope — later phases)
- mm-hub portal page that renders the view (separate mm-hub sprint).
- GP/settlement landing + grower sales page (phase 2, read-replica; `gpDetails` resolver broken).
- Cube semantic layer + metrics (phase 3). Hub MCP + agents (phase 4).
- Scheduled/incremental runs — the windowed loader supports it (`raw.sync_window`); wiring a
  schedule is a later sprint.

## Known issues / debt
- **Pushed** ✅ — all commits are on `mackaysmarketing/mm-data-hub` `main` (`git ls-remote`
  confirmed). The local `gh`/`timbowilcox` has no write access; pushed with a `mackaysmarketing`
  PAT via the remote URL then scrubbed it (see CLAUDE.md "Git & pushing"; never use `gh` here —
  it hangs on `api.github.com`).
- **46 loads have no pallets** (0.8%) — empty/cancelled loads or pallets packed before the pallet
  window start (2025-05-01). Surfaced in reconciliation; not a loader fault.
- **6 loads with a non-zero box delta** — `stock_boxes` carries a round planned/ordered quantity
  while pallets sum to fewer actual boxes. Upstream order-vs-actual artifact; flag to FreshTrack.
- **Pallet scoping** — `raw.ft_pallet` holds only pallets attached to our 5,926 dispatch loads.
  The **committed** loader (`src/loaders/pallets.ts`) fetches pallets **per load**
  (`pallets(filterDispatchLoadId)`) — one fetch per load, exact attribution, `rows_seen ≈
  rows_upserted`. The **session backfill** instead used a `packed_on`-windowed
  `filterAssociated:true` fetch kept where `dispatch_load_id ∈ raw.ft_dispatch_load` (efficient
  over the MCP `http` path; that is why `sync_window` shows pallet `rows_seen=189,937` vs
  `rows_upserted=38,796` — ~5× over-fetch then dedup-on-id). Both land the SAME 38,796
  correctly-attributed pallets (verified: 0 orphans, 0 null `dispatch_load_id`). Full pallet
  landing incl. inbound/harvest is deferred — not needed for the dispatch detail.
- **Session execution mechanism** — the backfill was run via temporary server-side functions over
  Postgres' `http` extension (FreshTrack fetched + inserted DB-side). Those temp functions and the
  `http` extension were **dropped** at end of session; the project is back to a clean state. The
  committed loader (`src/loaders/*`) is the production path and connects via `pg` + `DATABASE_URL`.
- **`DATABASE_URL` password** — not present on this machine, so `.env` has a `REPLACE_WITH_DB_
  PASSWORD` placeholder (now pointed at the working session pooler host). Fill it to run
  `npm run backfill` / `reconcile` / `test:integration` locally. (`load:entities` was already
  proven end-to-end this session via a temporary scoped role.)
- **Migration history** — applied via the Supabase management API as `0001`–`0009`. `supabase db
  push` from a fresh clone will no-op against the hub (objects already exist; DDL is idempotent).

## Exact next step
Fill `DATABASE_URL` in `.env`, run `npm run schema:snapshot` to refresh the FreshTrack snapshot
from the live endpoint with credentials, then begin the mm-hub portal page that renders
`semantic.grower_dispatch_detail` (separate mm-hub sprint), passing the `consignor_id` JWT claim.

## Files changed
- `CLAUDE.md`, `README.md`, `SPEC.md`, `SPRINT.md`, `package.json`, `tsconfig.json`, `.env.example`
- `supabase/migrations/0001`–`0010_*.sql` (`0010` = post-audit security hardening)
- `src/lib/{env,freshtrack,db,windows,parsers,specs,util}.ts`
- `src/loaders/{entities,dispatch,pallets,backfill}.ts`, `src/reconcile.ts`, `src/schemaDiff.ts`
- `tests/{windows,parsers,specs,imports}.test.ts`, `tests/integration/loader.integration.test.ts`
- `sql/{rls_two_context_proof,idempotency_resume_proof}.sql`
- `references/grading-rubrics.md`, `references/freshtrack-schema.snapshot.json`
- `reports/reconciliation_2026-06-20.md`
