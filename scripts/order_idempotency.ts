// A4 idempotency proof with ZERO source drift — the live replica keeps receiving new orders, so a
// "newest N" slice is a moving target. This instead re-upserts a FIXED set of rows already in raw
// (fetched from the replica by their exact ids) TWICE, and shows raw.ft_order_item count is unchanged
// across both re-upserts. That isolates upsert idempotency (on conflict do update) from source drift.
import { makePool, upsertNodes } from '../src/lib/db.ts';
import { connectFreshtrackRead } from '../src/lib/freshtrack_db.ts';
import { ftSelectList, ftOrderItemSpec } from '../src/lib/ft_order_specs.ts';
import { log } from '../src/lib/util.ts';

async function main(): Promise<void> {
  const pool = makePool();
  const ft = await connectFreshtrackRead();
  const c = await pool.connect();
  try {
    const before = (await c.query<{ n: string }>('select count(*)::text n from raw.ft_order_item')).rows[0]!.n;
    // A fixed set of 500 order_item ids already in raw (deterministic by id).
    const ids = (await c.query<{ id: string }>(
      'select id::text id from raw.ft_order_item order by id limit 500')).rows.map((r) => r.id);
    // Fetch those exact rows from the replica.
    const rows = (await ft.query(
      `select ${ftSelectList(ftOrderItemSpec)} from public.order_item t where t.id = any($1::uuid[])`, [ids])).rows;
    log(`fixed set: ${ids.length} ids; fetched ${rows.length} rows from replica`);
    log(`raw.ft_order_item count before: ${before}`);

    const u1 = await upsertNodes(c, ftOrderItemSpec, rows as Record<string, unknown>[]);
    const after1 = (await c.query<{ n: string }>('select count(*)::text n from raw.ft_order_item')).rows[0]!.n;
    log(`re-upsert #1: ${u1} rows touched → count = ${after1}`);

    const u2 = await upsertNodes(c, ftOrderItemSpec, rows as Record<string, unknown>[]);
    const after2 = (await c.query<{ n: string }>('select count(*)::text n from raw.ft_order_item')).rows[0]!.n;
    log(`re-upsert #2: ${u2} rows touched → count = ${after2}`);

    const ok = before === after1 && after1 === after2;
    log(`\n${ok ? 'PASS' : 'FAIL'} — 0 net new rows across two re-upserts of a fixed set (${before} → ${after1} → ${after2})`);
    if (!ok) process.exitCode = 1;
  } finally {
    c.release(); await ft.end(); await pool.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
