# Hub MCP — governed access over the dispatch + settlement semantic/metric layer

One **read** MCP server (`@modelcontextprotocol/sdk`, stdio, ESM, Node ≥ 22) over what's LIVE:
the Cube **`dispatch`** view (6 governed metrics), **`semantic.grower_dispatch_detail`**, and
**`semantic.grower_gp_settlement`** (schedule-grain settlement, paid date first-class). It
**consumes** the governed metrics — it never redefines one. SPEC §5/§7; CLAUDE.md claim contract.

## The one rule: identity-propagating RLS

The MCP holds **no standing elevated access**. Caller identity enters once, from a trusted
channel, and every tool runs scoped to that caller. No tool argument can assert or widen it.

- **Ingress.** The host launches the server with `HUB_MCP_CALLER_TOKEN` — a signed JWT whose
  payload carries `app_metadata` (`{ "app_metadata": { "consignor_id": "…" } }` for a single-farm
  grower, `{ "app_metadata": { "consignor_ids": ["…", "…"] } }` for a multi-farm grower (the
  migration-0026 consignor SET — the scalar folds into the set, de-duplicated, malformed elements
  skipped), or `{ "app_metadata": { "is_internal": true } }` for internal/service). It is verified
  once (HS256, `HUB_MCP_CALLER_SECRET`, default `CUBE_API_SECRET`) into a fixed session identity.
  **No token / invalid token → fail closed** (every data tool returns 0 rows). Identity is read
  from `app_metadata` ONLY — a forged top-level claim is ignored (identical to migrations
  0010/0026). Single-farm claims propagate byte-identically to pre-0026 payloads.
- **Metric path** (`query_metric`, catalog tools) → signs a **short-lived per-caller Cube JWT**
  and calls Cube REST `/load`; Cube `queryRewrite` scopes it (consignor SET membership, 0026).
- **Detail path** (`list_grower_dispatches`, `list_grower_sales`, `run_select`) → connects as the
  least-privilege **`hub_mcp`** role (migration 0013) and, per request, `SET ROLE authenticated` +
  `SET request.jwt.claims` (the caller), so the existing Postgres RLS (0008/0010/0020/0026) scopes
  the row. Read-only: every request is a transaction that rolls back.

Neither path can bypass RLS. Fail-closed is structural — no claims ⇒ `authenticated` sees 0 rows.

## Run it

```bash
# .env must have CUBE_API_URL, CUBE_API_SECRET, MCP_DB_URL (see ../.env.example)
npm run mcp:server          # stdio MCP server
```

Register with an MCP client (stdio), injecting the caller identity at launch:

```jsonc
{
  "mcpServers": {
    "hub": {
      "command": "node",
      "args": ["--experimental-strip-types", "mcp/server.ts"],
      "cwd": "C:/dev/mm-data-hub",
      "env": { "HUB_MCP_CALLER_TOKEN": "<signed app_metadata JWT for this caller>" }
    }
  }
}
```

Mint a caller token (dev) with `signCallerToken({ app_metadata: { is_internal: true } }, secret)`
from `mcp/identity.ts` (the same helper the proof uses).

## Tools (read surface)

| Tool | What | Path |
|---|---|---|
| `get_catalog` | metrics + dimensions + canonical definitions | Cube /meta |
| `list_metrics` | metrics with unit + sliceable dims (`domain?`) | Cube /meta |
| `get_definition` | canonical definition + filter logic for a term/metric/dim | registry |
| `list_dimension_values` | distinct values of a dimension (`search?`, `limit?`) | Cube /load (RLS) |
| `query_metric` | metric over `dispatch` (`group_by`, `filters`, `time_range`, `time_grain`, `order`, `limit`) | Cube /load (RLS) |
| `list_grower_dispatches` | pallet-grain detail (`grower?`, `time_range`, `product?`, `crop?`, `limit?`) | Postgres RLS |
| `list_grower_sales` | schedule-grain GP settlement: gross, deductions by category, GST, net, `paid_date` (null = unpaid, never zero-dated) (`grower?`, `time_range{from,to}` on `payable_on`, `paid?`, `limit?`) | Postgres RLS |
| `resolve_entity` | name/code → dimension members (`kind`, `search`) | Cube /load (RLS) |
| `run_select` | escape hatch: single read-only SELECT over `semantic.*` only | Postgres RLS |

Every read returns the governed shape: `{ columns, rows, metric_definition, filters_applied,
row_count, truncated }`. Guardrails: names are registry-validated (unknowns rejected); `run_select`
is `semantic.*`-only, no DDL/DML, single statement, row cap + statement timeout.

**Not registered here:** write/action tools (`create_grower`, `update_grower_contact`,
`raise_rcti`, `send_grower_notice`) belong to a separate audited action surface with human
confirmation for irreversible actions. The per-user `can_view_sales` capability gate (SPEC §7)
ships with the grower tool profile of the remote connector (GROWER_MCP_PROPOSAL step 3) — until
then `list_grower_sales` is bounded by Postgres RLS alone, exactly like the portal views.

## Proof

```bash
npm run mcp:proof    # env: DATABASE_URL + CUBE_API_URL + CUBE_API_SECRET + MCP_DB_URL
```

**Self-deriving:** expectations are computed in the same run from source SQL over raw/core
(the exact baked-in filter sets in `cube/CONTRACTS.md` / migration 0008 / `core.fact_gp_settlement`),
and grower fixtures are resolved by code from `core.dim_grower` — no hardcoded counts to go stale.
Proves, across internal + growers + no-claim + forged contexts on all three surfaces (metric /
detail / sales): scoped totals equal the derived source counts; no argument can widen scope;
absent/forged identity fails closed (0 rows); the **multi-farm consignor SET** (L & R Collins,
`consignor_ids[]`) sees the UNION of both farms on every path while a single-id token stays
single-farm with byte-identical claims; the paid flag partitions honestly on `paid_date`; the
governed output shape; registry validation; and `run_select` escape-hatch rejections. Writes
`reports/mcp_proof_<date>.txt`.
