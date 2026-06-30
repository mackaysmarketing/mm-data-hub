# Handoff (2026-06-30): Fix dispatch.grower_name text=uuid join cast
Date: 2026-06-30 · Branch: `fix/dispatch-grower-name-cast` (NOT pushed; not merged to main)
Session type: Surgical Cube model fix + proof harness. Build/commit done; live proofs PENDING-DEPLOY.

## What was done
The `dispatch` view advertised `grower_name` as a dimension but selecting it raised
`operator does not exist: text = uuid`. Root cause in `cube/model/cubes/dispatch_loads.yml`: the
`dispatch_loads → core.dim_grower` join predicate compared `grower_key` (text — `d.consignor_id::text`
in the cube SQL) against `{dim_grower}.consignor_id`, which inside join SQL resolves to the **raw uuid
column** of `core.dim_grower` (the dimension's `::text` does NOT apply in join context — `{dim_grower}`
expands to the table alias). Hence text = uuid.

**Fix (one predicate, cast DOWN to text):**
```
- sql: "{CUBE}.grower_key = {dim_grower}.consignor_id"
+ sql: "{CUBE}.grower_key = {dim_grower}.consignor_id::text"
```
Cast the uuid → text, **never** `grower_key::uuid`: `grower_key` is the RLS anchor that flows through
`queryRewrite` and every other select; casting it to uuid would throw on any non-uuid value, and
`core.dim_grower` is tiny so the predicate cast is free. This is a **display join**, distinct from the
RLS security-context anchor where the repo default ("cast must be uuid") applies — do not revert it.

## Scope discipline (what was NOT touched)
- `cube/cube.js` `queryRewrite` — **untouched** (`git diff cube/cube.js` empty). Still scopes only
  `dispatch.grower_key` (VIEW_GROWER_KEYS, cube.js:44–49; scope push, cube.js:104–111). No filter is
  ever pushed onto `grower_name`. **Criterion 4 — PASS (deploy-free, source-verified).**
- `origin_shed_id` / `origin_shed_name` dims and the raw layer — untouched.
- No member added/removed/renamed; the change is a join predicate only → `/meta` must be unchanged.

## Verification status
- `npm run typecheck` — clean. `npm test` — 72/72 pass. `dispatch_loads.yml` parses (js-yaml).
- **Criterion 4 (queryRewrite anchor)** — PASS, source-verified (deploy-free).
- **Criteria 1, 2, 3, 5** — **PENDING-DEPLOY.** They run through the governed REST `/load` + `/meta`
  API against prod deployment id 1, which serves the *built* model — so they require the fix deployed.
  Harness written: `npm run cube:grower-name` (`scripts/cube_grower_name_proof.ts`) runs all four and
  writes `reports/cube_grower_name_proof_<date>.txt`. **Awaiting deploy approval before running.**

## Deploy gate
MCP can only query prod deployment id 1 ("MM Data Hub"); no reachable dev deployment. Deploy via
`cd cube && npx cubejs-cli deploy --token <hex CLI deploy token>` (hex token from the Deploy-with-CLI
page — NOT a JWT query token). After deploy: `npm run cube:grower-name`, paste the report into SPRINT.md
acceptance, flip criteria 1/2/3/5 from PENDING-DEPLOY to checked.

---

# Handoff (Sprint 7 CLOSE): LMB Farms dispatch backfill — sync gap closed + origin verified
Date: 2026-06-29
Session type: Fix / Verification (incremental backfill of the LMB gap + read-only reconciliation
against the live FreshTrack source; no schema change, no new code committed)

## What was completed
The LMB Farms dispatch sync gap in `raw` is closed and verified against the live FreshTrack source.

- **Backfill run** — tested Sprint 7 loader, incremental `--since=2026-06-22`, into
  `raw.ft_dispatch_load` + `raw.ft_pallet` (data only, no schema change):
  `dispatch: seen=1245 upserted=1245` · `pallet: seen=6667 upserted=6667` · exit 0.
- **Completeness vs live source** (LMB sheds LMBCO/LMBBF/LMBEP/LMBFA):
  | Entity | Source (live FreshTrack) | Hub `raw` | Directional gap (source→hub) |
  |---|---|---|---|
  | LMB loads | 684 | 684 | **0 — exact** |
  | LMB pallets | 12,251 | 12,271 | **0** (`src_only=0`, `in_both=12,251`) |
  Every live-source LMB load and pallet is now in `raw`.
- **Sync high-water advanced:** `max(window_end)` for the `dispatch`/`pallet` streams
  2026-06-23 13:49 → **2026-06-29 10:11**.
