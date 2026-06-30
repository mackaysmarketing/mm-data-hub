# Sprint 8: Additive shipped-dispatch surface (Option C)
Date: 2026-06-30
Repo: mm-data-hub
Source of truth: `DISPATCH_DEFINITION_PROPOSAL.md` (2026-06-23). This sprint implements **Option C (additive)** — NOT Option B (redefine in place). If a re-baseline of the existing metric is actually wanted, that is a different, signed-off sprint.

## Scope
Today's governed dispatch definitions don't match how FreshTrack records dispatch: `dispatched = actual_pickup_on IS NOT NULL`, but `actual_pickup_on` is null on most shipped loads (100% of LMB's 2026 loads, 0% populated for 23 of 49 growers). Result: **22 of 49 active growers are invisible on the dashboard** and boxes undercount business-wide.

This sprint adds a **new, contract-compliant surface** that defines dispatch by load state instead, and leaves every existing metric untouched. The existing `actual_pickup_on`-based surface keeps working byte-for-byte; consumers opt in to the new one.

Build (all additive):
- `core.dim_dispatch_state` (+ its raw landing) — the 14-state FreshTrack lifecycle (id, code, name, sequence), Shipped = sequence 5.
- `semantic.grower_dispatch_shipped` — new view: `dispatched_on = coalesce(actual_pickup_on, scheduled_pickup_on)`, `boxes = coalesce(stock_boxes,0) + coalesce(reconsigned_boxes,0)`, gated `WHERE dispatch_state.sequence >= 5`, Sell loads only (`order_type = 'S'`), `is_test = false` — mirroring the existing view's non-state filters.
- New Cube surface (separate cube + view `dispatch_shipped`, reading the new semantic view): measures `shipped_load_count`, `boxes_packed` (+ pallet/net-weight on the shipped basis); dims `dispatch_state`, `effective_dispatched_on`, plus `grower_key` and the existing dimension set (consignor_*, origin_shed_*).
- `cube.js` `VIEW_GROWER_KEYS` gains `dispatch_shipped → dispatch_shipped.grower_key` — **the RLS anchor for the new view.**

Leave untouched (this is the whole point of C):
- `semantic.grower_dispatch_detail` and the existing `dispatch` Cube view/cubes (the `actual_pickup_on` definition). No edit, no re-baseline.
- The `consignor_*` / `origin_shed_*` work already shipped.

## Design decisions (confirm or override)
1. **Separate surface, not additive members on the existing dispatch view.** Two dispatch definitions sitting side by side on one view (`load_count` vs `shipped_load_count`) is a self-serve footgun. A distinct `dispatch_shipped` view keeps the definitions cleanly separated. (Alternative: additive members on the existing view — fewer objects, more ambiguity. Recommend separate.)
2. **Threshold `seq >= 5` is a parameter pending ops sign-off** (see Promotion gate). Build it as a single, clearly-marked WHERE condition so changing the line (e.g. to Delivered = seq ≥ 7) is a one-line edit.
3. **State dim source.** Prefer mirroring the existing `gp_status` raw→core pattern (FreshTrack-sourced). If the FreshTrack state lookup isn't readily ingestable this sprint, seed `core.dim_dispatch_state` from the 14 enumerated states in the migration as a documented interim — they're stable.

## Run as two bounded sessions
- **Phase A — Supabase (no deploy):** `core.dim_dispatch_state` + `semantic.grower_dispatch_shipped`. Fully provable in SQL; reproduces the entire blast-radius table on its own. Criteria 1–7, 9.
- **Phase B — Cube (deploy-gated):** the `dispatch_shipped` cube/view + the `VIEW_GROWER_KEYS` RLS wiring + deploy. Criteria 8, 10, plus re-confirming 2–4 through `/load`.

Each phase is its own `/goal` with its own turn cap and its own gate. Don't run both in one marathon session.

## Acceptance Criteria
SQL criteria run read-only against the DB. `/load` criteria run through the governed REST `/load` API with an internal-signed context (`npm run cube:reconcile` / `cube:rls` mechanism); the MCP chat tool is RLS fail-closed (0 rows) — use it only for execution/schema, never values. Paste real output for every claim. All figures are 2026 Sell loads.

**Phase A — Supabase**
- [ ] **1. State dim** — `core.dim_dispatch_state` has the 14 states with correct sequences (Open=1 … Shipped=5 … Paid=13 … Closed=14). Paste `\d core.dim_dispatch_state` + the rows.
- [ ] **2. Global re-baseline lands** — shipped loads (new view) ≈ **7,681** vs the old surface's **2,953** (×2.6). Paste both counts from the same query basis.
- [ ] **3. LMB becomes visible** — LMB shipped loads = **248** (resolve the 248-vs-250 discrepancy in the proposal and state which is right and why); LMB boxes = **296,824** (was 17,840, ×16.6). Paste.
- [ ] **4. 22 growers flip visible** — count of the 49 non-test growers with 0 loads on the old surface but >0 on the new = **22**. Paste the count and the grower list.
- [ ] **5. Boxes formula sound + targeted** — (a) `box_count == stock_boxes` for 100% of pallets (paste the invariant check); (b) the 15 stock-only growers are unchanged (MMTRU 1.56M→1.56M, MMANN 155,005→~155,007); (c) reconsignment growers correct upward (LMBCO ≈ 15.8×, LMBEP ≈ 21.6×). Paste.
- [ ] **6. `seq >= 5` is clean** — of the ~7,681 shipped loads, ≤ 6 have no pallets and ≤ 16 have zero boxes (≈0.2%). Paste.
- [ ] **7. Existing surface UNCHANGED (additive proof)** — `semantic.grower_dispatch_detail` returns identical numbers post-change (old-basis global dispatched loads still **2,953**; LMB still its single 2025-07-15 row). Paste before/after.
- [ ] **9. Date fallback works** — shipped loads with null `actual_pickup_on` carry `scheduled_pickup_on` as `dispatched_on` (LMB's 100%-null loads now have dates); none of the gated loads are dateless (or the count that are is reported, informing the `pack_date` decision). Paste a sample.

**Phase B — Cube**
- [ ] **8. RLS on the new surface (SECURITY-CRITICAL)** — `cube.js` `VIEW_GROWER_KEYS` contains `dispatch_shipped: 'dispatch_shipped.grower_key'`; a `/load` query on the new view under a single-grower context returns ONLY that grower's rows (or fail-closed 0 under NIL context), while the internal context returns all growers. The new semantic view has the same RLS policy as `grower_dispatch_detail`. Paste the scoped-vs-internal results and the policy/`pg_policies` row.
- [ ] **10. New measures live + additive** — `/meta` shows the new `dispatch_shipped` view with `shipped_load_count` / `boxes_packed` / `dispatch_state` / `effective_dispatched_on`; the existing `dispatch` view `/meta` is byte-identical to before (6 measures + 11 dims, nothing changed). A `/load` of `shipped_load_count` reproduces ≈7,681. Paste both member lists and the query.

## Definition of Done
- [ ] All acceptance criteria checked with pasted evidence (1–7, 9 for Phase A; 8, 10 for Phase B)
- [ ] Own branch per phase (e.g. `feat/dispatch-shipped-semantic`, then `feat/dispatch-shipped-cube`); not pushed to main without approval
- [ ] No existing migration edited in place; new migration(s) only
- [ ] Independent evaluator session per phase confirms its criteria (skeptical prompt + rubric)
- [ ] HANDOFF.md updated and committed at the end of each phase
- [ ] Working tree clean

## Gates
**Supabase migration apply (Phase A).** Migrations write to the DB. If a Supabase dev branch exists, apply + prove there. If migrations apply to prod directly (as 0022 did), build + commit the migration, prove the view logic read-only against current data, then **stop and request approval before applying the migration to prod**. Don't alter the raw layer's existing tables.

**Cube deploy (Phase B).** Only prod deployment 1 ("MM Data Hub") is queryable — no reachable dev. Build + commit, verify the deploy-free parts (cube.js diff, source review), then **stop and request deploy approval**. PENDING-DEPLOY until approved. Deploy: `cd cube && npx cubejs-cli deploy --token <hex CLI token>` — hex, not a JWT. **Tim runs the deploy himself and does NOT paste the token into the agent session, then says "deployed."** The agent then runs criteria 8 + 10 against prod.

**Promotion gate (NOT this sprint).** Pointing the dashboard / Steep / consumers at the new surface, and any consumer comms, waits on: (1) ops sign-off that `seq >= 5` is the right "has left the dock" line; (2) one stock-load portal cross-check of "boxes packed" (the SQL invariant `box_count == stock_boxes` is already proven; the portal screen closes it). This sprint delivers the surface; it does not switch anyone onto it.

## Quality Rubric
| Criterion | What to check |
|---|---|
| Additive contract honored | Existing `grower_dispatch_detail` + existing dispatch Cube surface return identical numbers. Old-basis global = 2,953 unchanged. Nothing removed or redefined. |
| RLS on new surface | New view registered in `VIEW_GROWER_KEYS`; scoped query returns only the caller's grower; same RLS policy as the existing dispatch view. No leak path. |
| Definition correctness | `seq >= 5` gate; `coalesce(actual, scheduled)` date; `stock_boxes + reconsigned_boxes` boxes. Numbers match the proposal's blast-radius table. |
| Targeted boxes change | Stock-only growers unchanged; reconsignment growers corrected up. The change is well-aimed, not blanket. |
| Threshold parameterised | The `seq >= 5` line is a single, clearly-marked, one-edit-to-change condition — ops may move it. |
| Migration safety | New migration only; no existing migration edited; no raw-table mutation. |
| No secrets / clean tree | No token/DB URL committed. Tree clean at each handoff. |

## Goal Condition — Phase A (Supabase)
```
/goal Build the additive shipped-dispatch SEMANTIC surface (Option C, not B). Add core.dim_dispatch_state
(14 FreshTrack states, Shipped=seq 5; mirror the gp_status raw->core pattern, or seed the 14 states in the
migration if the FreshTrack lookup is not ingestable this sprint) and a NEW semantic.grower_dispatch_shipped
view: dispatched_on = coalesce(actual_pickup_on, scheduled_pickup_on), boxes = coalesce(stock_boxes,0) +
coalesce(reconsigned_boxes,0), gated WHERE state sequence >= 5 (single clearly-marked condition), Sell loads
only, is_test=false. Do NOT touch grower_dispatch_detail or any existing metric. Prove with SQL, pasting each
result (2026 Sell): (1) dim_dispatch_state has the 14 states with correct sequences; (2) shipped loads ~7,681
vs old 2,953 (x2.6); (3) LMB shipped loads = 248 (resolve 248 vs 250) and LMB boxes = 296,824; (4) exactly 22
of 49 non-test growers flip 0->>0; (5) box_count==stock_boxes for 100% of pallets, stock-only growers
unchanged (MMTRU 1.56M, MMANN ~155,005), recon growers up (LMBCO ~15.8x); (6) of ~7,681 loads <=6 have no
pallets and <=16 zero boxes; (7) grower_dispatch_detail is UNCHANGED (old-basis global still 2,953); (9) the
date fallback gives null-actual loads a scheduled date and reports any dateless gated loads. New migration
only, no existing migration edited, raw tables not mutated. Own branch, do not push to main. Migration apply
gate: if a Supabase dev branch exists apply+prove there, else build+commit+prove read-only and request
approval before applying to prod. Stop after 25 turns.
```

## Goal Condition — Phase B (Cube)
```
/goal Build the additive shipped-dispatch CUBE surface over semantic.grower_dispatch_shipped (Phase A must be
applied first). Add a NEW dispatch_shipped cube+view with measures shipped_load_count, boxes_packed (and
pallet/net-weight on the shipped basis) and dims dispatch_state, effective_dispatched_on, grower_key, plus the
existing consignor_*/origin_shed_* dimension set. CRITICAL: register dispatch_shipped in cube.js
VIEW_GROWER_KEYS as dispatch_shipped.grower_key so the new view is RLS-gated. Do NOT touch the existing
dispatch cube/view. Prove via the governed /load API, pasting each result: (8) cube.js VIEW_GROWER_KEYS
includes dispatch_shipped.grower_key; a /load on the new view under a single-grower context returns ONLY that
grower's rows (NIL context -> 0), internal context returns all; the new semantic view has the same RLS policy
as grower_dispatch_detail; (10) /meta shows the dispatch_shipped view with the new members AND the existing
dispatch view /meta is byte-identical (6 measures + 11 dims unchanged); a /load of shipped_load_count
reproduces ~7,681. Own branch, do not push to main. Deploy fence: only prod deployment 1 is queryable -
build+commit, verify cube.js diff deploy-free, then request deploy approval (Tim deploys, does not paste the
token); PENDING-DEPLOY until approved. Stop after 20 turns.
```

## Evaluator opener (both phases)
```
You are a skeptical senior engineer doing QA on an additive Cube/semantic change that was just written.
- Read SPRINT.md, DISPATCH_DEFINITION_PROPOSAL.md, and HANDOFF.md first.
- This is Option C (additive). FAIL it immediately if the existing grower_dispatch_detail view or the existing
  dispatch Cube surface was modified, or if any existing metric's numbers moved (old-basis global must still be
  2,953).
- Re-run every acceptance criterion for this phase yourself (SQL for Phase A; governed /load for Phase B - NOT
  the MCP chat tool, it is RLS fail-closed). Reproduce the proposal's numbers: ~7,681 shipped, LMB 248/296,824,
  22 growers flipped.
- Phase B: independently confirm the new view is in VIEW_GROWER_KEYS and that a single-grower context CANNOT see
  another grower's rows. Treat a missing RLS anchor as a hard security failure.
- Confirm the seq>=5 gate is a single parameterised condition and the boxes formula is stock_boxes+reconsigned.
Do not call it done unless you have verified everything for this phase with your own evidence.
```

## Out of Scope
- Editing `semantic.grower_dispatch_detail` or the existing `dispatch` Cube surface (that is Option B — a separate, signed-off, re-baseline sprint).
- Promoting the new surface / switching the dashboard, Steep, or MCP onto it / consumer comms (waits on ops sign-off + portal check).
- The broader RLS hard-gate on the 17 RLS-disabled raw/core tables (separate critical sprint) — EXCEPT the new view, which must be gated here.
- `pack_date` as a third date fallback (decide only if criterion 9 finds dateless gated loads).
- Pushing to main / opening PRs.
