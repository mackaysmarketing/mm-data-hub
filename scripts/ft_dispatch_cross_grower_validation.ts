// Sprint 7 · CROSS-GROWER validation of the revised dispatch methodology (LOAD-SAFE, read-only).
// Before redefining a business-wide metric, prove the methodology generalises beyond LMB:
//   1. actual_pickup_on under-population — LMB-specific or across the board?
//   2. consistency — do actual_pickup loads AGREE with state seq>=5 (no contradictions)?
//   3. boxes = stock+reconsigned — leaves stock-only growers UNCHANGED, fixes reconsignment growers?
//   4. date fallback — is scheduled_pickup_on a sound proxy for actual_pickup_on?
//   5. over-inclusion — does seq>=5 sweep in non-shipped (0-pallet / 0-box) loads?
// Scoped to order_type='S' (the dispatch metric's Sell filter), 2026. Aggregates only.
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
function noVerifySsl(c: string): string {
  return /[?&]sslmode=/i.test(c) ? c.replace(/sslmode=[^&]*/i, 'sslmode=no-verify') : c + (c.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}
async function ro(url: string, app: string): Promise<pg.Client> {
  const c = new Client({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, application_name: app, connectionTimeoutMillis: 15_000, statement_timeout: 180_000 });
  await c.connect(); await c.query('SET default_transaction_read_only = on'); return c;
}
const j = (x: unknown) => JSON.stringify(x);
const n = (x: unknown) => Number(x ?? 0).toLocaleString();

async function main(): Promise<void> {
  const ft = await ro(process.env.FRESHTRACK_DATABASE_URL!, 'mm ft:dispatch xgrower-valid (ro src)');
  const hub = await ro(process.env.DATABASE_URL!, 'mm ft:dispatch xgrower-valid (ro hub)');
  try {
    // grower code map from the hub (small)
    const dg = await hub.query<{ consignor_id: string; code: string; org_name: string; is_test: boolean }>(
      `SELECT consignor_id::text AS consignor_id, code, org_name, coalesce(is_test,false) AS is_test FROM core.dim_grower`);
    const code = new Map(dg.rows.map((r) => [r.consignor_id, { code: r.code, name: r.org_name, is_test: r.is_test }]));

    // 1) GROWER coverage distribution — how many growers under-populate actual_pickup_on?
    console.log('1) actual_pickup_on coverage across growers (2026 Sell loads): grower buckets');
    const cov = await ft.query(
      `SELECT bucket, count(*)::int AS growers, sum(loads)::int AS loads FROM (
         SELECT consignor_id, count(*) AS loads,
                CASE WHEN count(actual_pickup_on)=0 THEN 'a) 0%'
                     WHEN 100.0*count(actual_pickup_on)/count(*) < 25 THEN 'b) <25%'
                     WHEN 100.0*count(actual_pickup_on)/count(*) < 75 THEN 'c) 25-75%'
                     ELSE 'd) >=75%' END AS bucket
           FROM public.dispatch_load WHERE order_type='S' AND created_on >= '2026-01-01' AND consignor_id IS NOT NULL
           GROUP BY consignor_id) t
        GROUP BY bucket ORDER BY bucket`);
    for (const r of cov.rows as any[]) console.log(`   ${r.bucket.padEnd(10)} growers=${String(r.growers).padStart(4)}  loads=${String(r.loads).padStart(6)}`);

    // 2) CONSISTENCY — do actual_pickup loads agree with seq>=5? (contradictions = bad)
    console.log('\n2) consistency: actual_pickup_on vs state seq>=5 (2026 Sell):');
    const con = await ft.query(
      `SELECT count(*) FILTER (WHERE dl.actual_pickup_on IS NOT NULL)::int AS with_actual,
              count(*) FILTER (WHERE dl.actual_pickup_on IS NOT NULL AND s.sequence >= 5)::int AS actual_and_shipped,
              count(*) FILTER (WHERE dl.actual_pickup_on IS NOT NULL AND s.sequence < 5)::int AS actual_but_NOT_shipped,
              count(*) FILTER (WHERE s.sequence >= 5)::int AS shipped,
              count(*) FILTER (WHERE s.sequence >= 5 AND dl.actual_pickup_on IS NULL)::int AS shipped_without_actual
         FROM public.dispatch_load dl JOIN public.dispatch_load_state s ON s.id = dl.state_id
        WHERE dl.order_type='S' AND dl.created_on >= '2026-01-01'`);
    console.log('  ', j(con.rows[0]));
    const cr: any = con.rows[0];
    console.log(`   → ${(100*cr.actual_and_shipped/cr.with_actual).toFixed(1)}% of actual_pickup loads are seq>=5 (want ~100%); ${cr.actual_but_not_shipped} contradictions`);

    // 3) OVER-INCLUSION — seq>=5 loads that look non-shipped (0 pallets / 0 boxes)
    console.log('\n3) over-inclusion: seq>=5 Sell loads with no pallets / zero boxes (2026):');
    const over = await ft.query(
      `SELECT count(*)::int AS shipped_loads,
              count(*) FILTER (WHERE pallets=0)::int AS no_pallets,
              count(*) FILTER (WHERE boxes=0)::int AS zero_boxes
         FROM (SELECT dl.id, count(p.id)::int AS pallets,
                      sum(coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0))::numeric AS boxes
                 FROM public.dispatch_load dl
                 JOIN public.dispatch_load_state s ON s.id=dl.state_id
                 LEFT JOIN public.pallet p ON p.dispatch_load_id = dl.id
                WHERE dl.order_type='S' AND s.sequence>=5 AND dl.created_on >= '2026-01-01'
                GROUP BY dl.id) t`);
    console.log('  ', j(over.rows[0]));

    // 4) DATE fallback — how close is scheduled_pickup_on to actual_pickup_on where both exist?
    console.log('\n4) date fallback soundness: scheduled vs actual pickup (2026 Sell, both present):');
    const dt = await ft.query(
      `SELECT count(*)::int AS both_present,
              round(avg(extract(epoch from (actual_pickup_on - scheduled_pickup_on))/86400.0)::numeric,2)::text AS avg_days,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (actual_pickup_on - scheduled_pickup_on))/86400.0))::numeric,2)::text AS median_days,
              round(100.0*count(*) FILTER (WHERE abs(extract(epoch from (actual_pickup_on - scheduled_pickup_on))) <= 2*86400)/count(*),1)::text AS pct_within_2d
         FROM public.dispatch_load
        WHERE order_type='S' AND created_on >= '2026-01-01' AND actual_pickup_on IS NOT NULL AND scheduled_pickup_on IS NOT NULL`);
    console.log('  ', j(dt.rows[0]));

    // 5) PER-GROWER impact — current vs proposed loads & boxes (top 30 by proposed loads).
    console.log('\n5) per-grower impact (2026 Sell): code | curr→prop loads | curr→prop boxes | recon% pallets');
    const loads = await ft.query(
      `SELECT dl.consignor_id::text AS cid,
              count(DISTINCT dl.id) FILTER (WHERE dl.actual_pickup_on IS NOT NULL)::int AS curr_loads,
              count(DISTINCT dl.id) FILTER (WHERE s.sequence >= 5)::int AS prop_loads
         FROM public.dispatch_load dl JOIN public.dispatch_load_state s ON s.id=dl.state_id
        WHERE dl.order_type='S' AND dl.created_on >= '2026-01-01' AND dl.consignor_id IS NOT NULL
        GROUP BY dl.consignor_id`);
    const boxes = await ft.query(
      `SELECT dl.consignor_id::text AS cid,
              sum(coalesce(p.box_count,0))::numeric AS boxes_curr,
              sum(coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0))::numeric AS boxes_prop,
              count(*)::int AS pallets,
              count(*) FILTER (WHERE coalesce(p.reconsigned_boxes,0) > 0)::int AS recon_pallets
         FROM public.pallet p
         JOIN public.dispatch_load dl ON dl.id = p.dispatch_load_id
         JOIN public.dispatch_load_state s ON s.id = dl.state_id
        WHERE dl.order_type='S' AND s.sequence>=5 AND dl.created_on >= '2026-01-01' AND dl.consignor_id IS NOT NULL
        GROUP BY dl.consignor_id`);
    const bmap = new Map((boxes.rows as any[]).map((r) => [r.cid, r]));
    const merged = (loads.rows as any[]).map((r) => {
      const b = bmap.get(r.cid) ?? {};
      const meta = code.get(r.cid);
      return {
        code: meta?.code ?? '(unknown)', is_test: meta?.is_test ?? false,
        curr_loads: r.curr_loads, prop_loads: r.prop_loads,
        boxes_curr: Number(b.boxes_curr ?? 0), boxes_prop: Number(b.boxes_prop ?? 0),
        pallets: b.pallets ?? 0, recon_pallets: b.recon_pallets ?? 0,
      };
    }).filter((r) => !r.is_test).sort((a, b) => b.prop_loads - a.prop_loads);

    for (const r of merged.slice(0, 30)) {
      const reconPct = r.pallets ? Math.round(100 * r.recon_pallets / r.pallets) : 0;
      const boxRatio = r.boxes_curr ? (r.boxes_prop / r.boxes_curr).toFixed(1) + '×' : (r.boxes_prop ? '0→' + n(r.boxes_prop) : '—');
      console.log(`   ${String(r.code).padEnd(8)} loads ${String(r.curr_loads).padStart(4)}→${String(r.prop_loads).padStart(4)}   boxes ${n(r.boxes_curr).padStart(9)}→${n(r.boxes_prop).padStart(9)} (${boxRatio})   recon=${reconPct}%`);
    }

    // Totals + how many growers UNCHANGED on boxes (stock-only) vs increased (reconsignment).
    const tot = merged.reduce((a, r) => ({
      curr_loads: a.curr_loads + r.curr_loads, prop_loads: a.prop_loads + r.prop_loads,
      boxes_curr: a.boxes_curr + r.boxes_curr, boxes_prop: a.boxes_prop + r.boxes_prop,
    }), { curr_loads: 0, prop_loads: 0, boxes_curr: 0, boxes_prop: 0 });
    const boxUnchanged = merged.filter((r) => r.boxes_prop === r.boxes_curr).length;
    const boxIncreased = merged.filter((r) => r.boxes_prop > r.boxes_curr).length;
    const growersHidden = merged.filter((r) => r.curr_loads === 0 && r.prop_loads > 0).length;
    console.log(`\n   TOTALS (non-test growers=${merged.length}): loads ${n(tot.curr_loads)}→${n(tot.prop_loads)}  boxes ${n(tot.boxes_curr)}→${n(tot.boxes_prop)}`);
    console.log(`   boxes UNCHANGED (stock-only) growers: ${boxUnchanged}  ·  boxes INCREASED (reconsignment) growers: ${boxIncreased}`);
    console.log(`   growers INVISIBLE today but shipping (curr 0 / prop >0): ${growersHidden}  ← LMB is one of these`);
  } finally {
    await ft.end().catch(() => {}); await hub.end().catch(() => {});
  }
}
main().catch((e) => { console.error('XGROWER-VALID FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