- **Integrity floor held:** null-`shed_id` pallets in the LMB set = **0**.
- **Origin semantics verified:** `shed_id` tracks pallet origin, **not** the load consignor —
  11,875 matched pallets, all resolve to an LMB shed in `raw.ft_entity`, **0** rows where
  `shed_id = consignor_id`. Reconsignment proven (LMBFA-packed pallets riding non-LMB consignor
  loads still carry the LMBFA `shed_id`).

## Test status
Read-only verification only (no unit/integration suite run this session):
- Origin correctness — **PASS** (10-row sample join + full-set aggregate; `shed ≠ consignor` every row).
- Completeness vs live source — **PASS** (`src_only = 0`; loads exact 684 = 684).
- Integrity — **PASS** (null-shed floor 0; 0 orphaned `dispatch_load_id`; 68 LMB pallets carry a
  null `dispatch_load_id` = unassigned/field, surfaced not failed).

## What is NOT done (carry-forward — spans sessions)
- **+20 hub-excess LMB pallets** — id-level diff proves all 20 are **hard-deleted in source** and
  retained by the **upsert-only loader** (no delete propagation). A design decision, **not data
  loss**. Purging needs a separate delete-reconciliation (tombstone) step.
- **`shed_id` dies at `raw`** — `semantic.grower_dispatch_detail` carries **no farm origin** (keyed
  on `grower_key` only); `core.load_box_reconciliation` has none either. Carrying pallet origin
  downstream is the next sprint.
- **HEAD loader is blocked** — HEAD carries the Sprint 8 draft `dispatch_state` stream, but
  `raw.ft_dispatch_load_state` is **not applied** (migration `0021` pending), so a plain
  `npm run ft:dispatch:load` aborts before loading. Use the tested Sprint 7 loader
  (`git show 3e51ca8:src/loaders/ft_dispatch.ts`) or apply `0021` first. (Memory:
  `head-dispatch-loader-sprint8-blocker`.)
- **RLS gate** — 17 `raw`/`core` tables have RLS disabled (Supabase advisor: critical). Treat as a
  **Sprint 0 hard gate**: policy-first, its own session, **no auto-enable** (enabling without
  policies blocks all access).

## Known issues / notes
- Loader is **upsert-only** — source hard-deletes / shed-reassignments are not propagated; the hub
  can exceed source (here +20 LMB pallets).
- LMB `actual_pickup_on` is capped at 2025-07-15 in source; `packed_on` is the reliable recency
  signal (hub now current through 2026-06-28).
- **SPRINT.md anomaly** — the working-tree `SPRINT.md` was modified out-of-session into a generic
  template that reintroduces the disproven "core dispatch table / raw→public→core silver" framing.
  Left **unstaged and NOT committed**; recommend reverting to HEAD (the accurate Sprint 7 spec).

## Exact next step
Carry `shed_id` (pallet origin) through `core` into `semantic` so farm origin reaches the analytical
layer — `semantic.grower_dispatch_detail` currently drops it.

## Files changed
- **None in code.** The backfill wrote only to `raw.ft_dispatch_load` + `raw.ft_pallet` (data, not
  schema). The working-tree loader was swapped to the tested Sprint 7 version for the run and
  **restored to HEAD** (verified clean). Read-only verification scripts live in the temp scratchpad,
  outside the repo.
- **HANDOFF.md** (this entry) — the only repo change committed this session. (`SPRINT.md` modified
  out-of-session — left unstaged, not committed.)

---

# Handoff (Sprint 7 BUILD): FreshTrack dispatch DB backfill — warehouse tables made current
Date: 2026-06-23
Session type: Build (new canonical dispatch loader from the FreshTrack prod Postgres source into the
view-backing raw tables; full backfill executed live + reconciled; RLS + idempotency + incremental
proven; redefinition finding documented and DEFERRED per user decision)

## What was completed
The warehouse dispatch tables that back `semantic.grower_dispatch_detail` — `raw.ft_dispatch_load`
and `raw.ft_pallet` — were a frozen, partial Sprint-1 snapshot (5,926 / 38,796). They are now CURRENT,
loaded directly from the FreshTrack prod Postgres source (the first non-GraphQL dispatch ingress).

- **Step 0 (committed `c25c0ef`):** load-safe recon (`ft:dispatch:recon`) → `DISPATCH_COLUMN_MAP.md`.
  Source `public.dispatch_load`→`raw.ft_dispatch_load`, `public.pallet`→`raw.ft_pallet`, **1:1 by name,
  0 gaps**; incremental key `last_modified_on`; pickup `actual_pickup_on`; LMB keyed to LMBFA/BF/CO/EP.
