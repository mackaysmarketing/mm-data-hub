// Read-only SQL runner for reconciliation. Reads DATABASE_URL from repo .env.
// Usage:
//   node --experimental-strip-types q.ts -f path/to/query.sql
//   node --experimental-strip-types q.ts -e "select 1 as x"
// Prints rows as an aligned table + JSON tail. NEVER writes (read-only intent;
// caller must not pass DML — this is a reconciliation read tool).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

const REPO = 'C:/dev/mm-data-hub-reconcile';
dotenv.config({ path: path.join(REPO, '.env') });

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

const args = process.argv.slice(2);
let sql = '';
const fi = args.indexOf('-f');
const ei = args.indexOf('-e');
if (fi >= 0) sql = readFileSync(args[fi + 1], 'utf8');
else if (ei >= 0) sql = args[ei + 1];
else { console.error('need -f <file> or -e <sql>'); process.exit(2); }

const url = process.env.DATABASE_URL || '';
if (!url.includes('uqzfkhsdyeokwnkpcxui')) {
  console.error('ABORT: DATABASE_URL does not target hub uqzfkhsdyeokwnkpcxui');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, max: 3 });

try {
  const res = await pool.query(sql);
  const rows = Array.isArray(res) ? res[res.length - 1].rows : res.rows;
  if (!rows || rows.length === 0) {
    console.log('(0 rows)');
  } else {
    const cols = Object.keys(rows[0]);
    const widths = cols.map((c) => Math.max(c.length, ...rows.map((r: any) => String(r[c] ?? '∅').length)));
    const fmt = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join(' | ');
    console.log(fmt(cols));
    console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
    for (const r of rows.slice(0, 200)) console.log(fmt(cols.map((c) => String(r[c] ?? '∅'))));
    if (rows.length > 200) console.log(`... (${rows.length} rows total, showing 200)`);
  }
} catch (e) {
  console.error('SQL ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
