# Sprint: Warehouse closeout — conformed dims, cross-source ties, governance sweep, MCP wiring
Date: 2026-07-11
Repo: mm-data-hub

## Why this bundle
Tim deferred the revenue-class marking and asked for one large session that closes as many remaining
items as possible. This sprint bundles everything from the backlog (DATA_HUB_AUDIT.md §8, prior
SPRINT out-of-scope lists, session memory) that is (a) buildable autonomously from data already in
reach, (b) not gated on Tim's sign-off, external credentials, infra decisions, or another repo.
Everything excluded is listed at the bottom WITH its blocking reason, so the backlog after this
sprint is only "genuinely blocked" items.

## Scope — seven chunks, in build order

### Chunk 1 — Conformed dimensions: dim_customer, dim_product, dim_date (audit §8.10)
The biggest reporting gap that is purely internal work. Verified live 2026-07-11:
- **Customer names have ZERO coverage** — 103 distinct load consignees / 66 GP consignees, none
  present in raw.ft_entity (318 rows ≈ consignors only). This is why
  semantic.settlement_bridge_by_customer carries NULL names today.
- ~153–156 distinct product_ids across pallets/orders/GP; product names currently live only in
  pallet display strings (SPEC §9.7 format codes) — parsed ad hoc, never conformed.
Build:
- **Extend the entity ingest** to land ALL entities referenced as load/GP consignees (raw.ft_entity
  is our landing table; widening its ingest is a loader change, not a schema break). Idempotent,
  window-resumable as usual.
- **core.dim_customer** (consignee grain): name, entity metadata, is_consignee/is_consignor flags.
  INTERNAL-ONLY + cube_readonly (no grower-facing view joins it today; least privilege, additive
  later).
- **core.dim_product** (product_id grain): display name parsed per SPEC §9.7 (strip `^{…}`/`[nn]`
  codes), crop, variety, pack descriptor — sourced from pallet descriptors (+ order item_no/EAN
  where they exist). SHARED REFERENCE posture (harmless lookup; a grower view may join it later)
  — same rationale as dim_dispatch_state in 0030.
- **core.dim_date**: calendar date grain incl. ISO week + the FreshTrack pack-week code (`Y{YY}W{WW}`)
  so pack-week ↔ calendar joins stop being string surgery. SHARED REFERENCE.
- **Wire names through**: refresh core.fact_settlement_bridge denormalising consignee_name from the
  now-complete entity set; settlement_bridge_by_customer shows real names.

### Chunk 2 — Settlement cross-source tie at bill grain (NetSuite ↔ GP)
The deferred "NetSuite fact_settlement_bill cross-check". Both sides are landed and proven
individually; the tie exists only as one-off parity numbers (grand net 0.6%, deductions 0.1%).
Build **core.recon_settlement_source** (view, internal-only): grower × month with GP
gross/deductions/GST/net/paid vs NetSuite gross/deductions/tax/net/paid + deltas, plus
`npm run settle:tie` printing grand + per-grower ties and the explained residuals (AG* sub-entities,
null-consignor schedules) — committed report. No new facts; a governed reconciliation surface.

### Chunk 3 — Retail brought to proof parity (audit Tier 1 #3)
Retail is the only live domain without the house-standard reconcile proof.
`scripts/retail_reconcile.ts` (`npm run retail:reconcile`): raw→semantic invariants — day-grain
latest-capture dedupe correctness, watchlist flag counts vs dim_retail_product, per-retailer/state
row parity vs raw, NULL prices preserved (never coalesced) — committed report in reports/.

### Chunk 4 — Automated RLS/grant posture sweep
0030 already remediated dim_dispatch_state / dim_gp_charge / dim_ns_charge (the old out-of-scope
note is stale). Verified stragglers today: **core.dim_shed has RLS disabled**; grant/policy
combinations drift silently. Build `scripts/rls_posture.ts` (`npm run rls:posture`): enumerate EVERY
relation in raw/core/semantic and assert it matches one declared posture —
{grower-scoped, internal-only, shared-reference, cube-only, etl-only} — from an explicit in-script
registry; FAIL on unknown relations or anomalies (e.g. authenticated grant with RLS off). Fix what
it finds (known: dim_shed — posture per its consumer surface; check whether a grower view joins it
before choosing shared-reference vs internal). Joins the standing proof suite.

