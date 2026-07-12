// ─────────────────────────────────────────────────────────────────────────────
// Remittance reconciliation proof — the headline AR-automation surface.
//   npm run remit:reconcile
//   1. Parser checksum: per remittance, Σ line payment_amount == header total_amount (the parser
//      guarantees it; re-assert against the LANDED rows so a bad load is caught).
//   2. Reconciliation buckets: matched / amount_mismatch / claim / unmatched, per the real Coles
//      payments; the unmatched + claim lines listed (the investigate list).
//   3. Matched lines: the remittance document $ ties to our FreshTrack invoice amount (variance ≈ 0),
//      and Coles's settlement discount ≈ 2.5% of document (the retail rebate) — surfaced.
//   4. Writes reports/ar_remittance_reconcile_<date>.md.
// Read-only. Exit 0 = all pass.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean }[] = [];
const report: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line); report.push(line);
}
function show(rows: Record<string, unknown>[]): void {
  if (!rows.length) { console.log('  (no rows)'); report.push('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  const head = '  ' + cols.join(' | ');
  console.log(head); report.push(head);
  for (const r of rows) { const l = '  ' + cols.map((c) => String(r[c] ?? '∅')).join(' | '); console.log(l); report.push(l); }
}

async function main(): Promise<void> {
  console.log('=== Remittance reconciliation (Coles) ===');
  report.push('# AR remittance reconciliation (Coles) — ' + new Date().toISOString().slice(0, 10), '');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    // 1. Checksum against landed rows
    console.log('\n--- 1. Parser checksum (landed rows) ---');
    report.push('## 1. Parser checksum');
    const cs = (await c.query(
      `select r.payment_no, r.total_amount::text as header_total,
              round(sum(rl.payment_amount),2)::text as line_sum, r.line_count::text as lines
         from raw.remittance r join raw.remittance_line rl on rl.remittance_id = r.id
         group by r.payment_no, r.total_amount, r.line_count order by r.payment_no`)).rows;
    show(cs);
    check('Σ line payment == header total (every advice)',
      cs.every((r) => Math.abs(Number(r.header_total) - Number(r.line_sum)) < 0.01),
      `${cs.length} advice(s)`);

    // 2. Reconciliation buckets
    console.log('\n--- 2. Reconciliation buckets ---');
    report.push('', '## 2. Reconciliation buckets');
    const buckets = (await c.query(
      `select recon_status, count(*)::text as lines, round(sum(document_amount),2)::text as document_amount
         from core.fact_remittance_line group by recon_status order by count(*) desc`)).rows;
    show(buckets);
    check('every line classified (no null recon_status)',
      (await c.query(`select count(*) n from core.fact_remittance_line where recon_status is null`)).rows[0]!.n === '0',
      'null recon_status = 0');

    console.log('\n  investigate list (claim + unmatched + amount_mismatch):');
    report.push('', '### Investigate list (claim / unmatched / amount_mismatch)');
    const inv = (await c.query(
      `select payment_no, invoice_no, doc_type, recon_status, document_amount::text as doc_amt,
              coalesce(invoice_amount::text,'∅') as our_inv_amt, coalesce(variance::text,'∅') as variance,
              coalesce(consignee_name,'∅') as customer
         from core.fact_remittance_line
         where recon_status <> 'matched' order by recon_status, payment_no, invoice_no`)).rows;
    show(inv);

    // 3. Matched lines tie to our invoices + the 2.5% settlement discount
    console.log('\n--- 3. Matched lines: variance + settlement discount ---');
    report.push('', '## 3. Matched lines: variance vs our invoice + Coles settlement discount');
    const m = (await c.query(
      `select count(*)::text as matched_lines,
              round(sum(abs(variance)),2)::text as total_abs_variance,
              count(*) filter (where abs(variance) < 0.01)::text as exact_ties,
              round(avg(100.0 * discount_amount / nullif(document_amount,0)),3)::text as avg_discount_pct
         from core.fact_remittance_line where recon_status = 'matched'`)).rows[0]!;
    show([m]);
    check('all matched lines tie to our invoice amount (variance ≈ 0)',
      m.matched_lines === m.exact_ties, `matched=${m.matched_lines} exact=${m.exact_ties}`);
    check('Coles settlement discount ≈ 2.5%', Math.abs(Number(m.avg_discount_pct) - 2.5) < 0.2,
      `avg discount = ${m.avg_discount_pct}%`);

    // 4. Matched → invoice paid status corroboration
    console.log('\n--- 4. Do matched invoices show paid in NetSuite? ---');
    report.push('', '## 4. Matched-invoice NetSuite paid-status corroboration');
    const corr = (await c.query(
      `select coalesce(invoice_paid_status,'(no invoice)') as invoice_paid_status, count(*)::text as lines
         from semantic.ar_remittance_reconciliation where recon_status='matched'
         group by invoice_paid_status order by count(*) desc`)).rows;
    show(corr);

    mkdirSync('reports', { recursive: true });
    const path = `reports/ar_remittance_reconcile_${new Date().toISOString().slice(0, 10)}.md`;
    writeFileSync(path, report.join('\n'), 'utf8');
    console.log(`\n→ ${path}`);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('remit:reconcile error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
