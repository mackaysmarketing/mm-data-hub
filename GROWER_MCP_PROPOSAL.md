# Design note — Grower-facing MCP connector

**Status:** design sketch (not a sprint — no acceptance criteria, no code). 2026-07-09.
**Relates to:** `DATA_HUB_AUDIT.md` §8 Tier 2 · `mcp/README.md` · CLAUDE.md claim contract · migration `0026`.

## Goal
Let a grower point **their own AI agent** (Claude, ChatGPT, a custom LangGraph bot, …) at a single
hosted endpoint and ask questions of **only their own production (dispatch) + sales (settlement)**
data — nothing else, fail-closed. "What did I dispatch last week?", "which of my settlements are
unpaid?", "show my banana boxes by customer this month."

## What already exists (the hard 80%)
The repo's `/mcp` Hub MCP already solves the security-critical part:
- **Identity-propagating, fail-closed.** Caller identity enters once from a trusted signed token,
  read **`app_metadata`-only** (forged top-level claims ignored); no token → 0 rows. No tool
  argument, filter, or `run_select` can widen scope (`mcp/identity.ts`).
- **Two enforcement paths.** Metric → per-caller Cube JWT → Cube `/load` (`queryRewrite` scopes).
  Detail → least-privilege `hub_mcp` role → `SET ROLE authenticated` + `SET request.jwt.claims` →
  Postgres RLS (`0008/0010`); read-only, always rolls back.
- **Governed output shape** + registry-validated names + `run_select` restricted to `semantic.*`.
- **Settlement data is now landed** (`semantic.grower_settlement`, `grower_gp_settlement`) — the
  reason `list_grower_sales` was stubbed ("Phase 2 — replica blocked") no longer holds.

## The gap — four changes to make it grower-ready
1. **Transport: stdio → remote, multi-tenant.** Today the server is stdio with **one fixed identity
   per process** (`HUB_MCP_CALLER_TOKEN` verified once at launch). Growers need a **hosted endpoint**
   (MCP **Streamable HTTP** transport) where **each session carries its own identity**, resolved
   per-connection rather than from a process env var.
2. **Auth: delegated grower login, never a self-asserted claim.** The grower authenticates through
   mm-hub (Supabase email auth); the MCP derives identity from that. Two shapes:
   - **OAuth 2.1** (MCP's standard remote-auth flow) — grower authorizes; the access token resolves to
     `app_metadata.consignor_ids` via the existing claim contract. Cleanest long-term.
   - **Interim connector token** — mm-hub's grower portal issues a **scoped, short-lived, revocable**
     signed `app_metadata` JWT; the MCP verifies it through the existing `verifyCallerToken` funnel
     (minimal change). Must honor **`claim_freshness`** revocation (token `iat` < `claims_updated_at`
     ⇒ treat as empty) — the same cross-repo gate the mm-hub sprint defined.
3. **Multi-farm identity (`consignor_ids[]`).** `mcp/identity.ts` currently reads the **scalar**
   `app_metadata.consignor_id` only. Migration `0026` widened RLS to a **consignor SET**
   (`current_consignor_ids()`), so a multi-farm grower (e.g. L & R Collins) would under-scope here.
   Update the MCP identity to read the array (falling back to the scalar), matching the DB + Cube.
4. **A grower tool profile (production + sales only).** Expose: `query_metric` over the **dispatch**
   and **settlement** metrics, `list_grower_dispatches`, `list_grower_sales` (**wire it now**), plus the
   catalog/definition/dimension tools; `run_select` limited to grower-safe `semantic.grower_*` views.
   **Exclude** internal-only surfaces (orders, retail, margin). Honor the **`can_view_sales`**
   capability (SPEC §7) so a grower-admin controls who in their org sees settlement dollars.

## Security posture (invariants that must not change)
- Identity from a trusted channel only; `app_metadata`-only; forged/missing ⇒ **0 rows**.
- Every tool RLS-scoped; scope narrowing is **defense-in-depth** (tool profile *and* RLS both restrict —
  either alone still fails closed). Read-only; detail path rolls back.
- The connector never holds standing elevated access; it mints per-caller credentials per request.

## Open questions (decide at sprint time)
- **Auth:** OAuth 2.1 now, or interim connector token first? (Depends on mm-hub auth capacity + timeline.)
- **Hosting:** where does the remote MCP run (Railway / Vercel / Supabase edge)? TLS, rate limits,
  per-grower quotas, abuse controls.
- **Identity mapping at the edge:** reuse the mm-hub resolver (`consignor_ids` + `claim_freshness`) so
  there is exactly one source of truth for "which farms is this login."
- **Audit:** per-grower query logging / observability for a data surface growers drive themselves.

## Rough phasing (each independently shippable)
1. **Wire `list_grower_sales` + settlement metrics** into the existing server; extend `mcp:proof`
   (settlement RLS across internal + 2 growers + no-claim + forged). *Near-term, low risk — no new infra.*
2. **Multi-farm identity** (`consignor_ids[]`).
3. **Grower tool profile** + `can_view_sales` gate.
4. **Remote transport + delegated auth** (the actual productization).
5. **Grower-facing proof** (per-session isolation, settlement fail-closed) + a pilot grower.
