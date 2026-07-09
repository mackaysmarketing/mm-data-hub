// Settlement-bridge CORE builder → core.fact_settlement_bridge + core.fact_revenue_charge.
//   npm run ft:bridge:core
//
// Idempotent: both refresh functions DELETE + re-INSERT. Run AFTER ft:gp:core (fact_gp_settlement_load)
// and ft:order:core (fact_order_item) — the bridge reads both. Prints the coverage + no-double-count
// self-checks so a bad build is loud. fact_revenue_charge stays at 0 rows until
// core.dim_gp_charge.revenue_class is marked (the SPRINT checkpoint — never guessed).
// Writes via DATABASE_URL (assertHubTarget guards the target).
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export interface BridgeCoreResult { fact_settlement_bridge: number; fact_revenue_charge: number; }

export async function buildBridgeCore(): Promise<BridgeCoreResult> {
  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c = await pool.connect();
    try {
      // The bridge rebuild is one large allocating insert — give it headroom past the role default.
      await c.query(`set statement_timeout = '600s'`);
      const bridge = (await c.query<{ n: number }>('select core.refresh_fact_settlement_bridge() as n')).rows[0]!.n;
      log(`  core.fact_settlement_bridge rebuilt: ${bridge} rows (ft_gp_detail grain, settled loads)`);
      const rev = (await c.query<{ n: number }>('select core.refresh_fact_revenue_charge() as n')).rows[0]!.n;
      log(`  core.fact_revenue_charge rebuilt: ${rev} rows (0 until the revenue-class checkpoint)`);

      // Coverage self-check — every settled gp_detail row landed (AC1).
      const cover = (await c.query<{ settled: string; bridged: string }>(
        `select (select count(*) from raw.ft_gp_detail d
                  where exists (select 1 from core.fact_gp_settlement_load f
                                where f.schedule_id = d.gp_schedule_id
                                  and f.dispatch_load_id = d.dispatch_load_id))::text as settled,
                (select count(*) from core.fact_settlement_bridge)::text as bridged`)).rows[0]!;
      log(`  coverage: settled gp_detail=${cover.settled} bridge=${cover.bridged} (expect equal)`);

      // No-double-count self-check — every (schedule, load) group sums exactly to the load fact (AC2).
      const dc = (await c.query<{ n: string }>(
        `select count(*)::text n
           from (select schedule_id, dispatch_load_id,
                        round(sum(grower_gross), 2) g, sum(total_deductions) d, sum(gst_total) t
                   from core.fact_settlement_bridge group by 1, 2) b
           join core.fact_gp_settlement_load f
             on f.schedule_id = b.schedule_id and f.dispatch_load_id = b.dispatch_load_id
          where abs(coalesce(b.g, 0) - f.gross_sales) > 0.005
             or abs(b.d - f.total_deductions) > 0.005
             or abs(b.t - f.gst_total) > 0.005`)).rows[0]!.n;
      log(`  (schedule, load) groups mismatching fact_gp_settlement_load: ${dc} (expect 0)`);
      return { fact_settlement_bridge: bridge, fact_revenue_charge: rev };
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const r = await buildBridgeCore();
  log(`done: fact_settlement_bridge=${r.fact_settlement_bridge} fact_revenue_charge=${r.fact_revenue_charge}`);
}
