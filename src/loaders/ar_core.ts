// AR core builder → core.fact_customer_invoice + core.fact_remittance_line.
//   npm run ar:core
//
// Idempotent: both refresh functions DELETE + re-INSERT. Run AFTER ft:invoice:load + ns:ar:load +
// remit:load and after refresh_dim_customer (the invoice fact denormalises the customer name).
// Order matters: fact_customer_invoice first (fact_remittance_line joins it). Prints row counts +
// the paid-status and reconciliation self-checks so a bad build is loud.
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export interface ArCoreResult { fact_customer_invoice: number; fact_remittance_line: number; }

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

      const paid = (await c.query<{ paid_status: string; n: string }>(
        `select paid_status, count(*)::text n from core.fact_customer_invoice group by paid_status order by 2 desc`)).rows;
      log('  paid-status breakdown: ' + paid.map((r) => `${r.paid_status}=${r.n}`).join(' '));

      const recon = (await c.query<{ recon_status: string; n: string }>(
        `select recon_status, count(*)::text n from core.fact_remittance_line group by recon_status order by 2 desc`)).rows;
      log('  remittance recon breakdown: ' + recon.map((r) => `${r.recon_status}=${r.n}`).join(' '));
      return { fact_customer_invoice: inv, fact_remittance_line: rl };
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const r = await buildArCore();
  log(`done: fact_customer_invoice=${r.fact_customer_invoice} fact_remittance_line=${r.fact_remittance_line}`);
}
