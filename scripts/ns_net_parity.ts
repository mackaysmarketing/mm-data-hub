// ─────────────────────────────────────────────────────────────────────────────
// Net-parity proof — the hub's grower settlement reconciles to LIVE NetSuite.
//   npm run ns:parity
//
// Re-queries NetSuite (read-only) and compares to core.fact_settlement_bill:
//   • bill count matches                           • Σ bill_total == Σ NetSuite foreigntotal
//   • Σ net_paid == −Σ foreigntotal                • per-grower net matches (grower_code = entityid)
//   • spot-check: one RCTI's gross/deductions/tax/net recomputed from NetSuite lines == the hub fact.
// This is the data-completeness/freshness check (no missing or duplicated bills), complementary to
// the internal line-reconciliation. Exit 0 = parity holds; 1 = any mismatch.
// ─────────────────────────────────────────────────────────────────────────────
import { makePool } from '../src/lib/db.ts';
import { suiteqlAll, suiteqlPage } from '../src/lib/netsuite.ts';
import { classifyCharge } from '../src/lib/ns_charges.ts';
import { rollupBill, type CategorizedLine } from '../src/lib/ns_lines.ts';
import { env } from '../src/lib/env.ts';
import { isMain } from '../src/lib/util.ts';

const TOL = 0.01;
const CAT = () => Number(env.nsGrowerVendorCategory());

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function main(): Promise<void> {
  console.log('=== Net-parity proof (hub vs live NetSuite) ===\n');
  const pool = makePool();
  const client = await pool.connect();
  try {
    // ── NetSuite live: per-grower count + total ────────────────────────────────
    const nsRows = await suiteqlAll<{ entityid: string; n: string; tot: string }>(
      `SELECT v.entityid, COUNT(*) AS n, SUM(t.foreigntotal) AS tot
         FROM transaction t JOIN vendor v ON v.id = t.entity
        WHERE t.type='VendBill' AND v.category=${CAT()}
        GROUP BY v.entityid`,
    );
    const nsByCode = new Map(nsRows.map((r) => [r.entityid, { n: Number(r.n), tot: Number(r.tot) }]));
    const nsCount = nsRows.reduce((a, r) => a + Number(r.n), 0);
    const nsTotal = nsRows.reduce((a, r) => a + Number(r.tot), 0);

    // ── Hub: per-grower count + totals ─────────────────────────────────────────
    const hubRows = (await client.query<{ grower_code: string; n: string; tot: string; net: string }>(
      `select grower_code, count(*) n, sum(bill_total) tot, sum(net_paid) net
         from core.fact_settlement_bill group by grower_code`,
    )).rows;
    const hubByCode = new Map(hubRows.map((r) => [r.grower_code, { n: Number(r.n), tot: Number(r.tot), net: Number(r.net) }]));
    const hubCount = hubRows.reduce((a, r) => a + Number(r.n), 0);
    const hubTotal = hubRows.reduce((a, r) => a + Number(r.tot), 0);
    const hubNet = hubRows.reduce((a, r) => a + Number(r.net), 0);

    console.log(`NetSuite: ${nsCount} bills, Σtotal=${nsTotal.toFixed(2)} | hub: ${hubCount} bills, Σtotal=${hubTotal.toFixed(2)}, Σnet=${hubNet.toFixed(2)}\n`);

    check('bill count matches', nsCount === hubCount, `ns=${nsCount} hub=${hubCount}`);
    check('Σ bill_total matches NetSuite Σ foreigntotal', Math.abs(nsTotal - hubTotal) < TOL, `Δ=${(nsTotal - hubTotal).toFixed(4)}`);
    check('Σ net_paid == −Σ foreigntotal', Math.abs(hubNet - -nsTotal) < TOL, `net=${hubNet.toFixed(2)} −total=${(-nsTotal).toFixed(2)}`);

    // ── Per-grower parity ──────────────────────────────────────────────────────
    let growerMismatch = 0;
    const allCodes = new Set([...nsByCode.keys(), ...hubByCode.keys()]);
    for (const code of allCodes) {
      const ns = nsByCode.get(code);
      const hub = hubByCode.get(code);
      if (!ns || !hub) { growerMismatch++; continue; }
      if (ns.n !== hub.n || Math.abs(hub.net - -ns.tot) > TOL) growerMismatch++;
    }
    check('every grower reconciles (count + net)', growerMismatch === 0, `${growerMismatch} grower mismatches of ${allCodes.size}`);

    // ── Spot-check one RCTI line-by-line vs NetSuite ───────────────────────────
    const spot = (await client.query<{ bill_id: string; tranid: string; gross_sales: string; total_deductions: string; tax_total: string; net_paid: string }>(
      `select bill_id, tranid, gross_sales, total_deductions, tax_total, net_paid
         from core.fact_settlement_bill where consignor_id is not null order by net_paid desc limit 1`,
    )).rows[0]!;
    const nsLines = (await suiteqlPage<{ mainline: string; taxline: string; foreignamount: string; itemid: string | null; displayname: string | null }>(
      `SELECT tl.mainline, tl.taxline, tl.foreignamount, i.itemid, i.displayname
         FROM transactionline tl LEFT JOIN item i ON i.id = tl.item
        WHERE tl.transaction = ${spot.bill_id}`,
    )).items;
    const oracle = rollupBill(nsLines.map((l): CategorizedLine => ({
      mainline: l.mainline === 'T',
      taxline: l.taxline === 'T',
      foreignamount: l.foreignamount == null ? null : Number(l.foreignamount),
      category: classifyCharge(l.itemid, l.displayname).category,
    })));
    const spotOk =
      Math.abs(oracle.gross - Number(spot.gross_sales)) < TOL &&
      Math.abs(oracle.totalDeductions - Number(spot.total_deductions)) < TOL &&
      Math.abs(oracle.tax - Number(spot.tax_total)) < TOL &&
      Math.abs(oracle.net - Number(spot.net_paid)) < TOL;
    check(`spot-check ${spot.tranid} line-by-line`, spotOk,
      `ns(gross=${oracle.gross} ded=${oracle.totalDeductions} tax=${oracle.tax} net=${oracle.net}) vs hub(${spot.gross_sales}/${spot.total_deductions}/${spot.tax_total}/${spot.net_paid})`);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    client.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('parity proof error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
