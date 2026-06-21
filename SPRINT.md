# Sprint 3 (Phase 4): Hub MCP over the semantic/metric layer
Date: 2026-06-21
Repo: mackaysmarketing/mm-data-hub

> Numbering note: this is the **Hub MCP** phase (Phase 4 in SPEC), pulled ahead of the GP/settlement
> phase (Phase 2) because Phase 2 is still blocked on FreshTrack enabling read-replica credentials
> (`readonlyDatabaseCredentials` returns null for our account). Build sequence ≠ spec phase number.

## Orient first (read before assuming any names)
- Read `HANDOFF.md` (the Sprint-2/Cube handoff at the top = what's LIVE, and the Sprint-1 handoff
  below), `SPEC.md` (§2 decisions, §4–5 semantic layer + MCP tool surface + output shape, §7 access
  model: tenant scope + `can_view_sales` + global tier, §9 data-quality constraints), and `CLAUDE.md`
  (schema-ownership boundary, the `app_metadata` RLS claim contract, the Cube section). Read
  `cube/CONTRACTS.md` and the `/cube` model.
- **Build to what's LIVE — do not invent names.** Sprint 2 shipped the Cube `dispatch` view + its 6
  governed metrics (deployed to Cube Cloud "MM Data Hub"; parity 347/347, RLS 12/12), the
  `cube_readonly` role (migrations `0011`/`0012`), and `semantic.grower_dispatch_detail` (the RLS
  view; migrations `0008`/`0010`). The MCP **consumes** these — it does not redefine metrics.

## Scope
Stand up the **Hub MCP**: one governed MCP server (TypeScript, `@modelcontextprotocol/sdk`, ESM,
Node ≥22) exposing the dispatch semantic/metric layer through a small **READ** tool surface, with
**identity-propagating RLS** — the MCP holds no standing elevated access; every call runs scoped to
the caller (`consignor_id` / `is_internal`). This is the agent/SQL access substrate from SPEC §1/§5.
Agents on top of the MCP, sales tools, and write/action tools are out of scope (Phase 2 GP data
isn't landed; writes need the separate audited action surface).

## Acceptance Criteria
- [ ] MCP server scaffolded in-repo (e.g. `/mcp`), runnable, with documented startup + invocation.
- [ ] **Read tools** over the LIVE layer: `get_catalog`, `list_metrics`, `get_definition`,
      `list_dimension_values`, `query_metric` (Cube `dispatch` view — group_by, filters, time_range,
      time_grain, order, limit), `list_grower_dispatches` (over `semantic.grower_dispatch_detail`),
      `resolve_entity`, and `run_select` (escape hatch: **`semantic.*` only**, no DDL, row cap, timeout).
- [ ] **Consumes the governed Cube metrics** — `query_metric`/`list_metrics`/`get_catalog` read the
      Cube catalog; metric/dimension names are registry-validated and unknowns rejected. No metric is
      redefined in the MCP.
- [ ] **Identity-propagating RLS (hard blocker):** caller identity is an explicit per-request input,
      never hardcoded/elevated. Metric tools sign a per-caller Cube JWT (`app_metadata.consignor_id` /
      `is_internal`) → Cube `queryRewrite` scopes it. Detail / `run_select` tools apply the caller's
      JWT claims so `semantic.*` Postgres RLS applies. Neither path bypasses RLS.
- [ ] **Output shape** on every read: `{ columns, rows, metric_definition, filters_applied,
      row_count, truncated }` (SPEC §5).
- [ ] **Fail closed:** absent/malformed identity → no rows; no tool argument, filter, group_by, or
      `run_select` escape can widen a grower's scope.
- [ ] Guardrails: `run_select` rejects non-`semantic.*` and any DDL/DML; every read enforces a row
      cap + statement timeout.

## Definition of Done
- [ ] All acceptance criteria checked **with evidence**.
- [ ] **RLS-propagation proof** (runnable script + captured output): `query_metric` (pallet_count)
      and `list_grower_dispatches` under **≥2 grower contexts + 1 internal** — each grower sees only
      its own rows, internal sees all, no-claim → 0, and an attempt to widen scope via a tool argument
      stays scoped. Plus the `app_metadata`-only / forged-claim rejection (parity with Sprint 2's RLS
      proof).
- [ ] **Parity check:** `query_metric` via the MCP matches the Cube/raw baselines (internal
      `pallet_count` = 38322; grower A's scoped total = its Cube-filtered total).
- [ ] `npm run typecheck` clean; `npm test` green — incl. unit tests for registry validation,
      output-shape, and fail-closed behaviour.
- [ ] No Sprint-2 regression: `npm run cube:rls` and `npm run cube:reconcile` still pass.
- [ ] `CLAUDE.md` updated (Hub MCP exists; the identity-propagation pattern). `HANDOFF.md` updated
      (tools shipped, the identity mechanism chosen, what's deferred to Phase 2).
- [ ] Committed + pushed to `mackaysmarketing/mm-data-hub` via the token-direct URL method (never gh).
      Use the same fine-grained PAT as the prior session, or a fresh one (Contents: read/write,
      mm-data-hub only).

## Quality Rubric (mm-data-hub — Hub MCP)
| Criterion | What to check |
|-----------|--------------|
| **Identity propagation** | Every tool runs as the caller; no standing service_role/superuser in the query path. Proven under ≥2 grower + 1 internal. |
| **No scope widening** | No tool argument, filter, group_by, or `run_select` escape returns another consignor's rows. Fail-closed on absent/malformed identity. |
| **Governed consumption** | Metrics consumed from Cube, never redefined; names registry-validated; output carries `metric_definition` + `filters_applied`. |
| **Escape-hatch safety** | `run_select` = `semantic.*` only, no DDL/DML, row cap + timeout. |
| **Grain / null integrity** | Inherited from the Cube/semantic layer — the MCP adds no coalescing and no sub-pallet/line grain. |
| **Scope discipline** | Sales + write/action tools deferred/stubbed, not faked. |
| **Secrets / least privilege** | Cube secret + DB creds via env, never in code; read-mostly, least-privilege role. |

**Threshold:** Identity propagation and No-scope-widening are hard blockers. Pass 6/7 overall.

## Out of Scope
- `list_grower_sales`, `raise_rcti`, any settlement/GP tools — Phase 2 (blocked on read-replica).
  Stub with a clear "unavailable until Phase 2" guard; do not fake.
- Write/action tools (`create_grower`, `update_grower_contact`, `send_grower_notice`) — need the
  separate audited surface with human confirmation for irreversible actions; defer. No unguarded writes.
- Agents / LLM orchestration on top of the MCP (later phase).
- Any change to the Cube metric definitions (additive-only; not this sprint).

## First step
Read the docs above, confirm the live Cube view + semantic view names and that `.env` Cube creds are
current, decide and **STATE** the identity-propagation mechanism (how caller identity reaches the
MCP), then acknowledge scope + acceptance criteria before building.
