// Sprint 7 · box-accounting probe (LOAD-SAFE, read-only). The portal shows 1200 "Boxes
// Packed" for G5021160 via pallet RECONSIGNED boxes (60×20), while pallet.box_count is
// null. Verify the box model: box_count vs stock_boxes vs reconsigned_boxes, for this
// load and across LMB's 2026 loads — so "boxes" coverage is judged on the right fields.
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const LMB_CODES = ['LMBFA', 'LMBBF', 'LMBCO', 'LMBEP'];

function noVerifySsl(c: string): string {
  return /[?&]sslmode=/i.test(c) ? c.replace(/sslmode=[^&]*/i, 'sslmode=no-verify') : c + (c.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}
async function ro(url: string, app: string): Promise<pg.Client> {
  const c = new Client({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, application_name: app, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
  await c.connect(); await c.query('SET default_transaction_read_only = on'); return c;
}

async function main(): Promise<void> {
  const ft = await ro(process.env.FRESHTRACK_DATABASE_URL!, 'mm ft:dispatch box-probe (ro src)');
  const hub = await ro(process.env.DATABASE_URL!, 'mm ft:dispatch box-probe (ro hub)');
  try {
    // 1) G5021160 pallet box breakdown (first 5 + sums) — confirm 60 reconsigned/pallet, 1200 total.
    const load = await ft.query<{ id: string }>(`SELECT id::text FROM public.dispatch_load WHERE load_no = 'G5021160 - 126'`);
    const id = load.rows[0]!.id;
    console.log('1) G5021160 — per-pallet box fields (first 5):');
    const p5 = await ft.query(
      `SELECT pallet_no, box_count, stock_boxes, reconsigned_boxes, repacked_boxes, rejected_boxes, waste_boxes, net_weight_value
         FROM public.pallet WHERE dispatch_load_id = $1 ORDER BY pallet_no LIMIT 5`, [id]);
    for (const r of p5.rows as any[]) console.log('   ', JSON.stringify(r));
    const psum = await ft.query(
      `SELECT count(*)::int pallets, sum(box_count) box_count, sum(stock_boxes) stock_boxes,
              sum(reconsigned_boxes) reconsigned_boxes, sum(net_weight_value) net_weight
         FROM public.pallet WHERE dispatch_load_id = $1`, [id]);
    console.log('   SUMS:', JSON.stringify(psum.rows[0]));
    const lsum = await ft.query(
      `SELECT stock_boxes, reconsigned_boxes, rejected_boxes, waste_boxes FROM public.dispatch_load WHERE id = $1`, [id]);
    console.log('   LOAD-level boxes:', JSON.stringify(lsum.rows[0]));

    // 2) LMB 2026 pallets — coverage of each box field + an "effective boxes" rollup.
    const lmb = await hub.query<{ consignor_id: string }>(
      `SELECT consignor_id::text AS consignor_id FROM core.dim_grower WHERE code = ANY($1)`, [LMB_CODES]);
    const ids = lmb.rows.map((r) => r.consignor_id);
    console.log('\n2) LMB 2026 pallets — where do the boxes live?');
    const cov = await ft.query(
      `SELECT count(*)::int pallets,
              count(*) FILTER (WHERE coalesce(p.box_count,0) > 0)::int        with_box_count,
              count(*) FILTER (WHERE coalesce(p.stock_boxes,0) > 0)::int       with_stock,
              count(*) FILTER (WHERE coalesce(p.reconsigned_boxes,0) > 0)::int with_reconsigned,
              count(*) FILTER (WHERE coalesce(p.box_count,0)+coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0) > 0)::int with_any_boxes,
              count(*) FILTER (WHERE coalesce(p.net_weight_value,0) > 0)::int  with_net_weight,
              sum(coalesce(p.box_count,0))::numeric        sum_box_count,
              sum(coalesce(p.stock_boxes,0))::numeric       sum_stock,
              sum(coalesce(p.reconsigned_boxes,0))::numeric sum_reconsigned
         FROM public.pallet p JOIN public.dispatch_load dl ON dl.id = p.dispatch_load_id
        WHERE dl.consignor_id = ANY($1::uuid[]) AND dl.created_on >= '2026-01-01'`, [ids]);
    console.log('  ', JSON.stringify(cov.rows[0]));

    // 3) GLOBAL sanity — does box_count usually equal stock+reconsigned, or is it a separate sparse field?
    console.log('\n3) GLOBAL 2026 pallets — box_count vs (stock+reconsigned) coverage:');
    const g = await ft.query(
      `SELECT count(*)::int pallets,
              count(*) FILTER (WHERE coalesce(p.box_count,0) > 0)::int with_box_count,
              count(*) FILTER (WHERE coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0) > 0)::int with_stock_or_recon,
              sum(coalesce(p.box_count,0))::numeric sum_box_count,
              sum(coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0))::numeric sum_stock_recon
         FROM public.pallet p JOIN public.dispatch_load dl ON dl.id = p.dispatch_load_id
        WHERE dl.created_on >= '2026-01-01'`);
    console.log('  ', JSON.stringify(g.rows[0]));
  } finally {
    await ft.end().catch(() => {}); await hub.end().catch(() => {});
  }
}
main().catch((e) => { console.error('BOX-PROBE FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
