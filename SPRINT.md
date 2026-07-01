# Sprint: Order-Domain Ingest — order / order_version / order_item
Date: 2026-07-01
Repo: mm-data-hub (mackaysmarketing/mm-data-hub)
Source: FreshTrack **read-replica** (same source as the GP settlement tables — `raw.ft_gp_*`)
Project: `data_hub` (`uqzfkhsdyeokwnkpcxui`, ap-southeast-2)

## A0 Findings (resolved 2026-07-01 — build gate cleared)

Replica introspection (`npm run ft:order:profile`, snapshot committed at
`reconciliation/replica_order_schema_2026-07-01.md`) confirmed the depended-on columns, **with two
schema realities that the sprint text assumed differently** — recorded here per the A0 STOP rule
before any loader was written:

1. **`order.total_price_value` does NOT exist**, and **`order.latest_version_no` does NOT exist**.
   The replica header carries no dollar total and no version pointer. The dollar total lives at the
   **line** grain (`order_item.total_price_value`, alongside `order_item.total_box_count`). Design
   consequence: the header total is **DERIVED** = Σ of the **current-version** line
   `total_price_value` (and `total_box_count`); the authoritative version is **`max(order_version.version_no)`
   per `order_id`**. `order.total_ordered` (int, present) is the ordered *quantity*, not a dollar total.
2. **The source contains only `type='S'`** (21192 S, **0 B**). `type` still lands as **text** (both
   `B`/`S` admissible, never an enum); there are simply no Buy rows to land today. The sales semantic
   filters to `S` (which is currently the whole population).
3. `order_item.price_currency` is **100% AUD** (0 non-AUD). `order_item.price_per` ∈ {`BOX` 73194,
   `WEIGHT_UNIT` 18} — no `PALLET`/`CUSTOM`. Extended-line-value rule: `BOX → total_box_count ×
   price_value`; `WEIGHT_UNIT` (18 lines) has no quantity on the line → defer to native
   `total_price_value`. Verified: for 200 sample orders, derived == native `total_price_value`
   (834,654.30), 200/200.
4. Versioning: max 15 versions on one order; **0** order_item rows fail to resolve a version; **35,967**
   lines sit on the latest version (the `fact_order_item` size); 8 header-only orders carry no version/line.

A7/A8 below are read against these facts: the A7 "native replica total" is the replica's own
**current-version line sum** (there being no header total column); A8's "both B/S land in raw" is met
by the **text** column admitting both, the source currently holding only S.

## Scope

Build the commercial **order** layer end-to-end so ordered quantities, unit prices and line
dollars stop being invisible. The warehouse currently lands `dispatch_load` + `pallet` only —
fulfilment, not commerce — which blocks the Weekly PO Summary report and the dollar side of
Sales-by-farm. This sprint lands `order` / `order_version` / `order_item` from the FreshTrack
read-replica through the full medallion: `raw` (three trimmed tables) → `core`
(`dim_order` + `fact_order_item`, current-version only) → `semantic` (internal order/sales
views) → **Cube** (one cube + one internal view). Prices exist in FreshTrack at the line level;
the read-replica also carries the pre-computed totals (`order_item.total_box_count`,
`order.total_price_value`), so those land as native columns rather than being re-derived.

Order data is the **sell side** (buyer = `consignee_id`/`parent_consignee_id` = the retailer;
seller = `marketer_id` = Mackays Marketing on the majority of sales). It carries Mackays'
selling prices and margins, so it is **internal-only** — no grower is ever granted access. The
order cube view is therefore `public:false`, and RLS isolation is proven by showing a grower
claim context returns **zero** order rows.

The order↔dispatch join keys (`order_item.dispatch_load_id`, `order.id`→`dispatch_load.order_id`,
`po_no`, `latest_order_version_no`) are **exposed** on the surface so the immediate follow-on
sprint (origin-grower attribution / Sales-by-farm) can join order to dispatch without rework —
but that bridge is **not** built here.

What is explicitly **NOT** in scope: charges (`charge_applied`), invoices, the origin-grower
attribution bridge, any `primary_origin_consignor_id` column, the ordered-vs-shipped variance
view, and any DDL against `public` / `auth` / `storage` (those schemas belong to other apps).

## Acceptance Criteria

