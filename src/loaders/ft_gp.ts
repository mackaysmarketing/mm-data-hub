// FreshTrack grower-pool SETTLEMENT loader → raw.ft_gp_* + raw.ft_charge* (read-replica source).
//
// READ-ONLY out of FreshTrack: connects to the production read-replica (src/lib/freshtrack_db.ts),
// SELECT only, session pinned read-only. Lands the GP settlement domain into the hub:
//   dims   : ft_charge_type, ft_charge, ft_gp_status        (small; loaded in full)
//   headers: ft_gp_schedule, ft_gp_payment
//   lines  : ft_gp_detail (per dispatch load), ft_charge_applied (the deduction ledger)
//
// Three modes:
//   npm run ft:gp:load                       # FULL backfill (all schedules + settled charge ledger)
//   npm run ft:gp:load -- --since=2026-06-01 # INCREMENTAL by last_modified_on (change capture)
//   npm run ft:gp:load -- --schedules=50     # SLICE: newest N schedules + their children (testing)
//
// Idempotent: every stream upserts on its PK (id). Resumable: each stream records a raw.sync_window
// row; a full backfill skips streams already 'done' (delete those rows to force a re-backfill).
// charge_applied is scoped to gp_schedule_id IS NOT NULL — the SETTLED charges (the ~24k unsettled
// null-schedule rows are out of settlement scope; confirmed live). The replica is fetched fully per
// stream BEFORE the hub connection is opened for the upsert (a hub connection left idle through a
// long fetch gets dropped by the pooler — the NetSuite loader learned this the hard way).
import type { Pool, PoolClient, Client } from 'pg';
import { makePool, upsertNodes } from '../lib/db.ts';
import { connectFreshtrackRead } from '../lib/freshtrack_db.ts';
import {
  ftSelectList, type FtSpec,
  ftGpScheduleSpec, ftGpDetailSpec, ftGpPaymentSpec,
  ftChargeAppliedSpec, ftChargeSpec, ftChargeTypeSpec, ftGpStatusSpec,
} from '../lib/ft_gp_specs.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;
const DEFAULT_SCHEDULES = 50;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const BACKFILL_MARK = '1970-01-01T00:00:00Z'; // sync_window.window_start sentinel for a full load
const FETCH_PAGE = 5000;

/** Source table = hub table minus the `ft_` prefix (ft_gp_schedule→gp_schedule, ft_charge→charge). */
function sourceTable(spec: FtSpec): string {
  return spec.table.replace(/^ft_/, '');
}

// ── Keyset-paginated read from the replica (no hub connection held) ───────────
// `where` uses $1..$N from `params`; the id keyset predicate is appended as the next placeholder.
async function fetchPaged(ft: Client, spec: FtSpec, where: string, params: unknown[]): Promise<Node[]> {
  const out: Node[] = [];
  const cols = ftSelectList(spec);
  const src = sourceTable(spec);
  let lastId = NIL_UUID;
  for (;;) {
    const idParam = `$${params.length + 1}::uuid`;
    const whereSql = where ? `${where} AND id > ${idParam}` : `id > ${idParam}`;
    const sql = `SELECT ${cols} FROM public.${src} WHERE ${whereSql} ORDER BY id LIMIT ${FETCH_PAGE}`;
    const rows = (await ft.query(sql, [...params, lastId])).rows as Node[];
    out.push(...rows);
    if (rows.length < FETCH_PAGE) break;
    lastId = rows[rows.length - 1]!.id as string;
  }
  return out;
}

// A single INSERT…SELECT over a multi-MB JSON parameter can exceed the pooler's limits; batch it.
const UPSERT_BATCH = 1000;
async function upsertBatched(client: PoolClient, spec: FtSpec, nodes: Node[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < nodes.length; i += UPSERT_BATCH) {
    total += await upsertNodes(client, spec, nodes.slice(i, i + UPSERT_BATCH));
  }
  return total;
}

