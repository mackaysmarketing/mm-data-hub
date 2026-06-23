// ─────────────────────────────────────────────────────────────────────────────
// FreshTrack read-replica EXPLORE — read-only column maps + tiny samples for the
// tables that matter to the hub: the newly-unblocked GP/settlement set (gp_detail,
// gp_schedule, gp_payment) and the dispatch tables we currently source via GraphQL
// (dispatch_load, pallet, charge_applied). Lets us see FreshTrack's NATIVE schema
// (vs the GraphQL shape we model today) before designing a loader.
//
//   npm run ft:db:explore                 # default target set below
//   node --experimental-strip-types scripts/ft_db_explore.ts gp_detail gp_schedule
//
// STRICTLY READ-ONLY. Caps samples to a few rows; skips geometry/bytea columns so we
// never haul PostGIS blobs. Prints to stdout for eyeballing — sample rows are your own
// grower data, treat the output accordingly.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const SAMPLE_ROWS = 3;

const DEFAULT_TARGETS = [
  'gp_detail',
  'gp_schedule',
  'gp_payment',
  'dispatch_load',
  'pallet',
  'charge_applied',
];

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

interface Col {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
}

async function main(): Promise<void> {
  const url = process.env.FRESHTRACK_DATABASE_URL;
  if (!url || url.trim() === '') throw new Error('Missing FRESHTRACK_DATABASE_URL in .env');

  const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;

  const client = new Client({
    connectionString: noVerifySsl(url),
    ssl: { rejectUnauthorized: false },
    application_name: 'mm-data-hub ft:db:explore (readonly)',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
  });

  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');

    for (const table of targets) {
      console.log(`\n${'═'.repeat(78)}\n  public.${table}\n${'═'.repeat(78)}`);

      // Exact row count is cheap enough at these sizes and worth having vs the estimate.
      const cnt = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${table}`);
      console.log(`  rows: ${cnt.rows[0]?.n ?? '?'}`);

      const cols = await client.query<Col>(
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1
          ORDER BY ordinal_position`,
        [table],
      );
      console.log(`  columns (${cols.rows.length}):`);
      for (const c of cols.rows) {
        const t = c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
        console.log(`    ${c.column_name.padEnd(32)} ${t}${c.is_nullable === 'NO' ? '  NOT NULL' : ''}`);
      }

      // Sample rows — skip geometry/bytea so we don't haul PostGIS/binary blobs.
      const safeCols = cols.rows
        .filter((c) => !['geometry', 'geography', 'bytea'].includes(c.udt_name))
        .map((c) => `"${c.column_name}"`);
      if (safeCols.length === 0) continue;

      const sample = await client.query(
        `SELECT ${safeCols.join(', ')} FROM public.${table} ORDER BY 1 DESC LIMIT ${SAMPLE_ROWS}`,
      );
      console.log(`  sample (${sample.rows.length} row(s), newest by first column):`);
      sample.rows.forEach((row, i) => {
        console.log(`  ── row ${i + 1} ${'─'.repeat(60)}`);
        for (const [k, v] of Object.entries(row)) {
          let disp = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (disp.length > 120) disp = disp.slice(0, 117) + '…';
          console.log(`    ${k.padEnd(32)} ${disp}`);
        }
      });
    }
    console.log('\n=== EXPLORE done (read-only). ===');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('\nEXPLORE FAIL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