Every criterion is proven by a command or query whose real output is pasted into the transcript.
Percentages/counts below are **reproduced by the surface**, never asserted from memory.

### Phase A — Supabase (raw → core → semantic; migrations `0023`+)

- [ ] **A0 — Replica schema confirmed and snapshotted (build gate).** The read-replica
  `order` / `order_version` / `order_item` schema is introspected and the snapshot committed
  under `reconciliation/` (this also seeds the schema-diff watcher). Paste the introspection
  showing the columns the core model depends on are present: `order.total_price_value`,
  `order.latest_version_no`, `order_item.total_box_count`, `order_item.price_value` +
  `price_currency` + `price_per`, and a **`last_modified_on`** (incremental key) on all three
  tables. **If any is absent, STOP and update SPRINT.md before writing a loader.**
- [ ] **A1 — Schema-ownership boundary (HARD BLOCKER).** Every migration touches only
  `raw` / `core` / `semantic`. Zero DDL against `public` / `auth` / `storage`; no reads of
  `public.ft_*`. Paste `grep` over the new migrations proving no out-of-schema object is
  referenced, and the migration numbers used (must start at `0023` — `0021` and `0022` are
  already applied).
- [ ] **A2 — Three raw tables land, mirroring the dispatch convention.** `raw.ft_order`,
  `raw.ft_order_version`, `raw.ft_order_item` exist with UUID PKs, `_synced_at default now()`,
  and `_raw jsonb` on `ft_order` + `ft_order_version` but **not** on `ft_order_item` (mirrors
  `_raw` on `dispatch_load`/`entity`, not `pallet`). Paste `\d` for each. Row counts land in a
  sane band vs the replica and are reported (order ≈ 21k, order_version ≈ 34.6k,
  order_item ≈ 71.9k before exclusions).
- [ ] **A3 — Enums stored as text, no Postgres enum types.** `type`, `edi_status`,
  `price_currency`, `price_per` are `text` columns. Paste a catalog query proving **0** new enum
  types were created by this sprint.
- [ ] **A4 — Idempotent, resumable loader (proven, not claimed).** Re-running a completed
  window upserts on `id` and yields **0 net new rows** — paste `count(*)` before and after for
  the same window on `raw.ft_order_item`. A mid-window restart causes no duplication.
  `raw.sync_window` carries `ft_order` / `ft_order_version` / `ft_order_item` streams windowed
  on `last_modified_on`; paste the window rows.
- [ ] **A5 — Test-entity exclusion at pull.** No order lands in `raw` whose `consignor` /
  `marketer` / `consignee` resolves to a test entity (`TRUGTEST`, `LARATEST`, `ANNRTEST`;
  `ft_entity.is_test`). Paste a query over `raw.ft_order` joined to `raw.ft_entity` returning
  **0** test-linked orders.
- [ ] **A6 — Core built; current-version integrity.** `core.dim_order` = one row per order
  (PK order `id`); `core.fact_order_item` = one row per order line of the **authoritative
  version** (PK order_item `id`). Prove no superseded-version line reaches the fact: a query for
  `fact_order_item` rows whose `order_version_id` ≠ the order's `latest_version_no` returns
  **0** (raw still holds every version). Paste it.
- [ ] **A7 — Header ↔ line ↔ source reconciliation.** For a committed sample of N orders, the
  surface reconciles to **itself and to source**: `dim_order.total_price_value` equals the sum
  of that order's current-version `fact_order_item` extended line value within tolerance, **and**
  equals the native replica `order.total_price_value`; `total_box_count` reconciles the same way.
  The derived extended-line-value rule is documented per `price_per`
  (`BOX` → `total_box_count × price_value`; `PALLET` → `pallet_count × price_value`;
  `WEIGHT_UNIT`/`CUSTOM` → confirm the quantity source on the replica or defer to the native
  total). Prefer native replica totals; where derived values are used, discrepancies are logged.
  Commit the reconciliation report under `reconciliation/`.
- [ ] **A8 — Data-quality invariants.** `price_value` / `total_price_value` never coalesced to 0.
  `price_currency` asserted AUD for Mackays sales, with any non-AUD row flagged (query pasted).
  `dispatch_load_id`, `order_id`, `po_no`, `latest_order_version_no` are present on the surface
  for the downstream join. Both order `type` values (`B` / `S`) land in `raw`; the semantic
  **sales** view filters to `S` (paste the type distribution at raw and at semantic).
