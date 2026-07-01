// One-off migration applier — runs the given supabase/migrations/*.sql files against the HUB via
// DATABASE_URL, guarded by assertHubTarget (so it can only ever hit uqzfkhsdyeokwnkpcxui). The
// order-domain migrations are idempotent (create if not exists / create or replace / drop policy if
// exists), so a re-run is safe. Each file runs inside its own transaction.
//   node --experimental-strip-types scripts/apply_migration.ts supabase/migrations/0023_raw_ft_order.sql ...
import { readFileSync } from 'node:fs';
import { makePool, assertHubTarget } from '../src/lib/db.ts';
import { log } from '../src/lib/util.ts';

async function main(): Promise<void> {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.sql'));
  if (files.length === 0) throw new Error('pass one or more .sql migration paths');
  const pool = makePool();
  try {
    await assertHubTarget(pool);
    for (const f of files) {
      const sql = readFileSync(f, 'utf8');
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(sql);
        await c.query('commit');
        log(`applied: ${f}`);
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw new Error(`FAILED ${f}: ${e instanceof Error ? e.message : String(e)}`);
      } finally { c.release(); }
    }
    log('=== all migrations applied ===');
  } finally { await pool.end(); }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
