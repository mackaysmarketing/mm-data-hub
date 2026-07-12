// ─────────────────────────────────────────────────────────────────────────────
// AR reconciliation — customer invoice landing + NetSuite cash mirror. SQL is the oracle;
// every expectation is DERIVED in-run from source (no hardcoded baselines — house contract).
//   npm run ar:reconcile
//   1. Landing parity: fact_customer_invoice == raw.ft_invoice customer-AR rows (PI/SI/CN/DR).
//   2. NS↔FT crosswalk: fact rows with an NS match == NS invoices whose externalid is an FT number
//      that resolves; Opening-Balance / non-FT NS rows surfaced (not silently dropped).
//   3. Cash tie: Σ fact.paid_amount == Σ applied CustPymt on in-scope invoices (both derived).
//   4. Paid-status partition sums to the fact; lineage (consignee) coverage surfaced.
// Exit 0 = all pass. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function table(rows: Record<string, unknown>[]): void {
  if (!rows.length) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  console.log('  ' + cols.join(' | '));
  for (const r of rows) console.log('  ' + cols.map((c) => String(r[c] ?? '∅')).join(' | '));
}

async function main(): Promise<void> {
  console.log('=== AR reconciliation (SQL is the oracle; expectations derived in-run) ===');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    // 1. Landing parity
    console.log('\n--- 1. Invoice landing parity ---');
    const p = (await c.query(
      `select (select count(*) from raw.ft_invoice where invoice_type in ('PI','SI','CN','DR'))::text as raw_ar,
              (select count(*) from core.fact_customer_invoice)::text as fact,
              (select count(*) from raw.ft_invoice)::text as raw_all`)).rows[0]!;
    table([p]);
    check('fact_customer_invoice == raw customer-AR rows', p.raw_ar === p.fact, `raw_ar=${p.raw_ar} fact=${p.fact}`);

    // 2. NS↔FT crosswalk
    console.log('\n--- 2. NetSuite↔FreshTrack invoice crosswalk (externalid = invoice_no) ---');
    const x = (await c.query(
      `select
         (select count(*) from core.fact_customer_invoice where ns_invoice_id is not null)::text as fact_ns_matched,
         (select count(*) from raw.ns_customer_invoice ni
            where ni.externalid ~ '^FT' and exists (select 1 from raw.ft_invoice f where f.invoice_no = ni.externalid
                                                     and f.invoice_type in ('PI','SI','CN','DR')))::text as ns_ft_resolvable,
         (select count(*) from raw.ns_customer_invoice where externalid is null or externalid !~ '^FT')::text as ns_non_ft_opening,
         (select count(*) from core.fact_customer_invoice where ns_invoice_id is null)::text as fact_no_ns`)).rows[0]!;
    table([x]);
    check('fact NS-matched == NS invoices with a resolvable FT externalid', x.fact_ns_matched === x.ns_ft_resolvable,
      `fact_matched=${x.fact_ns_matched} ns_resolvable=${x.ns_ft_resolvable}; non-FT/opening NS rows=${x.ns_non_ft_opening}; fact w/o NS=${x.fact_no_ns} (surfaced)`);

    // 3. Cash tie — fact paid_amount vs applied CustPymt on in-scope invoices
    console.log('\n--- 3. Cash tie: Σ fact.paid_amount == Σ applied CustPymt ---');
    const cash = (await c.query(
      `with applied as (
         select round(sum(l.foreignamount),2) as amt
         from raw.ns_ar_apply_link l
         where l.previoustype='CustInvc' and l.nexttype='CustPymt'
           and l.previousdoc in (select ns_invoice_id from core.fact_customer_invoice where ns_invoice_id is not null))
       select (select round(sum(paid_amount),2) from core.fact_customer_invoice)::text as fact_paid,
              (select amt from applied)::text as applied_pymt`)).rows[0]!;
    table([cash]);
    check('Σ fact.paid_amount == Σ applied CustPymt', Math.abs(Number(cash.fact_paid) - Number(cash.applied_pymt)) < 0.01,
      `fact=${cash.fact_paid} applied=${cash.applied_pymt}`);

    // 4. Paid-status partition + lineage
    console.log('\n--- 4. Paid-status breakdown + lineage coverage ---');
    const st = (await c.query(
      `select paid_status, count(*)::text as invoices, round(sum(amount_value),2)::text as amount
         from core.fact_customer_invoice group by paid_status order by count(*) desc`)).rows;
    table(st);
    const partition = (await c.query(
      `with byst as (select count(*) n from core.fact_customer_invoice group by paid_status)
       select (select count(*) from core.fact_customer_invoice)::text as total,
              (select coalesce(sum(n),0) from byst)::text as summed,
              (select count(*) from core.fact_customer_invoice where consignee_id is not null)::text as with_consignee`)).rows[0]!;
    check('paid-status partitions the fact (no row dropped)', partition.total === partition.summed, `total=${partition.total} summed=${partition.summed}`);
    check('invoices resolve to a customer (lineage)',
      Number(partition.with_consignee) > 0.95 * Number(partition.total),
      `with_consignee=${partition.with_consignee}/${partition.total}`);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('ar:reconcile error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