- [ ] **A9 — Semantic surface is internal.** `semantic.order_*` views expose the internal order
  surface (current version), carry the join keys, and are **not** grower-scoped (no
  `grower_*` prefix, no grower grant). Paste the view definitions and confirm they run under the
  internal role.
- [ ] **A10 — Raw order tables are not publicly exposed.** New `raw.ft_order*` tables have RLS
  enabled, mirroring `raw.ft_dispatch_load`'s policy (so they don't extend the anon/authenticated
  exposure the security advisor already flags). Paste `pg_policies` for each.
- [ ] **A11 — TypeScript clean.** `npm run typecheck` exits clean; no `any` without a comment;
  no secrets in code (env only). Paste the tail.

### Phase B — Cube (cube + internal view; RLS; **compile gate**)

- [ ] **B1 — Cube compiles the WHOLE schema (HARD PRE-DEPLOY GATE).** A local `cubejs`
  dev-server compile (or a staging deployment) compiles the new order cube + view **and every
  existing view** with **0 errors** — paste the compile output. This gate is non-negotiable: a
  name clash last sprint passed local typecheck + the test suite but took all prod views down on
  deploy; only a real schema compile catches it.
- [ ] **B2 — RLS isolation, internal-only (HARD BLOCKER).** A **grower** claim context returns
  **zero** order rows / cannot query the order cube (paste the authenticated query result or the
  access denial). An internal/hub context returns rows. No grower can reach order data under any
  claim permutation.
- [ ] **B3 — Public-guard test passes.** The order view is `public:false` (internal), so
  `tests/cube_rls_public_guard.test.ts` passes without a `VIEW_GROWER_KEYS` anchor. The full test
  suite is green, total ≥ current baseline with **none removed** — paste the summary line.
- [ ] **B4 — Manual deploy; no token in session.** Deploy of the Cube schema is performed by Tim.
  The session contains **no** Cube deploy token. HANDOFF.md states "awaiting manual Cube deploy"
  as the last step.

## Definition of Done

- [ ] All acceptance criteria checked, each with pasted evidence (query rows / command output).
- [ ] Tests written and passing (see Quality Rubric); no test deleted or skipped to get green.
- [ ] `npm run typecheck` clean.
- [ ] Reconciliation report and replica schema snapshot committed under `reconciliation/`.
- [ ] HANDOFF.md updated (ends with "awaiting manual Cube deploy").
- [ ] Committed to git; working tree clean.

## Quality Rubric

Lifted from `references/grading-rubrics.md` (mm-data-hub) and adapted from the dispatch sprint
to the order domain. **Score threshold: schema-ownership boundary and RLS isolation are
non-negotiable hard blockers; must pass 8/9 overall.**

| Criterion | What to check |
|-----------|--------------|
| **Schema-ownership boundary** | Every migration touches only `raw`/`core`/`semantic`. Zero DDL against `public`/`auth`/`storage`. No reads of `public.ft_*`. **Hard blocker.** |
| **Idempotent loaders** | Re-running a completed window upserts on `id` and yields 0 net new rows. Resumable by window (mid-window restart → no duplication). Proven, not claimed. |
| **Test-entity exclusion** | `TRUGTEST`/`LARATEST`/`ANNRTEST` excluded at pull (their orders never land in `raw`). Derived `is_test` on `ft_entity` matches (inactive + `*TEST` code). |
| **RLS isolation** | Order surface is internal-only: a grower claim context returns **zero** order rows under any claim permutation; the cube view is `public:false`. **Hard blocker.** |
| **Data-quality invariants** | Enums (`type`/`edi_status`/`price_currency`/`price_per`) are text not enum. `price_value`/`total_price_value` never coalesced. Currency asserted AUD (non-AUD flagged). Both `B`/`S` land in raw; sales semantic filters to `S`. Join keys (`dispatch_load_id`, `order_id`, `po_no`, `latest_order_version_no`) present. |
| **Versioning correctness** | `core.fact_order_item` exposes only the `latest_version_no` lines; superseded versions remain in `raw` and are excluded from core (0 leak). |
| **Reconciliation** | Header `total_price_value`/`total_box_count` reconcile to the sum of the order's own current-version lines **and** to the native replica totals, within tolerance; discrepancies logged. Report committed. |
| **Schema evolution safety** | No Postgres enum types. Stable column names (never repurposed). `_raw jsonb` on `ft_order` + `ft_order_version` (not `ft_order_item`). UUID PKs. Replica schema snapshot committed; diff watcher flags added/removed/renamed columns. |
| **TypeScript** | `npm run typecheck` clean. No `any` without a comment. No secrets in code (env only). |

