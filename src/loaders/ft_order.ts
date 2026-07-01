// FreshTrack ORDER-domain loader → raw.ft_order + raw.ft_order_version + raw.ft_order_item.
// Source = FreshTrack prod Postgres read-replica (src/lib/freshtrack_db.ts), SELECT only, session
// pinned read-only. Mirrors src/loaders/ft_dispatch.ts: keyset-paged read, idempotent upsert on id,
// resumable via raw.sync_window, incremental by last_modified_on, assertHubTarget write-guard.
//
// Three modes:
//   npm run ft:order:load                        # FULL backfill (all orders + versions + items)
//   npm run ft:order:load -- --since=2026-06-01   # INCREMENTAL by last_modified_on (per stream)
//   npm run ft:order:load -- --orders=200         # SLICE: newest N orders + their children (testing)
//
// Test-entity exclusion at pull (SPEC §9.6 / CLAUDE.md invariant #4): an order is excluded if its
// consignor_id / consignee_id / marketer_id resolves to a test entity (TRUGTEST/LARATEST/ANNRTEST;
// raw.ft_entity.is_test). Versions/items are excluded via their parent order. The test-entity id sets
// (one per role, since a test entity's consignor_id ≠ its consignee_id) are resolved from the hub's
// raw.ft_entity before the pull. Each stream is fetched fully from the source BEFORE the hub
// connection is opened for the upsert (a hub connection left idle through a long fetch gets dropped by
// the pooler — the NS/GP/dispatch loaders learned this the hard way).
//
// NOTE: `order` is a reserved word — the source identifiers are quoted (public."order").
import type { Pool, PoolClient, Client } from 'pg';
import { makePool, upsertNodes, assertHubTarget } from '../lib/db.ts';
import { connectFreshtrackRead } from '../lib/freshtrack_db.ts';
import { ftSelectList, type FtSpec, ftOrderSpec, ftOrderVersionSpec, ftOrderItemSpec } from '../lib/ft_order_specs.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const BACKFILL_MARK = '1970-01-01T00:00:00Z'; // sync_window.window_start sentinel for a full load
const SLICE_MARK = '1970-01-02T00:00:00Z';
const FETCH_PAGE = 5000;
const UPSERT_BATCH = 1000;
const DEFAULT_ORDERS = 200;

/** Source table = hub table minus the `ft_` prefix, quoted (order is a reserved word). */
function sourceTable(spec: FtSpec): string {
  return `"${spec.table.replace(/^ft_/, '')}"`;
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
    const whereSql = where ? `${where} AND t.id > ${idParam}` : `t.id > ${idParam}`;
    const sql = `SELECT ${cols} FROM public.${src} t WHERE ${whereSql} ORDER BY t.id LIMIT ${FETCH_PAGE}`;
    const rows = (await ft.query(sql, [...params, lastId])).rows as Node[];
    out.push(...rows);
    if (rows.length < FETCH_PAGE) break;
    lastId = rows[rows.length - 1]!.id as string;
  }
  return out;
}

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

export interface OrderLoadResult { order: number; order_version: number; order_item: number; }

interface TestIds { consignor: string[]; consignee: string[]; marketer: string[]; }

/** Resolve the test-entity id sets (per role) to exclude at pull, from the hub's raw.ft_entity. */
async function resolveTestIds(pool: Pool): Promise<TestIds> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ consignor_id: string | null; consignee_id: string | null; marketer_id: string | null }>(
      `select consignor_id::text as consignor_id, consignee_id::text as consignee_id, marketer_id::text as marketer_id
         from raw.ft_entity where is_test = true`,
    );
    const set = (k: 'consignor_id' | 'consignee_id' | 'marketer_id') =>
      [...new Set(r.rows.map((x) => x[k]).filter((v): v is string => !!v))];
    return { consignor: set('consignor_id'), consignee: set('consignee_id'), marketer: set('marketer_id') };
  } finally { c.release(); }
}

// Test-exclusion predicate on an order alias (`o`). Empty arrays are vacuously satisfied. Null-role
// rows are KEPT (faithful) — the view is internal-only anyway. Params: $1 consignor, $2 consignee, $3 marketer.
const ORDER_NOT_TEST = (o: string) =>
  `(${o}.consignor_id IS NULL OR ${o}.consignor_id <> ALL($1::uuid[]))
   AND (${o}.consignee_id IS NULL OR ${o}.consignee_id <> ALL($2::uuid[]))
   AND (${o}.marketer_id  IS NULL OR ${o}.marketer_id  <> ALL($3::uuid[]))`;

const ORDER_WHERE = ORDER_NOT_TEST('t');
const VERSION_WHERE =
  `EXISTS (SELECT 1 FROM public."order" o WHERE o.id = t.order_id AND ${ORDER_NOT_TEST('o')})`;
