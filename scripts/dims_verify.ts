// ─────────────────────────────────────────────────────────────────────────────
// Conformed-dimension verification (Sprint: closeout C1) — SQL as the oracle.
//   npm run dims:verify
//
// Runs AFTER: 0033/0034 applied, ft:ref:load + entity load run, refresh_dim_customer() /
// refresh_dim_product() / refresh_dim_date() executed, and ft:bridge:core re-run (the 0034
// consignee-join fix only takes effect on a refresh).
//
//   1. dim_customer covers 100% of load + GP + order consignee_ids; named/unnamed counts,
//      the unnamed ids listed (surfaced, never dropped).
//   2. dim_product covers 100% of hub product_ids (pallet ∪ order_item ∪ gp_detail);
//      0 names still carrying SPEC §9.7 display codes (^{…} / [nn]).
//   3. dim_date: 1,461 rows spanning 2024-01-01..2027-12-31; pack_week_code matches load
//      extra_text_2 (anchored on scheduled_pickup_on UTC date) at ≥ the verified rate.
//   4. Settlement bridge: consignee_name coverage > 95%; top-10 customers by grower_gross
//      carry real (non-null, non-blank) names.
//
// Exit 0 = all hard checks pass; 1 = any fail. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

// Measured live 2026-07-11: 22,120 / 22,363 well-formed codes = 98.91% (ISO year-week of the
// load's scheduled_pickup_on UTC date; pack_date anchors top out ~47%). Floor leaves headroom
// for fresh loads whose pickup gets rescheduled after code assignment — the known residual class.
const PACK_WEEK_MATCH_FLOOR_PCT = 98.5;

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
  console.log('=== Conformed-dimension verification (SQL is the oracle) ===');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    // ── 1. dim_customer coverage + name coverage ─────────────────────────────
    console.log('\n--- 1. dim_customer: consignee coverage (load + GP + order) ---');
    const cust = (await c.query(
      `with u as (
         select consignee_id from raw.ft_dispatch_load where consignee_id is not null
         union select consignee_id from raw.ft_gp_detail where consignee_id is not null
         union select consignee_id from raw.ft_gp_schedule where consignee_id is not null
         union select consignee_id from raw.ft_order where consignee_id is not null)
       select (select count(*) from u)::text as referenced_consignees,
              (select count(*) from u
                where exists (select 1 from core.dim_customer dc where dc.consignee_id = u.consignee_id))::text as covered,
              (select count(*) from core.dim_customer)::text as dim_rows,
              (select count(*) from core.dim_customer where name is not null and btrim(name) <> '')::text as named,
              (select count(*) from core.dim_customer where name is null or btrim(name) = '')::text as unnamed`)).rows[0]!;
    table([cust]);
    check('dim_customer covers 100% of load+GP+order consignee_ids',
      cust.referenced_consignees === cust.covered,
      `referenced=${cust.referenced_consignees} covered=${cust.covered} (dim rows=${cust.dim_rows}, named=${cust.named}, unnamed=${cust.unnamed})`);
    console.log('  unnamed consignees (no raw.ft_entity backlink — surfaced, never dropped):');
    const unnamed = (await c.query(
      `select dc.consignee_id::text as consignee_id, dc.vendor_no, dc.b2b_code, dc.is_active::text as is_active,
              (select count(*) from raw.ft_dispatch_load l where l.consignee_id = dc.consignee_id)::text as loads,
              (select count(*) from raw.ft_gp_detail d where d.consignee_id = dc.consignee_id)::text as gp_details,
              (select count(*) from raw.ft_order o where o.consignee_id = dc.consignee_id)::text as orders
       from core.dim_customer dc
       where dc.name is null or btrim(dc.name) = ''
       order by dc.consignee_id`)).rows;
    table(unnamed);

    // ── 2. dim_product coverage + clean names ────────────────────────────────
    console.log('\n--- 2. dim_product: product coverage + display-code-free names ---');
    const prod = (await c.query(
      `with p as (
         select product_id from raw.ft_pallet where product_id is not null
         union select product_id from raw.ft_order_item where product_id is not null
         union select product_id from raw.ft_gp_detail where product_id is not null)
       select (select count(*) from p)::text as hub_products,
              (select count(*) from p
                where exists (select 1 from core.dim_product dp where dp.product_id = p.product_id))::text as covered,
              (select count(*) from core.dim_product)::text as dim_rows,
              (select count(*) from core.dim_product
                where name ~ '\\^\\{' or name ~ '\\[\\d+\\]')::text as names_with_codes,
              (select count(*) from core.dim_product where name is null)::text as null_names`)).rows[0]!;
    table([prod]);
    check('dim_product covers 100% of hub product_ids',
      prod.hub_products === prod.covered,
      `hub products=${prod.hub_products} covered=${prod.covered} (dim rows=${prod.dim_rows})`);
    check('0 product names carry ^{…}/[nn] display codes',
      prod.names_with_codes === '0',
      `names_with_codes=${prod.names_with_codes} null_names=${prod.null_names}`);

    // ── 3. dim_date structure + pack-week rule ───────────────────────────────
    console.log('\n--- 3. dim_date: span + pack-week code vs load extra_text_2 ---');
    const dd = (await c.query(
      `select count(*)::text as rows, min(date)::text as min_date, max(date)::text as max_date,
              count(distinct pack_week_code)::text as distinct_pack_weeks
       from core.dim_date`)).rows[0]!;
    table([dd]);
    check('dim_date spans 2024-01-01..2027-12-31 (1,461 rows)',
      dd.rows === '1461' && dd.min_date === '2024-01-01' && dd.max_date === '2027-12-31',
      `rows=${dd.rows} span=${dd.min_date}..${dd.max_date}`);
    const pw = (await c.query(
      `select count(*)::text as loads,
              count(*) filter (where dd.pack_week_code = l.extra_text_2)::text as matched,
              round(100.0 * count(*) filter (where dd.pack_week_code = l.extra_text_2) / count(*), 2)::text as pct
       from raw.ft_dispatch_load l
       join core.dim_date dd on dd.date = (l.scheduled_pickup_on at time zone 'UTC')::date
       where l.extra_text_2 ~ '^Y\\d{2}W\\d{2}$' and l.scheduled_pickup_on is not null`)).rows[0]!;
    table([pw]);
    check(`pack_week_code matches load extra_text_2 at ≥ ${PACK_WEEK_MATCH_FLOOR_PCT}% (measured 98.91% on 2026-07-11)`,
      Number(pw.pct) >= PACK_WEEK_MATCH_FLOOR_PCT,
      `matched=${pw.matched}/${pw.loads} (${pw.pct}%) — anchor = scheduled_pickup_on UTC date; residual = pickup reschedules after code assignment`);

    // ── 4. Settlement bridge consignee names ─────────────────────────────────
    console.log('\n--- 4. settlement bridge: consignee_name coverage + top-10 customers ---');
    const br = (await c.query(
      `select count(*)::text as bridge_rows,
              count(consignee_name)::text as with_name,
              round(100.0 * count(consignee_name) / nullif(count(*), 0), 2)::text as pct_named
       from core.fact_settlement_bridge`)).rows[0]!;
    table([br]);
    check('bridge consignee_name coverage > 95%',
      Number(br.pct_named) > 95,
      `named=${br.with_name}/${br.bridge_rows} (${br.pct_named}%)`);
    const top = (await c.query(
      `select consignee_id::text as consignee_id, consignee_name,
              count(*)::text as detail_rows,
              round(sum(grower_gross), 2)::text as grower_gross
       from core.fact_settlement_bridge
       group by consignee_id, consignee_name
       order by sum(grower_gross) desc nulls last
       limit 10`)).rows;
    console.log('  top 10 customers by grower_gross:');
    table(top);
    check('top-10 customers by grower_gross all carry real names',
      top.length === 10 && top.every((t) => typeof t.consignee_name === 'string' && t.consignee_name.trim() !== ''),
      `named=${top.filter((t) => typeof t.consignee_name === 'string' && t.consignee_name.trim() !== '').length}/10`);

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
