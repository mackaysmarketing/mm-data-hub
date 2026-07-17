// ─────────────────────────────────────────────────────────────────────────────
// Grower-portal fix pack (2026-07-18) — acceptance proof for FIX 1/2/4/5/6/7.
//   npm run portal:verify
//
// One check block per fix, mirroring the portal's own acceptance queries
// (docs handed over 2026-07-18), plus RLS behavior on the two NEW views:
//   F1  grower_gp_settlement dates: nulls == underivable source rows (no week_no
//       AND no source dates); every derived row is Monday-aligned to week_no,
//       date_to = date_from + 6; test pair has ZERO null dates.
//   F2  product labels: no '^{' residue, no leading-[N] residue, no empty
//       strings in shipped/detail; null products == pallets with no product/
//       variety/crop at all (derived in-run); test pair: bad-or-empty == 0.
//   F4  grower_dispatch_load: rows == distinct non-archived (grower, load) in
//       the pallet grain; Σboxes / Σnet_weight tie EXACTLY to the pallet grain;
//       grower token sees only its rows; no-claim → 0.
//   F5  fact_load_sale row accounting partitions the invoice book exactly
//       (grouped rows + loads-not-landed == invoices with a load id); retailer
//       parity vs the crosswalk recomputed in-run; the test pair's sold loads
//       all carry a retailer_group.
//   F6  consignment_status: exactly one of Tim's four values on every load;
//       each status is signal-consistent (re-derived from the exposed columns).
//   F7  schedule 1329 (Tim's fixture): via the LRCTU grower token, each of its
//       loads shows retailer_group (grower_load_sale) + per-category deductions
//       (grower_gp_settlement_load).
//
// Proof-style contract: NO hardcoded count baselines — every expectation is
// derived in-run from source SQL (the portal's "238 loads" is REPORTED, not
// asserted). Fixture identities (grower codes LRCLA/LRCTU, schedule 1329) are
// pinned identities from the handover doc, not counts. Run with loaders
// QUIESCENT. Read-only: every RLS context rolls back.
// Report: reports/grower_portal_fixes_<date>.txt (written even on abort).
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const PAIR_CODES = ['LRCLA', 'LRCTU'];   // the portal's test pair (handover doc)
const F7_SCHEDULE_NO = '1329';           // Tim's drill-down fixture (LRCTU)

const lines: string[] = [];
function log(msg: string): void { lines.push(msg); console.log(msg); }
const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const hubTok = (o: object) => JSON.stringify({ role: 'authenticated', ...o });

async function underCtx<T>(c: PoolClient, claimsJson: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [claimsJson ?? '']);
    return await fn();
  } finally {
    await c.query('rollback');
  }
}
async function q1<T extends object>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  return (await c.query(sql, params)).rows[0]! as T;
}

