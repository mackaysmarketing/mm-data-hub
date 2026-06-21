# Hub MCP — governed access over the dispatch semantic/metric layer

One **read** MCP server (`@modelcontextprotocol/sdk`, stdio, ESM, Node ≥ 22) over what's LIVE:
the Cube **`dispatch`** view (6 governed metrics) and **`semantic.grower_dispatch_detail`**. It
**consumes** the governed metrics — it never redefines one. SPEC §5/§7; CLAUDE.md claim contract.

## The one rule: identity-propagating RLS

The MCP holds **no standing elevated access**. Caller identity enters once, from a trusted
channel, and every tool runs scoped to that caller. No tool argument can assert or widen it.

- **Ingress.** The host launches the server with `HUB_MCP_CALLER_TOKEN` — a signed JWT whose
  payload carries `app_metadata` (`{ "app_metadata": { "consignor_id": "…" } }` for a grower, or
  `{ "app_metadata": { "is_internal": true } }` for internal/service). It is verified once
  (HS256, `HUB_MCP_CALLER_SECRET`, default `CUBE_API_SECRET`) into a fixed session identity.
  **No token / invalid token → fail closed** (every data tool returns 0 rows). Identity is read
  from `app_metadata` ONLY — a forged top-level claim is ignored (identical to migration 0010).
- **Metric path** (`query_metric`, catalog tools) → signs a **short-lived per-caller Cube JWT**
  and calls Cube REST `/load`; Cube `queryRewrite` scopes it.
- **Detail path** (`list_grower_dispatches`, `run_select`) → connects as the least-privilege
  **`hub_mcp`** role (migration 0013) and, per request, `SET ROLE authenticated` +
  `SET request.jwt.claims` (the caller), so the existing Postgres RLS (0008/0010) scopes the row.
  Read-only: every request is a transaction that rolls back.

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
| `resolve_entity` | name/code → dimension members (`kind`, `search`) | Cube /load (RLS) |
| `run_select` | escape hatch: single read-only SELECT over `semantic.*` only | Postgres RLS |

Every read returns the governed shape: `{ columns, rows, metric_definition, filters_applied,
row_count, truncated }`. Guardrails: names are registry-validated (unknowns rejected); `run_select`
is `semantic.*`-only, no DDL/DML, single statement, row cap + statement timeout.

**Deferred (stubbed, not faked):** `list_grower_sales` → `UnavailableError` until Phase 2 (GP data
not landed). Write/action tools (`create_grower`, `update_grower_contact`, `raise_rcti`,
`send_grower_notice`) are **not** registered here — they belong to a separate audited action
surface with human confirmation for irreversible actions.

## Proof

```bash
npm run mcp:proof    # drives the real handlers under internal + 2 growers + no-claim + forged
```

Proves: metric `pallet_count` internal=38322 / A=13186 / B=7631 / none=0 / forged=0; detail
internal=38796 / A=13281 / B=7631 / none=0 / forged=0; no argument can widen scope; the governed
output shape; registry validation; and `run_select` escape-hatch rejections. Writes
`reports/mcp_proof_<date>.txt`.
