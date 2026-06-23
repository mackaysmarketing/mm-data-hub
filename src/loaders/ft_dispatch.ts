// FreshTrack DISPATCH loader (Sprint 7) → raw.ft_dispatch_load + raw.ft_pallet (the tables
// semantic.grower_dispatch_detail reads). Source = FreshTrack prod Postgres read-replica
// (src/lib/freshtrack_db.ts), SELECT only, session pinned read-only. Mirrors src/loaders/ft_gp.ts:
// keyset-paged read, idempotent upsert on id, resumable via raw.sync_window, incremental by
// last_modified_on.
//
// Three modes:
//   npm run ft:dispatch:load                       # FULL backfill (all loads + pallets) — OFF-PEAK
//   npm run ft:dispatch:load -- --since=2026-06-01  # INCREMENTAL by last_modified_on
//   npm run ft:dispatch:load -- --loads=200         # SLICE: newest N loads + their pallets (testing)
//
// SAFETY (Sprint 7 hard blocker): assertHubTarget(pool) runs BEFORE any write — the loader aborts
// unless the write connection targets the hub project uqzfkhsdyeokwnkpcxui AND the live DB exposes
// the view-backing tables. Encoded fix for the OneDrive .env-revert / wrong-target failure mode.
//
// Test consignors (TRUGTEST/LARATEST/ANNRTEST) are EXCLUDED at pull (SPEC §9.6 / CLAUDE.md
// invariant #4): dispatch_load by consignor_id, pallet by its load's consignor. The full source
// is otherwise landed faithfully (archived rows included; raw ≈ source minus test). Each stream is
// fetched fully from the source BEFORE the hub connection is opened for the upsert (a hub
// connection left idle through a long fetch gets dropped by the pooler — the NS/GP loaders learned
// this the hard way).
import type { Pool, PoolClient, Client } from 'pg';
import { makePool, upsertNodes, assertHubTarget } from '../lib/db.ts';
import { connectFreshtrackRead } from '../lib/freshtrack_db.ts';
import { ftSelectList, type FtSpec } from '../lib/ft_gp_specs.ts';
import { ftDispatchLoadSpec, ftPalletSpec } from '../lib/ft_dispatch_specs.ts';
import { KNOWN_TEST_CONSIGNOR_IDS } from '../lib/env.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const BACKFILL_MARK = '1970-01-01T00:00:00Z'; // sync_window.window_start sentinel for a full load
const SLICE_MARK = '1970-01-02T00:00:00Z';    // distinct sentinel for slice/test runs (window_start is timestamptz)
const FETCH_PAGE = 5000;
const UPSERT_BATCH = 1000;
const DEFAULT_LOADS = 200;

/** Source table = hub table minus the `ft_` prefix (ft_dispatch_load→dispatch_load, ft_pallet→pallet). */
function sourceTable(spec: FtSpec): string {
  return spec.table.replace(/^ft_/, '');
}

// ── Keyset-paginated read from the source (no hub connection held) ────────────
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
async function upsertBatched(client: PoolClient, spec: FtSpec, nodes: Node[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < nodes.length; i += UPSERT_BATCH) {
    total += await upsertNodes(client, spec, nodes.slice(i, i + UPSERT_BATCH));
  }
  return total;
}

// ── One stream: window bookkeeping → fetch (source) → upsert (hub) ────────────
async function loadStream(
  pool: Pool, ft: Client, spec: FtSpec, stream: string,
  where: string, params: unknown[], windowStart: string, skipDone: boolean,
): Promise<{ seen: number; upserted: number; skipped: boolean }> {
  const c0 = await pool.connect();
  try {
    if (skipDone) {
      const done = await c0.query(
        `select 1 from raw.sync_window where stream=$1 and window_start=$2 and status='done'`,
        [stream, windowStart],
      );
      if ((done.rowCount ?? 0) > 0) { log(`  ${stream}: skip (already done)`); return { seen: 0, upserted: 0, skipped: true }; }
    }
    await c0.query(
      `insert into raw.sync_window (stream, window_start, window_end, status, started_at)
       values ($1,$2,now(),'running',now())
       on conflict (stream, window_start) do update set status='running', started_at=now(), error=null`,
      [stream, windowStart],
    );
  } finally { c0.release(); }

  const rows = await fetchPaged(ft, spec, where, params); // source only — no hub connection held

  const client = await pool.connect();
  try {
    const upserted = await upsertBatched(client, spec, rows);
    await client.query(
      `update raw.sync_window set status='done', rows_seen=$3, rows_upserted=$4, finished_at=now(), error=null
       where stream=$1 and window_start=$2`,
      [stream, windowStart, rows.length, upserted],
    );
    log(`  ${stream}: seen=${rows.length} upserted=${upserted}`);
    return { seen: rows.length, upserted, skipped: false };
  } catch (e) {
    await client.query(
      `update raw.sync_window set status='error', error=$3, finished_at=now() where stream=$1 and window_start=$2`,
      [stream, windowStart, (e instanceof Error ? e.message : String(e)).slice(0, 2000)],
    ).catch(() => {});
    throw e;
  } finally { client.release(); }
}