- **Loader (`src/loaders/ft_dispatch.ts`, commit `3e51ca8`)** mirrors `ft_gp.ts`: keyset-paged read
  (fetch-before-hub-connect), idempotent upsert on `id`, resumable `raw.sync_window` (streams
  `dispatch` + `pallet`), full / `--since` (incremental by `last_modified_on`) / `--loads` (slice) modes.
  Test consignors excluded at pull (SPEC §9.6); `location_id`/`harvest_load_id` unmodelled (SPEC §9.1/9.2).
- **Write-target safety (hard blocker):** `assertHubTarget(pool)` runs before ANY write — aborts unless
  `DATABASE_URL` carries the hub ref `uqzfkhsdyeokwnkpcxui` (the pooler puts the ref in the USERNAME,
  not the host) AND the live DB exposes the view-backing tables. `connStringTargetsHub` unit-tested;
  fires live (the load passed it). Encoded fix for the OneDrive `.env`-revert / wrong-target failure mode.
- **Full backfill landed (live, off-peak, user-confirmed):** `dispatch=22,033 · pallet=201,852` upserted.
  Hub now **22,033 loads / 201,894 pallets** (from 5,926 / 38,796).
- **Lands `state_id` + `stock_boxes` + `reconsigned_boxes`** so the documented dispatched/boxes
  redefinition is later a pure view/Cube change with NO re-load.

## The redefinition finding (documented, DEFERRED per user decision)
Step-0 discovery (ground-truth load **G5021160 / LMBCO**, validated across all 49 growers) found the
governed dispatch definitions don't match how FreshTrack records dispatch — full writeup +
cross-grower validation in **`DISPATCH_DEFINITION_PROPOSAL.md`** (commit `dc1d3cd`):
- **"dispatched" = `actual_pickup_on IS NOT NULL`** is barely-captured (null on 85% of Paid / 98% of In
  Transit; **23 of 49 growers at 0%**). The reliable signal is `dispatch_load_state.sequence >= 5`
  (Shipped+); it agrees with `actual_pickup_on` **99.4%** where that exists (17 contradictions of 2,953).
- **"boxes" = `pallet.box_count`** is own-stock only (`== stock_boxes` 100% of pallets); reconsigned
  cartons live in `reconsigned_boxes` (the 1,200 on G5021160). Correct = `stock_boxes + reconsigned_boxes`.
- Impact: **22 of 49 active growers are invisible** on today's dashboard (LMB is one); dispatched loads
  ×2.6, boxes +44% — stock-only growers unchanged, reconsignment growers corrected.
- **User decision:** do the raw backfill now (lands all the fields); HOLD the view/Cube redefinition as
  the documented next step (needs ops sign-off on the seq≥5 threshold + a stock-load box validation).

## Evidence (runnable, against the live hub)
- `npm run ft:dispatch:reconcile` — **PASS**: loads **22,033/22,033 (0.00%)**, pallets **201,894/201,852
  (+0.02%)**, Σnet_weight +0.01%, Σboxes +0.02%; `max(dispatched_on)` = **2026-06-27** (current, was
  2025-07-15). The +42 pallet residual = upsert-only backfill doesn't hard-delete pallets that vanished
  from the source (within tolerance; surfaced).
- `npm run ft:dispatch:rls` — **7/7**: internal sees all 44,392 (37 growers); grower A→15,270 (0 of B),
  B→7,965 (0 of A); no-claim→0; forged top-level→0; filter cannot widen (A→B=0). Same app_metadata-only
  fail-closed contract as 0008/0010.
- **Idempotent:** slice re-run grew 0 rows; **incremental** `--since=2026-06-23` picked up only 198 loads
  / 781 pallets (by `last_modified_on`), `sync_window` both streams `done`; a 2nd incremental left counts
  unchanged (22,033 / 201,894).
- **LMB landed in `raw`:** 672 loads (LMBBF 40 · LMBCO 317 · LMBEP 303 · LMBFA 12), scheduled pickups
  current through today. Via the *current* view: still 22 rows @ 2025-07-15 / 0 boxes — the governed-
  definition limitation, deferred to the redefinition (NOT a load failure; the data is present).

## Test status
- `npm run typecheck` clean · `npm test` **72/72** (+8 new: spec 1:1 map, view-column coverage,
  redefinition-field landing, ::text dates, `connStringTargetsHub` host-vs-user gating).
- **No regression (live):** `cube:reconcile` **471/471** · `cube:rls` **12/12** · `cube:settlement`
  **7/7** · `cube:gp` **9/9** · `ns:reconcile` PASS · `ns:rls` **7/7** · `ns:parity` **5/5** ·
  `ft:gp:reconcile` PASS (0 drift, 1170/1206) · `ft:gp:parity` **5/5** · `ft:gp:rls` **14/14**. The
  dispatch cube grew to reflect the backfill (internal pallet total 38,322→42,336) and still reconciles.

