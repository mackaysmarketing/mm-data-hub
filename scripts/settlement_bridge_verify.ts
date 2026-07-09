// ─────────────────────────────────────────────────────────────────────────────
// Settlement-bridge verification — the SPRINT acceptance proofs, SQL as the oracle.
//   npm run ft:bridge:verify
//
//   1. Row-count parity: bridge rows == raw.ft_gp_detail rows whose (schedule, load) is settled.
//   2. No settlement double-count: every (schedule, load) group and every LOAD (summed across
//      schedules) reconciles exactly to core.fact_gp_settlement_load; the charge-only groups
//      (detail_line_count = 0 — unrepresentable at detail grain) are surfaced, not hidden.
//   3. No revenue over-allocation: per order, Σ sell_value ≤ dim_order.derived_price_value + $1.
//   4. Tier breakdown — product_exact must carry ≥ 80% of gross.
//   5. Variance distribution: median, p95, ±1% share, top-10 |variance|.
//   6. Revenue status: mackays_revenue NULL until the checkpoint; ripening raw anchor printed.
//
// Exit 0 = all hard checks pass; 1 = any fail. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '∅').length)));
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i]!)).join('  '));
  for (const r of rows) console.log('  ' + cols.map((c, i) => String(r[c] ?? '∅').padEnd(w[i]!)).join('  '));
}