const ITEM_WHERE =
  `EXISTS (SELECT 1 FROM public.order_version ov JOIN public."order" o ON o.id = ov.order_id
           WHERE ov.id = t.order_version_id AND ${ORDER_NOT_TEST('o')})`;

// ── FULL backfill ─────────────────────────────────────────────────────────────
export async function loadOrderFull(pool: Pool): Promise<OrderLoadResult> {
  const test = await resolveTestIds(pool);
  const p = [test.consignor, test.consignee, test.marketer];
  const ft = await connectFreshtrackRead();
  try {
    log(`Order full backfill (read-only source) — excluding test entities (consignor=${test.consignor.length} consignee=${test.consignee.length} marketer=${test.marketer.length})`);
    const order = (await loadStream(pool, ft, ftOrderSpec, 'order:ft_order', ORDER_WHERE, p, BACKFILL_MARK, true)).upserted;
    const version = (await loadStream(pool, ft, ftOrderVersionSpec, 'order:ft_order_version', VERSION_WHERE, p, BACKFILL_MARK, true)).upserted;
    const item = (await loadStream(pool, ft, ftOrderItemSpec, 'order:ft_order_item', ITEM_WHERE, p, BACKFILL_MARK, true)).upserted;
    return { order, order_version: version, order_item: item };
  } finally { await ft.end(); }
}

// ── INCREMENTAL by last_modified_on (change capture) ──────────────────────────
export async function loadOrderIncremental(pool: Pool, since: string): Promise<OrderLoadResult> {
  const test = await resolveTestIds(pool);
  const p = [test.consignor, test.consignee, test.marketer, since];
  const mod = 't.last_modified_on >= $4::timestamptz';
  const ft = await connectFreshtrackRead();
  try {
    log(`Order incremental since ${since} (last_modified_on watermark) — excluding test entities`);
    const order = (await loadStream(pool, ft, ftOrderSpec, 'order:ft_order', `${ORDER_WHERE} AND ${mod}`, p, since, false)).upserted;
    const version = (await loadStream(pool, ft, ftOrderVersionSpec, 'order:ft_order_version', `${VERSION_WHERE} AND ${mod}`, p, since, false)).upserted;
    const item = (await loadStream(pool, ft, ftOrderItemSpec, 'order:ft_order_item', `${ITEM_WHERE} AND ${mod}`, p, since, false)).upserted;
    return { order, order_version: version, order_item: item };
  } finally { await ft.end(); }
}

// ── SLICE: newest N orders + their versions + items (testing / proving the path) ──
export async function loadOrderSlice(pool: Pool, n = DEFAULT_ORDERS): Promise<OrderLoadResult> {
  const test = await resolveTestIds(pool);
  const p = [test.consignor, test.consignee, test.marketer];
  const ft = await connectFreshtrackRead();
  try {
    const ids = (await ft.query<{ id: string }>(
      `SELECT t.id FROM public."order" t WHERE ${ORDER_WHERE} ORDER BY t.created_on DESC, t.id DESC LIMIT $4`,
      [...p, n],
    )).rows.map((x) => x.id);
    log(`Order slice — newest ${ids.length} orders + their versions/items (sync_window @ ${SLICE_MARK})`);
    if (ids.length === 0) return { order: 0, order_version: 0, order_item: 0 };
    const order = (await loadStream(pool, ft, ftOrderSpec, 'order:ft_order', 't.id = ANY($1::uuid[])', [ids], SLICE_MARK, false)).upserted;
    const version = (await loadStream(pool, ft, ftOrderVersionSpec, 'order:ft_order_version', 't.order_id = ANY($1::uuid[])', [ids], SLICE_MARK, false)).upserted;
    const item = (await loadStream(pool, ft, ftOrderItemSpec, 'order:ft_order_item',
      't.order_version_id IN (SELECT id FROM public.order_version WHERE order_id = ANY($1::uuid[]))', [ids], SLICE_MARK, false)).upserted;
    return { order, order_version: version, order_item: item };
  } finally { await ft.end(); }
}

function fmt(r: OrderLoadResult): string {
  return `order=${r.order} order_version=${r.order_version} order_item=${r.order_item}`;
}

if (isMain(import.meta.url)) {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const ordersArg = process.argv.find((a) => a.startsWith('--orders='))?.split('=')[1];
  const pool = makePool();
  try {
    await assertHubTarget(pool); // hard blocker — abort unless the write target is the hub
    let r: OrderLoadResult;
    if (ordersArg) r = await loadOrderSlice(pool, Number(ordersArg));
    else if (sinceArg) r = await loadOrderIncremental(pool, sinceArg);
    else r = await loadOrderFull(pool);
    log(`done: ${fmt(r)}`);
  } finally {
    await pool.end();
  }
}
