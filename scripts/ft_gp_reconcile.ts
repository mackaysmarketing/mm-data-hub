// ─────────────────────────────────────────────────────────────────────────────
// GP internal reconciliation — the settlement-integrity proof.
//   npm run ft:gp:reconcile
//
// Proves, per GP schedule, that net = gross − deductions − GST holds, four ways:
//   A. Drift:  the unit-tested TS oracle (ft_gp_settlement.rollupSchedule) recomputes each
//              schedule's net from raw INDEPENDENTLY of the SQL, and == core.fact_gp_settlement.
//   B. Cash:   the fact net reconciles to gp_payment (the actual cash) within tolerance — pass-rate
//              reported; reconsignment-split variance SURFACED (not hidden; not replicated).
//   C. Oracle: the hub fact net ties to FreshTrack's OWN v_power_bi_charge_split (grand total),
//              the reference settlement math (read-only on the replica).
//   D. Anchors: grand gross / deductions / GST / paid vs the live source + the NetSuite RCTI net.
// Plus it SURFACES (never hides): OTHER-category deductions, null-consignor schedules, schedules
// with no gp_payment row. Writes reports/ft_gp_reconcile_<date>.md. Exit 0 = A clean; 1 = drift.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { connectFreshtrackRead } from '../src/lib/freshtrack_db.ts';
import { rollupSchedule, type GpChargeLine } from '../src/lib/ft_gp_settlement.ts';
import { isMain, log } from '../src/lib/util.ts';

const TOL = 0.02;        // drift tolerance (cents rounding)
const CASH_TOL_PCT = 0.01;

const DIGIT: Record<string, string> = { '1': 'FR', '2': 'WH', '3': 'MD', '4': 'MI', '5': 'LA' };
/** Per-line category — EXACTLY the SQL CASE: line account_code first digit, else dim category. */
function lineCategory(accountCode: string | null, dimCategory: string | null): string {
  const d = (accountCode ?? '').trim()[0] ?? '';
  return DIGIT[d] ?? dimCategory ?? 'OTHER';
}

interface FactRow { schedule_id: string; net_settlement: string | null; paid_amount: string | null; consignor_id: string | null; deduction_other: string | null; paid_status: string | null; }

async function loadGrandFromReplica(): Promise<{ pbiNet: number; pbiSales: number; pbiCharges: number } | null> {
  try {
    const ft = await connectFreshtrackRead();
    try {
      const r = (await ft.query<{ net: string; sales: string; charges: string }>(
        `select sum(total_amount_value)+sum(gst) net,
                sum(total_amount_value) filter (where text_3='Sales') sales,
                sum(total_amount_value) filter (where text_3 is distinct from 'Sales') charges
           from public.v_power_bi_charge_split`,
      )).rows[0]!;
      return { pbiNet: Number(r.net), pbiSales: Number(r.sales), pbiCharges: Number(r.charges) };
    } finally { await ft.end(); }
  } catch (e) {
    log(`  (replica PBI cross-check skipped: ${e instanceof Error ? e.message : e})`);
    return null;
  }
}

