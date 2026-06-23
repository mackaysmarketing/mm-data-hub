// Sprint 7 · evidence for the dispatched/boxes redefinition proposal (LOAD-SAFE, read-only).
// Quantifies the blast radius of:
//   "dispatched"  current = actual_pickup_on IS NOT NULL   →  proposed = state.sequence >= 5 (Shipped+)
//   "dispatched_on" date   = actual_pickup_on              →  proposed = coalesce(actual_pickup_on, scheduled_pickup_on)
//   "boxes"       current = pallet.box_count               →  proposed = stock_boxes + reconsigned_boxes
// All scoped to order_type='S' (the dispatch metric's baked Sell filter). Global + LMB.
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const LMB_CODES = ['LMBFA', 'LMBBF', 'LMBCO', 'LMBEP'];

function noVerifySsl(c: string): string {
  return /[?&]sslmode=/i.test(c) ? c.replace(/sslmode=[^&]*/i, 'sslmode=no-verify') : c + (c.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}
async function ro(url: string, app: string): Promise<pg.Client> {
  const c = new Client({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, application_name: app, connectionTimeoutMillis: 15_000, statement_timeout: 120_000 });
  await c.connect(); await c.query('SET default_transaction_read_only = on'); return c;
}
const j = (x: unknown) => JSON.stringify(x);

async function main(): Promise<void> {
  const ft = await ro(process.env.FRESHTRACK_DATABASE_URL!, 'mm ft:dispatch def-evidence (ro src)');
  const hub = await ro(process.env.DATABASE_URL!, 'mm ft:dispatch def-evidence (ro hub)');
  try {
    const lmb = await hub.query<{ consignor_id: string }>(`SELECT consignor_id::text AS consignor_id FROM core.dim_grower WHERE code = ANY($1)`, [LMB_CODES]);
    const ids = lmb.rows.map((r) => r.consignor_id);

    // A) Boxes formula: is box_count == stock, or == stock+reconsigned? (2026, all pallets)
    console.log('A) Boxes formula check (2026 pallets where box_count present):');
    const a = await ft.query(
      `SELECT count(*) FILTER (WHERE p.box_count IS NOT NULL)::int AS bc_present,
              count(*) FILTER (WHERE p.box_count IS NOT NULL AND p.box_count = p.stock_boxes)::int AS bc_eq_stock,
              count(*) FILTER (WHERE p.box_count IS NOT NULL AND p.box_count = coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0))::int AS bc_eq_stock_recon,
              count(*) FILTER (WHERE p.box_count IS NOT NULL AND p.box_count <> p.stock_boxes)::int AS bc_ne_stock
         FROM public.pallet p JOIN public.dispatch_load dl ON dl.id = p.dispatch_load_id
        WHERE dl.created_on >= '2026-01-01'`);
    console.log('  ', j(a.rows[0]));

    // B) Dispatched LOADS, Sell, 2026: current vs proposed. Global.
    console.log('\nB) Dispatched Sell loads in 2026 — current (actual_pickup) vs proposed (state seq>=5):');
    const b = await ft.query(
      `SELECT count(*)::int AS sell_loads_2026,
              count(*) FILTER (WHERE dl.actual_pickup_on IS NOT NULL)::int AS current_dispatched,
              count(*) FILTER (WHERE s.sequence >= 5)::int AS proposed_dispatched
         FROM public.dispatch_load dl
         JOIN public.dispatch_load_state s ON s.id = dl.state_id
        WHERE dl.order_type = 'S' AND dl.created_on >= '2026-01-01'`);
    console.log('  ', j(b.rows[0]));

    // C) Same for LMB.
    console.log('\nC) LMB dispatched Sell loads in 2026 — current vs proposed:');
    const c = await ft.query(
      `SELECT count(*)::int AS sell_loads_2026,
              count(*) FILTER (WHERE dl.actual_pickup_on IS NOT NULL)::int AS current_dispatched,
              count(*) FILTER (WHERE s.sequence >= 5)::int AS proposed_dispatched
         FROM public.dispatch_load dl
         JOIN public.dispatch_load_state s ON s.id = dl.state_id
        WHERE dl.order_type = 'S' AND dl.consignor_id = ANY($1::uuid[]) AND dl.created_on >= '2026-01-01'`, [ids]);
    console.log('  ', j(c.rows[0]));

    // D) Boxes TOTAL, Sell dispatched(proposed) 2026: current box_count vs proposed stock+reconsigned. Global + LMB.
    console.log('\nD) Boxes total over proposed-dispatched Sell pallets, 2026 (current box_count vs proposed stock+reconsigned):');
    for (const [label, filt, params] of [['GLOBAL', '', []], ['LMB', 'AND dl.consignor_id = ANY($1::uuid[])', [ids]]] as const) {
      const d = await ft.query(
        `SELECT sum(coalesce(p.box_count,0))::numeric AS boxes_current,
                sum(coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0))::numeric AS boxes_proposed,
                count(*)::int AS pallets
           FROM public.pallet p
           JOIN public.dispatch_load dl ON dl.id = p.dispatch_load_id
           JOIN public.dispatch_load_state s ON s.id = dl.state_id
          WHERE dl.order_type = 'S' AND s.sequence >= 5 AND dl.created_on >= '2026-01-01' ${filt}`, [...params]);
      console.log(`   ${label}:`, j(d.rows[0]));
    }

    // E) LMB by ISO week under PROPOSED defs — loads + boxes, recent weeks (does a recent week have boxes>0?).
    console.log('\nE) LMB recent weeks under PROPOSED defs (dispatched_on = coalesce(actual,scheduled), boxes = stock+reconsigned):');
    const e = await ft.query(
      `SELECT to_char(coalesce(dl.actual_pickup_on, dl.scheduled_pickup_on), 'IYYY-"W"IW') AS iso_week,
              count(DISTINCT dl.id)::int AS loads,
              sum(coalesce(p.stock_boxes,0)+coalesce(p.reconsigned_boxes,0))::numeric AS boxes
         FROM public.dispatch_load dl
         JOIN public.dispatch_load_state s ON s.id = dl.state_id
         LEFT JOIN public.pallet p ON p.dispatch_load_id = dl.id
        WHERE dl.order_type = 'S' AND s.sequence >= 5 AND dl.consignor_id = ANY($1::uuid[])
          AND coalesce(dl.actual_pickup_on, dl.scheduled_pickup_on) >= '2026-05-01'
        GROUP BY 1 ORDER BY 1`, [ids]);
    for (const r of e.rows as any[]) console.log(`   ${r.iso_week}  loads=${String(r.loads).padStart(3)}  boxes=${r.boxes}`);

    // F) Current view reality for LMB (what shows TODAY): actual_pickup not null + box_count.
    console.log('\nF) LMB under CURRENT view defs (actual_pickup_on NOT NULL; boxes=box_count) since 2026-05-01:');
    const f = await ft.query(
      `SELECT count(DISTINCT dl.id)::int AS loads, sum(coalesce(p.box_count,0))::numeric AS boxes
         FROM public.dispatch_load dl
         LEFT JOIN public.pallet p ON p.dispatch_load_id = dl.id
        WHERE dl.order_type='S' AND dl.consignor_id = ANY($1::uuid[]) AND dl.actual_pickup_on IS NOT NULL
          AND dl.actual_pickup_on >= '2026-05-01'`, [ids]);
    console.log('  ', j(f.rows[0]));
  } finally {
    await ft.end().catch(() => {}); await hub.end().catch(() => {});
  }
}
main().catch((e) => { console.error('DEF-EVIDENCE FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
