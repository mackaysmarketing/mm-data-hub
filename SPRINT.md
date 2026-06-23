# Sprint 7: FreshTrack dispatch DB backfill
Date: 2026-06-23
Repo: mackaysmarketing/mm-data-hub
Hub (target): Supabase `uqzfkhsdyeokwnkpcxui` (ap-southeast-2) — NOT "Analytics Agent"
Source: FreshTrack production DB, read-only — `FRESHTRACK_DATABASE_URL`
(`cloud_mackaysmarketing_readonly` @ `fts-cloud-prod-rds.c1unadkiffrs.ap-southeast-2.rds.amazonaws.com` / `cloud_mackaysmarketing`). This is production, not a replica — the big backfill runs OFF-PEAK.

## Scope
The warehouse dispatch tables that feed the dashboard — `raw.ft_dispatch_load` (5,926 loads) and `raw.ft_pallet` (38,796 pallets), surfaced through `semantic.grower_dispatch_detail` — are stale and partial. Latest dispatch is 2026-06-20 but coverage is thin: a single grower (LMB) has only 22 rows, all dated 2025-07-15, with null box counts, and nothing in 2026. This sprint builds a dispatch loader that pulls the full, current dispatch history directly from the FreshTrack production DB into those exact warehouse tables, mirroring the proven Sprint 6 GP loader (`ft_gp.ts`): keyset-paged read, idempotent upsert on `id`, resumable via `raw.sync_window`, incremental by `last_modified`. NOT in scope: building a `core.fact_dispatch` layer, touching the separate app-side `public.ft_*` dispatch path, or building any new dashboard tile / Cube cube. The deliverable is correct, current dispatch data in the tables the existing view already reads.

## Why this is needed (evidence)
- `raw.ft_dispatch_load` = 5,926 and `raw.ft_pallet` = 38,796 — unchanged since the Sprint 1 load; no `dispatch` stream has ever run through `raw.sync_window` (only `gp:*` and `ns_*`).
- The app-side `public.ft_*` path syncs dispatch incrementally (`public.ft_sync_state.dispatchLoads`), but it writes to `public.ft_dispatch` (~739 rows) which the dashboard does NOT read. The dashboard reads `raw` → `semantic.grower_dispatch_detail`.
- Net effect: the warehouse dispatch layer is a frozen, partial Sprint 1 snapshot. LMB (a real four-farm grower, all entities `is_active`) shows 22 rows ending 2025-07-15. That is a load gap, not reality.

## Step 0 — Discovery (REQUIRED before writing the loader)
Run the recon against `FRESHTRACK_DATABASE_URL` (`freshtrack_recon.mjs`, already in repo/outputs — metadata + row estimates only, load-safe). Produce and commit a source→target column map before any loader code:
- [ ] Identify the FreshTrack source dispatch-load and pallet tables, their `id`, and the `last_modified` (and pickup-date) columns.
- [ ] Map source columns → the `raw.ft_dispatch_load` / `raw.ft_pallet` columns that `semantic.grower_dispatch_detail` consumes: `grower_key` (= consignor_id), `dispatched_on`, `dispatched_at`, `pack_date`, `pack_week`, `load_no`, `pallet_id`, `pallet_no`, `crop`, `variety`, `product`, `boxes`, `net_weight`, `net_weight_unit`, `is_field`, `is_archived`, and the pallet→load linkage.
- [ ] Confirm LMB's dispatch in the source is keyed to the LMB consignor_ids (`LMBFA`, `LMBBF`, `LMBCO`, `LMBEP`) so rows land under the right `grower_key`.
- [ ] If the source schema diverges from the current `raw.ft_dispatch_load` / `raw.ft_pallet` shape, STOP and flag it as a decision — do not silently alter `semantic.grower_dispatch_detail`.

## Acceptance Criteria
- [x] **Target is correct.** Writes ONLY to `raw.ft_dispatch_load` / `raw.ft_pallet`. Not `public.ft_*`, not new tables.
- [x] **Target is asserted at runtime.** `assertHubTarget(pool)` aborts before any write unless the resolved write connection carries `uqzfkhsdyeokwnkpcxui` (the pooler keeps the ref in the USERNAME, not the host) AND the live DB exposes the view-backing tables. `connStringTargetsHub` unit-tested; fired live.
- [x] **Backfill lands current data.** `ft:dispatch:reconcile` PASS: loads **22,033/22,033 (0.00%)**, pallets **201,894/201,852 (+0.02%)**, Σnet_weight/Σboxes within 0.02%; `max(dispatched_on)` = **2026-06-27** (current). +42 pallet residual = upsert-no-delete (within 2% tol; surfaced).
- [ ] **LMB proof (user-facing) — DEFERRED (user decision).** The source caps LMB at `actual_pickup_on` 2025-07-15 and records boxes in `reconsigned_boxes`, not `box_count`. **672 LMB loads landed in `raw`**; dashboard visibility needs the dispatched/boxes redefinition (`DISPATCH_DEFINITION_PROPOSAL.md`). Not achievable by the backfill alone — held as the documented next step per the option-A decision.
- [x] **Idempotent.** Slice + incremental re-runs grew 0 rows (22,033 / 201,894 stable).
- [x] **Incremental works.** `--since=2026-06-23` picked up only 198 loads / 781 pallets by `last_modified_on`; `raw.sync_window` `dispatch` + `pallet` both `status=done`.
- [x] **RLS intact.** `ft:dispatch:rls` **7/7**: internal all (44,392), grower own-only, no-claim→0, forged→0, no widening.
- [x] **Reconcile proof exists.** `ft:dispatch:reconcile` — counts/volumes/per-grower/per-pack-week/currency, variances surfaced. PASS.
- [x] **No regression.** All green: `cube:reconcile` 471/471 · `cube:rls` 12/12 · `cube:settlement` 7/7 · `cube:gp` 9/9 · `ns:reconcile` PASS · `ns:rls` 7/7 · `ns:parity` 5/5 · `ft:gp:reconcile` PASS · `ft:gp:parity` 5/5 · `ft:gp:rls` 14/14.

