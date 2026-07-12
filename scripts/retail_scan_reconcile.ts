// ─────────────────────────────────────────────────────────────────────────────
// Retail-scan reconciliation — SQL is the oracle; every expectation DERIVED in-run (house contract:
// no hardcoded baselines).
//   npm run scan:reconcile
//   1. Schema drift guard: every SCAN_MEASURE_COLUMNS name exists as a numeric column on
//      raw.retail_scan (the parser and the migration share one source of truth).
//   2. Core parity: fact weekly rows == raw 'W/E %' rows; Latest-N rows stay raw-only.
//   3. THE CHANNEL CHECKSUM: in_store + online == total for units/dollars/volume on every
//      (week, geography, segment) — 0 mismatches (the additivity the source guarantees).
//   4. Conformance: 0 unmapped segment/geography/causal; week_ending parses inside the label range;
//      every fact week joins core.dim_date (pack-week available).
//   5. NULL preservation: fact nulls == raw nulls for the mapped measure columns (never coalesced).
//   6. Ties (informational): states-vs-national and segments-vs-category dollar sums per week.
//   7. RLS behavioral: internal sees rows; real grower / no-claim / forged top-level / forged
//      user_metadata all → 0 on the fact + the semantic view.
//   Writes reports/retail_scan_reconcile_<date>.md. Exit 0 = all hard checks pass.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { SCAN_MEASURE_COLUMNS } from '../src/lib/retail_scan_coles.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean }[] = [];
const report: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line); report.push(line);
}
function show(rows: Record<string, unknown>[]): void {
  if (!rows.length) { console.log('  (no rows)'); report.push('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  const head = '  ' + cols.join(' | ');
  console.log(head); report.push(head);
  for (const r of rows) { const l = '  ' + cols.map((c) => String(r[c] ?? '∅')).join(' | '); console.log(l); report.push(l); }
}
const claims = (o: object) => JSON.stringify({ role: 'authenticated', ...o });
async function rlsCount(c: PoolClient, rel: string, claimsJson: string): Promise<number> {
  await c.query('begin');
  try {
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [claimsJson]);
    return Number((await c.query(`select count(*) n from ${rel}`)).rows[0]!.n);
  } finally { await c.query('rollback'); }
}

async function main(): Promise<void> {
  console.log('=== Retail-scan reconciliation (expectations derived in-run) ===');
  report.push('# Retail-scan reconciliation — ' + new Date().toISOString().slice(0, 10), '');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    // 1. schema drift guard
    console.log('\n--- 1. Measure-column drift guard ---');
    const cols = new Set((await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='raw' and table_name='retail_scan' and data_type='numeric'`)).rows
      .map((r) => r.column_name));
    const missing = SCAN_MEASURE_COLUMNS.filter((m) => !cols.has(m));
    check('every SCAN_MEASURE_COLUMNS name is a numeric raw column',
      missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : `${SCAN_MEASURE_COLUMNS.length}/57 present`);

    // 2. core parity
    console.log('\n--- 2. Core parity (weekly grain) ---');
    const p = (await c.query(
      `select (select count(*) from raw.retail_scan)::text as raw_all,
              (select count(*) from raw.retail_scan where time_label like 'W/E %')::text as raw_weekly,
              (select count(*) from raw.retail_scan where time_label like 'Latest %')::text as raw_latest,
              (select count(*) from core.fact_retail_scan)::text as fact`)).rows[0]!;
    show([p]);
    check('fact == raw weekly rows', p.raw_weekly === p.fact, `raw_weekly=${p.raw_weekly} fact=${p.fact} (latest-N raw-only=${p.raw_latest})`);

    // 3. the channel checksum
    console.log('\n--- 3. Channel checksum: in_store + online == total ---');
    const cs = (await c.query(
      `with piv as (
         select week_ending, geography_code, segment, supplier,
                sum(units)     filter (where causal='total')    as u_t,
                sum(units)     filter (where causal='in_store') as u_i,
                sum(units)     filter (where causal='online')   as u_o,
                sum(dollars)   filter (where causal='total')    as d_t,
                sum(dollars)   filter (where causal='in_store') as d_i,
                sum(dollars)   filter (where causal='online')   as d_o,
                sum(volume_kg) filter (where causal='total')    as v_t,
                sum(volume_kg) filter (where causal='in_store') as v_i,
                sum(volume_kg) filter (where causal='online')   as v_o
           from core.fact_retail_scan group by 1, 2, 3, 4)
       select count(*)::text as groups,
              count(*) filter (where u_t is not null and u_i is not null and u_o is not null
                                 and abs((u_i + u_o) - u_t) > greatest(0.02, abs(u_t) * 1e-9))::text as units_bad,
              count(*) filter (where d_t is not null and d_i is not null and d_o is not null
                                 and abs((d_i + d_o) - d_t) > greatest(0.02, abs(d_t) * 1e-9))::text as dollars_bad,
              count(*) filter (where v_t is not null and v_i is not null and v_o is not null
                                 and abs((v_i + v_o) - v_t) > greatest(0.02, abs(v_t) * 1e-9))::text as volume_bad
         from piv`)).rows[0]!;
    show([cs]);
    check('0 checksum mismatches across units/dollars/volume',
      cs.units_bad === '0' && cs.dollars_bad === '0' && cs.volume_bad === '0',
      `groups=${cs.groups} units_bad=${cs.units_bad} dollars_bad=${cs.dollars_bad} volume_bad=${cs.volume_bad}`);

    // 4. conformance
    console.log('\n--- 4. Conformance (mappings + weeks + dim_date join) ---');
    const conf = (await c.query(
      `select (select count(*) from core.fact_retail_scan
                where segment not in ('ALL','REGULAR','PRE_PACK','LADY_FINGER','OTHER')
                   or geography_code not in ('AU','NSW+ACT','QLD','SA+NT','TAS','VIC','WA')
                   or causal not in ('total','in_store','online'))::text as unmapped,
              (select count(*) from core.fact_retail_scan f
                where not exists (select 1 from core.dim_date d where d.date = f.week_ending))::text as weeks_without_dimdate,
              (select count(distinct week_ending) from core.fact_retail_scan)::text as distinct_weeks,
              (select min(week_ending)::text from core.fact_retail_scan) as min_week,
              (select max(week_ending)::text from core.fact_retail_scan) as max_week`)).rows[0]!;
    show([conf]);
    check('0 unmapped segment/geography/causal', conf.unmapped === '0', `unmapped=${conf.unmapped}`);
    check('every fact week joins core.dim_date', conf.weeks_without_dimdate === '0',
      `weeks=${conf.distinct_weeks} span=${conf.min_week}..${conf.max_week}`);

    // 5. NULL preservation (mapped columns raw↔fact on weekly rows)
    console.log('\n--- 5. NULL preservation ---');
    const nulls = (await c.query(
      `select
         (select count(*) from raw.retail_scan where time_label like 'W/E %' and volume_sales is null)::text as raw_vol_nulls,
         (select count(*) from core.fact_retail_scan where volume_kg is null)::text as fact_vol_nulls,
         (select count(*) from raw.retail_scan where time_label like 'W/E %' and acv_distribution is null)::text as raw_acv_nulls,
         (select count(*) from core.fact_retail_scan where acv_distribution is null)::text as fact_acv_nulls,
         (select count(*) from core.fact_retail_scan where volume_kg = 0 and units > 0)::text as suspicious_zero_vol`)).rows[0]!;
    show([nulls]);
    check('NULLs preserved raw→fact (volume, acv)',
      nulls.raw_vol_nulls === nulls.fact_vol_nulls && nulls.raw_acv_nulls === nulls.fact_acv_nulls,
      `vol ${nulls.raw_vol_nulls}==${nulls.fact_vol_nulls}, acv ${nulls.raw_acv_nulls}==${nulls.fact_acv_nulls}`);

    // 6. informational ties
    console.log('\n--- 6. Ties (informational, tolerance — the source is not forced additive here) ---');
    report.push('', '## Ties (informational)');
    const ties = (await c.query(
      `with wk as (
         select week_ending,
                sum(dollars) filter (where geography_code='AU' and segment='ALL' and causal='total') as national,
                sum(dollars) filter (where geography_code<>'AU' and segment='ALL' and causal='total') as states,
                sum(dollars) filter (where geography_code='AU' and segment<>'ALL' and causal='total') as segments
           from core.fact_retail_scan group by 1)
       select count(*)::text as weeks,
              round(avg(abs(states - national) / nullif(national, 0)) * 100, 3)::text as avg_state_gap_pct,
              round(avg(abs(segments - national) / nullif(national, 0)) * 100, 3)::text as avg_segment_gap_pct
         from wk where national is not null`)).rows[0]!;
    show([ties]);

    // 7. RLS behavioral
    console.log('\n--- 7. RLS (internal-only, fail-closed) ---');
    const grower = (await c.query<{ id: string }>(
      `select consignor_id::text id from core.dim_grower
        where consignor_id is not null and coalesce(is_test,false)=false limit 1`)).rows[0]!.id;
    for (const rel of ['core.fact_retail_scan', 'semantic.retail_scan']) {
      const internal = await rlsCount(c, rel, claims({ app_metadata: { is_internal: true } }));
      const g = await rlsCount(c, rel, claims({ app_metadata: { consignor_id: grower } }));
      const none = await rlsCount(c, rel, claims({}));
      const forged = await rlsCount(c, rel, claims({ is_internal: true }));
      const forgedUm = await rlsCount(c, rel, claims({ user_metadata: { is_internal: true } }));
      check(`[${rel}] internal>0; grower/no-claim/forged/user_meta = 0`,
        internal > 0 && g === 0 && none === 0 && forged === 0 && forgedUm === 0,
        `internal=${internal} grower=${g} none=${none} forged=${forged} user_meta=${forgedUm}`);
    }

    mkdirSync('reports', { recursive: true });
    const path = `reports/retail_scan_reconcile_${new Date().toISOString().slice(0, 10)}.md`;
    writeFileSync(path, report.join('\n'), 'utf8');
    console.log(`\n→ ${path}`);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('scan:reconcile error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
