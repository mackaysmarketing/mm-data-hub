# Sprint 2: Cube semantic layer over the dispatch model
Date: 2026-06-20
Repo: mackaysmarketing/mm-data-hub

> Numbering note: this is the **Cube** phase (Phase 3 in SPEC), pulled ahead of the
> GP/settlement phase (Phase 2) because GP/settlement is still blocked on the FreshTrack
> vendor enabling read-replica credentials. Build sequence ≠ spec phase number.

## Orient first (read before assuming any names)
- Read `SPEC.md` (semantic-layer + metrics sections, and §9 data-quality constraints),
  `CLAUDE.md` (including the Git & pushing note), the `raw`/`core`/`semantic` migrations,
  and the `semantic.grower_dispatch_detail` view. **Build to the real schema — do not invent
  column or table names.**
- Sprint 1 already landed FY25–26 dispatch (`raw` → `core` → `semantic`) with consignor-based
  RLS on the grower dispatch view. This sprint adds the **metric layer** on top. No new ingestion.

## Scope
Stand up a Cube project inside this repo as the single, code-defined metric surface over the
dispatch data landed in Sprint 1. Cube reads the hub Postgres and defines the dispatch measures
and dimensions **once**, so both Steep and the future Hub MCP consume the same governed
definitions — Steep consumes Cube, it does not define metrics. Tenant RLS carries through: a
grower security context returns only that consignor's rows, identical to the Sprint 1 semantic
view. This sprint is the aggregate/BI surface only; it does **not** replace the portal's
row-level dispatch list (that is the `semantic.grower_dispatch_detail` view, already shipped).

## Acceptance Criteria
- [ ] Cube project scaffolded in-repo (e.g. `/cube`), data models as code, connected to the hub
      Postgres via a **read-only** role; runs in Cube dev mode / Playground against the live
      landed data.
- [ ] Dispatch cube(s) defined over the existing `core`/`semantic` model with these **measures**:
      `net_weight_dispatched`, `load_count`, `pallet_count`, `line_count`.
- [ ] **Dimensions**: grower/consignor, `pack_week` (parsed from `extra_text_2`, format `Y{YY}W{WW}`),
      produce type, consignee/customer DC, dispatch date (`actual_pickup_on`).
- [ ] **Baked-in filters every consumer inherits**: `*TEST` consignors excluded; `order_type`
      filtered to **Sell** (sales dispatches only). Encode once at the cube, not per query.
- [ ] **Null integrity**: `net_weight` nulls stay null in measures — never coalesced or summed
      as 0. Produce-level capture rates reproduce against raw (papaya ~100%, banana ~88%,
      avocado ~41% — avocados sell by count, so null = unknown, not zero).
- [ ] **Metric parity**: each measure reconciles to a direct SQL aggregate over the landed data
      within agreed tolerance — net weight and load/pallet/line counts **by grower** and **by
      pack-week** match a raw aggregate; log any variance, don't hide it.
- [ ] **RLS in Cube**: a security context injects `consignor_id` (via `queryRewrite` or
      equivalent) so every dispatch query is row-filtered. Prove with **two distinct grower
      contexts** (each sees only its own rows) **plus one internal/unscoped context** (sees all).
      Same claim contract as Sprint 1: grower auth → `consignor_id`. No dimension selection can
      widen a grower's scope.
- [ ] `pallet.location_id` and harvest-load lineage are **not** modelled at dispatch
      (`harvest_load_id` is null outbound). No measure sliceable below pallet/line grain.
- [ ] Each metric documented as a **contract**: single meaning (which column summed), grain,
      baked-in filters, allowed dimensions. Additive only — adding metrics is fine; redefining an
      existing one is not.

## Definition of Done
- [ ] All acceptance criteria checked with evidence (Cube query output vs SQL reconciliation
      report; three-context RLS proof).
- [ ] Parity + RLS checks committed as runnable scripts and passing.
- [ ] No TypeScript errors (Cube schema files clean).
- [ ] `CLAUDE.md` updated: Cube lives in this repo; the metric-contract / add-never-change rule;
      the security-context → `consignor_id` RLS pattern.
- [ ] `HANDOFF.md` updated: measures shipped, reconciliation deltas, and the two open decisions
      left for next sprint (Cube deployment target, Steep wiring).
- [ ] Committed and pushed to `mackaysmarketing/mm-data-hub` using the token-direct URL method.
      Use a **fresh fine-grained token** scoped to mm-data-hub only (Contents: read/write),
      short-lived — **not** the one revoked after Sprint 1.

## Quality Rubric (mm-data-hub — semantic/Cube)
| Criterion | What to check |
|-----------|--------------|
| **Metric parity** | Every measure reconciles to direct SQL within tolerance; variances logged, not silently absorbed. |
| **RLS propagation** | Grower security context returns only that consignor's rows; proven under ≥2 grower + 1 internal context. No dimension or filter selection widens scope. |
| **Null integrity** | `net_weight` nulls never coalesced to 0 in any measure; produce capture rates reproduce. |
| **Contract discipline** | Each metric has one meaning/grain/baked-in-filter set/allowed dimensions; no redefinition of an existing metric. |
| **Grain safety** | No load-grain measure exposed below pallet/line grain. |
| **FreshTrack §9 constraints** | `*TEST` excluded; `order_type = Sell` applied; `location_id` and harvest-load lineage not modelled at dispatch. |
| **Secrets / connection** | DB connection via env var on a read-only role; no credentials in code. |

**Threshold:** Metric parity and RLS propagation are hard blockers. Pass 6/7 overall.

## Out of Scope
- GP/settlement metrics (invoiced / paid / remitted dollars) — Phase 2, blocked on read-replica creds.
- Wiring Steep to Cube — separate step once Cube is deployed somewhere reachable.
- Cube production deployment / hosting choice (Cube Cloud vs self-host on Railway) — **flag the
  decision in HANDOFF, don't make it here**; dev-mode proof is sufficient for this sprint.
- Hub MCP, agents, action tools — Phase 4.
- The grower dispatch list — already shipped as the `semantic.grower_dispatch_detail` view; Cube
  does not replace it.
- NetSuite, retail scan, pricing sources.

## First step
Read `SPEC.md`, `CLAUDE.md`, the migrations and the `semantic.grower_dispatch_detail` view to
confirm real names, then scaffold the Cube project against the hub Postgres and define the
dispatch cube from the existing model.
