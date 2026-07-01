// Order-domain CORE builder → core.fact_order_item + core.dim_order.
//   npm run ft:order:core
//
// Idempotent: both refresh functions DELETE + re-INSERT. Order matters — the fact is rebuilt first
// (authoritative-version lines only), then dim_order aggregates the fact for the derived header
// totals. Prints row counts + the A6 (no superseded line) and A7 (header == line, native == derived)
// self-checks so a bad build is loud. Writes via DATABASE_URL (assertHubTarget guards the target).
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export interface OrderCoreResult { fact_order_item: number; dim_order: number; }

export async function buildOrderCore(): Promise<OrderCoreResult> {
  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c = await pool.connect();
    try {
      const facts = (await c.query<{ n: number }>('select core.refresh_fact_order_item() as n')).rows[0]!.n;
      log(`  core.fact_order_item rebuilt: ${facts} rows (authoritative-version lines only)`);
      const dims = (await c.query<{ n: number }>('select core.refresh_dim_order() as n')).rows[0]!.n;
      log(`  core.dim_order rebuilt: ${dims} rows (one per order)`);

      // A6 self-check — no superseded-version line reached the fact.
      const superseded = (await c.query<{ n: string }>(
        `select count(*)::text n from core.fact_order_item where order_version_no <> order_latest_version_no`)).rows[0]!.n;
      log(`  A6 superseded-version lines in fact: ${superseded} (expect 0)`);

      // A7 self-check — header total == Σ current-version line native, and native == derived.
      const recon = (await c.query<{ orders: string; native_eq_lines: string; native_eq_derived: string }>(
        `with lines as (
           select order_id, sum(total_price_value) native_lines, sum(derived_price_value) derived_lines
             from core.fact_order_item group by order_id)
         select count(*)::text orders,
                count(*) filter (where d.total_price_value is not distinct from l.native_lines)::text native_eq_lines,
                count(*) filter (where abs(coalesce(l.native_lines,0)-coalesce(l.derived_lines,0))<0.01)::text native_eq_derived
           from core.dim_order d join lines l on l.order_id = d.order_id`)).rows[0]!;
      log(`  A7 orders with lines: ${recon.orders}; header==Σlines: ${recon.native_eq_lines}; native==derived: ${recon.native_eq_derived}`);
      return { fact_order_item: facts, dim_order: dims };
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const r = await buildOrderCore();
  log(`done: fact_order_item=${r.fact_order_item} dim_order=${r.dim_order}`);
}
