// ─────────────────────────────────────────────────────────────────────────────
// Insight-layer reconciliation — SQL is the oracle; every expectation DERIVED in-run (house
// contract: no hardcoded baselines).
//   npm run insight:reconcile
//   1. Crosswalk completeness: every dim_customer / dim_product row carries a crosswalk row;
//      unmapped rows surfaced (never dropped).
//   2. Coverage ACs (independent denominators): ≥95% of Coles/WOW/ALDI dispatch volume mapped to a
//      retail group (denominator = an independent name-regex over pallet boxes, NOT the crosswalk);
//      ≥95% of that retail volume state-mapped; ≥95% of banana pallets (crop via dim_product) in an
//      in-scope scan segment.
//   3. Mart scan-side parity: fact_market_week scan columns == fact_retail_scan sums under the same
//      filters (causal total, own-brand, weekly) — independent formulation, exact.
//   4. Mart supply-side parity: fact_market_week our_* == an independently-written
//      bridge × crosswalk × scan-week aggregation — at AU×ALL grain per retailer AND at the
//      state×segment grain. Farm-gate parity likewise at AU×ALL.
//   5. Share sanity (bounds derived from the live physics, probed 2026-07-12 — the checks exist to
//      catch UNIT/DOUBLE-COUNT errors, which present as ≥2×, not to legislate market structure):
//      · weekly STATE-level share breaches 1.0 on stock timing (DC receipts lead till sales;
//        VIC REGULAR peaks 1.11, TAS PRE_PACK 1.48 on a tiny cell), and
//      · PRE_PACK pooled state shares sit at 1.01–1.06 — Mackays is effectively the SOLE Coles
//        pre-pack supplier in VIC/TAS/SA and our carton kg (e.g. Coles Bands 10.5 kg) differs
//        slightly from Circana's per-pack kg definition (a ~5% wedge, systematic, surfaced).
//      Hard bounds: H1 every coles AU (national) cell share in (0, 1.05] (the decision-grade
//      grain — strict); H2 every coles (state, segment) POOLED share (Σkg/Σkg, the stable
//      estimator) in (0, 1.10]; H3 no single weekly cell > 2.0 (absurdity = unit error).
//      Weekly cells > 1.05 and pooled groups in (1.05, 1.10] are surfaced with the explanation.
//   6. Ladder: populated (farm+wholesale+till all non-null) on the MAJORITY of coles REGULAR ×
//      VIC/QLD cells (hard, the SPRINT AC); rung ordering farm ≤ wholesale ≤ till informational
//      (agency construction puts farm ≈ wholesale by design).
//   7. RLS behavioral: internal>0; real grower / no-claim / forged top-level / forged
//      user_metadata all → 0 on the mart, both crosswalks and all 4 semantic views.
//   Writes reports/insight_reconcile_<date>.md. Exit 0 = all hard checks pass.
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
function info(line: string): void { console.log(line); report.push(line); }
function show(rows: Record<string, unknown>[]): void {
  if (!rows.length) { info('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  info('  ' + cols.join(' | '));
  for (const r of rows) info('  ' + cols.map((c) => String(r[c] ?? '∅')).join(' | '));
}
const claims = (o: object) => JSON.stringify({ role: 'authenticated', ...o });
// inTxn: a validation harness may drive runInsightChecks inside an open transaction (savepoints
// instead of begin/rollback so the probe cannot end the caller's txn). Normal runs: inTxn=false.
async function rlsCount(c: PoolClient, rel: string, claimsJson: string, inTxn: boolean): Promise<number> {
  await c.query(inTxn ? 'savepoint rls_probe' : 'begin');
  try {
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [claimsJson]);
    return Number((await c.query(`select count(*) n from ${rel}`)).rows[0]!.n);
  } finally { await c.query(inTxn ? 'rollback to savepoint rls_probe' : 'rollback'); }
}

// the mart's supply/farm-gate derivation, WRITTEN INDEPENDENTLY of the refresh function (same
// contract, different SQL) — the parity oracle for section 4
const SUPPLY_INDEP = `
  select cw.retailer_group,
         case cw.state_code when 'NSW' then 'NSW+ACT' when 'SA' then 'SA+NT' when 'NT' then 'SA+NT'
              else cw.state_code end as state_code,
         ps.segment, w.week_ending,
         b.box_quantity as boxes, b.box_quantity * ps.kg_per_box as kg, b.sell_value as sell
  from core.fact_settlement_bridge b
  join raw.ft_dispatch_load dl on dl.id = b.dispatch_load_id
  join core.crosswalk_customer_retail cw on cw.consignee_id = b.consignee_id
  join core.crosswalk_product_segment ps on ps.product_id = b.product_id
  join (select distinct week_ending from core.fact_retail_scan) w
    on (dl.scheduled_pickup_on at time zone 'UTC')::date between w.week_ending - 6 and w.week_ending
  where cw.retailer_group in ('coles','woolworths','aldi')
    and ps.segment in ('REGULAR','PRE_PACK','LADY_FINGER','OTHER')`;

const FARM_INDEP = `
  select cw.retailer_group,
         case cw.state_code when 'NSW' then 'NSW+ACT' when 'SA' then 'SA+NT' when 'NT' then 'SA+NT'
              else cw.state_code end as state_code,
         ps.segment, w.week_ending,
         d.box_quantity * d.price_invoiced_value as fg_dollars,
         d.box_quantity * ps.kg_per_box as fg_kg
  from raw.ft_gp_detail d
  left join raw.ft_dispatch_load dl on dl.id = d.dispatch_load_id
  join core.crosswalk_customer_retail cw on cw.consignee_id = d.consignee_id
  join core.crosswalk_product_segment ps on ps.product_id = d.product_id
  join (select distinct week_ending from core.fact_retail_scan) w
    on coalesce(d.pack_date, (dl.scheduled_pickup_on at time zone 'UTC')::date)
       between w.week_ending - 6 and w.week_ending
  where cw.retailer_group in ('coles','woolworths','aldi')
    and ps.segment in ('REGULAR','PRE_PACK','LADY_FINGER','OTHER')
    and d.price_invoiced_value is not null`;

export interface InsightCheckOpts {
  /** caller already holds an open transaction (validation harness) — use savepoints, skip SET */
  inTxn?: boolean;
  /** where the markdown report lands (default 'reports') */
  reportDir?: string;
}

/** All checks against an existing client. Returns true when every hard check passed.
 *  Exported (the rls_posture.ts sweep() precedent) so a harness can validate the battery
 *  against in-transaction objects; npm run insight:reconcile drives it standalone. */
export async function runInsightChecks(c: PoolClient, opts: InsightCheckOpts = {}): Promise<boolean> {
  const inTxn = opts.inTxn ?? false;
  results.length = 0;
  report.length = 0;
  console.log('=== Insight-layer reconciliation (expectations derived in-run) ===');
  report.push('# Insight-layer reconciliation — ' + new Date().toISOString().slice(0, 10), '');
  {
    await c.query(`set ${inTxn ? 'local ' : ''}statement_timeout = '600s'`);

    // ── 1. crosswalk completeness ────────────────────────────────────────────
    console.log('\n--- 1. Crosswalk completeness ---');
    const comp = (await c.query(
      `select (select count(*) from core.dim_customer)::text dim_cust,
              (select count(*) from core.crosswalk_customer_retail)::text cw_cust,
              (select count(*) from core.dim_customer dc
                where not exists (select 1 from core.crosswalk_customer_retail x
                                   where x.consignee_id = dc.consignee_id))::text cust_missing,
              (select count(*) from core.dim_product)::text dim_prod,
              (select count(*) from core.crosswalk_product_segment)::text cw_prod,
              (select count(*) from core.dim_product dp
                where not exists (select 1 from core.crosswalk_product_segment x
                                   where x.product_id = dp.product_id))::text prod_missing,
              (select count(*) from core.crosswalk_customer_retail where method like 'unmapped%')::text cust_unmapped,
              (select count(*) from core.crosswalk_product_segment where method = 'unmapped')::text prod_unmapped`)).rows[0]!;
    show([comp]);
    check('every dim_customer row has a crosswalk row', comp.cust_missing === '0',
      `dim=${comp.dim_cust} crosswalk=${comp.cw_cust} missing=${comp.cust_missing} (unmapped surfaced: ${comp.cust_unmapped})`);
    check('every dim_product row has a crosswalk row', comp.prod_missing === '0',
      `dim=${comp.dim_prod} crosswalk=${comp.cw_prod} missing=${comp.prod_missing} (unmapped surfaced: ${comp.prod_unmapped})`);

    // ── 2. coverage ACs (independent denominators) ───────────────────────────
    console.log('\n--- 2. Coverage (≥95% ACs, independent denominators) ---');
    const cov = (await c.query(
      `select
         round(100.0 * sum(p.box_count) filter (where cw.retailer_group in ('coles','woolworths','aldi')
                                                  and cw.method not like 'unmapped%')
               / nullif(sum(p.box_count) filter (where dc.name ~* '^(coles|woolworths|wow |aldi)'), 0), 2) as retail_mapped_pct,
         round(100.0 * sum(p.box_count) filter (where cw.retailer_group in ('coles','woolworths','aldi')
                                                  and cw.state_code is not null)
               / nullif(sum(p.box_count) filter (where cw.retailer_group in ('coles','woolworths','aldi')), 0), 2) as retail_state_pct
       from raw.ft_pallet p
       join raw.ft_dispatch_load dl on dl.id = p.dispatch_load_id
       left join core.dim_customer dc on dc.consignee_id = dl.consignee_id
       left join core.crosswalk_customer_retail cw on cw.consignee_id = dl.consignee_id`)).rows[0]!;
    const banana = (await c.query(
      `select count(*)::text pallets,
              round(100.0 * count(*) filter (where ps.segment in ('REGULAR','PRE_PACK','LADY_FINGER','OTHER'))
                    / nullif(count(*), 0), 2) as seg_pct,
              count(*) filter (where ps.segment = 'OUT_OF_SCOPE')::text out_of_scope
       from raw.ft_pallet p
       join core.dim_product dp on dp.product_id = p.product_id
       left join core.crosswalk_product_segment ps on ps.product_id = p.product_id
       where dp.crop_name = 'Banana'`)).rows[0]!;
    show([{ ...cov, ...banana }]);
    check('≥95% of Coles/WOW/ALDI dispatch volume mapped (independent name-regex denominator)',
      Number(cov.retail_mapped_pct) >= 95, `${cov.retail_mapped_pct}%`);
    check('≥95% of mapped retail volume carries a state', Number(cov.retail_state_pct) >= 95,
      `${cov.retail_state_pct}%`);
    check('≥95% of banana pallets map to an in-scope segment', Number(banana.seg_pct) >= 95,
      `${banana.seg_pct}% of ${banana.pallets} (OUT_OF_SCOPE bins/value-added: ${banana.out_of_scope} — correct, surfaced)`);
    info('\n  unmapped / other-bucket consignees with retail-looking volume (expect none):');
    show((await c.query(
      `select dc.name, cw.retailer_group, cw.method, count(p.id)::text pallets
         from raw.ft_pallet p
         join raw.ft_dispatch_load dl on dl.id = p.dispatch_load_id
         join core.dim_customer dc on dc.consignee_id = dl.consignee_id
         join core.crosswalk_customer_retail cw on cw.consignee_id = dl.consignee_id
        where dc.name ~* '^(coles|woolworths|wow |aldi)'
          and (cw.retailer_group not in ('coles','woolworths','aldi') or cw.method like 'unmapped%')
        group by 1,2,3 order by 4 desc limit 10`)).rows);

    // ── 3. mart scan-side parity (independent formulation) ───────────────────
    console.log('\n--- 3. Mart scan-side parity ---');
    const sp = (await c.query(
      `select
         (select count(*) from core.fact_retail_scan where causal='total' and supplier is null
            and (units is not null or dollars is not null or volume_kg is not null
              or price_per_volume is not null or base_dollars is not null or incr_dollars is not null
              or volume_kg_ya is not null or dollars_ya is not null))::text src_rows,
         (select count(*) from core.fact_market_week where scan_units is not null or scan_dollars is not null
             or scan_volume_kg is not null or scan_till_price_kg is not null or scan_base_dollars is not null
             or scan_incr_dollars is not null or scan_volume_kg_ya is not null or scan_dollars_ya is not null)::text mart_rows,
         (select round(coalesce(sum(dollars),0),2) from core.fact_retail_scan where causal='total' and supplier is null)::text src_dollars,
         (select round(coalesce(sum(scan_dollars),0),2) from core.fact_market_week)::text mart_dollars,
         (select round(coalesce(sum(volume_kg),0),2) from core.fact_retail_scan where causal='total' and supplier is null)::text src_kg,
         (select round(coalesce(sum(scan_volume_kg),0),2) from core.fact_market_week)::text mart_kg,
         (select round(coalesce(sum(units),0),2) from core.fact_retail_scan where causal='total' and supplier is null)::text src_units,
         (select round(coalesce(sum(scan_units),0),2) from core.fact_market_week)::text mart_units`)).rows[0]!;
    show([sp]);
    check('mart scan cells == fact_retail_scan rows (causal total, own-brand)', sp.src_rows === sp.mart_rows,
      `src=${sp.src_rows} mart=${sp.mart_rows}`);
    check('scan-side sums identical (dollars/kg/units)',
      sp.src_dollars === sp.mart_dollars && sp.src_kg === sp.mart_kg && sp.src_units === sp.mart_units,
      `$ ${sp.src_dollars}==${sp.mart_dollars} · kg ${sp.src_kg}==${sp.mart_kg} · units ${sp.src_units}==${sp.mart_units}`);

    // ── 4. supply + farm-gate parity (independent derivation) ────────────────
    console.log('\n--- 4. Supply-side + farm-gate parity ---');
    const sup = (await c.query(
      `with indep as (${SUPPLY_INDEP})
       select r as retailer_group,
              (select round(coalesce(sum(boxes),0),2) from indep i where i.retailer_group = r)::text i_boxes,
              (select round(coalesce(sum(our_boxes),0),2) from core.fact_market_week m
                where m.retailer_group = r and m.state_code='AU' and m.segment='ALL')::text m_boxes,
              (select round(coalesce(sum(kg),0),2) from indep i where i.retailer_group = r)::text i_kg,
              (select round(coalesce(sum(our_kg),0),2) from core.fact_market_week m
                where m.retailer_group = r and m.state_code='AU' and m.segment='ALL')::text m_kg,
              (select round(coalesce(sum(sell),0),2) from indep i where i.retailer_group = r)::text i_sell,
              (select round(coalesce(sum(our_sell_dollars),0),2) from core.fact_market_week m
                where m.retailer_group = r and m.state_code='AU' and m.segment='ALL')::text m_sell
       from unnest(array['coles','woolworths','aldi']) as t(r)`)).rows;
    show(sup);
    check('supply parity at AU×ALL per retailer (boxes/kg/sell$)',
      sup.every((r) => r.i_boxes === r.m_boxes && r.i_kg === r.m_kg && r.i_sell === r.m_sell),
      sup.map((r) => `${r.retailer_group}: ${r.i_boxes}==${r.m_boxes}`).join(' · '));
    const supState = (await c.query(
      `with indep as (${SUPPLY_INDEP})
       select (select round(coalesce(sum(boxes),0),2) from indep where state_code is not null)::text i_boxes,
              (select round(coalesce(sum(our_boxes),0),2) from core.fact_market_week
                where state_code <> 'AU' and segment <> 'ALL')::text m_boxes,
              (select round(coalesce(sum(kg),0),2) from indep where state_code is not null)::text i_kg,
              (select round(coalesce(sum(our_kg),0),2) from core.fact_market_week
                where state_code <> 'AU' and segment <> 'ALL')::text m_kg,
              (select count(*) from (select distinct state_code, segment, week_ending, retailer_group
                                       from indep where state_code is not null and boxes is not null) x)::text i_cells,
              (select count(*) from core.fact_market_week
                where state_code <> 'AU' and segment <> 'ALL' and our_boxes is not null)::text m_cells`)).rows[0]!;
    show([supState]);
    check('supply parity at state×segment grain (boxes/kg + cell count)',
      supState.i_boxes === supState.m_boxes && supState.i_kg === supState.m_kg
        && supState.i_cells === supState.m_cells,
      `boxes ${supState.i_boxes}==${supState.m_boxes} · kg ${supState.i_kg}==${supState.m_kg} · cells ${supState.i_cells}==${supState.m_cells}`);
    const farm = (await c.query(
      `with indep as (${FARM_INDEP})
       select (select round(coalesce(sum(fg_dollars),0),2) from indep)::text i_fg,
              (select round(coalesce(sum(farmgate_dollars),0),2) from core.fact_market_week
                where state_code='AU' and segment='ALL')::text m_fg,
              (select round(coalesce(sum(fg_kg),0),2) from indep)::text i_kg,
              (select round(coalesce(sum(farmgate_kg),0),2) from core.fact_market_week
                where state_code='AU' and segment='ALL')::text m_kg`)).rows[0]!;
    show([farm]);
    check('farm-gate parity at AU×ALL ($ / kg)', farm.i_fg === farm.m_fg && farm.i_kg === farm.m_kg,
      `$ ${farm.i_fg}==${farm.m_fg} · kg ${farm.i_kg}==${farm.m_kg}`);

    // ── 5. share sanity (see header for the framing) ─────────────────────────
    console.log('\n--- 5. Share sanity (coles cells with scan) ---');
    const sh = (await c.query(
      `with cells as (
         select state_code, segment, week_ending, our_kg, scan_volume_kg,
                our_kg / scan_volume_kg as share
           from core.fact_market_week
          where retailer_group = 'coles' and our_kg is not null
            and scan_volume_kg is not null and scan_volume_kg <> 0)
       select
         (select count(*) from cells)::text cells,
         (select count(*) from cells where state_code = 'AU' and (share <= 0 or share > 1.05))::text au_bad,
         (select count(*) from cells where share > 2.0)::text absurd,
         (select count(*) from (select state_code, segment, sum(our_kg) / sum(scan_volume_kg) a
                                  from cells where state_code <> 'AU' group by 1, 2) g
           where g.a <= 0 or g.a > 1.10)::text pooled_bad,
         (select count(*) from cells where state_code <> 'AU' and share > 1.05)::text weekly_over,
         (select count(*) from cells where share <= 0)::text nonpos,
         (select round(min(share), 3) from cells)::text mn,
         (select round(max(share), 3) from cells)::text mx`)).rows[0]!;
    show([sh]);
    check('H1: every coles AU (national) cell share in (0, 1.05]', sh.au_bad === '0',
      `violations=${sh.au_bad} of ${sh.cells} cells (overall range ${sh.mn}..${sh.mx})`);
    check('H2: every coles (state, segment) POOLED share in (0, 1.10]', sh.pooled_bad === '0',
      `violating cell-groups=${sh.pooled_bad}`);
    check('H3: no weekly cell share > 2.0 (unit-error ceiling)', sh.absurd === '0', `violations=${sh.absurd}`);
    info(`  weekly state cells > 1.05 (stock timing — DC receipts lead till sales): ${sh.weekly_over}`);
    info(`  weekly cells with non-positive share (net-adjustment weeks, surfaced): ${sh.nonpos}`);
    info('  pooled state groups in (1.05, 1.10] (sole-supplier + carton-vs-pack kg wedge):');
    show((await c.query(
      `select state_code, segment, count(*)::text weeks,
              round(sum(our_kg) / sum(scan_volume_kg), 3)::text pooled_share
         from core.fact_market_week
        where retailer_group='coles' and state_code <> 'AU'
          and our_kg is not null and scan_volume_kg is not null and scan_volume_kg <> 0
        group by 1, 2
       having sum(our_kg) / sum(scan_volume_kg) > 1.05
        order by 4 desc`)).rows);
    info('  top weekly outliers (> 1.05):');
    show((await c.query(
      `select state_code, segment, week_ending::text, round(our_kg / scan_volume_kg, 3)::text share
         from core.fact_market_week
        where retailer_group='coles' and state_code <> 'AU'
          and our_kg is not null and scan_volume_kg is not null and scan_volume_kg <> 0
          and our_kg / scan_volume_kg > 1.05
        order by our_kg / scan_volume_kg desc limit 5`)).rows);

    // ── 6. price ladder ──────────────────────────────────────────────────────
    console.log('\n--- 6. Price ladder (populated = hard; ordering = informational) ---');
    const lad = (await c.query(
      `with cells as (
         select state_code, week_ending,
                farmgate_dollars / nullif(farmgate_kg, 0)   as farm,
                our_sell_dollars / nullif(our_kg, 0)        as wholesale,
                scan_till_price_kg                          as till
           from core.fact_market_week
          where retailer_group = 'coles' and segment = 'REGULAR' and state_code in ('VIC', 'QLD'))
       select count(*)::text cells,
              count(*) filter (where farm is not null and wholesale is not null and till is not null)::text full_ladder,
              round(100.0 * count(*) filter (where farm is not null and wholesale is not null and till is not null)
                    / nullif(count(*), 0), 1)::text pct
       from cells`)).rows[0]!;
    show([lad]);
    check('ladder populated on the majority of coles REGULAR × VIC/QLD cells (SPRINT AC)',
      Number(lad.pct) > 50, `${lad.full_ladder}/${lad.cells} = ${lad.pct}%`);
    const ord = (await c.query(
      `with cells as (
         select farmgate_dollars / nullif(farmgate_kg, 0) as farm,
                our_sell_dollars / nullif(our_kg, 0)      as wholesale,
                scan_till_price_kg                        as till
           from core.fact_market_week
          where retailer_group = 'coles'
            and farmgate_dollars is not null and farmgate_kg is not null and farmgate_kg <> 0
            and our_sell_dollars is not null and our_kg is not null and our_kg <> 0
            and scan_till_price_kg is not null)
       select count(*)::text cells,
              count(*) filter (where farm <= wholesale + 0.005)::text farm_le_wholesale,
              count(*) filter (where wholesale <= till + 0.005)::text wholesale_le_till,
              round(avg(farm), 3)::text avg_farm, round(avg(wholesale), 3)::text avg_wholesale,
              round(avg(till), 3)::text avg_till
       from cells`)).rows[0]!;
    info('  ordering (informational — farm ≈ wholesale by agency construction):');
    show([ord]);

    // ── 7. RLS behavioral ────────────────────────────────────────────────────
    console.log('\n--- 7. RLS (internal-only, fail-closed) ---');
    const grower = (await c.query<{ id: string }>(
      `select consignor_id::text id from core.dim_grower
        where consignor_id is not null and coalesce(is_test,false)=false limit 1`)).rows[0]!.id;
    for (const rel of [
      'core.fact_market_week', 'core.crosswalk_customer_retail', 'core.crosswalk_product_segment',
      'semantic.market_week', 'semantic.customer_margin', 'semantic.grower_scorecard',
      'semantic.retail_supplier_share',
    ]) {
      const internal = await rlsCount(c, rel, claims({ app_metadata: { is_internal: true } }), inTxn);
      const g = await rlsCount(c, rel, claims({ app_metadata: { consignor_id: grower } }), inTxn);
      const none = await rlsCount(c, rel, claims({}), inTxn);
      const forged = await rlsCount(c, rel, claims({ is_internal: true }), inTxn);
      const forgedUm = await rlsCount(c, rel, claims({ user_metadata: { is_internal: true } }), inTxn);
      check(`[${rel}] internal>0; grower/no-claim/forged/user_meta = 0`,
        internal > 0 && g === 0 && none === 0 && forged === 0 && forgedUm === 0,
        `internal=${internal} grower=${g} none=${none} forged=${forged} user_meta=${forgedUm}`);
    }

    const dir = opts.reportDir ?? 'reports';
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/insight_reconcile_${new Date().toISOString().slice(0, 10)}.md`;
    writeFileSync(path, report.join('\n'), 'utf8');
    console.log(`\n→ ${path}`);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join('; '));
    return failed.length === 0;
  }
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const pass = await runInsightChecks(client);
    if (!pass) process.exitCode = 1;
  } catch (e) {
    console.error('insight:reconcile error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
