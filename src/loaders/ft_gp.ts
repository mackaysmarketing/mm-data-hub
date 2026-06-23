// FreshTrack grower-pool SETTLEMENT loader → raw.ft_gp_* (GP domain, read-replica source).
//
// READ-ONLY out of FreshTrack: connects to the production read-replica (src/lib/freshtrack_db.ts),
// SELECT only. Lands a referentially-complete slice — the newest N gp_schedule rows plus ALL their
// gp_detail lines and gp_payment rows (joined by gp_schedule_id) — into the hub.
//
//   npm run ft:gp:load                 # newest 50 schedules + their detail/payments (test batch)
//   npm run ft:gp:load -- --schedules=200
//
// Idempotent: every stream upserts on its PK (id), so re-running is a no-op for unchanged rows.
// Proper incremental windowing by last_modified_on is Phase-2 work; this is the slice loader that
// proves the read-replica → hub path end to end.
import type { Pool, PoolClient } from 'pg';
import { makePool, upsertNodes } from '../lib/db.ts';
import { connectFreshtrackRead } from '../lib/freshtrack_db.ts';
import {
  ftSelectList, type FtSpec,
  ftGpScheduleSpec, ftGpDetailSpec, ftGpPaymentSpec,
} from '../lib/ft_gp_specs.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;
const DEFAULT_SCHEDULES = 50;

export interface GpSlice {
  scheduleIds: string[];
  schedules: Node[];
  details: Node[];
  payments: Node[];
}

/** Fetch the newest `n` schedules and everything hanging off them. No DB write here. */
export async function fetchGpSlice(n: number): Promise<GpSlice> {
  const ft = await connectFreshtrackRead();
  try {
    const ids = (
      await ft.query<{ id: string }>(
        `SELECT id FROM public.gp_schedule ORDER BY created_on DESC, id DESC LIMIT $1`,
        [n],
      )
    ).rows.map((r) => r.id);
    if (ids.length === 0) return { scheduleIds: [], schedules: [], payments: [], details: [] };

    const schedules = (
      await ft.query(
        `SELECT ${ftSelectList(ftGpScheduleSpec)} FROM public.gp_schedule WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    const details = (
      await ft.query(
        `SELECT ${ftSelectList(ftGpDetailSpec)} FROM public.gp_detail WHERE gp_schedule_id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    const payments = (
      await ft.query(
        `SELECT ${ftSelectList(ftGpPaymentSpec)} FROM public.gp_payment WHERE gp_schedule_id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    return { scheduleIds: ids, schedules, details, payments };
  } finally {
    await ft.end();
  }
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

export interface GpLoadResult {
  schedules: number; details: number; payments: number; scheduleIds: number;
}

export async function loadGpSlice(pool: Pool, n = DEFAULT_SCHEDULES): Promise<GpLoadResult> {
  // Fetch fully from the replica BEFORE opening a hub connection (a connection left idle through a
  // long fetch gets dropped by the pooler — the NetSuite loader learned this the hard way).
  const slice = await fetchGpSlice(n);
  const client = await pool.connect();
  try {
    const schedules = await upsertBatched(client, ftGpScheduleSpec, slice.schedules);
    const details = await upsertBatched(client, ftGpDetailSpec, slice.details);
    const payments = await upsertBatched(client, ftGpPaymentSpec, slice.payments);
    return { scheduleIds: slice.scheduleIds.length, schedules, details, payments };
  } finally {
    client.release();
  }
}

if (isMain(import.meta.url)) {
  const nArg = process.argv.find((a) => a.startsWith('--schedules='))?.split('=')[1];
  const n = nArg ? Number(nArg) : DEFAULT_SCHEDULES;
  const pool = makePool();
  try {
    log(`FreshTrack GP slice load — newest ${n} schedules + their detail/payments (read-only source)`);
    const r = await loadGpSlice(pool, n);
    log(`done: schedules=${r.schedules} (of ${r.scheduleIds} selected) details=${r.details} payments=${r.payments}`);
  } finally {
    await pool.end();
  }
}
