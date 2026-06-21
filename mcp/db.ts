// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — Postgres caller-scoped runner (the DETAIL / run_select path). SPEC §5/§7.
// Connects as the least-privilege `hub_mcp` role (migration 0013) which, on its own, can read
// NOTHING. Per request it drops to `authenticated` and presents the caller's JWT claims so the
// existing RLS (0008/0010) scopes every row. Read-only: each request is a transaction that
// always ROLLBACKs. Fail-closed is structural — no claims ⇒ authenticated sees 0 rows.
// ─────────────────────────────────────────────────────────────────────────────
import pg from 'pg';
import { config, LIMITS } from './config.ts';
import { claimsJson, type CallerIdentity } from './identity.ts';

export interface CallerDb {
  /** Run `fn` inside a caller-scoped, read-only transaction. */
  query<T>(id: CallerIdentity, fn: (run: ScopedRun) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** A parameterized SELECT runner, already scoped to the caller via SET ROLE + claims. */
export type ScopedRun = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

export function makeCallerDb(): CallerDb {
  const pool = new pg.Pool({
    connectionString: config.mcpDbUrl(),
    ssl: { rejectUnauthorized: false },
    max: 4,
    application_name: 'hub-mcp',
  });

  async function query<T>(id: CallerIdentity, fn: (run: ScopedRun) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Drop from hub_mcp to authenticated, then present the caller's claims. Both are
      // transaction-local (SET LOCAL semantics) so the pooled connection resets on rollback.
      await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claims', $1, true)", [claimsJson(id)]);
      await client.query("select set_config('statement_timeout', $1, true)", [
        String(LIMITS.STATEMENT_TIMEOUT_MS),
      ]);
      const run: ScopedRun = (text, params) => client.query(text, params as unknown[]);
      const out = await fn(run);
      return out;
    } finally {
      // Read-only path: always roll back (undoes role/claims AND any stray write).
      try {
        await client.query('rollback');
      } catch {
        /* connection already gone */
      }
      client.release();
    }
  }

  return { query, end: () => pool.end() };
}