**Universal (all sprints):** no secrets in code (env only); error states handled (no empty
catch, no silent data loss — log + skip malformed rows); working tree clean at handoff;
HANDOFF.md committed; "done" means criteria ticked with evidence.

## Goal Condition

Lift straight into `/goal` (Auto mode on). Fill the `<placeholders>` with the exact table/window
names once A0 confirms the replica schema.

```
/goal The order-domain ingest is complete for mm-data-hub, sourced from the FreshTrack
read-replica, internal-only. Prove each with pasted SQL/output:
(A0) the replica order/order_version/order_item schema is snapshotted + committed, and
order_item.total_box_count, order_item.price_value/currency/per, order.total_price_value and a
last_modified_on key are all present.
(A1) migrations touch only raw/core/semantic (grep proves no public/auth/storage DDL), numbered
from 0023.
(A2/A3) raw.ft_order, raw.ft_order_version, raw.ft_order_item exist (paste \d), UUID PKs,
_raw jsonb on order+order_version not order_item, enums stored as text, 0 new Postgres enum types.
(A4) re-running a completed window yields 0 net new rows (paste before/after count), sync_window
carries the three streams windowed on last_modified_on.
(A5) 0 orders in raw are linked to a test entity (TRUGTEST/LARATEST/ANNRTEST).
(A6) core.fact_order_item has 0 rows from a non-latest version (paste the check).
(A7) for a sample of orders, dim_order.total_price_value reconciles to the sum of its own
current-version lines AND to the native replica total within tolerance; report committed.
(A8) price_currency is AUD (non-AUD flagged), join keys present, both B/S in raw, sales semantic
filters to S.
(B1) a local cubejs dev-server compile of the WHOLE schema (new order cube+view + all existing
views) shows 0 errors — paste it.
(B2) a grower claim context returns 0 order rows / cannot query the order cube; an internal
context returns rows.
(B3) cube_rls_public_guard passes and the full test suite is green with none removed (paste the
summary line).
Do not touch public/auth/storage. Do not build the origin-grower/Sales-by-farm bridge, any
primary_origin column, the variance view, charges, or invoices. Put no Cube deploy token in the
session — deploy is manual. Stop after 30 turns.
```

## Out of Scope

- **Origin-grower attribution / Sales-by-farm bridge** (the next sprint) — including the
  `primary_origin_consignor_id` column, the multi-farm allocation (~10% of sell orders, up to 10
  farms each), and the ~20% "unattributed" handling. This sprint only **exposes the join keys**.
- **Ordered-vs-shipped variance view** — depends on the bridge above.
- **Charges** (`charge_applied`) and **invoices** — a separate follow-on.
- **Order `type = B` (buy) semantics** — landed in `raw` but not modelled for reporting; the
  sales semantic layer is `S` only.
- **Any DDL against `public` / `auth` / `storage`** — other apps own those schemas.
- **Cube deploy** — performed manually by Tim after the compile gate passes.

---

### Notes for the build session
- Mirror the `ft_dispatch` loader **mechanics** (keyset paging on `id`, idempotent upsert,
  `sync_window` resume, the `assertHubTarget` write-guard, test-entity exclusion) but source from
  the **read-replica** as the GP loaders do — windowed on `last_modified_on`, which GraphQL
  cannot provide for orders.
- `consignor_id` on a sell order is the **seller** (Mackays Marketing, or a Mackays-owned farm),
  **not** a grower key and not the buyer — do not use it as a grower RLS anchor. Buyer =
  `consignee_id` / `parent_consignee_id`. Seller = `marketer_id`.
- End with the independent skeptical-evaluator pass (Phase 3), then commit HANDOFF.md.
