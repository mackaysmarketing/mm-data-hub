// ─────────────────────────────────────────────────────────────────────────────
// FreshTrack GP CHARGE-MODEL profile + reference-view defs. READ-ONLY.
// Locks the deduction taxonomy before the core build:
//   • pg_get_viewdef of public.v_power_bi_charge_split / v_power_bi_charges (FreshTrack's own
//     charge categorisation + GST math — the reference implementation we must reproduce)
//   • charge_type rows (code/name/scope/account_code/is_deductible/netsuite_id)
//   • charge rate-card sample + count (name/charge_type_id/account_code/netsuite_id)
//   • charge_applied columns + volume + is_deductible/vat_info/account-prefix/scope distributions
//   • gp_status rows
//
//   npm run ft:db:charge-profile      (needs FRESHTRACK_DATABASE_URL)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

async function tryQuery(ft: pg.Client, label: string, sql: string, params: unknown[] = []): Promise<void> {
  try {
    const r = await ft.query(sql, params);
    console.log(`\n── ${label} (${r.rowCount} rows) ──`);
    console.table(r.rows);
  } catch (e) {
    console.log(`\n── ${label} — ERROR: ${e instanceof Error ? e.message : e}`);
  }
}

async function main(): Promise<void> {
  const ftUrl = process.env.FRESHTRACK_DATABASE_URL;
  if (!ftUrl) throw new Error('Missing FRESHTRACK_DATABASE_URL');

  const ft = new Client({
    connectionString: noVerifySsl(ftUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'mm-data-hub ft:db:charge-profile (readonly)',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
  });
  await ft.connect();
  try {
    await ft.query('SET default_transaction_read_only = on');
    console.log('=== FreshTrack GP charge-model profile (read-only) ===');

    // ── Reference view defs ────────────────────────────────────────────────────
    for (const v of ['v_power_bi_charge_split', 'v_power_bi_charges']) {
      try {
        const def = await ft.query<{ def: string }>(`SELECT pg_get_viewdef('public.${v}'::regclass, true) AS def`);
        console.log(`\n========== public.${v} ==========\n${def.rows[0]?.def ?? '(none)'}`);
      } catch (e) {
        console.log(`\n========== public.${v} — ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }

    // ── charge_type (the taxonomy dimension) ───────────────────────────────────
    await tryQuery(ft, 'charge_type columns',
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='charge_type' ORDER BY ordinal_position`);
    await tryQuery(ft, 'charge_type ALL rows',
      `SELECT id, code, name, scope, account_code, is_deductible, netsuite_id FROM public.charge_type ORDER BY account_code NULLS FIRST, code`);

    // ── charge (rate card) ─────────────────────────────────────────────────────
    await tryQuery(ft, 'charge columns',
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='charge' ORDER BY ordinal_position`);
    await tryQuery(ft, 'charge count + netsuite_id coverage',
      `SELECT count(*)::int AS charges,
              count(netsuite_id)::int AS with_netsuite_id,
              count(DISTINCT charge_type_id)::int AS distinct_charge_types,
              count(DISTINCT account_code)::int AS distinct_account_codes
         FROM public.charge`);
    await tryQuery(ft, 'charge sample (20)',
      `SELECT c.id, c.name, c.account_code, c.netsuite_id, ct.code AS ct_code, ct.scope AS ct_scope
         FROM public.charge c LEFT JOIN public.charge_type ct ON ct.id = c.charge_type_id
        ORDER BY c.name LIMIT 20`);

    // ── charge_applied (the deduction ledger) ──────────────────────────────────
    await tryQuery(ft, 'charge_applied columns',
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='charge_applied' ORDER BY ordinal_position`);
    await tryQuery(ft, 'charge_applied volume',
      `SELECT count(*)::int AS rows,
              count(DISTINCT gp_schedule_id)::int AS schedules,
              count(DISTINCT gp_detail_id)::int AS details,
              count(DISTINCT dispatch_load_id)::int AS loads,
              count(DISTINCT charge_id)::int AS charges,
              count(*) FILTER (WHERE is_deductible)::int AS deductible_rows,
              to_char(sum(total_amount_value) FILTER (WHERE is_deductible),'FM999,999,999.00') AS sum_deductible,
              to_char(sum(total_amount_value),'FM999,999,999.00') AS sum_all
         FROM public.charge_applied`);
    await tryQuery(ft, 'charge_applied sample (15)',
      `SELECT id, gp_schedule_id, dispatch_load_id, charge_id, account_code, is_deductible, total_amount_value, vat_info, text_1
         FROM public.charge_applied LIMIT 15`);
    await tryQuery(ft, 'charge_applied vat_info distribution',
      `SELECT vat_info, count(*)::int AS n,
              to_char(sum(total_amount_value),'FM999,999,999.00') AS sum_amount
         FROM public.charge_applied GROUP BY vat_info ORDER BY n DESC`);
    await tryQuery(ft, 'charge_applied account_code first-digit × is_deductible',
      `SELECT left(account_code,1) AS acct_prefix, is_deductible, count(*)::int AS n,
              to_char(sum(total_amount_value),'FM999,999,999.00') AS sum_amount
         FROM public.charge_applied GROUP BY 1,2 ORDER BY 1,2`);
    await tryQuery(ft, 'charge_applied × charge_type.scope (taxonomy join)',
      `SELECT ct.scope, ct.code AS ct_code, ca.is_deductible, count(*)::int AS n,
              to_char(sum(ca.total_amount_value),'FM999,999,999.00') AS sum_amount
         FROM public.charge_applied ca
         LEFT JOIN public.charge c ON c.id = ca.charge_id
         LEFT JOIN public.charge_type ct ON ct.id = c.charge_type_id
        GROUP BY 1,2,3 ORDER BY ct.scope NULLS FIRST, n DESC`);

    // ── gp_status ──────────────────────────────────────────────────────────────
    await tryQuery(ft, 'gp_status ALL rows',
      `SELECT * FROM public.gp_status ORDER BY 1`);

    // ── gp_schedule status distribution (PA/PD/DR) ─────────────────────────────
    await tryQuery(ft, 'gp_schedule × gp_status',
      `SELECT s.code AS status_code, s.name AS status_name, count(*)::int AS schedules
         FROM public.gp_schedule g LEFT JOIN public.gp_status s ON s.id = g.gp_status_id
        GROUP BY 1,2 ORDER BY schedules DESC`);

    console.log('\n=== CHARGE PROFILE done (read-only). ===');
  } finally {
    await ft.end();
  }
}

main().catch((e) => {
  console.error('\nCHARGE PROFILE FAIL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
