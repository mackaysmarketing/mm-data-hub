// ─────────────────────────────────────────────────────────────────────────────
// Line-reconciliation proof — the no-double-count guard for grower RCTIs.
//   npm run ns:reconcile
//
// Proves, per RCTI, that SUM(lines) = the bill total, three ways:
//   A. DB fact:   core.fact_settlement_bill.recon_diff ≈ 0 for every bill.
//   B. Oracle:    the unit-tested TS rollup (ns_lines.rollupBill) recomputes net = -bill_total
//                 from raw lines INDEPENDENTLY of the SQL.
//   C. Drift:     the oracle net == the SQL fact net_paid for every bill (TS and SQL agree).
// Plus it SURFACES (never hides): unmapped growers (consignor_id null) and any OTHER-category
// (unclassified) deduction lines. Writes reports/ns_line_reconcile_<date>.md.
//
// Exit 0 = A,B,C all clean; 1 = any mismatch.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { makePool } from '../src/lib/db.ts';
import { rollupBill, type CategorizedLine } from '../src/lib/ns_lines.ts';
import { isMain, log } from '../src/lib/util.ts';

const TOL = 0.01;

interface BillRow { bill_id: string; tranid: string; foreigntotal: string | null; }
interface LineRow { bill_id: string; mainline: boolean | null; taxline: boolean | null; foreignamount: string | null; category: string; }
interface FactRow { bill_id: string; net_paid: string | null; recon_diff: string | null; consignor_id: string | null; }

export async function reconcile(): Promise<{ pass: boolean; reportPath: string }> {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const bills = (await client.query<BillRow>(
      `select id as bill_id, tranid, foreigntotal from raw.ns_vendor_bill where type='VendBill'`,
    )).rows;
    const lines = (await client.query<LineRow>(
      `select l.transaction as bill_id, l.mainline, l.taxline, l.foreignamount,
              coalesce(ch.category,'OTHER') as category
         from raw.ns_vendor_bill_line l
         left join core.dim_ns_charge ch on ch.item_id = l.item`,
    )).rows;
    const facts = (await client.query<FactRow>(
      `select bill_id, net_paid, recon_diff, consignor_id from core.fact_settlement_bill`,
    )).rows;

    // Group lines per bill for the independent oracle.
    const byBill = new Map<string, CategorizedLine[]>();
    for (const r of lines) {
      const arr = byBill.get(r.bill_id) ?? [];
      arr.push({ mainline: r.mainline, taxline: r.taxline, foreignamount: r.foreignamount == null ? null : Number(r.foreignamount), category: r.category });
      byBill.set(r.bill_id, arr);
    }
    const factByBill = new Map(facts.map((f) => [f.bill_id, f]));

    let oracleVsBillTotal = 0;   // B
    let oracleVsFact = 0;        // C
    const worst: { tranid: string; diff: number; oracleNet: number; billTotal: number }[] = [];
    let otherLineTotal = 0;
    let billsWithOther = 0;

    for (const b of bills) {
      const ls = byBill.get(b.bill_id) ?? [];
      const r = rollupBill(ls);
      const billTotal = b.foreigntotal == null ? 0 : Number(b.foreigntotal);

      const dB = Math.abs(r.net - -billTotal);
      if (dB > TOL) { oracleVsBillTotal++; worst.push({ tranid: b.tranid, diff: dB, oracleNet: r.net, billTotal }); }

      const f = factByBill.get(b.bill_id);
      if (f && f.net_paid != null) {
        if (Math.abs(r.net - Number(f.net_paid)) > TOL) oracleVsFact++;
      }
      const other = r.deductionsByCategory['OTHER'] ?? 0;
      if (other !== 0) { billsWithOther++; otherLineTotal += other; }
    }

    // A. DB-side recon_diff + unmapped surfacing.
    const dbBad = facts.filter((f) => f.recon_diff != null && Math.abs(Number(f.recon_diff)) > TOL).length;
    const unmapped = facts.filter((f) => f.consignor_id == null).length;

    const pass = dbBad === 0 && oracleVsBillTotal === 0 && oracleVsFact === 0;

    const stamp = new Date().toISOString();
    const reportPath = `reports/ns_line_reconcile_${stamp.slice(0, 10)}.md`;
    const lines2: string[] = [];
    lines2.push(`# NetSuite RCTI line-reconciliation — ${stamp}`);
    lines2.push('');
    lines2.push(`Bills: **${bills.length}** · fact rows: **${facts.length}** · tolerance: ${TOL}`);
    lines2.push('');
    lines2.push('| Check | Result |');
    lines2.push('|---|---|');
    lines2.push(`| A. DB fact recon_diff within tol | ${dbBad === 0 ? 'PASS' : 'FAIL'} (${dbBad} over tol) |`);
    lines2.push(`| B. Oracle net == −bill_total (sum lines = total) | ${oracleVsBillTotal === 0 ? 'PASS' : 'FAIL'} (${oracleVsBillTotal} mismatch) |`);
    lines2.push(`| C. Oracle net == SQL fact net_paid (no drift) | ${oracleVsFact === 0 ? 'PASS' : 'FAIL'} (${oracleVsFact} mismatch) |`);
    lines2.push('');
    lines2.push('## Surfaced (not hidden)');
    lines2.push(`- Unmapped growers (consignor_id null): **${unmapped}**`);
    lines2.push(`- Bills with OTHER-category (unclassified) deduction lines: **${billsWithOther}** (Σ ${otherLineTotal.toFixed(2)})`);
    if (worst.length) {
      lines2.push('');
      lines2.push('## Worst oracle-vs-bill-total mismatches');
      lines2.push('| RCTI | oracle net | bill total | diff |');
      lines2.push('|---|---:|---:|---:|');
      for (const w of worst.sort((a, b) => b.diff - a.diff).slice(0, 20)) {
        lines2.push(`| ${w.tranid} | ${w.oracleNet.toFixed(2)} | ${(-w.billTotal).toFixed(2)} | ${w.diff.toFixed(4)} |`);
      }
    }
    lines2.push('');
    writeFileSync(reportPath, lines2.join('\n'), 'utf8');

    log(`A(db recon)=${dbBad === 0 ? 'PASS' : 'FAIL'} B(oracle=total)=${oracleVsBillTotal === 0 ? 'PASS' : 'FAIL'} C(oracle=fact)=${oracleVsFact === 0 ? 'PASS' : 'FAIL'} · unmapped=${unmapped} other=${billsWithOther} → ${reportPath}`);
    return { pass, reportPath };
  } finally {
    client.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  const { pass } = await reconcile();
  if (!pass) process.exitCode = 1;
}