### Chunk 5 — Hub MCP: multi-farm identity, wire sales, self-deriving proofs
Three known gaps, all internal wiring (NOT the remote connector — see exclusions):
1. **`mcp/identity.ts` reads only the scalar `consignor_id`** — migration 0026 widened RLS to a
   consignor SET, so a multi-farm grower under-scopes through the MCP today. Read
   `app_metadata.consignor_ids[]` with scalar fallback, matching DB + Cube.
2. **Wire `list_grower_sales`** (stubbed "Phase 2 — replica blocked"; settlement has long been
   landed): grower-scoped settlement listing over semantic.grower_gp_settlement (paid date
   first-class), same envelope + registry validation as the other tools.
3. **`scripts/mcp_proof.ts` baselines are stale June-21 hardcodes** (19/25 today on baseline drift
   only). Replace absolute-count asserts with source-SQL-derived expectations computed in the same
   run, and extend the suite to cover the new sales tool across all five contexts.

### Chunk 6 — Freshness: incremental loads everywhere + full suite re-run
Prove the pipelines are turnkey and retire the stale-baseline class of failure: run every
incremental loader (dispatch GraphQL windows + pallets + entities incl. the chunk-1 widening; GP
`--since`; NetSuite `--since`; orders), document row deltas, then re-run the ENTIRE proof battery
green on fresh data: dispatch reconcile, GP reconcile + parity + RLS, NS reconcile + RLS + parity,
order reconcile + RLS, bridge verify + RLS, retail reconcile (new), settle:tie (new), rls:posture
(new), rls:multifarm, mcp:proof (now self-deriving), unit tests, typecheck.
Note (memory, to re-verify): plain `ft:dispatch:load` previously aborted on Sprint-8 draft state;
raw.ft_dispatch_load_state now exists with 14 rows — if the loader still trips, fix forward, don't
work around.

### Chunk 7 — Documentation closeout
- Commit the currently-untracked DATA_HUB_AUDIT.md, GROWER_MCP_PROPOSAL.md,
  KNOWLEDGE_GRAPH_PROPOSAL.md (this sprint references them; they must survive the working tree).
- Update CLAUDE.md (new dims, new proofs, posture registry) and HANDOFF.md (evidence per chunk).
- Clean tree at handoff. Push remains MANUAL (mackaysmarketing PAT per CLAUDE.md — listed for Tim).

## Acceptance Criteria
- [ ] **C1 dims:** raw.ft_entity covers 100% of load + GP consignee_ids (paste before/after counts);
      dim_customer / dim_product / dim_date exist with row counts pasted; product names parse clean
      (0 rows still carrying `^{…}`/`[nn]` codes); settlement_bridge_by_customer returns real names
      (paste top-10 customers by grower_gross); bridge refresh re-run with 23,544-row parity intact.
- [ ] **C2 tie:** recon_settlement_source exists; settle:tie output pasted — grand GP-vs-NS net within
      the known 0.6%, per-grower table, every residual bucket explained (not hand-waved); report
      committed.
- [ ] **C3 retail:** retail:reconcile passes with pasted output (dedupe, watchlist, parity, null-price
      invariants); report committed.
- [ ] **C4 posture:** rls:posture enumerates every raw/core/semantic relation with ZERO unclassified
      and ZERO anomalies (paste summary); dim_shed (and anything else found) remediated by migration
      with the posture rationale documented; no existing policy weakened.
- [ ] **C5 MCP:** multi-farm consignor_ids[] honored (proof: multi-farm grower context sees BOTH farms
      through the MCP, single-farm unchanged, forged/no-claim still 0); list_grower_sales live with
      identity proofs across internal + 2 growers + no-claim + forged; mcp:proof fully self-deriving
      and green (paste N/N); no baseline constants remain.
- [ ] **C6 freshness:** every incremental loader run with row deltas pasted; the full proof battery
      re-run green AFTER the loads (paste the consolidated results table).
- [ ] **C7 docs:** audit + proposals committed; CLAUDE.md + HANDOFF.md updated; `git status` clean
      (paste); commits listed for Tim to push.