export async function reconcile(client: PoolClient): Promise<{ pass: boolean; reportPath: string }> {
  // ── Pull raw inputs once; group in JS for the independent oracle ────────────
  const gross = new Map<string, number>();
  for (const r of (await client.query<{ sid: string; g: string }>(
    `select gp_schedule_id sid, sum(box_quantity*price_invoiced_value) g from raw.ft_gp_detail group by 1`,
  )).rows) gross.set(r.sid, Number(r.g));

  const linesBySchedule = new Map<string, GpChargeLine[]>();
  for (const r of (await client.query<{ sid: string; account_code: string | null; dim_cat: string | null; vat_info: string | null; amt: string | null }>(
    `select ca.gp_schedule_id sid, ca.account_code, dgc.category dim_cat, ca.vat_info, ca.total_amount_value amt
       from raw.ft_charge_applied ca
       left join core.dim_gp_charge dgc on dgc.charge_id = ca.charge_id
      where ca.gp_schedule_id is not null and ca.is_deductible`,
  )).rows) {
    const arr = linesBySchedule.get(r.sid) ?? [];
    arr.push({ category: lineCategory(r.account_code, r.dim_cat), isDeductible: true, totalAmount: Number(r.amt ?? 0), vatInfo: r.vat_info });
    linesBySchedule.set(r.sid, arr);
  }

  const facts = (await client.query<FactRow>(
    `select schedule_id, net_settlement, paid_amount, consignor_id, deduction_other, paid_status from core.fact_gp_settlement`,
  )).rows;

  // ── A. Drift: TS oracle net == SQL fact net ────────────────────────────────
  let drift = 0; const worstDrift: { sid: string; oracle: number; sql: number }[] = [];
  // ── B. Cash: fact net vs gp_payment ────────────────────────────────────────
  let withPay = 0, within1pct = 0, within1dollar = 0; const worstCash: { sid: string; net: number; paid: number; diff: number }[] = [];
  let nullConsignor = 0, noPayment = 0, otherTotal = 0;

  for (const f of facts) {
    const sqlNet = f.net_settlement == null ? 0 : Number(f.net_settlement);
    const oracle = rollupSchedule(gross.get(f.schedule_id) ?? 0, linesBySchedule.get(f.schedule_id) ?? []);
    if (Math.abs(oracle.net - sqlNet) > TOL) { drift++; worstDrift.push({ sid: f.schedule_id, oracle: oracle.net, sql: sqlNet }); }

    if (f.consignor_id == null) nullConsignor++;
    otherTotal += f.deduction_other == null ? 0 : Number(f.deduction_other);

    if (f.paid_amount == null) { noPayment++; continue; }
    withPay++;
    const paid = Number(f.paid_amount);
    const diff = Math.abs(sqlNet - paid);
    if (diff <= 1) within1dollar++;
    if (diff <= Math.max(1, CASH_TOL_PCT * Math.abs(paid))) within1pct++;
    else worstCash.push({ sid: f.schedule_id, net: sqlNet, paid, diff });
  }

  // ── C/D. Grand totals + anchors ────────────────────────────────────────────
  const grand = (await client.query<{ gross: string; ded: string; gst: string; net: string; paid: string }>(
    `select sum(gross_sales) gross, sum(total_deductions) ded, sum(gst_total) gst,
            sum(net_settlement) net, sum(paid_amount) paid from core.fact_gp_settlement`,
  )).rows[0]!;
  const nsNet = (await client.query<{ net: string }>(`select sum(net_paid) net from core.fact_settlement_bill`)).rows[0]?.net;
  const pbi = await loadGrandFromReplica();

  const pass = drift === 0;

  // ── Report ──────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString();
  const rp = `reports/ft_gp_reconcile_${stamp.slice(0, 10)}.md`;
  const L: string[] = [];
  L.push(`# FreshTrack GP internal reconciliation — ${stamp}`, '');
  L.push(`Schedules: **${facts.length}** · with payment: **${withPay}** · drift tol: ${TOL} · cash tol: ${CASH_TOL_PCT * 100}%`, '');
  L.push('| Check | Result |', '|---|---|');
  L.push(`| A. TS oracle net == SQL fact net (drift guard) | ${drift === 0 ? 'PASS' : 'FAIL'} (${drift} drift) |`);
  L.push(`| B. fact net ≈ gp_payment (cash) | ${within1pct}/${withPay} within ${CASH_TOL_PCT * 100}% (${within1dollar} within $1) |`);
  L.push('');
  L.push('## Grand totals');
  L.push(`- gross_sales = **$${(+grand.gross).toLocaleString()}** · total_deductions = **$${(+grand.ded).toLocaleString()}** · gst = **$${(+grand.gst).toLocaleString()}**`);
  L.push(`- net_settlement = **$${(+grand.net).toLocaleString()}** · paid (gp_payment) = **$${(+grand.paid).toLocaleString()}**`);
  if (pbi) L.push(`- C. FreshTrack v_power_bi_charge_split net = **$${pbi.pbiNet.toLocaleString()}** (Δ vs hub net = $${(pbi.pbiNet - +grand.net).toFixed(2)})`);
  if (nsNet) L.push(`- D. NetSuite RCTI net_paid = **$${(+nsNet).toLocaleString()}** (Δ vs GP paid = $${(+grand.paid - +nsNet).toFixed(2)}, ${(100 * (+grand.paid - +nsNet) / +nsNet).toFixed(2)}%)`);
  L.push('');
  L.push('## Surfaced (not hidden)');
  L.push(`- OTHER-category deductions (signed): **$${otherTotal.toFixed(2)}**`);
  L.push(`- Schedules with null consignor (source has no grower; internal-only via RLS): **${nullConsignor}**`);
  L.push(`- Schedules with no gp_payment row (flagged, null paid_date — never zero-dated): **${noPayment}**`);
  L.push(`- Schedules outside cash tolerance (reconsignment-split residual; not replicated): **${worstCash.length}**`);
  if (worstCash.length) {
    L.push('', '### Largest cash variances (reconsignment residual)', '| schedule_id | fact net | gp_payment | diff |', '|---|---:|---:|---:|');
    for (const w of worstCash.sort((a, b) => b.diff - a.diff).slice(0, 15))
      L.push(`| ${w.sid.slice(0, 8)}… | ${w.net.toFixed(2)} | ${w.paid.toFixed(2)} | ${w.diff.toFixed(2)} |`);
  }
  if (worstDrift.length) {
    L.push('', '### ⚠ Oracle-vs-SQL drift (should be empty)', '| schedule_id | oracle | sql |', '|---|---:|---:|');
    for (const w of worstDrift.slice(0, 15)) L.push(`| ${w.sid.slice(0, 8)}… | ${w.oracle.toFixed(2)} | ${w.sql.toFixed(2)} |`);
  }
  L.push('');
  writeFileSync(rp, L.join('\n'), 'utf8');

  log(`A(drift)=${drift === 0 ? 'PASS' : `FAIL ${drift}`} · B(cash)=${within1pct}/${withPay} within ${CASH_TOL_PCT * 100}% · other=$${otherTotal.toFixed(2)} · null_consignor=${nullConsignor} · no_payment=${noPayment}`);
  if (pbi) log(`C(PBI grand net) hub=$${(+grand.net).toFixed(2)} freshtrack=$${pbi.pbiNet.toFixed(2)} Δ=$${(pbi.pbiNet - +grand.net).toFixed(2)}`);
  if (nsNet) log(`D(NetSuite net) GP_paid=$${(+grand.paid).toFixed(2)} ns=$${(+nsNet).toFixed(2)} Δ=${(100 * (+grand.paid - +nsNet) / +nsNet).toFixed(2)}%`);
  log(`→ ${rp}`);
  return { pass, reportPath: rp };
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const { pass } = await reconcile(client);
    if (!pass) process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