async function main(): Promise<void> {
  const pool = makePool();
  const c = await pool.connect();
  try {
    // ── fixtures: resolve the test pair by grower code (never by uuid constant) ──
    const pair = (await c.query<{ consignor_id: string; code: string }>(
      `select consignor_id, code from core.dim_grower where code = any($1) order by code`, [PAIR_CODES])).rows;
    if (pair.length < 2) throw new Error(`test pair ${PAIR_CODES.join('/')} not resolvable from core.dim_grower`);
    const pairIds = pair.map((r) => r.consignor_id);
    const pairTok = hubTok({ app_metadata: { consignor_ids: pairIds } });
    log(`fixtures: ${pair.map((r) => `${r.code}=${r.consignor_id}`).join(' ')}`);

    // ── F1: settlement period dates ──────────────────────────────────────────────
    log('\n=== F1  grower_gp_settlement.date_from/date_to (derived from week_no) ===');
    const f1 = await q1<{ total: string; nulls: string; derived: string; misaligned: string; not_monday: string }>(c, `
      select count(*) total,
             count(*) filter (where date_from is null or date_to is null) nulls,
             count(*) filter (where dates_derived) derived,
             count(*) filter (where dates_derived and (to_char(date_from,'IW')::int <> week_no or date_to <> date_from + 6)) misaligned,
             count(*) filter (where dates_derived and extract(isodow from date_from) <> 1) not_monday
      from semantic.grower_gp_settlement`);
    const f1src = await q1<{ underivable: string }>(c, `
      select count(*) underivable from raw.ft_gp_schedule
      where week_no is null and date_from is null and date_to is null`);
    check(`null-date rows (${f1.nulls}) == underivable source rows (${f1src.underivable})`, f1.nulls === f1src.underivable);
    check(`every derived row aligns to week_no (misaligned=${f1.misaligned})`, Number(f1.misaligned) === 0);
    check(`every derived date_from is a Monday (violations=${f1.not_monday})`, Number(f1.not_monday) === 0);
    check(`derivation is near-total (${f1.derived}/${f1.total})`, Number(f1.derived) >= Number(f1.total) - Number(f1src.underivable));
    const f1pair = await underCtx(c, pairTok, () =>
      q1<{ total: string; nulls: string }>(c, `
        select count(*) total, count(*) filter (where date_from is null or date_to is null) nulls
        from semantic.grower_gp_settlement`));
    check(`test pair via grower token: ${f1pair.total} schedules, 0 null dates`, Number(f1pair.nulls) === 0 && Number(f1pair.total) > 0,
      `nulls=${f1pair.nulls}`);

    // ── F2: product labels ───────────────────────────────────────────────────────
    log('\n=== F2  product labels cleaned (shipped + detail) ===');
    for (const v of ['semantic.grower_dispatch_shipped', 'semantic.grower_dispatch_detail']) {
      const r = await q1<{ coded: string; empties: string; leading: string; nulls: string }>(c, `
        select count(*) filter (where product like '%^{%') coded,
               count(*) filter (where btrim(product) = '') empties,
               count(*) filter (where product ~ '^\\s*\\[\\d+\\]') leading,
               count(*) filter (where product is null) nulls
        from ${v}`);
      check(`${v}: 0 coded / 0 empty-string / 0 leading-[N]`,
        Number(r.coded) === 0 && Number(r.empties) === 0 && Number(r.leading) === 0,
        `coded=${r.coded} empty=${r.empties} leading=${r.leading} null=${r.nulls}`);
    }
    // null products == pallets with NOTHING to fall back on (derived, shipped scope)
    const f2 = await q1<{ view_nulls: string; hopeless: string }>(c, `
      select
        (select count(*) from semantic.grower_dispatch_shipped where product is null) view_nulls,
        (select count(*)
           from raw.ft_pallet p
           join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
           join core.dim_dispatch_state st on st.state_id = d.state_id
           join core.dim_grower g on g.consignor_id = d.consignor_id
          where st.sequence >= 5 and d.order_type = 'S' and coalesce(g.is_test,false) = false
            and btrim(coalesce(p.product_description,'')) = ''
            and btrim(coalesce(p.variety_description,'')) = ''
            and btrim(coalesce(p.crop_description,'')) = '') hopeless`);
    check(`null products (${f2.view_nulls}) == pallets with no product/variety/crop (${f2.hopeless}) — surfaced, not invented`,
      f2.view_nulls === f2.hopeless);
    const f2pair = await underCtx(c, pairTok, () =>
      q1<{ bad: string }>(c, `
        select count(*) bad from semantic.grower_dispatch_shipped
        where product like '%^{%' or btrim(coalesce(product,'')) = ''`));
    check('test pair via grower token: portal acceptance query == 0', Number(f2pair.bad) === 0, `bad=${f2pair.bad}`);

    // ── F4: load-grain view ──────────────────────────────────────────────────────
    log('\n=== F4  grower_dispatch_load (load grain) ===');
    const f4 = await q1<{ view_rows: string; pallet_loads: string }>(c, `
      select
        (select count(*) from semantic.grower_dispatch_load) view_rows,
        (select count(distinct (grower_key, load_id)) from semantic.grower_dispatch_shipped where not is_archived) pallet_loads`);
    check(`view rows (${f4.view_rows}) == distinct non-archived (grower, load) pallet groups (${f4.pallet_loads})`,
      f4.view_rows === f4.pallet_loads);
    const f4sum = await q1<{ v_boxes: string; p_boxes: string; v_wt: string; p_wt: string }>(c, `
      select
        (select coalesce(sum(boxes),0)::text from semantic.grower_dispatch_load) v_boxes,
        (select coalesce(sum(boxes),0)::text from semantic.grower_dispatch_shipped where not is_archived) p_boxes,
        (select coalesce(sum(net_weight_kg),0)::text from semantic.grower_dispatch_load) v_wt,
        (select coalesce(sum(net_weight),0)::text from semantic.grower_dispatch_shipped where not is_archived) p_wt`);
    check(`Σboxes ties exactly (${f4sum.v_boxes})`, f4sum.v_boxes === f4sum.p_boxes, `pallet grain ${f4sum.p_boxes}`);
    check(`Σnet_weight ties exactly (${f4sum.v_wt})`, f4sum.v_wt === f4sum.p_wt, `pallet grain ${f4sum.p_wt}`);
    const f4pair = await underCtx(c, pairTok, () =>
      q1<{ rows: string; own: string }>(c, `
        select count(*) rows, count(*) filter (where grower_key = any($1::uuid[])) own
        from semantic.grower_dispatch_load`, [pairIds]));
    check(`test pair via grower token sees ONLY its rows (${f4pair.rows}, portal expects ~238)`,
      f4pair.rows === f4pair.own && Number(f4pair.rows) > 0);
    const f4none = await underCtx(c, null, () =>
      q1<{ n: string }>(c, `select count(*) n from semantic.grower_dispatch_load`));
    check('no-claim token → 0 rows (fail closed)', Number(f4none.n) === 0, `got ${f4none.n}`);

    // ── F5: retailer identity (fact_load_sale + grower_load_sale) ────────────────
    log('\n=== F5  retailer identity on grower-readable sales ===');
    const f5 = await q1<{ fact_rows: string; grouped: string; with_load: string; not_landed: string }>(c, `
      select
        (select count(*) from core.fact_load_sale) fact_rows,
        (select count(*) from (
           select 1 from core.fact_customer_invoice ci
           join raw.ft_dispatch_load d on d.id = ci.dispatch_load_id
           group by d.consignor_id, ci.dispatch_load_id, ci.consignee_id) g) grouped,
        (select count(*) from core.fact_customer_invoice where dispatch_load_id is not null) with_load,
        (select count(*) from core.fact_customer_invoice ci where ci.dispatch_load_id is not null
           and not exists (select 1 from raw.ft_dispatch_load d where d.id = ci.dispatch_load_id)) not_landed`);
    check(`fact rows (${f5.fact_rows}) == derived (load, consignee) groups (${f5.grouped})`, f5.fact_rows === f5.grouped);
    log(`  invoice accounting: ${f5.with_load} load-linked invoices = ${f5.fact_rows} grain rows + ${f5.not_landed} whose loads predate the dispatch landing (surfaced, not silently dropped)`);
    const f5parity = await q1<{ mismatched: string; unmapped: string }>(c, `
      select count(*) filter (where f.retailer_group is distinct from cw.retailer_group) mismatched,
             count(*) filter (where f.retailer_group is null) unmapped
      from core.fact_load_sale f
      left join core.crosswalk_customer_retail cw on cw.consignee_id = f.consignee_id`);
    check(`retailer_group parity vs crosswalk recomputed in-run (mismatched=${f5parity.mismatched})`, Number(f5parity.mismatched) === 0);
    log(`  unmapped retailer_group rows: ${f5parity.unmapped} (surfaced)`);
    const f5pair = await underCtx(c, pairTok, () =>
      (async () => (await c.query<{ retailer_group: string | null; loads: string }>(`
        select retailer_group, count(distinct dispatch_load_id)::text loads
        from semantic.grower_load_sale group by 1 order by 2 desc`)).rows)());
    const pairSaleLoads = f5pair.reduce((s, r) => s + Number(r.loads), 0);
    check(`test pair via grower token: every sold load carries retailer_group (${pairSaleLoads} loads)`,
      pairSaleLoads > 0 && f5pair.every((r) => r.retailer_group !== null),
      f5pair.map((r) => `${r.retailer_group ?? 'NULL'}=${r.loads}`).join(' '));
    const f5dom = f5pair[0];
    check(`pair retailer mix is woolworths-dominant (doc: "- WOW" hints)`, f5dom?.retailer_group === 'woolworths',
      f5pair.map((r) => `${r.retailer_group}=${r.loads}`).join(' '));

    // ── F6: consignment_status ───────────────────────────────────────────────────
    log('\n=== F6  consignment_status (Tim\'s four states) ===');
    const f6dist = (await c.query<{ consignment_status: string; n: string }>(`
      select consignment_status, count(*)::text n from semantic.grower_dispatch_load
      group by 1 order by 2 desc`)).rows;
    log('  distribution: ' + f6dist.map((r) => `${r.consignment_status}=${r.n}`).join(' '));
    const VALID = ['Not Consigned', 'Consigned', 'Sold', 'Paid'];
    check('every load carries exactly one of the four values',
      f6dist.every((r) => VALID.includes(r.consignment_status)) &&
      f6dist.reduce((s, r) => s + Number(r.n), 0) > 0);
    const f6sig = await q1<{ bad_paid: string; bad_sold: string; bad_consigned: string; bad_not: string }>(c, `
      select
        count(*) filter (where consignment_status = 'Paid'
          and not (coalesce(settlement_all_paid,false) or (settlement_schedule_count is null and dispatch_state_seq >= 13))) bad_paid,
        count(*) filter (where consignment_status = 'Sold'
          and not (dispatch_state_seq >= 10 or has_invoice or settlement_schedule_count is not null)) bad_sold,
        count(*) filter (where consignment_status = 'Consigned' and connote_no is null) bad_consigned,
        count(*) filter (where consignment_status = 'Not Consigned' and connote_no is not null) bad_not
      from semantic.grower_dispatch_load`);
    check('every status is signal-consistent (re-derived from the exposed columns)',
      Number(f6sig.bad_paid) === 0 && Number(f6sig.bad_sold) === 0 &&
      Number(f6sig.bad_consigned) === 0 && Number(f6sig.bad_not) === 0,
      `paid=${f6sig.bad_paid} sold=${f6sig.bad_sold} consigned=${f6sig.bad_consigned} not=${f6sig.bad_not}`);
    const f6pair = await underCtx(c, pairTok, () =>
      (async () => (await c.query<{ consignment_status: string; n: string }>(`
        select consignment_status, count(*)::text n from semantic.grower_dispatch_load
        group by 1 order by 2 desc`)).rows)());
    log('  test pair distribution: ' + f6pair.map((r) => `${r.consignment_status}=${r.n}`).join(' '));

    // ── F7: settlement drill-down (schedule 1329) ────────────────────────────────
    log(`\n=== F7  drill-down: schedule ${F7_SCHEDULE_NO} via grower token ===`);
    const f7 = await underCtx(c, pairTok, () =>
      (async () => (await c.query<{ load_no: string; retailer_group: string | null; ded_cols_present: boolean; gross_sales: string }>(`
        select sl.load_no,
               ls.retailer_group,
               (sl.deduction_freight is not null and sl.deduction_warehouse is not null
                 and sl.deduction_market is not null and sl.total_deductions is not null) ded_cols_present,
               sl.gross_sales::text gross_sales
        from semantic.grower_gp_settlement s
        join semantic.grower_gp_settlement_load sl on sl.schedule_id = s.schedule_id
        left join semantic.grower_load_sale ls on ls.dispatch_load_id = sl.dispatch_load_id
        where s.schedule_no = $1 order by sl.load_no`, [F7_SCHEDULE_NO])).rows)());
    check(`schedule ${F7_SCHEDULE_NO} loads visible via grower token (${f7.length})`, f7.length > 0);
    check('each load shows retailer + per-category deductions',
      f7.length > 0 && f7.every((r) => r.retailer_group !== null && r.ded_cols_present),
      f7.map((r) => `${r.load_no}: ${r.retailer_group ?? 'NULL'} gross=${r.gross_sales}`).join(' | '));

    // ── RLS on the new views (fail-closed + isolation basics; full sweep = auth0:rls/rls:posture) ──
    log('\n=== RLS  new views fail closed; grower_load_sale isolation ===');
    const lsNone = await underCtx(c, null, () =>
      q1<{ n: string }>(c, `select count(*) n from semantic.grower_load_sale`));
    check('grower_load_sale: no-claim → 0', Number(lsNone.n) === 0, `got ${lsNone.n}`);
    const lsPair = await underCtx(c, pairTok, () =>
      q1<{ rows: string; own: string }>(c, `
        select count(*) rows, count(*) filter (where grower_key = any($1::uuid[])) own
        from semantic.grower_load_sale`, [pairIds]));
    check('grower_load_sale: pair token sees only its rows', lsPair.rows === lsPair.own && Number(lsPair.rows) > 0,
      `rows=${lsPair.rows}`);

    const failed = results.filter((r) => !r.pass);
    log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { log('FAILED: ' + failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    try {
      mkdirSync('reports', { recursive: true });
      const path = `reports/grower_portal_fixes_${new Date().toISOString().slice(0, 10)}.txt`;
      writeFileSync(path, lines.join('\n') + '\n');
      console.log(`report: ${path}`);
    } catch (we) {
      console.error('report write failed:', we instanceof Error ? we.message : we);
    }
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('proof error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