## What is NOT done (deferred — not faked)
- **The LMB user-facing visibility AC is NOT met by the backfill alone, and cannot be** — the source
  caps LMB at `actual_pickup_on` 2025-07-15 and records boxes in `reconsigned_boxes`, not `box_count`.
  The DATA landed (672 LMB loads); the VIEW visibility needs the dispatched/boxes redefinition. Deferred
  per the user's explicit decision (option A: backfill now, redefinition next).
- **The redefinition itself** (view + Cube): designed in `DISPATCH_DEFINITION_PROPOSAL.md`; pending ops
  sign-off on the `seq>=5` "shipped" threshold and a stock-load box-formula validation.
- `core.fact_dispatch` conformance layer (raw→view-direct is the current architecture; out of scope).

## Known issues / notes
- **+42-pallet residual** (hub 201,894 > source 201,852): the loader upserts but never hard-deletes, so
  pallets removed from the source (archived/deleted/reconsigned-away since Sprint 1) linger. Within the
  2% reconcile tolerance; a "prune vanished ids" pass could close it if exact parity is ever required.
- **Legacy `pallet` sync_window stream:** the old GraphQL loader wrote weekly `pallet` windows (through
  2026-06-19), so SPRINT.md's "no dispatch stream has ever run" is slightly off — the old path wrote
  windows yet left the tables partial. The new Postgres loader uses distinct window_starts (1970-01-01
  full, 1970-01-02 slice, the `--since` date for incremental) so the two never collide.
- **GP slice latent bug (not fixed — out of scope):** `ft_gp.ts` slice passes `window_start='slice:N'`
  into a `timestamptz` column and would error; the dispatch loader uses a real sentinel (`1970-01-02`).
- **Push needs the `mackaysmarketing` PAT** (per CLAUDE.md) — not available in-session; commits are local
  until pushed. Do NOT declare done on an unpushed commit (the Sprint-6 `bfaed42` lesson).

## Files changed (Sprint 7 build)
- `src/lib/ft_dispatch_specs.ts`, `src/lib/db.ts` (`assertHubTarget`/`connStringTargetsHub`),
  `src/loaders/ft_dispatch.ts`, `tests/ft_dispatch_specs.test.ts`
- `scripts/ft_dispatch_{recon,reconcile,rls_proof,order_lookup,lmb_probe,box_probe,status_probe,definition_evidence,cross_grower_validation}.ts`
- `DISPATCH_COLUMN_MAP.md`, `DISPATCH_DEFINITION_PROPOSAL.md`, `package.json`, `HANDOFF.md`, `SPRINT.md`

## Exact next step
Build the additive redefinition (Option C in `DISPATCH_DEFINITION_PROPOSAL.md`), after ops confirms
`seq>=5` is the right "has-shipped" line and a stock-load portal screen validates `stock+reconsigned`
boxes: land `core.dim_dispatch_state` (mirror `gp_status`), add a `semantic.grower_dispatch_shipped`
view + RLS, and new additive Cube measures (`shipped_load_count`, `boxes_packed`) + dims
(`dispatch_state`, `effective_dispatched_on`). LMB and the 22 hidden growers then surface, existing
metrics untouched.

---

# Handoff (Sprint 6 BUILD): FreshTrack GP settlement — load-grain settlement + cross-source reconcile
Date: 2026-06-23
Session type: Build (GP settlement onboarded as the 3rd source / 2nd settlement view; raw→core→semantic→Cube; RLS + internal + cross-source reconciliation proven live)

## What was completed
All SPRINT.md acceptance criteria met **with evidence** against the live hub (`data_hub` /
`uqzfkhsdyeokwnkpcxui`), EXCEPT the live Cube `gp_settlement` deploy (operator-gated — no deploy token
in this environment; code complete + validated offline + cube:gp ready). Built FROM the Sprint-6 probe.

- **Raw charge landing (migration `0018`):** `raw.ft_charge_applied` (the deduction ledger — all 36
  source cols, no `_raw`), `raw.ft_charge` / `ft_charge_type` / `ft_gp_status` (curated + `_raw`).
  Faithful native mirrors; text not enum; temporal via `::text`; amounts never coalesced.
- **Loader generalized (`src/loaders/ft_gp.ts`):** full backfill / **incremental by `last_modified_on`**
  (`-- --since=`) / slice. Keyset-paged from the replica (read-only, fetch-before-hub-connect),
  idempotent (upsert on `id`), resumable per-stream via `raw.sync_window`. **Backfill landed: 1254
  schedules · 23544 detail · 1257 payments · 93804 settled charges · 30+155+3 dims.** Idempotent
  (incremental re-run left counts unchanged).
