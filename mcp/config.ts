// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — configuration & env access (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────
// Secrets live in the gitignored .env (loaded by `dotenv`). NOTHING is hardcoded.
// The MCP holds no standing elevated access: it reads Cube via CUBE_API_SECRET (per-caller
// signed JWT) and Postgres via the least-privilege hub_mcp role (MCP_DB_URL, migration 0013).
import 'dotenv/config';

/** Hard guardrails applied to every read tool (SPEC §5 row cap + timeout). */
export const LIMITS = {
  /** Default page size when a tool omits `limit`. */
  DEFAULT_ROWS: 1000,
  /** Absolute ceiling — no tool argument can raise this. */
  MAX_ROWS: 5000,
  /** Per-request Postgres statement timeout for the detail / run_select path. */
  STATEMENT_TIMEOUT_MS: 15000,
} as const;

/** The single governed Cube view + the baked-in filters every metric inherits (CONTRACTS.md). */
export const DISPATCH_VIEW = 'dispatch';
export const BAKED_IN_FILTERS = [
  "order_type = 'S' (Sell only)",
  'actual_pickup_on IS NOT NULL (dispatched)',
  'non-test consignor (dim_grower.is_test = false)',
] as const;

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '' || v.startsWith('REPLACE')) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v;
}

export const config = {
  /** Cube REST base, e.g. https://<deployment>.cubecloudapp.dev/cubejs-api/v1 */
  cubeApiUrl: (): string => required('CUBE_API_URL').replace(/\/+$/, ''),
  /** HS256 secret Cube validates per-caller tokens with (== deployment CUBEJS_API_SECRET). */
  cubeApiSecret: (): string => required('CUBE_API_SECRET'),
  /** Postgres URL for the least-privilege hub_mcp role (detail / run_select path). */
  mcpDbUrl: (): string => required('MCP_DB_URL'),

  /**
   * Secret used to VERIFY the inbound caller-identity token (HUB_MCP_CALLER_TOKEN).
   * Defaults to CUBE_API_SECRET so a single shared secret works out of the box; set
   * HUB_MCP_CALLER_SECRET to separate ingress verification from Cube signing.
   */
  callerSecret: (): string => process.env.HUB_MCP_CALLER_SECRET?.trim() || required('CUBE_API_SECRET'),
  /** The trusted, signed caller identity presented by the host at launch (optional → fail closed). */
  callerToken: (): string | null => process.env.HUB_MCP_CALLER_TOKEN?.trim() || null,
} as const;