## Definition of Done
- [ ] All acceptance criteria checked with pasted evidence
- [ ] `npm run typecheck` clean; `npm test` green; every proof script green on fresh data
- [ ] No destructive SQL; migrations touch only raw/core/semantic; nothing weakens an existing policy
- [ ] HANDOFF.md updated; committed to git (push manual — PAT)

## Quality Rubric (Mackays / mm-data-hub)
- SQL against the layers is the oracle; counts reconcile across every boundary; no key field dropped.
- Defensive on nulls everywhere (names, prices, dates); never coalesce measures to 0.
- New dims ship with declared RLS posture + policies matching the house patterns; enforcement proven.
- Idempotent, resumable loaders; re-run lands zero net-new rows.
- Universal: no secrets, no empty catch blocks, no TODO in the critical path, clean tree at handoff.
- Hard blockers: posture sweep zero-anomaly, MCP multi-farm fix proven, freshness battery green.

## Goal Condition
/goal The closeout sprint is done in mm-data-hub per SPRINT.md dated 2026-07-11: (C1) dim_customer +
dim_product + dim_date built with full consignee coverage and real customer names flowing through the
bridge views; (C2) settle:tie green with the GP↔NetSuite bill-grain reconciliation surface committed;
(C3) retail:reconcile green and committed; (C4) rls:posture enumerates every raw/core/semantic
relation with zero unclassified and zero anomalies, stragglers remediated; (C5) MCP honors
consignor_ids[] multi-farm identity, list_grower_sales is wired, and mcp:proof is self-deriving and
fully green; (C6) all incremental loaders run and the entire proof battery re-run green on fresh
data; (C7) docs committed and tree clean. Paste real command output as evidence for every criterion.
Do not touch public.*, Cube config, the revenue_class column values, or grower-facing view
definitions except where a chunk explicitly says so. Stop after 45 turns.

## Explicitly deferred — and why (the post-sprint backlog is exactly this list)
- **Revenue classification wiring** — Tim deferred the marking (2026-07-11). Tool is ready
  (reports/revenue_class_marker_2026-07-09.html); wiring resumes when the CSV comes back.
- **Cube exposure of the settlement bridge** — SPRINT 2026-07-09 gates it on Tim signing off the
  variance + revenue definitions; revenue is deferred, so the gate stands.
- **Dispatch metric redefinition** (seq≥5 + stock+reconsigned as THE dispatch definition) — designed,
  deferred pending ops sign-off; the additive dispatch_shipped surface already exists.
- **Grower-facing remote MCP connector** — needs hosting + auth-shape decisions (OAuth 2.1 vs interim
  token) and mm-hub token issuance; chunk 5 deliberately completes every part that is internal.
- **Business knowledge graph MVP** — its sources live in mm-hub's `public.*` schema, which this repo
  must not read; needs an agreed cross-repo interface (export, FDW, or mm-hub-owned view) first.
- **Customer AR invoicing + remittance reconciliation** — its own sprint per the audit (per-customer
  PDF parsing scoped at design time); chunk 1's dim_customer is deliberately its prerequisite.
- **Harvest/yield, retail scan (IRI/Quantium), wholesale benchmarks, QC/claims** — new external
  sources requiring discovery/credentials.
- **Backfilling the 2,339 loads with no order_id** — a source-data gap, not derivable in the hub.
- **Push to GitHub** — requires the mackaysmarketing PAT (manual, per CLAUDE.md).

## Notes for the build session
- Replace this file's predecessor (settlement-bridge sprint) is already committed at bc03af7; commit
  this SPRINT.md before starting.
- Bridge refresh + any big rebuild: use the temp-table + ANALYZE pattern (0031) — CTEs get no stats
  and the pooler login timeout is 2 min; `set local statement_timeout` inside a transaction.
- raw.ft_entity widening: additive columns only if needed; existing 318 rows must be preserved
  (upsert on id, house pattern).
- dim_customer names are commercially neutral (business names) but the customer LIST is internal —
  internal-only posture unless a grower surface is found to need it (then document the change).
- Run the evaluator (dispatched Agent View session, standard skeptical-QA prompt) after the goal loop
  reports done; it must re-run the SQL itself.