// ── One stream: window bookkeeping → fetch (replica) → upsert (hub) ───────────
async function loadStream(
  pool: Pool, ft: Client, spec: FtSpec,
  where: string, params: unknown[], windowStart: string, skipDone: boolean,
): Promise<{ seen: number; upserted: number; skipped: boolean }> {
  const stream = `gp:${spec.table}`;
  // Resumability + window-begin (hub connection opened briefly, then released before the fetch).
  const c0 = await pool.connect();
  try {
    if (skipDone) {
      const done = await c0.query(
        `select 1 from raw.sync_window where stream=$1 and window_start=$2 and status='done'`,
        [stream, windowStart],
      );
      if ((done.rowCount ?? 0) > 0) { log(`  ${spec.table}: skip (already done)`); return { seen: 0, upserted: 0, skipped: true }; }
    }
    await c0.query(
      `insert into raw.sync_window (stream, window_start, window_end, status, started_at)
       values ($1,$2,now(),'running',now())
       on conflict (stream, window_start) do update set status='running', started_at=now(), error=null`,
      [stream, windowStart],
    );
  } finally { c0.release(); }

  const rows = await fetchPaged(ft, spec, where, params); // replica only — no hub connection held

  const client = await pool.connect();
  try {
    const upserted = await upsertBatched(client, spec, rows);
    await client.query(
      `update raw.sync_window set status='done', rows_seen=$3, rows_upserted=$4, finished_at=now(), error=null
       where stream=$1 and window_start=$2`,
      [stream, windowStart, rows.length, upserted],
    );
    log(`  ${spec.table}: seen=${rows.length} upserted=${upserted}`);
    return { seen: rows.length, upserted, skipped: false };
  } catch (e) {
    await client.query(
      `update raw.sync_window set status='error', error=$3, finished_at=now() where stream=$1 and window_start=$2`,
      [stream, windowStart, (e instanceof Error ? e.message : String(e)).slice(0, 2000)],
    ).catch(() => {});
    throw e;
  } finally { client.release(); }
}

export interface GpLoadResult {
  charge_type: number; charge: number; gp_status: number;
  schedules: number; details: number; payments: number; charge_applied: number;
}

function emptyResult(): GpLoadResult {
  return { charge_type: 0, charge: 0, gp_status: 0, schedules: 0, details: 0, payments: 0, charge_applied: 0 };
}

// ── FULL backfill ────────────────────────────────────────────────────────────
export async function loadGpFull(pool: Pool): Promise<GpLoadResult> {
  const ft = await connectFreshtrackRead();
  const r = emptyResult();
  try {
    log('GP full backfill (read-only replica) — dims, headers, detail, charge ledger');
    r.charge_type = (await loadStream(pool, ft, ftChargeTypeSpec, '', [], BACKFILL_MARK, true)).upserted;
    r.charge      = (await loadStream(pool, ft, ftChargeSpec, '', [], BACKFILL_MARK, true)).upserted;
    r.gp_status   = (await loadStream(pool, ft, ftGpStatusSpec, '', [], BACKFILL_MARK, true)).upserted;
    r.schedules   = (await loadStream(pool, ft, ftGpScheduleSpec, '', [], BACKFILL_MARK, true)).upserted;
    r.details     = (await loadStream(pool, ft, ftGpDetailSpec, '', [], BACKFILL_MARK, true)).upserted;
    r.payments    = (await loadStream(pool, ft, ftGpPaymentSpec, '', [], BACKFILL_MARK, true)).upserted;
    // settled charges only (gp_schedule_id IS NOT NULL); unsettled charges are out of scope.
    r.charge_applied = (await loadStream(pool, ft, ftChargeAppliedSpec, 'gp_schedule_id IS NOT NULL', [], BACKFILL_MARK, true)).upserted;
    return r;
  } finally { await ft.end(); }
}