## Definition of Done
- [ ] All acceptance criteria checked with evidence (query output / proof-script results pasted into HANDOFF.md)
- [ ] Reconcile + idempotency proofs green; typecheck clean; full test suite passing
- [ ] HANDOFF.md updated (honest "what is NOT done")
- [ ] Committed in logical chunks AND the commit confirmed present on `origin/main` — `git log origin/main` shows it, `0 ahead`. (Encoded fix: last sprint's final commit `bfaed42` failed to push and was left local; do not declare done on an unpushed commit.)

## Out of Scope
- `core.fact_dispatch` conformance layer (raw → view-direct is the current architecture; a core fact is a later sprint unless explicitly added).
- The app-side `public.ft_*` dispatch path (separate loader, not the dashboard source).
- New dashboard tiles or Cube cubes/measures for dispatch.
- Reconsignment apportionment, scan data, any non-dispatch source.

## Key decisions (mirror Sprint 6, stated up front)
- **Source / cadence:** FreshTrack prod DB (read-only), keyset-paged with `statement_timeout`; full backfill OFF-PEAK (production-direct, gentle); incremental thereafter.
- **Target:** `raw.ft_dispatch_load` + `raw.ft_pallet`; host asserted = `uqzfkhsdyeokwnkpcxui`.
- **Idempotency / resumability:** upsert on `id`; `raw.sync_window` streams for dispatch + pallet.
- **Incremental key:** `last_modified` (exact column confirmed in Step 0; pickup-date noted).
- **Mirror:** `loaders/ft_gp.ts` for the loader; `ft_gp_reconcile.ts` for the proof; the GP RLS proof for the RLS check.

## Quality Rubric — Mackays Tools (internal) + universal
| Criterion | What to check |
|-----------|--------------|
| **Write-target safety** | Loader asserts hub host (`uqzfkhsdyeokwnkpcxui`) before any write; aborts otherwise. Hard blocker. |
| **FreshTrack DB read** | Read-only; keyset-paged; `statement_timeout` set; off-peak for backfill; null-safe column mapping. |
| **Star/warehouse conformance** | Writes only to the view-backing `raw.ft_dispatch_load` / `raw.ft_pallet`; column map preserves what `semantic.grower_dispatch_detail` reads. No silent view changes. |
| **Idempotency** | Re-run does not grow counts; resumable via `raw.sync_window`. |
| **Supabase RLS** | `semantic.grower_dispatch_detail` fail-closed behaviour preserved; no widening. |
| **Grower isolation** | Grower A cannot see Grower B's dispatch under any claim permutation. Hard blocker. |
| **Automation safety** | Explicit stop conditions; reconcile-to-source proof; no silent data loss on malformed/archived rows. |
| **No secrets in code** | `FRESHTRACK_DATABASE_URL` and hub URL from env only. |
| **Clean handoff** | Working tree clean; commit on `origin/main`; HANDOFF.md current. |
**Threshold:** write-target safety and grower isolation are hard blockers; everything else 5/5.

---

## Evaluator session opener (Phase 3 — paste into a fresh Claude Code session after the build)

```
You are a skeptical senior engineer doing QA on a dispatch backfill that was just written for mm-data-hub.
Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are certain it meets the standard. Verify against the live hub, not the run log.

Start by reading SPRINT.md and HANDOFF.md, then specifically verify:
- TARGET: confirm the loader wrote to raw.ft_dispatch_load and raw.ft_pallet (NOT public.ft_*, NOT a new table). Confirm the loader asserts the hub host uqzfkhsdyeokwnkpcxui before writing — try to prove it would abort against the wrong DB.
- LANDED: query the live hub. Is max(dispatched_on) current? Do raw.ft_dispatch_load / raw.ft_pallet counts reconcile to the FreshTrack source counts? Re-run the reconcile script and read the output.
- LMB: run the dashboard's own query — does semantic.grower_dispatch_detail return LMB dispatches for the most recent completed week, with non-null boxes, across LMBFA/LMBBF/LMBCO/LMBEP? If LMB is still empty, the sprint failed regardless of what the handoff claims.
- IDEMPOTENCY: run the incremental again. Did any count grow? It must not.
- RLS: prove semantic.grower_dispatch_detail still fail-closes — internal all, grower own only, no-claim 0, forged 0.
- NO REGRESSION: run cube:*, ns:*, ft:gp:* proofs. Report any failure.
- PUSH: confirm the final commit is on origin/main (git log origin/main, 0 ahead). A local-only commit is not done.

Report each as PASS/FAIL with the evidence. Do not say the work is complete unless you have verified every one.
```
