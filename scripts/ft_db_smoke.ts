// ─────────────────────────────────────────────────────────────────────────────
// FreshTrack read-replica smoke — the live gate for DIRECT Postgres access to
// FreshTrack's production RDS (cloud_mackaysmarketing_readonly). Until now FreshTrack
// was reachable ONLY via its GraphQL API; the read-replica was blocked across sprints
// (readonlyDatabaseCredentials returned null). This proves the freshly-provided
// FRESHTRACK_DATABASE_URL connects and is queryable, BEFORE any loader is written.
//
//   npm run ft:db:smoke        (needs FRESHTRACK_DATABASE_URL in .env)
//
// STRICTLY READ-ONLY: this is a replica of FreshTrack's prod DB. Never write. The script
// only runs SELECTs, sets a default_transaction_read_only + statement_timeout guard, and
// prints identity + schema shape (no row PII). Exit 0 = connected + queryable.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

/** Encrypt without chain verification (RDS presents the Amazon RDS CA, not in Node's
 *  default store). String-only rewrite so a password with special chars is untouched. */
function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

async function main(): Promise<void> {
  const url = process.env.FRESHTRACK_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Missing FRESHTRACK_DATABASE_URL in .env');
  }

  console.log('=== FreshTrack read-replica smoke (live, read-only) ===\n');

  const client = new Client({
    connectionString: noVerifySsl(url),
    ssl: { rejectUnauthorized: false },
    application_name: 'mm-data-hub ft:db:smoke (readonly)',
    // Fail fast rather than hang if the RDS security group blocks our egress IP.
    connectionTimeoutMillis: 15_000,
    statement_timeout: 20_000,
  });

  await client.connect();
  try {
    // Belt-and-braces: force this session read-only even though the role is _readonly.
    await client.query('SET default_transaction_read_only = on');

    // 1) Identity — who/where are we connected as.
    const id = await client.query<{
      version: string; usr: string; db: string; server_ip: string | null; now: string;
    }>(
      `SELECT version() AS version, current_user AS usr, current_database() AS db,
              host(inet_server_addr()) AS server_ip, now()::text AS now`,
    );
    const r = id.rows[0];
    if (!r) throw new Error('identity query returned no row');
    console.log(`PASS  connected`);
    console.log(`      user:     ${r.usr}`);
    console.log(`      database: ${r.db}`);
    console.log(`      server:   ${r.server_ip ?? '(n/a)'}`);
    console.log(`      now:      ${r.now}`);
    console.log(`      ${r.version.split(',')[0]}\n`);

    // 2) Schemas with table counts (exclude system + internal schemas).
    const schemas = await client.query<{ schema: string; tables: number }>(
      `SELECT n.nspname AS schema, count(c.oid)::int AS tables
         FROM pg_namespace n
         LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m')
        WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
        GROUP BY n.nspname
        HAVING count(c.oid) > 0
        ORDER BY tables DESC`,
    );
    console.log(`PASS  ${schemas.rows.length} non-system schema(s) with relations:`);
    for (const s of schemas.rows) console.log(`      ${s.schema.padEnd(28)} ${s.tables} relations`);
    console.log('');

    // 3) Largest tables by ESTIMATED row count (pg_class.reltuples — no expensive count(*)).
    const tables = await client.query<{
      schema: string; table: string; est_rows: number; size: string;
    }>(
      `SELECT n.nspname AS schema, c.relname AS table,
              c.reltuples::bigint AS est_rows,
              pg_size_pretty(pg_total_relation_size(c.oid)) AS size
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p')
          AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        ORDER BY c.reltuples DESC
        LIMIT 30`,
    );
    console.log(`PASS  top ${tables.rows.length} tables by estimated row count:`);
    console.log(`      ${'schema.table'.padEnd(48)} ${'est_rows'.padStart(12)}  size`);
    for (const t of tables.rows) {
      console.log(
        `      ${`${t.schema}.${t.table}`.padEnd(48)} ${String(t.est_rows).padStart(12)}  ${t.size}`,
      );
    }
    console.log('');

    console.log('=== SMOKE PASS — FreshTrack read-replica is reachable and queryable. ===');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('\nSMOKE FAIL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
