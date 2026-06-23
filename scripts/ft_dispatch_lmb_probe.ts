// Sprint 7 · Step-0 LMB recency probe #2 (LOAD-SAFE, read-only). Pin down WHICH date
// fields LMB's recent loads populate (actual_pickup_on is ~always null), whether those
// loads carry pallets+box_count, and how LMB compares to the growers that DO dispatch
// recently — so the view-filter decision can be put to the user with concrete numbers.
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const LMB_CODES = ['LMBFA', 'LMBBF', 'LMBCO', 'LMBEP'];

function noVerifySsl(c: string): string {
  return /[?&]sslmode=/i.test(c) ? c.replace(/sslmode=[^&]*/i, 'sslmode=no-verify') : c + (c.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}
async function ro(url: string, app: string): Promise<pg.Client> {
  const c = new Client({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, application_name: app, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  return c;
}

async function main(): Promise<void> {
  const ft = await ro(process.env.FRESHTRACK_DATABASE_URL!, 'mm ft:dispatch lmb-probe2 (ro src)');
  const hub = await ro(process.env.DATABASE_URL!, 'mm ft:dispatch lmb-probe2 (ro hub)');
  try {
    const lmb = await hub.query<{ consignor_id: string }>(
      `SELECT consignor_id::text AS consignor_id FROM core.dim_grower WHERE code = ANY($1)`, [LMB_CODES]);
    const ids = lmb.rows.map((r) => r.consignor_id);

    // 1) LMB 2026 loads — which date fields are populated, order_type, completion, pallets+boxes.
    console.log('1) LMB loads created >= 2026-01-01 — date-field & flag coverage:');
    const q1 = await ft.query(
      `SELECT count(*)::int AS loads,
              count(actual_pickup_on)::int     AS has_actual_pickup,
              count(scheduled_pickup_on)::int  AS has_sched_pickup,
              count(actual_delivery_on)::int   AS has_actual_delivery,
              count(asn_sent_on)::int          AS has_asn_sent,
              count(email_sent_on)::int        AS has_email_sent,
              count(*) FILTER (WHERE is_complete)::int AS is_complete_true,
              count(*) FILTER (WHERE is_archived)::int AS is_archived_true
         FROM public.dispatch_load WHERE consignor_id = ANY($1::uuid[]) AND created_on >= '2026-01-01'`, [ids]);
    console.log('  ', JSON.stringify(q1.rows[0]));

    console.log('\n   order_type distribution (LMB 2026 loads):');
    const q1b = await ft.query(
      `SELECT order_type, count(*)::int AS n FROM public.dispatch_load
        WHERE consignor_id = ANY($1::uuid[]) AND created_on >= '2026-01-01' GROUP BY 1 ORDER BY 2 DESC`, [ids]);
    for (const r of q1b.rows) console.log(`     order_type=${JSON.stringify(r.order_type)}  n=${r.n}`);

    // 2) Do LMB 2026 loads have pallets, and do those pallets carry box_count / net_weight?
    console.log('\n2) Pallets on LMB 2026 loads (data present even though pickup is null?):');
    const q2 = await ft.query(
      `SELECT count(p.*)::int AS pallets,
              count(p.box_count)::int AS with_box,
              count(p.net_weight_value)::int AS with_net_wt,
              count(distinct p.dispatch_load_id)::int AS loads_with_pallets
         FROM public.pallet p
         JOIN public.dispatch_load dl ON dl.id = p.dispatch_load_id
        WHERE dl.consignor_id = ANY($1::uuid[]) AND dl.created_on >= '2026-01-01'`, [ids]);
    console.log('  ', JSON.stringify(q2.rows[0]));

    // 3) Newest 6 LMB loads — date fields + flags only (NO sensitive text).
    console.log('\n3) Newest 6 LMB loads (dates/flags only):');
    const q3 = await ft.query(
      `SELECT load_no, order_type, is_complete, is_locked,
              created_on::text AS created,
              scheduled_pickup_on::text AS sched_pickup,
              actual_pickup_on::text AS actual_pickup,
              actual_delivery_on::text AS actual_delivery
         FROM public.dispatch_load WHERE consignor_id = ANY($1::uuid[])
         ORDER BY created_on DESC LIMIT 6`, [ids]);
    for (const r of q3.rows) console.log('   ', JSON.stringify(r));

    // 4) Is "creates loads but null actual_pickup_on" LMB-specific or common? Global 2026.
    console.log('\n4) GLOBAL 2026 loads — actual_pickup_on coverage (is null-pickup normal?):');
    const q4 = await ft.query(
      `SELECT count(*)::int AS loads_2026,
              count(actual_pickup_on)::int AS with_actual_pickup,
              round(100.0*count(actual_pickup_on)/nullif(count(*),0),1)::text AS pct_with_pickup
         FROM public.dispatch_load WHERE created_on >= '2026-01-01'`);
    console.log('  ', JSON.stringify(q4.rows[0]));

    // 5) Of the four LMB entities, which has the single dispatched (actual_pickup_on) load?
    console.log('\n5) LMB dispatched (actual_pickup_on NOT NULL) loads by consignor:');
    const q5 = await ft.query(
      `SELECT consignor_id::text AS cid, count(*)::int AS dispatched, max(actual_pickup_on)::text AS max_pickup
         FROM public.dispatch_load
        WHERE consignor_id = ANY($1::uuid[]) AND actual_pickup_on IS NOT NULL
        GROUP BY 1`, [ids]);
    for (const r of q5.rows) console.log('   ', JSON.stringify(r));

    // 6) Among the 18 growers that DID dispatch in the last 14d — sanity they use actual_pickup_on
    //    AND have non-null box_count (i.e. the AC IS achievable for an active grower).
    console.log('\n6) A recently-active grower sample (last 14d) — boxes present on dispatched loads?');
    const q6 = await ft.query(
      `SELECT dl.consignor_id::text AS cid, count(distinct dl.id)::int AS loads,
              count(p.box_count)::int AS pallet_with_box, max(dl.actual_pickup_on)::text AS max_pickup
         FROM public.dispatch_load dl
         LEFT JOIN public.pallet p ON p.dispatch_load_id = dl.id
        WHERE dl.actual_pickup_on >= now() - interval '14 days'
        GROUP BY dl.consignor_id ORDER BY loads DESC LIMIT 5`);
    for (const r of q6.rows) console.log('   ', JSON.stringify(r));
  } finally {
    await ft.end().catch(() => {});
    await hub.end().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE2 FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
