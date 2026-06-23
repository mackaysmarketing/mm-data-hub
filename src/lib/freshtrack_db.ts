// READ-ONLY access to FreshTrack's production Postgres read-replica. This is the source for the
// GP/settlement domain (gp_*), which the GraphQL API does not expose. NEVER write here — it is a
// replica of FreshTrack's prod DB. The client forces a read-only transaction posture and a
// statement timeout; TLS is "encrypt, don't verify" (RDS presents the Amazon RDS CA, not in Node's
// default trust store) — same posture makePool() uses for the Supabase pooler.
import pg from 'pg';
import { env } from './env.ts';

const { Client } = pg;

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

/** A connected, read-only-pinned client against the FreshTrack replica. Caller must `end()` it. */
export async function connectFreshtrackRead(): Promise<pg.Client> {
  const client = new Client({
    connectionString: noVerifySsl(env.freshtrackDatabaseUrl()),
    ssl: { rejectUnauthorized: false },
    application_name: 'mm-data-hub gp loader (readonly)',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
  });
  await client.connect();
  // Belt-and-braces: the role is already _readonly, but pin the session too.
  await client.query('SET default_transaction_read_only = on');
  return client;
}
