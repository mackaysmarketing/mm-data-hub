// AR core builder → core.fact_customer_invoice + core.fact_remittance_line + core.fact_load_sale.
//   npm run ar:core
//
// Idempotent: all refresh functions DELETE + re-INSERT. Run AFTER ft:invoice:load + ns:ar:load +
// remit:load and after refresh_dim_customer (the invoice fact denormalises the customer name).
// Order matters: fact_customer_invoice first (fact_remittance_line and fact_load_sale join it).
// fact_load_sale (0054, grower-portal fix pack) also reads core.crosswalk_customer_retail —
// run insight:core first after any consignee churn or its retailer_group goes stale/null.
// Prints row counts + the paid-status and reconciliation self-checks so a bad build is loud.
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export interface ArCoreResult { fact_customer_invoice: number; fact_remittance_line: number; fact_load_sale: number; }

export async function buildArCore(): Promise<ArCoreResult> {
  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c = await pool.connect();
    try {
      const inv = (await c.query<{ n: number }>('select core.refresh_fact_customer_invoice() as n')).rows[0]!.n;
      log(`  core.fact_customer_invoice rebuilt: ${inv} rows (customer AR: PI/SI/CN/DR)`);
      const rl = (await c.query<{ n: number }>('select core.refresh_fact_remittance_line() as n')).rows[0]!.n;
      log(`  core.fact_remittance_line rebuilt: ${rl} rows`);
      const ls = (await c.query<{ n: number }>('select core.refresh_fact_load_sale() as n')).rows[0]!.n;
      const lsUnmapped = Number((await c.query<{ n: string }>(
        `select count(*)::text n from core.fact_load_sale where retailer_group is null`)).rows[0]!.n);
      log(`  core.fact_load_sale rebuilt: ${ls} rows (retailer_group unmapped: ${lsUnmapped})`);

      const paid = (await c.query<{ paid_status: string; n: string }>(
        `select paid_status, count(*)::text n from core.fact_customer_invoice group by paid_status order by 2 desc`)).rows;
      log('  paid-status breakdown: ' + paid.map((r) => `${r.paid_status}=${r.n}`).join(' '));

      const recon = (await c.query<{ recon_status: string; n: string }>(
        `select recon_status, count(*)::text n from core.fact_remittance_line group by recon_status order by 2 desc`)).rows;
      log('  remittance recon breakdown: ' + recon.map((r) => `${r.recon_status}=${r.n}`).join(' '));
      return { fact_customer_invoice: inv, fact_remittance_line: rl, fact_load_sale: ls };
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const r = await buildArCore();
  log(`done: fact_customer_invoice=${r.fact_customer_invoice} fact_remittance_line=${r.fact_remittance_line} fact_load_sale=${r.fact_load_sale}`);
}