async function main(): Promise<void> {
  console.log('=== Settlement-bridge verification (SQL is the oracle) ===');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    // ── 1. Row-count parity ──────────────────────────────────────────────────
    console.log('\n--- 1. Row-count parity (AC1) ---');
    const parity = (await c.query(
      `select
         (select count(*) from raw.ft_gp_detail d
           where exists (select 1 from core.fact_gp_settlement_load f
                         where f.schedule_id = d.gp_schedule_id
                           and f.dispatch_load_id = d.dispatch_load_id))::text as settled_gp_detail,
         (select count(*) from raw.ft_gp_detail)::text as gp_detail_total,
         (select count(*) from core.fact_settlement_bridge)::text as bridge_rows`)).rows[0]!;
    table([parity]);
    check('bridge rows == settled gp_detail rows', parity.settled_gp_detail === parity.bridge_rows,
      `settled=${parity.settled_gp_detail} bridge=${parity.bridge_rows} (gp_detail total=${parity.gp_detail_total})`);

    // ── 2. No settlement double-count ────────────────────────────────────────
    console.log('\n--- 2. Settlement reconciliation vs fact_gp_settlement_load (AC2) ---');
    // (a) exact per (schedule, load) group — gross + every deduction class + GST
    const grp = (await c.query(
      `with b as (
         select schedule_id, dispatch_load_id,
                round(sum(grower_gross), 2) as g,
                sum(deduction_freight) fr, sum(deduction_warehouse) wh, sum(deduction_market) md,
                sum(deduction_larapinta) la, sum(deduction_misc) mi, sum(deduction_other) oth,
                sum(total_deductions) ded, sum(gst_total) gst
         from core.fact_settlement_bridge group by 1, 2)
       select count(*)::text as bridge_groups,
              count(*) filter (where abs(coalesce(b.g,0) - f.gross_sales) > 0.005
                or abs(b.fr - f.deduction_freight) > 0.005 or abs(b.wh - f.deduction_warehouse) > 0.005
                or abs(b.md - f.deduction_market)  > 0.005 or abs(b.la - f.deduction_larapinta) > 0.005
                or abs(b.mi - f.deduction_misc)    > 0.005 or abs(b.oth - f.deduction_other)    > 0.005
                or abs(b.ded - f.total_deductions) > 0.005 or abs(b.gst - f.gst_total) > 0.005)::text as mismatched
       from b join core.fact_gp_settlement_load f
         on f.schedule_id = b.schedule_id and f.dispatch_load_id = b.dispatch_load_id`)).rows[0]!;
    check('(schedule, load) groups reconcile exactly', grp.mismatched === '0',
      `groups=${grp.bridge_groups} mismatched=${grp.mismatched}`);

    // (b) per LOAD summed across schedules, vs the load fact restricted to detail-bearing groups
    const perLoad = (await c.query(
      `with b as (
         select dispatch_load_id, round(sum(grower_gross), 2) g, sum(total_deductions) ded, sum(gst_total) gst
         from core.fact_settlement_bridge group by 1),
       f as (
         select dispatch_load_id, sum(gross_sales) g, sum(total_deductions) ded, sum(gst_total) gst
         from core.fact_gp_settlement_load where detail_line_count > 0 group by 1)
       select count(*)::text as loads,
              count(*) filter (where b.dispatch_load_id is null or f.dispatch_load_id is null
                or abs(coalesce(b.g,0) - f.g) > 0.01 or abs(b.ded - f.ded) > 0.01
                or abs(b.gst - f.gst) > 0.01)::text as mismatched
       from b full join f using (dispatch_load_id)`)).rows[0]!;
    check('per-load totals (summed across schedules) reconcile', perLoad.mismatched === '0',
      `loads=${perLoad.loads} mismatched=${perLoad.mismatched}`);

    // (c) surface the charge-only groups the detail grain cannot carry
    const chargeOnly = (await c.query(
      `select count(*)::text as charge_only_groups,
              count(distinct dispatch_load_id)::text as loads,
              round(sum(total_deductions), 2)::text as total_deductions,
              round(sum(gst_total), 2)::text as gst_total
       from core.fact_gp_settlement_load where detail_line_count = 0`)).rows[0]!;
    console.log('  charge-only (schedule, load) groups — no detail rows exist, excluded by grain, surfaced:');
    table([chargeOnly]);

    // ── 3. No revenue over-allocation ────────────────────────────────────────
    console.log('\n--- 3. Per-order over-allocation guard (AC3) ---');
    const over = (await c.query(
      `with s as (select order_id, round(sum(sell_value), 2) as sell
                    from core.fact_settlement_bridge where order_id is not null group by 1)
       select count(*)::text as orders_with_sell,
              count(*) filter (where s.sell > o.derived_price_value + 1)::text as violating,
              count(*) filter (where o.order_id is null)::text as orders_missing_dim
       from s left join core.dim_order o on o.order_id = s.order_id`)).rows[0]!;
    check('orders with Σ sell_value > derived_price_value + $1', over.violating === '0',
      `orders=${over.orders_with_sell} violating=${over.violating} missing_dim=${over.orders_missing_dim}`);

    // ── 4. Tier breakdown ────────────────────────────────────────────────────
    console.log('\n--- 4. Match-tier breakdown (AC4) ---');
    const tiers = (await c.query(
      `select match_tier, count(*)::text as rows,
              count(*) filter (where sell_value is not null)::text as rows_with_sell,
              round(sum(grower_gross), 2)::text as grower_gross,
              round(100 * sum(grower_gross) / nullif((select sum(grower_gross) from core.fact_settlement_bridge), 0), 2)::text as gross_pct,
              round(sum(sell_value), 2)::text as sell_value
       from core.fact_settlement_bridge group by match_tier order by sum(grower_gross) desc nulls last`)).rows;
    table(tiers);
    const pe = tiers.find((t) => t.match_tier === 'product_exact');
    check('product_exact carries ≥ 80% of gross', pe != null && Number(pe.gross_pct) >= 80,
      `product_exact gross share=${pe?.gross_pct}%`);

    // ── 5. Variance distribution ─────────────────────────────────────────────
    console.log('\n--- 5. Variance distribution (product_exact rows with sell + gross) ---');
    const vd = (await c.query(
      `select count(*)::text as rows,
              round(percentile_cont(0.5) within group (order by variance)::numeric, 2)::text as median_variance,
              round(percentile_cont(0.95) within group (order by abs(variance))::numeric, 2)::text as p95_abs_variance,
              round(sum(variance), 2)::text as total_variance,
              round(100.0 * count(*) filter (where grower_gross <> 0 and abs(variance) <= 0.01 * abs(grower_gross))
                    / nullif(count(*) filter (where grower_gross <> 0), 0), 2)::text as pct_within_1pct
       from core.fact_settlement_bridge
       where match_tier = 'product_exact' and variance is not null`)).rows[0]!;
    table([vd]);
    console.log('  top 10 |variance| (product_exact):');
    const top = (await c.query(
      `select load_no, order_id::text as order_id, product_id::text as product_id, grower_code,
              box_quantity::text as boxes, round(sell_value, 2)::text as sell_value,
              round(grower_gross, 2)::text as grower_gross, variance::text as variance
       from core.fact_settlement_bridge
       where variance is not null
       order by abs(variance) desc limit 10`)).rows;
    table(top);
    check('variance distribution computed', Number(vd.rows) > 0, `rows=${vd.rows} median=${vd.median_variance} p95(|v|)=${vd.p95_abs_variance}`);

    // ── 6. Revenue status (checkpoint-gated) ─────────────────────────────────
    console.log('\n--- 6. Mackays revenue status (checkpoint-gated) ---');
    const rev = (await c.query(
      `select (select count(*) from core.dim_gp_charge where revenue_class is not null)::text as charges_marked,
              (select count(*) from core.fact_settlement_bridge where mackays_revenue is not null)::text as bridge_rows_with_revenue,
              (select count(*) from core.fact_revenue_charge)::text as revenue_charge_rows,
              (select round(sum(ca.total_amount_value), 2)
                 from raw.ft_charge_applied ca
                 join core.dim_gp_charge dgc on dgc.charge_id = ca.charge_id
                where ca.gp_schedule_id is not null and ca.is_deductible
                  and dgc.ct_scope = 'WH - Ripening')::text as ripening_ct_scope_raw_sum`)).rows[0]!;
    table([rev]);
    console.log('  (mackays_revenue stays NULL and fact_revenue_charge stays empty until Tim marks revenue_class — never guessed)');

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('verify error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