- **Core (`migration 0019` + `src/loaders/ft_gp_core.ts`):** `core.dim_gp_charge` (TS-classifier built,
  155 charges), `core.crosswalk_gp_grower` (deterministic; surfaces detail-only), `core.fact_gp_settlement`
  (schedule grain, 1254) + `core.fact_gp_settlement_load` (**load grain via `dispatch_load_id`, 17975** —
  the lineage NetSuite cannot give). Category by LINE `account_code` prefix + dim fallback.
- **Semantic (`migration 0020`):** `semantic.grower_gp_settlement` + `semantic.grower_gp_settlement_load`,
  `security_invoker`, RLS on the **SCHEDULE consignor** via the same `app_metadata`-only fail-closed
  helpers as `0008`/`0010`/`0016`; `cube_readonly` read-all. Paid date first-class.
- **Cube (additive):** `cube/model/cubes/gp_settlement_schedule.yml` + `gp_settlement_load.yml` → views
  `gp_settlement` + `gp_settlement_load`; `gp_*` measures (never redefining a dispatch/NetSuite metric);
  `cube.js` `queryRewrite` VIEW_GROWER_KEYS extended to scope both. **Deployed live** to Cube Cloud
  ("MM Data Hub"); base load cube renamed `gp_settlement_load_fact` (a cube and view cannot share a name).
- **Unit tests (+16, 64 total):** charge classification (FR/WH/MD/MI/LA, GL-string fallback, LA=Load
  Adjustment), GST `vat_info` math, settlement rollup oracle (incl. LA credits), crosswalk (reconsignment).

## Decisions stated (per SPRINT first-step)
- **Net computation = anchor-and-reconcile** (the recommended option). gross from `gp_detail`, deductions
  from `charge_applied (is_deductible)`, GST from `vat_info`; reconciled to **`gp_payment`** + FreshTrack's
  own `v_power_bi_charge_split`. **Original-load split apportionment NOT replicated** (`quantity_value/text_2`
  explodes to $326M; even FreshTrack's PBI view doesn't perfectly tie reconsignment to payment) — residual
  surfaced. `gp_schedule.invoiced_amount_value` is **unreliable** ($33M vs true gross $177M) — not anchored on.
- **Incremental key = `last_modified_on`** (confirmed; an archive/lock/pay event bumps it).
- **LA = "Load Adjustment"** in FreshTrack (account 5xxxxx) — shared code with NetSuite's LA=Larapinta but
  different meaning; documented, labelled distinctly.
