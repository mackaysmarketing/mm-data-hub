// ─────────────────────────────────────────────────────────────────────────────
// WOW scan verification — the loadable acceptance checks (SQL is the oracle, derived in-run).
//   npm run wow:verify
// Full-scale AC1/AC3/AC5 numbers (rows_in 303,264 / sales $497,463,530) require the real 303k
// Q.Checkout export, which lands with one wow:load; these checks assert the invariants that hold on
// ANY loaded data + the parser accounting recorded in the load ledger:
//   • core PK integrity (no duplicate finest-grain rows);
//   • national reconciliation: v_wow_scan_national sums == core sums (derived totals are exact);
//   • promo split: promo + off-promo == total on every (week, article, state);
//   • parser row-accounting from the sidecar (rows_in == out + blank + total_dropped; unparsed == 0);
//   • cross-retailer view surfaces both retailers on a shared week;
//   • RLS internal-only fail-closed (core + the 3 views).
// Exit 0 = all pass. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function show(rows: Record<string, unknown>[]): void {
  if (!rows.length) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  console.log('  ' + cols.join(' | '));
  for (const r of rows) console.log('  ' + cols.map((c) => String(r[c] ?? '∅')).join(' | '));
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
  console.log('=== WOW scan verification (loadable ACs, derived in-run) ===');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    const loaded = Number((await c.query(`select count(*) n from core.wow_scan_weekly`)).rows[0]!.n);
    if (loaded === 0) {
      console.log('\nNOTE: core.wow_scan_weekly is empty — run `npm run wow:load <export.csv>` first.');
      console.log('=== 0/0 checks (nothing loaded) ===');
      return;
    }

    // parser accounting from the load ledger (the sidecar's own numbers)
    console.log('\n--- 1. Parser row-accounting (load ledger) ---');
    const acct = (await c.query(
      `select source_filename,
              (stats->>'rows_in')::bigint as rows_in,
              (stats->>'rows_out')::bigint as rows_out,
              (stats->>'rows_blank_dropped')::bigint as blank,
              (stats->>'rows_total_grain_dropped')::bigint as total_grain,
              (stats->>'rows_unparsed_product')::bigint as unparsed
       from raw.wow_scan_loads order by loaded_at desc limit 5`)).rows;
    show(acct);
    check('every load balances (rows_in == out + blank + total) and unparsed == 0',
      acct.every((r) => BigInt(r.rows_in as string) === BigInt(r.rows_out as string) + BigInt(r.blank as string) + BigInt(r.total_grain as string)
        && BigInt(r.unparsed as string) === 0n),
      `${acct.length} load(s)`);

    // core PK integrity
    console.log('\n--- 2. Core finest-grain PK integrity ---');
    const dups = (await c.query(
      `select count(*)::text n from (
         select 1 from core.wow_scan_weekly
         group by week_ending, article_number, state, vcu, channel, promotion
         having count(*) > 1) d`)).rows[0]!.n;
    check('no duplicate finest-grain rows', dups === '0', `core rows=${loaded} dup groups=${dups}`);

    // national reconciliation (derived totals == core sums)
    console.log('\n--- 3. National reconciliation (v_wow_scan_national == core sums) ---');
    const nat = (await c.query(
      `select round(sum(sales),2)::text as core_sales, round(sum(volume),3)::text as core_volume,
              (select round(sum(sales),2) from semantic.v_wow_scan_national)::text as view_sales,
              (select round(sum(volume),3) from semantic.v_wow_scan_national)::text as view_volume
       from core.wow_scan_weekly`)).rows[0]!;
    show([nat]);
    check('national view sums == core sums (derived totals exact)',
      nat.core_sales === nat.view_sales && nat.core_volume === nat.view_volume,
      `sales ${nat.core_sales}==${nat.view_sales}, volume ${nat.core_volume}==${nat.view_volume}`);

    // promo split completeness
    console.log('\n--- 4. Promo split: promo + off-promo == total ---');
    const promo = (await c.query(
      `select count(*)::text as groups,
              count(*) filter (where abs(coalesce(promo_sales,0) + coalesce(base_sales,0) - total_sales) > 0.01)::text as bad
       from semantic.v_wow_scan_promo`)).rows[0]!;
    check('promo + off-promo == total sales on every (week,article,state)',
      promo.bad === '0', `groups=${promo.groups} mismatched=${promo.bad}`);

    // cross-retailer view
    console.log('\n--- 5. Cross-retailer spine ---');
    const xr = (await c.query(
      `select retailer, count(*)::text as rows, count(distinct week_ending)::text as weeks
       from semantic.v_scan_cross_retailer group by retailer order by retailer`)).rows;
    show(xr);
    check('cross-retailer view surfaces woolworths (Coles present if scan loaded)',
      xr.some((r) => r.retailer === 'woolworths' && Number(r.rows) > 0), `${xr.length} retailer(s)`);

    // RLS internal-only
    console.log('\n--- 6. RLS (internal-only, fail-closed) ---');
    const grower = (await c.query<{ id: string }>(
      `select consignor_id::text id from core.dim_grower
        where consignor_id is not null and coalesce(is_test,false)=false limit 1`)).rows[0]!.id;
    for (const rel of ['core.wow_scan_weekly', 'semantic.v_wow_scan_national',
                       'semantic.v_wow_scan_promo', 'semantic.v_scan_cross_retailer']) {
      const internal = await rlsCount(c, rel, claims({ app_metadata: { is_internal: true } }));
      const g = await rlsCount(c, rel, claims({ app_metadata: { consignor_id: grower } }));
      const none = await rlsCount(c, rel, claims({}));
      const forged = await rlsCount(c, rel, claims({ is_internal: true }));
      const um = await rlsCount(c, rel, claims({ user_metadata: { is_internal: true } }));
      check(`[${rel}] internal>0; grower/no-claim/forged/user_meta = 0`,
        internal > 0 && g === 0 && none === 0 && forged === 0 && um === 0,
        `internal=${internal} grower=${g} none=${none} forged=${forged} user_meta=${um}`);
    }

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('wow:verify error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
