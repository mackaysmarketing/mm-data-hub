// ─────────────────────────────────────────────────────────────────────────────
// FreshTrack GP (grower-pool settlement) PROFILE + hub conformance check. Read-only.
// Answers "is this real, usable test data, and does it slot into the hub's model?":
//   • volumes, date ranges, $ totals, paid/unpaid for gp_schedule / gp_detail / gp_payment
//   • load-lineage coverage: % of gp_detail rows carrying a dispatch_load_id (the grain
//     NetSuite settlement could NOT provide)
//   • CONFORMANCE: do gp_schedule.consignor_id values exist in the hub core.dim_grower?
//
//   npm run ft:db:gp-profile      (needs FRESHTRACK_DATABASE_URL + DATABASE_URL)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

function ftClient(url: string): pg.Client {
  return new Client({
    connectionString: noVerifySsl(url),
    ssl: { rejectUnauthorized: false },
    application_name: 'mm-data-hub ft:db:gp-profile (readonly)',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
  });
}

async function main(): Promise<void> {
  const ftUrl = process.env.FRESHTRACK_DATABASE_URL;
  const hubUrl = process.env.DATABASE_URL;
  if (!ftUrl) throw new Error('Missing FRESHTRACK_DATABASE_URL');

  const ft = ftClient(ftUrl);
  await ft.connect();
  try {
    await ft.query('SET default_transaction_read_only = on');

    console.log('=== FreshTrack GP settlement profile (read-only) ===\n');

    const sched = await ft.query(
      `SELECT count(*)::int AS schedules,
              count(DISTINCT consignor_id)::int AS growers,
              min(payable_on)::text AS first_payable,
              max(payable_on)::text AS last_payable,
              count(*) FILTER (WHERE paid_amount_value IS NOT NULL)::int AS with_paid_amount,
              to_char(sum(invoiced_amount_value),'FM999,999,999.00') AS sum_invoiced,
              to_char(sum(paid_amount_value),'FM999,999,999.00') AS sum_paid
         FROM public.gp_schedule`,
    );
    console.log('gp_schedule (settlement headers):');
    console.table(sched.rows);

    const detail = await ft.query(
      `SELECT count(*)::int AS detail_rows,
              count(DISTINCT consignor_id)::int AS growers,
              count(*) FILTER (WHERE dispatch_load_id IS NOT NULL)::int AS with_dispatch_load,
              round(100.0 * count(*) FILTER (WHERE dispatch_load_id IS NOT NULL) / count(*), 1) AS pct_with_load,
              count(*) FILTER (WHERE harvest_load_id IS NOT NULL)::int AS with_harvest_load,
              count(*) FILTER (WHERE price_paid_value IS NOT NULL)::int AS with_price_paid,
              min(created_on)::date::text AS first_created,
              max(created_on)::date::text AS last_created
         FROM public.gp_detail`,
    );
    console.log('\ngp_detail (per dispatch-load settlement lines):');
    console.table(detail.rows);

    const pay = await ft.query(
      `SELECT count(*)::int AS payments,
              count(*) FILTER (WHERE paid_on IS NOT NULL)::int AS with_paid_on,
              count(*) FILTER (WHERE ext_link <> '')::int AS with_ext_link,
              min(paid_on)::text AS first_paid, max(paid_on)::text AS last_paid,
              to_char(sum(amount_value),'FM999,999,999.00') AS sum_amount
         FROM public.gp_payment`,
    );
    console.log('\ngp_payment (settlement payments):');
    console.table(pay.rows);

    const payStatus = await ft.query(
      `SELECT payment_status, sync_status, count(*)::int AS n
         FROM public.gp_payment GROUP BY 1,2 ORDER BY n DESC`,
    );
    console.log('\ngp_payment status × sync_status:');
    console.table(payStatus.rows);

    // ── Conformance to the hub grower dimension ────────────────────────────────
    const consignors = await ft.query<{ consignor_id: string }>(
      `SELECT DISTINCT consignor_id FROM public.gp_schedule WHERE consignor_id IS NOT NULL`,
    );
    const ids = consignors.rows.map((r) => r.consignor_id);
    console.log(`\nDistinct gp_schedule consignors: ${ids.length}`);

    if (!hubUrl) {
      console.log('(DATABASE_URL not set — skipping hub core.dim_grower conformance check)');
    } else {
      const hub = new Client({
        connectionString: noVerifySsl(hubUrl),
        ssl: { rejectUnauthorized: false },
        application_name: 'mm-data-hub ft:db:gp-profile (hub check)',
        connectionTimeoutMillis: 15_000,
        statement_timeout: 30_000,
      });
      await hub.connect();
      try {
        const match = await hub.query<{ matched: number; total: number }>(
          `SELECT count(*) FILTER (WHERE g.consignor_id IS NOT NULL)::int AS matched,
                  count(*)::int AS total
             FROM unnest($1::uuid[]) AS x(consignor_id)
             LEFT JOIN core.dim_grower g ON g.consignor_id = x.consignor_id`,
          [ids],
        );
        const m = match.rows[0];
        if (!m) throw new Error('conformance query returned no row');
        console.log(
          `Hub core.dim_grower conformance: ${m.matched}/${m.total} GP consignors exist in dim_grower` +
            (m.matched === m.total ? '  ✅ (all conform)' : '  ⚠️ (some unmapped — surface, do not drop)'),
        );
      } finally {
        await hub.end();
      }
    }

    console.log('\n=== PROFILE done (read-only). ===');
  } finally {
    await ft.end();
  }
}

main().catch((e) => {
  console.error('\nPROFILE FAIL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