export interface DispatchLoadResult { dispatch: number; pallet: number; }

/** Resolve the test consignor ids to exclude at pull: dim_grower.is_test (authoritative) ∪ the
 *  KNOWN_TEST_CONSIGNOR_IDS fallback (SPEC §9.6). */
async function resolveTestConsignorIds(pool: Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ consignor_id: string }>(
      `select consignor_id::text as consignor_id from core.dim_grower where is_test = true`,
    );
    return [...new Set([...r.rows.map((x) => x.consignor_id), ...KNOWN_TEST_CONSIGNOR_IDS])];
  } finally { c.release(); }
}

// Test exclusion predicates (parameterised on $1 = test consignor ids; null-consignor / null-load
// rows are KEPT — the view inner-joins them away anyway, but raw stays faithful to the source).
const DISPATCH_NOT_TEST = '(consignor_id IS NULL OR consignor_id <> ALL($1::uuid[]))';
const PALLET_NOT_TEST =
  'NOT EXISTS (SELECT 1 FROM public.dispatch_load dl WHERE dl.id = pallet.dispatch_load_id AND dl.consignor_id = ANY($1::uuid[]))';

// ── FULL backfill ─────────────────────────────────────────────────────────────
export async function loadDispatchFull(pool: Pool): Promise<DispatchLoadResult> {
  const testIds = await resolveTestConsignorIds(pool);
  const ft = await connectFreshtrackRead();
  try {
    log(`Dispatch full backfill (read-only source) — excluding ${testIds.length} test consignor(s) at pull`);
    const dispatch = (await loadStream(pool, ft, ftDispatchLoadSpec, 'dispatch', DISPATCH_NOT_TEST, [testIds], BACKFILL_MARK, true)).upserted;
    const pallet = (await loadStream(pool, ft, ftPalletSpec, 'pallet', PALLET_NOT_TEST, [testIds], BACKFILL_MARK, true)).upserted;
    return { dispatch, pallet };
  } finally { await ft.end(); }
}

// ── INCREMENTAL by last_modified_on (change capture) ──────────────────────────
export async function loadDispatchIncremental(pool: Pool, since: string): Promise<DispatchLoadResult> {
  const testIds = await resolveTestConsignorIds(pool);
  const ft = await connectFreshtrackRead();
  const mod = 'last_modified_on >= $2::timestamptz';
  try {
    log(`Dispatch incremental since ${since} (last_modified_on watermark) — excluding ${testIds.length} test consignor(s)`);
    const dispatch = (await loadStream(pool, ft, ftDispatchLoadSpec, 'dispatch', `${DISPATCH_NOT_TEST} AND ${mod}`, [testIds, since], since, false)).upserted;
    const pallet = (await loadStream(pool, ft, ftPalletSpec, 'pallet', `${PALLET_NOT_TEST} AND ${mod}`, [testIds, since], since, false)).upserted;
    return { dispatch, pallet };
  } finally { await ft.end(); }
}

// ── SLICE: newest N loads + their pallets (testing / proving the path) ────────
export async function loadDispatchSlice(pool: Pool, n = DEFAULT_LOADS): Promise<DispatchLoadResult> {
  const testIds = await resolveTestConsignorIds(pool);
  const ft = await connectFreshtrackRead();
  try {
    const ids = (await ft.query<{ id: string }>(
      `SELECT id FROM public.dispatch_load
        WHERE ${DISPATCH_NOT_TEST}
        ORDER BY created_on DESC, id DESC LIMIT $2`, [testIds, n],
    )).rows.map((x) => x.id);
    log(`Dispatch slice — newest ${ids.length} loads + their pallets (sync_window @ ${SLICE_MARK})`);
    if (ids.length === 0) return { dispatch: 0, pallet: 0 };
    const dispatch = (await loadStream(pool, ft, ftDispatchLoadSpec, 'dispatch', 'id = ANY($1::uuid[])', [ids], SLICE_MARK, false)).upserted;
    const pallet = (await loadStream(pool, ft, ftPalletSpec, 'pallet', 'dispatch_load_id = ANY($1::uuid[])', [ids], SLICE_MARK, false)).upserted;
    return { dispatch, pallet };
  } finally { await ft.end(); }
}

function fmt(r: DispatchLoadResult): string {
  return `dispatch=${r.dispatch} pallet=${r.pallet}`;
}

if (isMain(import.meta.url)) {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const loadsArg = process.argv.find((a) => a.startsWith('--loads='))?.split('=')[1];
  const pool = makePool();
  try {
    await assertHubTarget(pool); // hard blocker — abort unless the write target is the hub
    let r: DispatchLoadResult;
    if (loadsArg) r = await loadDispatchSlice(pool, Number(loadsArg));
    else if (sinceArg) r = await loadDispatchIncremental(pool, sinceArg);
    else r = await loadDispatchFull(pool);
    log(`done: ${fmt(r)}`);
  } finally {
    await pool.end();
  }
}
