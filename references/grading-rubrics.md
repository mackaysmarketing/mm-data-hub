# Grading Rubrics — mm-data-hub

Per-sprint quality criteria for evaluator-agent sessions. Copy the relevant section into
`SPRINT.md` and the evaluator prompt. Seeded in sprint 1 (FreshTrack dispatch landing).

---

## mm-data-hub (mackaysmarketing/mm-data-hub)

**Stack context:** TypeScript (ESM, Node ≥ 22), Supabase Postgres 17 (`data_hub`,
`uqzfkhsdyeokwnkpcxui`, ap-southeast-2). This repo owns `raw`/`core`/`semantic` on a
**shared** project; `public` belongs to mm-hub and is off-limits. FreshTrack GraphQL is
`filterLimit`-only (windowed loaders). Grower identity = `consignor_id`.

| Criterion | What to check |
|-----------|--------------|
| **Schema-ownership boundary** | Every migration touches only `raw`/`core`/`semantic`. Zero DDL against `public`, `auth`, `storage`. No reads of `public.ft_*`. **Hard blocker.** |
| **Idempotent loaders** | Re-running a completed window upserts on `id` and yields **0 net new rows**. Loader is resumable by window (mid-window restart causes no duplication). Proven, not claimed. |
| **Test-consignor exclusion** | `TRUGTEST`, `LARATEST`, `ANNRTEST` excluded **at pull** (their loads never land in `raw`). Derived `is_test` on `ft_entity` matches (inactive + `*TEST` code). |
| **RLS isolation** | `semantic.grower_dispatch_detail` returns only the caller's rows under two distinct grower claim contexts. No grower can read another's rows under any claim permutation. **Hard blocker.** |
| **Data-quality invariants (SPEC §9)** | `location_id` not modelled; `harvest_load_id` not used for grower attribution; `net_weight_value` never coalesced; `order_type` is text not enum; `extra_text_2` landed + documented. |
| **Reconciliation** | Per-load pallet `box_count` reconciled to load `stock_boxes` with discrepancies logged (incl. null `box_count` rate). Report committed. |
| **Schema evolution safety** | No Postgres enum types. Stable column names (never repurposed). `_raw jsonb` present on `dispatch_load` + `entity` (not pallet). UUID PKs. |
| **Schema-diff watcher** | Re-introspects FreshTrack and flags added/removed/renamed fields against a stored snapshot. |
| **TypeScript** | `npm run typecheck` clean. No `any` without a comment. No secrets in code (env only). |

**Score threshold:** Schema-ownership boundary and RLS isolation are non-negotiable hard
blockers. Must pass 8/9 overall.

---

## Universal criteria (all sprints)
- No secrets in code — endpoints/keys/passwords in env only.
- Error states handled — no empty catch blocks, no silent data loss (log + skip malformed rows).
- Working tree clean at handoff; `HANDOFF.md` committed.
- "Done" means acceptance criteria ticked with evidence (run output, reconciliation, RLS proof).
