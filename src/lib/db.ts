// Postgres access for the loaders. Writes go direct via pg (never PostgREST).
// The upsert builder pushes a GraphQL JSON array straight into Postgres and maps
// camelCase source keys → snake_case columns, so the mapping lives in one place.
import pg from 'pg';
import type { PoolClient } from 'pg';
import { env } from './env.ts';

const { Pool } = pg;

/** Force "encrypt, don't verify" — recent pg makes `sslmode=require` verify the chain, which
 *  fails on the Supabase pooler's private-CA cert. Rewrite sslmode to no-verify (string-only, so a
 *  password with special chars is never re-encoded). */
function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

export function makePool(): pg.Pool {
  // Same TLS posture as mcp/db.ts and the CUBE_DB_URL/MCP_DB_URL `sslmode=no-verify` connections.
  return new Pool({
    connectionString: noVerifySsl(env.databaseUrl()),
    max: 4,
    ssl: { rejectUnauthorized: false },
  });
}

/** The hub Supabase project ref (data_hub). The ONLY database any loader may write to. */
export const HUB_PROJECT_REF = 'uqzfkhsdyeokwnkpcxui';

/** True when a connection string targets the hub project. With the Supabase pooler the ref lives
 *  in the USERNAME (`postgres.<ref>`), not the host — so test the whole string, not just the host.
 *  Pure + side-effect-free so it is unit-testable without a database. */
export function connStringTargetsHub(connStr: string): boolean {
  return typeof connStr === 'string' && connStr.includes(HUB_PROJECT_REF);
}

/** Write-target safety (Sprint 7 hard blocker). Before ANY loader write, prove the pool will
 *  write to the hub — abort loudly otherwise. Two independent checks defend the OneDrive
 *  `.env`-revert / wrong-target failure mode:
 *    1. the configured DATABASE_URL carries the hub ref (catches a reverted/swapped .env), and
 *    2. a LIVE fingerprint — the connected database actually exposes the view-backing tables
 *       (catches a string that looks right but points at the wrong DB).
 *  Throws (never returns false) so a misconfigured run can never reach an upsert. */
export async function assertHubTarget(pool: pg.Pool): Promise<void> {
  const url = env.databaseUrl();
  if (!connStringTargetsHub(url)) {
    let host = '(unparseable)';
    try { host = new URL(url).host; } catch { /* ignore */ }
    throw new Error(
      `ABORT (write-target safety): DATABASE_URL does not target hub ${HUB_PROJECT_REF} ` +
      `(host=${host}). Refusing to write. Check .env did not revert to the wrong project.`,
    );
  }
  const c = await pool.connect();
  try {
    const r = await c.query<{ a: string | null; b: string | null; c: string | null }>(
      `select to_regclass('raw.ft_dispatch_load')::text as a,
              to_regclass('raw.ft_pallet')::text        as b,
              to_regclass('raw.sync_window')::text       as c`,
    );
    const row = r.rows[0];
    if (!row?.a || !row?.b || !row?.c) {
      throw new Error(
        `ABORT (write-target safety): connected database is missing raw.ft_dispatch_load / ` +
        `raw.ft_pallet / raw.sync_window — this is not the hub. Refusing to write.`,
      );
    }
  } finally {
    c.release();
  }
}

export type ColKind =
  | 'text'
  | 'uuid'
  | 'int'
  | 'bigint'
  | 'numeric'
  | 'bool'
  | 'timestamptz'
  | 'date'
  | 'text[]';

export interface Column {
  /** snake_case destination column */
  col: string;
  /** camelCase key in the FreshTrack JSON node */
  key: string;
  kind: ColKind;
}

export interface UpsertSpec {
  schema: string;
  table: string;
  idColumn: string;
  columns: Column[];
  /** store the whole source node as _raw jsonb (small tables only) */
  withRaw: boolean;
}

function extract(c: Column): string {
  const j = `elem->>'${c.key}'`;
  switch (c.kind) {
    case 'text':
      return j;
    case 'uuid':
      return `nullif(${j},'')::uuid`;
    case 'int':
      return `nullif(${j},'')::integer`;
    case 'bigint':
      return `nullif(${j},'')::bigint`;
    case 'numeric':
      return `nullif(${j},'')::numeric`;
    case 'bool':
      return `nullif(${j},'')::boolean`;
    case 'timestamptz':
      return `nullif(${j},'')::timestamptz`;
    case 'date':
      return `nullif(${j},'')::date`;
    case 'text[]':
      return `case when jsonb_typeof(elem->'${c.key}')='array'
                   then array(select jsonb_array_elements_text(elem->'${c.key}'))
                   else null end`;
  }
}

/** Idempotent upsert of GraphQL nodes. Returns rows affected. No-op on empty input. */
export async function upsertNodes(
  client: PoolClient,
  spec: UpsertSpec,
  nodes: Record<string, unknown>[],
): Promise<number> {
  if (nodes.length === 0) return 0;

  const insertCols = [...spec.columns.map((c) => c.col)];
  const selectExprs = [...spec.columns.map(extract)];
  if (spec.withRaw) {
    insertCols.push('_raw');
    selectExprs.push('elem');
  }
  insertCols.push('_synced_at');
  selectExprs.push('now()');

  const updates = spec.columns
    .filter((c) => c.col !== spec.idColumn)
    .map((c) => `${c.col} = excluded.${c.col}`);
  if (spec.withRaw) updates.push('_raw = excluded._raw');
  updates.push('_synced_at = excluded._synced_at');

  const sql = `
    insert into ${spec.schema}.${spec.table} (${insertCols.join(', ')})
    select ${selectExprs.join(', ')}
    from jsonb_array_elements($1::jsonb) as elem
    on conflict (${spec.idColumn}) do update set
      ${updates.join(',\n      ')}
  `;

  const res = await client.query(sql, [JSON.stringify(nodes)]);
  return res.rowCount ?? 0;
}

// ── sync_window bookkeeping (resumable backfill) ────────────────────────────
export async function doneWindowStarts(client: PoolClient, stream: string): Promise<Set<string>> {
  const res = await client.query<{ window_start: Date }>(
    `select window_start from raw.sync_window where stream = $1 and status = 'done'`,
    [stream],
  );
  return new Set(res.rows.map((r) => r.window_start.toISOString()));
}

export async function beginWindow(
  client: PoolClient,
  stream: string,
  start: Date,
  end: Date,
): Promise<void> {
  await client.query(
    `insert into raw.sync_window (stream, window_start, window_end, status, started_at)
     values ($1, $2, $3, 'running', now())
     on conflict (stream, window_start) do update set
       status='running', started_at=now(), window_end=excluded.window_end, error=null`,
    [stream, start, end],
  );
}

export async function completeWindow(
  client: PoolClient,
  stream: string,
  start: Date,
  counts: { seen: number; upserted: number; excluded?: number },
): Promise<void> {
  await client.query(
    `update raw.sync_window set status='done', rows_seen=$3, rows_upserted=$4,
       rows_excluded=$5, finished_at=now(), error=null
     where stream=$1 and window_start=$2`,
    [stream, start, counts.seen, counts.upserted, counts.excluded ?? 0],
  );
}

export async function failWindow(
  client: PoolClient,
  stream: string,
  start: Date,
  error: string,
): Promise<void> {
  await client.query(
    `update raw.sync_window set status='error', error=$3, finished_at=now()
     where stream=$1 and window_start=$2`,
    [stream, start, error.slice(0, 2000)],
  );
}
