# Sprint: FreshTrack dispatch landing + grower dispatch view
Date: 2026-06-20
Repo: mackaysmarketing/mm-data-hub

## Scope
First sprint in the new `mm-data-hub` repo. Land FreshTrack dispatch data (`dispatch_load`, `pallet`, `entity`) into Supabase `raw` via windowed, idempotent loaders, conform a `dim_grower`, and publish a grower-scoped dispatch detail view in `semantic` with RLS. This repo owns the `raw` / `core` / `semantic` schemas on the shared hub project; mm-hub owns its own app schemas and never migrates these. The mm-hub portal page that renders this view is a separate mm-hub sprint and is NOT in scope here. See `SPEC.md` for the full design and the §9 data-quality constraints.

## Acceptance Criteria
- [ ] Repo scaffolded: TypeScript + Supabase CLI migration tooling wired to the hub project; `.env` for the FreshTrack GraphQL endpoint (read-replica creds deferred to phase 2); `CLAUDE.md` created documenting the schema-ownership boundary (this repo owns `raw`/`core`/`semantic` only) and the cross-repo RLS claim contract with mm-hub (grower auth -> `consignor_id`).
- [ ] `raw.ft_dispatch_load`, `raw.ft_pallet`, `raw.ft_entity` migrations with the trimmed columns from SPEC §3; UUID PKs; text (not Postgres enum) types; `_raw jsonb` on `dispatch_load` and `entity`; `is_field` retained on pallet; `location_id` NOT modelled.
- [ ] Loader walks `2025-07-01 -> today` in weekly windows (API has no cursor — paginate on `actual_pickup_on`), upserts on `id`, is resumable by window, and excludes the 3 test consignors (`TRUGTEST`, `LARATEST`, `ANNRTEST`) at pull.
- [ ] Full FY25-26 dispatch loaded; per-load pallet `box_count` reconciles to load `stock_boxes` within agreed tolerance, with discrepancies logged.
- [ ] `dim_grower` (in `core`/`semantic`) keyed on `consignor_id`, carrying `is_grower`, `is_active`, `is_test`.
- [ ] `semantic.grower_dispatch_detail` view at pallet/line grain exposing: date, crop/variety/product, boxes, `net_weight` (nullable, not coalesced), load no — with `grower_key = consignor_id`. `harvest_load_id` is NOT used for grower attribution.
- [ ] RLS on `semantic.grower_dispatch_detail`: querying under two different grower auth contexts returns only that grower's own rows (proven by role/JWT-claim simulation in SQL — no app required).
- [ ] Schema-diff watcher: re-introspects FreshTrack, diffs against the stored schema, and flags any added/removed/renamed field.

## Definition of Done
- [ ] All acceptance criteria checked with evidence (loader run output, reconciliation report, two-context RLS test).
- [ ] Tests written and passing: loader idempotency, window resume, RLS isolation.
- [ ] No TypeScript errors.
- [ ] HANDOFF.md updated (row counts, reconciliation gaps, the `extra_text_2` finding).
- [ ] Committed and pushed to `mackaysmarketing/mm-data-hub`.

## Quality Rubric
No mm-data-hub rubric exists yet (new repo) — seed one in `references/grading-rubrics.md` as part of this sprint. For this sprint specifically: idempotency proven by re-running a completed window with zero new rows; loader resumes mid-window without duplication; RLS isolation proven under two grower contexts.

## Out of Scope
- The mm-hub portal page that renders the view (separate mm-hub sprint).
- GP/settlement landing and the grower sales page (phase 2 — read-replica; `gpDetails` GraphQL resolver is broken).
- Cube semantic layer and metrics (phase 3).
- Hub MCP, agents, action tools (phase 4).
- NetSuite, retail scan, pricing sources.
- Scheduled/incremental runs beyond the resumable backfill (the windowed loader supports it; wiring a schedule is a later sprint).

## First step
Confirm the `extra_text_2` meaning with the FreshTrack team, link the Supabase hub project to the repo, then create the `raw.ft_*` migrations from SPEC §3.