- **`netsuite_id` is UNUSABLE** as the cross-source key (2/155 charges, 0/30 charge_types) → cross-source
  join is by grower `consignor_id` + the shared FR/WH/MD taxonomy. (Corrects the SPRINT's assumed key.)

## Evidence (runnable)
- `npm run ft:gp:reconcile` — **A (TS oracle == SQL fact) PASS (0 drift)**; B (cash vs gp_payment)
  **1170/1206 (97%) within 1%**; OTHER $0; null-consignor 52, no-payment 48 (surfaced). Grand: gross
  **$176,615,800** − deductions **$32,532,268** − GST **$2,716,111**; paid **$140,543,825**.
- `npm run ft:gp:parity` — **5/5**: grand net **0.60%**, grand deductions **−0.10%**; 22/26 growers within
  10%; accounting closes (GP $141.37M = NS $139.70M + finer-granularity attribution); spot-check MACBO
  net −4.8% (FR/WH/MD ~3%). Cross-source ties: GP paid **$140.5M** ≈ NS **$139.7M**; deductions
  **$32.53M** ≈ NS **$32.50M**.
- `npm run ft:gp:rls` — **14/14**: both views × {internal, 2 growers, no-claim→0, forged→0, no-widening},
  anchored on the SCHEDULE consignor.
- Crosswalk: **35/35** schedule consignors mapped; **10** detail-only (reconsignment) originals surfaced.

## Test status
- `npm run typecheck` clean · `npm test` **64/64** (+16 new).
- **No regression (live, post-deploy):** `cube:gp` **9/9** · `cube:rls` **12/12** · `cube:reconcile`
  **347/347** · `cube:settlement` **7/7** · `ns:reconcile` PASS · `ns:rls` **7/7** · `mcp:proof` **25/25**
  · `ns:parity` re-synced (see below).

## What is NOT done (deferred — not faked)
- Original-load split apportionment (deliberately not replicated — see Decisions).
- Merging GP + NetSuite into one canonical settlement (kept as two reconciled sources, per SPRINT).
- Hub MCP / Steep surfacing of GP metrics (later phase; the Cube metrics are the substrate).

## Known issues / notes
- **`ns:parity` source drift:** live NetSuite gained **2 RCTIs** (1097 vs the hub's 1095, $12,494) since
  the Sprint-5 backfill — NOT a Sprint-6 regression (spot-check still exact). Re-synced via incremental
  `ns:backfill` + `ns:core` (data sync, no code change) → `ns:parity` **5/5** restored; `ft:gp:parity`
  re-verified **5/5** against the current NetSuite (grand net 0.59%, deductions −0.10%).
- **Reconsignment** is common (12,770 detail rows, 70k charge rows carry an original load). GP attributes
  to the schedule consignor; NetSuite to the RCTI vendor → per-grower cross-source differences (grand ties).
- **Secret rotation TODO:** the GitHub PAT and the Cube deploy token were both provided in-session
  (chat transcript) to complete the push + Cube deploy — rotate both (carried from Sprint 2/5).

## Files changed (Sprint 6 build)
- `supabase/migrations/{0018_raw_ft_gp_charges,0019_core_gp_settlement,0020_semantic_grower_gp_settlement}.sql`
- `src/lib/{ft_gp_specs,ft_gp_charges,ft_gp_settlement,ft_gp_crosswalk}.ts`, `src/loaders/{ft_gp,ft_gp_core}.ts`
- `cube/model/cubes/{gp_settlement_schedule,gp_settlement_load}.yml`, `cube/model/views/{gp_settlement,gp_settlement_load}.yml`, `cube/cube.js`
- `scripts/{ft_db_charge_profile,ft_gp_reconcile,ft_gp_parity,ft_gp_settlement_rls_proof,cube_gp_settlement_check}.ts`
- `tests/{ft_gp_charges,ft_gp_settlement,ft_gp_crosswalk}.test.ts`, `package.json`, `CLAUDE.md`, `HANDOFF.md`

## Exact next step
Wire the GP metrics into Steep (native Cube integration, internal context) and the Hub MCP
(`list_grower_sales`/settlement behind `can_view_sales`, now that the `gp_settlement` view is live).
Rotate the chat-shared secrets (GitHub PAT + Cube deploy token).

---

# Handoff (Sprint 6 kickoff): FreshTrack GP settlement — Phase-2 read-replica probe + sprint spec
Date: 2026-06-23
Session type: Discovery + scoping (read-replica access proven; GP raw landing applied + test-loaded; Sprint-6 spec written). NOT a full build.

## What was completed
- **FreshTrack read-replica access proven** — `.env` `FRESHTRACK_DATABASE_URL` (role
  `cloud_mackaysmarketing_readonly`). The FIRST non-GraphQL FreshTrack ingress; the GP/settlement
  domain was blocked across Sprints 1–5 ("`readonlyDatabaseCredentials` returns null"). Read-only
  probes committed: `ft:db:smoke` (connectivity), `ft:db:explore` (schema), `ft:db:gp-profile`
  (GP profile + hub conformance).
- **GP raw landing applied** — migration `0017_raw_ft_gp.sql`: `raw.ft_gp_schedule` /
  `raw.ft_gp_detail` / `raw.ft_gp_payment` (faithful native-column mirror; temporal columns read
  `::text` to dodge the +10 date off-by-one).
- **Test batch loaded + verified** — `src/loaders/ft_gp.ts` (`npm run ft:gp:load`, newest-N-schedules
  slice) + `npm run ft:gp:verify`: 50 schedules / 1,053 detail / 50 payments. Idempotent (0 net-new on
  re-run), 0 unmapped consignors (35/35 in `core.dim_grower`), 100% load-lineage (`dispatch_load_id`
  populated), dates exact (no off-by-one).
- **Sprint-6 spec written** (`SPRINT.md`) — the full GP medallion: charge model (`charge_applied` +
  `charge`/`charge_type` dims), core facts at schedule + load grain, RLS semantic views, additive Cube
  metrics, internal + cross-source (FreshTrack↔NetSuite) reconciliation. Discovery section confirmed live.

## Key discovery (build to this)
- Deductions live in `charge_applied` (FR/WH/MD/LA/MI taxonomy, SAME as NetSuite, via
  `charge_type.scope` / `account_code` prefix / `charge.name`) — NOT the `gp_detail.extra_*` slots.
  Reconciles: GP deductions ≈ **$32.5M** ≈ NetSuite **$32.5M**; GP paid ≈ **$140.5M** ≈ NetSuite
  net_paid **$139.7M**. Cross-source join key: `charge.netsuite_id` / `charge_type.netsuite_id`.
- Net math reference = FreshTrack's own `public.v_power_bi_charge_split` view (gross = `box_quantity ×
  price_invoiced_value`; deductions sign-flipped; GST from `vat_info` EX/INC/FREE; original-load splits).
- RLS anchor = `gp_schedule.consignor_id` (the SETTLED party); `gp_detail.consignor_id` can be the
  ORIGINAL grower on reconsignment (the 45-vs-35 distinct-consignor gap — surface, don't drop).

## Test status
- `npm run typecheck` clean · `npm test` **48/48**. No new automated tests yet (the build sprint adds:
  charge classification, GST math, crosswalk incl. original-load case, fail-closed RLS).

## What is NOT done (this was scoping, not the build)
- The Sprint-6 build: charge raw tables (migration `0018`), the incremental loader, `core` / `semantic` /
  Cube / RLS, the two reconciliation scripts, and the FULL backfill. Only a **50-schedule TEST slice** is
  currently in `raw.ft_gp_*`.

## Exact next step
Execute the `SPRINT.md` "First step": read the live `v_power_bi_charge_split` def + `charge_type` rows,
lock the FR/WH/MD/LA/MI mapping, state the net-computation approach + the incremental key
(`last_modified_on`), then write migration `0018` (charge raw tables) and extend the loader.

## Files changed
- `SPRINT.md` (→ Sprint 6), `HANDOFF.md`, `package.json` (`ft:*` scripts), `src/lib/env.ts`
  (`FRESHTRACK_DATABASE_URL` accessor)
- `scripts/ft_db_{smoke,explore,gp_profile}.ts`, `scripts/ft_gp_verify.ts`
- `src/lib/{freshtrack_db,ft_gp_specs}.ts`, `src/loaders/ft_gp.ts`, `supabase/migrations/0017_raw_ft_gp.sql`

---

# Handoff (Sprint 5): NetSuite RCTI / grower-settlement ingestion
Date: 2026-06-22
Session type: Build (NetSuite onboarded as a 2nd source; RCTI settlement landed raw→core→semantic; RLS + parity proven live; Cube metrics authored)

## What was completed
All Sprint-5 acceptance criteria met **with evidence** against the live hub (`data_hub` /
`uqzfkhsdyeokwnkpcxui`) and live NetSuite (account `11176992`, subsidiary 2 = Mackays Marketing).

- **NetSuite as a second source — read-only SuiteQL over OAuth 1.0a TBA (HMAC-SHA256).** The signer
  (`src/lib/oauth1.ts`) is dependency-free, unit-proven against the published Twitter OAuth KAT, and
  proven LIVE (`npm run ns:smoke` → 200 + real rows). The TBA integration role needs **SuiteAnalytics
  Workbook** (gates SuiteQL) + Lists→Vendors/Items + Transactions→Find Transaction/Bills (View).
- **raw.ns_* landed** (migration `0014`, `npm run ns:backfill`): fetch-first (no DB connection held
  through the multi-page fetch), 1000-row batched upserts, idempotent (upsert on PK), resumable via
  `raw.sync_window`, incremental by `lastmodifieddate`. Counts: **ns_vendor 39 · ns_item 638 ·
  ns_vendor_bill 1095 · ns_vendor_bill_line 46193 · ns_vendor_payment 1042 · ns_bill_payment_link
  1133.** Real REST-SuiteQL columns (NARROWER than the discovery MCP: no `amount`/`posting`/`account`,
  no `transaction.subsidiary` — uses `foreignamount`/`netamount`, `mainline`/`taxline`, `uniquekey`
  line PK). Subsidiary-2 scope is transitive (all 39 category-110 vendors are sub 2).
- **core conformance** (migration `0015`, `npm run ns:core`):
  - `core.crosswalk_ns_grower` — `vendor.entityid = dim_grower.code → consignor_id`; WADDA-style
    duplicate codes resolved to the ACTIVE dim_grower row. **27/27 grower RCTIs mapped, 0 unmapped.**
  - `core.dim_ns_charge` (638 items, the unit-tested classifier): FR 178 · WH 104 · MD 36 · LA 23 ·
    MI 2 · PRODUCT 260 · OTHER 35 (from `itemid` prefix + `displayname`).
  - `core.fact_settlement_bill` (1095, bill grain): gross, deductions by category (signed), tax,
    net_paid, paid_date/status. **recon_diff = 0 for ALL bills.**
- **semantic.grower_settlement** (migration `0016`) — bill-grain view; RLS by `consignor_id` via the
  SAME `app_metadata`-only, fail-closed helpers as `0008`/`0010`; `security_invoker`; `cube_readonly`
  read-all policy (mirror `0012`). **Paid date is first-class.**
- **Cube** — additive `settlement` cube + view (`gross_sales`, `total_deductions`, FR/WH/MD/LA/MI
  deductions, `net_paid`, `rcti_count`, paid/unpaid). `cube.js` `queryRewrite` extended to scope BOTH
  the dispatch and settlement views per query (dispatch RLS preserved — verified by the no-regression
  run). **Deployed live** to Cube Cloud ("MM Data Hub"); the base cube is `settlement_bill`, exposed
  via the public `settlement` view. `npm run cube:settlement` → **7/7**: internal net_paid/rcti_count
  match the DB fact, grower ROLFE scoped to its own, no-claim/forged-top-level → 0.

## Evidence (runnable)
- `npm run ns:reconcile` — A(DB recon)=PASS · B(oracle net = −bill_total)=PASS · C(oracle = SQL fact,
  no drift)=PASS · unmapped=0 · OTHER deductions = **−$221** (surfaced, not hidden).
- `npm run ns:rls` — **7/7**: internal sees all 1095; ROLFE/MACBO see only their own 102 (disjoint);
  no-claim→0; forged top-level→0; a grower filtering to another → 0 (no widening).
- `npm run ns:parity` — **5/5**: bill count 1095=1095; Σ bill_total = NetSuite Σ foreigntotal (Δ=0);
  Σ net_paid = −Σ foreigntotal; every grower reconciles (0/27 mismatch); spot-check `2528-LMBEP`
  line-by-line exact.
- Totals: gross **$174,919,596.36** − deductions **$32,498,332.21** − tax **$2,718,743.69** =
  net_paid **$139,702,520.46** = −Σ bill_total. Paid **1087** / unpaid **8** (flagged, null paid_date).

## Test status
- `npm run typecheck` clean · `npm test` **48/48** (OAuth KAT; charge classification; line rollup
  reproducing the live ZONTA reconciliation; WADDA crosswalk; line-type filtering).
- **No regression:** `cube:rls` **12/12** · `cube:reconcile` **347/347** · `mcp:proof` **25/25**.
- **Cube settlement live:** `cube:settlement` **7/7** (internal parity + grower scope + fail-closed + forged).

## Decisions stated
- **Incremental key = `lastmodifieddate`** (change capture — a bill mutates after `trandate`:
  deductions corrected, approval, payment-application flips status). `trandate` = settlement/business
  date. NetSuite has `limit`/`offset` → offset pagination (no time-windowing needed).
- **Gross vs deduction by SIGN** (positive = money to grower = gross; negative = deduction), category
  (FR/WH/MD/LA/MI) by `itemid` prefix. Reconciles by construction; LA's mixed sales+charges handled.
- `semantic.grower_settlement` = **bill grain** (user decision); line detail stays in core.

## What is NOT done (deferred — not faked)
- Retailer AR (CustInvc, 12,529) + Finance/GL → later NetSuite sprints.
- Line-to-load lineage (settlement is product-grain; FreshTrack read-replica still blocked).
- Write-back to NetSuite — never (read-only TBA role).

## Known issues / notes
- **`.env` reverts** — something on this machine (an editor with `.env` open, or a file-sync)
  restored `.env`'s `DATABASE_URL` to the placeholder mid-session, which produced spurious `28P01`
  auth failures (NOT a pooler lockout, as first suspected). The committed loaders read `DATABASE_URL`
  at startup — keep `.env` stable; each run here rewrote it immediately before invoking.
- `makePool` now forces `sslmode=no-verify` + `rejectUnauthorized:false` (the Supabase pooler's
  private-CA cert fails Node ≥20's default verification) and `db.ts` gained a `bigint` ColKind —
  latent fixes that also unblock the existing dispatch loaders on Node 25.
- Loader fetches each stream WITHOUT holding a DB connection — a connection left idle through the
  ~46k-line fetch gets dropped by the pooler, which crashed the first two attempts.

## Files changed (Sprint 5)
- `src/lib/{oauth1,netsuite,ns_specs,ns_charges,ns_lines,ns_crosswalk}.ts`; `src/lib/{env,db}.ts`
  (NS env + `bigint` + ssl)
- `src/loaders/{ns_settlement,ns_core}.ts`
- `supabase/migrations/{0014_raw_ns_settlement,0015_core_settlement,0016_semantic_grower_settlement}.sql`
- `cube/model/cubes/settlement_bill.yml`, `cube/model/views/settlement.yml`, `cube/cube.js` (queryRewrite)
- `scripts/{ns_smoke,ns_line_reconcile,ns_settlement_rls_proof,ns_net_parity,cube_settlement_check}.ts`
- `tests/{oauth1,ns_charges,ns_lines,ns_crosswalk}.test.ts`
- `package.json` (ns:* + cube:settlement scripts), `.env.example` (NS_*), `CLAUDE.md`, `HANDOFF.md`
- `reports/ns_line_reconcile_2026-06-21.md`

## Exact next step
Start the retailer-AR (CustInvc, 12,529) NetSuite sprint over the same TBA/medallion pattern.
Rotate the chat-shared secrets (Cube deploy token + `CUBEJS_API_SECRET`) and fix whatever keeps
reverting `DATABASE_URL` in `.env` (an open editor / file-sync) so loader runs stop hitting it.

---

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