// ── INCREMENTAL by last_modified_on (change capture) ─────────────────────────
export async function loadGpIncremental(pool: Pool, since: string): Promise<GpLoadResult> {
  const ft = await connectFreshtrackRead();
  const r = emptyResult();
  const mod = 'last_modified_on >= $1::timestamptz';
  try {
    log(`GP incremental since ${since} (last_modified_on watermark)`);
    r.charge_type = (await loadStream(pool, ft, ftChargeTypeSpec, mod, [since], since, false)).upserted;
    r.charge      = (await loadStream(pool, ft, ftChargeSpec, mod, [since], since, false)).upserted;
    r.gp_status   = (await loadStream(pool, ft, ftGpStatusSpec, mod, [since], since, false)).upserted;
    r.schedules   = (await loadStream(pool, ft, ftGpScheduleSpec, mod, [since], since, false)).upserted;
    r.details     = (await loadStream(pool, ft, ftGpDetailSpec, mod, [since], since, false)).upserted;
    r.payments    = (await loadStream(pool, ft, ftGpPaymentSpec, mod, [since], since, false)).upserted;
    r.charge_applied = (await loadStream(pool, ft, ftChargeAppliedSpec, `${mod} AND gp_schedule_id IS NOT NULL`, [since], since, false)).upserted;
    return r;
  } finally { await ft.end(); }
}

// ── SLICE: newest N schedules + their children (testing / proving the path) ──
export async function loadGpSlice(pool: Pool, n = DEFAULT_SCHEDULES): Promise<GpLoadResult> {
  const ft = await connectFreshtrackRead();
  const r = emptyResult();
  try {
    const ids = (await ft.query<{ id: string }>(
      `SELECT id FROM public.gp_schedule ORDER BY created_on DESC, id DESC LIMIT $1`, [n],
    )).rows.map((x) => x.id);
    log(`GP slice — newest ${ids.length} schedules + their detail/payments/charges`);
    if (ids.length === 0) return r;
    const win = `slice:${n}`;
    // dims in full (tiny)
    r.charge_type = (await loadStream(pool, ft, ftChargeTypeSpec, '', [], win, false)).upserted;
    r.charge      = (await loadStream(pool, ft, ftChargeSpec, '', [], win, false)).upserted;
    r.gp_status   = (await loadStream(pool, ft, ftGpStatusSpec, '', [], win, false)).upserted;
    r.schedules   = (await loadStream(pool, ft, ftGpScheduleSpec, 'id = ANY($1::uuid[])', [ids], win, false)).upserted;
    r.details     = (await loadStream(pool, ft, ftGpDetailSpec, 'gp_schedule_id = ANY($1::uuid[])', [ids], win, false)).upserted;
    r.payments    = (await loadStream(pool, ft, ftGpPaymentSpec, 'gp_schedule_id = ANY($1::uuid[])', [ids], win, false)).upserted;
    r.charge_applied = (await loadStream(pool, ft, ftChargeAppliedSpec, 'gp_schedule_id = ANY($1::uuid[])', [ids], win, false)).upserted;
    return r;
  } finally { await ft.end(); }
}

function fmt(r: GpLoadResult): string {
  return `charge_type=${r.charge_type} charge=${r.charge} gp_status=${r.gp_status} | schedules=${r.schedules} details=${r.details} payments=${r.payments} charge_applied=${r.charge_applied}`;
}

if (isMain(import.meta.url)) {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const schedArg = process.argv.find((a) => a.startsWith('--schedules='))?.split('=')[1];
  const pool = makePool();
  try {
    let r: GpLoadResult;
    if (schedArg) r = await loadGpSlice(pool, Number(schedArg));
    else if (sinceArg) r = await loadGpIncremental(pool, sinceArg);
    else r = await loadGpFull(pool);
    log(`done: ${fmt(r)}`);
  } finally {
    await pool.end();
  }
}
