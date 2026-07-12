// Insight-layer CORE builder → core.crosswalk_customer_retail + core.crosswalk_product_segment +
// core.fact_market_week.
//   npm run insight:core
//
// Idempotent: all three refresh functions DELETE + re-INSERT. ORDER MATTERS: the crosswalks first
// (the mart joins them), then the mart. Run AFTER refresh_dim_customer/refresh_dim_product
// (ft:ref:load → dims), scan:core (fact_retail_scan) and ft:bridge:core (fact_settlement_bridge).
// Prints the coverage / cell-count / share-range self-checks so a bad build is loud; the full
// derived-in-run proof battery is npm run insight:reconcile.
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export interface InsightCoreResult {
  crosswalk_customer_retail: number;
  crosswalk_product_segment: number;
  fact_market_week: number;
}

export async function buildInsightCore(): Promise<InsightCoreResult> {
  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c = await pool.connect();
    try {
      // headroom past the role default for the mart's temp-table build (0031 pattern)
      await c.query(`set statement_timeout = '600s'`);

      const cw1 = (await c.query<{ n: number }>('select core.refresh_crosswalk_customer_retail() as n')).rows[0]!.n;
      log(`  core.crosswalk_customer_retail rebuilt: ${cw1} rows`);
      const grp = (await c.query<{ retailer_group: string; n: string }>(
        `select retailer_group, count(*)::text n from core.crosswalk_customer_retail
          group by 1 order by 2 desc`)).rows;
      log('    by retailer_group: ' + grp.map((r) => `${r.retailer_group}=${r.n}`).join(' '));

      const cw2 = (await c.query<{ n: number }>('select core.refresh_crosswalk_product_segment() as n')).rows[0]!.n;
      log(`  core.crosswalk_product_segment rebuilt: ${cw2} rows`);
      const seg = (await c.query<{ segment: string; n: string }>(
        `select segment, count(*)::text n from core.crosswalk_product_segment
          group by 1 order by 2 desc`)).rows;
      log('    by segment: ' + seg.map((r) => `${r.segment}=${r.n}`).join(' '));

      // coverage self-checks (the ≥95% ACs, derived here for loudness; insight:reconcile is the proof)
      const cov = (await c.query<{ retail_pct: string; banana_pct: string }>(
        `select
           round(100.0 * sum(p.box_count) filter (where cw.retailer_group in ('coles','woolworths','aldi')
                                                    and cw.method not like 'unmapped%')
                 / nullif(sum(p.box_count) filter (where dc.name ~* '^(coles|woolworths|wow |aldi)'), 0), 2)::text as retail_pct,
           (select round(100.0 * count(*) filter (where ps.segment in ('REGULAR','PRE_PACK','LADY_FINGER','OTHER'))
                   / nullif(count(*), 0), 2)::text
              from raw.ft_pallet pp
              join core.dim_product dpp on dpp.product_id = pp.product_id
              left join core.crosswalk_product_segment ps on ps.product_id = pp.product_id
             where dpp.crop_name = 'Banana') as banana_pct
         from raw.ft_pallet p
         join raw.ft_dispatch_load dl on dl.id = p.dispatch_load_id
         left join core.dim_customer dc on dc.consignee_id = dl.consignee_id
         left join core.crosswalk_customer_retail cw on cw.consignee_id = dl.consignee_id`)).rows[0]!;
      log(`    coverage: retail dispatch volume mapped=${cov.retail_pct}% · banana pallets in-scope segment=${cov.banana_pct}%`);

      const mart = (await c.query<{ n: number }>('select core.refresh_fact_market_week() as n')).rows[0]!.n;
      log(`  core.fact_market_week rebuilt: ${mart} cells`);
      const shape = (await c.query<{ weeks: string; coles_scan: string; supply_only: string }>(
        `select count(distinct week_ending)::text weeks,
                count(*) filter (where retailer_group='coles' and scan_volume_kg is not null)::text coles_scan,
                count(*) filter (where retailer_group in ('woolworths','aldi'))::text supply_only
           from core.fact_market_week`)).rows[0]!;
      log(`    weeks=${shape.weeks} coles-cells-with-scan=${shape.coles_scan} woolworths/aldi supply-only=${shape.supply_only}`);
      const share = (await c.query<{ mn: string; mx: string; cells: string }>(
        `select round(min(our_kg / scan_volume_kg), 3)::text mn,
                round(max(our_kg / scan_volume_kg), 3)::text mx,
                count(*)::text cells
           from core.fact_market_week
          where retailer_group = 'coles' and state_code = 'AU'
            and our_kg is not null and scan_volume_kg is not null and scan_volume_kg <> 0`)).rows[0]!;
      log(`    national (AU) coles share range: ${share.mn}..${share.mx} over ${share.cells} cells`);

      return { crosswalk_customer_retail: cw1, crosswalk_product_segment: cw2, fact_market_week: mart };
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const r = await buildInsightCore();
  log(`done: crosswalk_customer_retail=${r.crosswalk_customer_retail} crosswalk_product_segment=${r.crosswalk_product_segment} fact_market_week=${r.fact_market_week}`);
}
