// Order-domain acceptance evidence (A2/A3/A5/A6/A8/A10) — prints pasteable proof from the hub.
import { makePool } from '../src/lib/db.ts';
import { log } from '../src/lib/util.ts';

async function main(): Promise<void> {
  const pool = makePool();
  const c = await pool.connect();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  try {
    log('===== A2 — three raw tables land (counts + _raw + PK) =====');
    for (const r of await q(
      `select t.table_name,
              (select count(*) from raw.ft_order       where t.table_name='ft_order') +
              (select count(*) from raw.ft_order_version where t.table_name='ft_order_version') +
              (select count(*) from raw.ft_order_item  where t.table_name='ft_order_item') as rows,
              exists(select 1 from information_schema.columns w
                     where w.table_schema='raw' and w.table_name=t.table_name and w.column_name='_raw') as has_raw,
              (select c2.data_type from information_schema.columns c2
                 where c2.table_schema='raw' and c2.table_name=t.table_name and c2.column_name='id') as id_type
         from (values ('ft_order'),('ft_order_version'),('ft_order_item')) t(table_name)`))
      log(`  ${String((r as any).table_name).padEnd(18)} rows=${String((r as any).rows).padEnd(7)} _raw=${(r as any).has_raw} id_type=${(r as any).id_type}`);

    log('\n===== A3 — enums stored as text; 0 Postgres enum types =====');
    const enums = await q(`select typname from pg_type where typtype='e' order by 1`);
    log(`  enum types in DB: ${enums.length === 0 ? '0 (none)' : enums.map((e: any) => e.typname).join(', ')}`);
    for (const r of await q(
      `select column_name, data_type from information_schema.columns
        where table_schema='raw' and table_name='ft_order' and column_name in ('type','edi_status','gs1_order_type','discount_currency')
        union all
        select column_name, data_type from information_schema.columns
        where table_schema='raw' and table_name='ft_order_item' and column_name in ('price_currency','price_per')
        order by 1`))
      log(`  ${String((r as any).column_name).padEnd(18)} ${(r as any).data_type}`);

    log('\n===== A5 — 0 orders in raw linked to a test entity (join raw.ft_entity) =====');
    const testLinked = await q(
      `select count(*) n from raw.ft_order o
        where exists (select 1 from raw.ft_entity e where e.is_test
                      and (e.consignor_id=o.consignor_id or e.consignee_id=o.consignee_id or e.marketer_id=o.marketer_id))`);
    log(`  test-linked orders in raw.ft_order: ${(testLinked[0] as any).n} (expect 0)`);
    const testEnts = await q(`select code, is_test from raw.ft_entity where code ilike '%TEST' order by code`);
    log(`  test entities present in raw.ft_entity: ${testEnts.map((e: any) => `${e.code}(is_test=${e.is_test})`).join(', ')}`);

    log('\n===== A6 — core.fact_order_item has 0 rows from a non-latest version =====');
    const a6 = await q(
      `select count(*) total, count(*) filter (where order_version_no <> order_latest_version_no) nonlatest
         from core.fact_order_item`);
    log(`  fact rows: ${(a6[0] as any).total}; from a non-latest version: ${(a6[0] as any).nonlatest} (expect 0)`);

    log('\n===== A8 — enums text, currency AUD, join keys, B/S distribution =====');
    log('  order.type distribution at RAW:');
    for (const r of await q(`select type, count(*) n from raw.ft_order group by type order by n desc`))
      log(`    ${(r as any).type ?? '∅'}: ${(r as any).n}`);
    log('  order_type distribution at SEMANTIC (order_headers, service_role bypass):');
    for (const r of await q(`select order_type, count(*) n from semantic.order_headers group by order_type order by n desc`))
      log(`    ${(r as any).order_type ?? '∅'}: ${(r as any).n}`);
    log('  semantic.order_sales order_type (must be S only):');
    for (const r of await q(`select order_type, count(*) n from semantic.order_sales group by order_type order by n desc`))
      log(`    ${(r as any).order_type ?? '∅'}: ${(r as any).n}`);
    const cur = await q(
      `select count(*) total, count(*) filter (where price_currency is not null and price_currency<>'AUD') non_aud
         from core.fact_order_item`);
    log(`  price_currency: ${(cur[0] as any).total} lines; non-AUD (flagged): ${(cur[0] as any).non_aud}`);
    const jk = await q(
      `select count(*) filter (where dispatch_load_id is not null) dl,
              count(*) filter (where po_no is not null and po_no<>'') po,
              count(*) total from core.fact_order_item`);
    log(`  join keys on fact: dispatch_load_id present=${(jk[0] as any).dl}/${(jk[0] as any).total}; po_no present=${(jk[0] as any).po}`);
    const dimjk = await q(
      `select count(*) filter (where latest_version_no is not null) lv,
              count(*) filter (where po_no is not null and po_no<>'') po, count(*) total from core.dim_order`);
    log(`  dim_order join keys: latest_version_no present=${(dimjk[0] as any).lv}/${(dimjk[0] as any).total}; po_no present=${(dimjk[0] as any).po}`);
    log(`  never-coalesced check — orders with NULL total_price_value (header-only or all-null lines):`);
    const nullTot = await q(`select count(*) n from core.dim_order where total_price_value is null`);
    log(`    ${(nullTot[0] as any).n} orders keep NULL total_price_value (not 0)`);

    log('\n===== A10 — raw order tables have RLS enabled (pg_policies) =====');
    for (const r of await q(
      `select tablename, policyname, roles::text, cmd from pg_policies
        where schemaname='raw' and tablename in ('ft_order','ft_order_version','ft_order_item') order by tablename, policyname`))
      log(`  ${String((r as any).tablename).padEnd(18)} ${String((r as any).policyname).padEnd(30)} ${(r as any).roles} ${(r as any).cmd}`);
    for (const r of await q(
      `select relname, relrowsecurity from pg_class where relnamespace='raw'::regnamespace
        and relname in ('ft_order','ft_order_version','ft_order_item') order by relname`))
      log(`  RLS enabled: ${(r as any).relname} = ${(r as any).relrowsecurity}`);
  } finally { c.release(); await pool.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
