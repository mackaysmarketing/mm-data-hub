// ─────────────────────────────────────────────────────────────────────────────
// AR RLS proof — the AR surface is INTERNAL-ONLY (customer book + selling side; never grower-facing).
// Proves across both facts + all three semantic views that:
//   • internal (app_metadata.is_internal) sees rows
//   • a REAL grower claim (a genuine consignor) sees ZERO
//   • no claim / forged TOP-LEVEL is_internal / forged TOP-LEVEL consignor → ZERO (fail-closed;
//     same app_metadata-only contract as 0010/0024/0031/0040)
//   npm run ar:rls
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
const claims = (o: object) => JSON.stringify({ role: 'authenticated', ...o });

async function rows(client: PoolClient, rel: string, claimsJson: string): Promise<number> {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claims', $1, true)", [claimsJson]);
    return Number((await client.query(`select count(*) n from ${rel}`)).rows[0]!.n);
  } finally {
    await client.query('rollback');
  }
}

async function proveRel(client: PoolClient, rel: string, grower: string): Promise<void> {
  console.log(`\n--- ${rel} ---`);
  const internal = await rows(client, rel, claims({ app_metadata: { is_internal: true } }));
  const growerCtx = await rows(client, rel, claims({ app_metadata: { consignor_id: grower } }));
  const noClaim = await rows(client, rel, claims({}));
  const forgedInternal = await rows(client, rel, claims({ is_internal: true }));
  const forgedBoth = await rows(client, rel, claims({ consignor_id: grower, is_internal: true }));
  check(`[${rel}] internal sees rows`, internal > 0, `rows=${internal}`);
  check(`[${rel}] grower claim → 0 (AR never grower-facing)`, growerCtx === 0, `rows=${growerCtx}`);
  check(`[${rel}] no claim → 0 (fail closed)`, noClaim === 0, `rows=${noClaim}`);
  check(`[${rel}] forged top-level is_internal → 0`, forgedInternal === 0, `rows=${forgedInternal}`);
  check(`[${rel}] forged top-level consignor+is_internal → 0`, forgedBoth === 0, `rows=${forgedBoth}`);
}

async function main(): Promise<void> {
  console.log('=== AR RLS proof (internal-only; 2 facts + 3 views) ===');
  const pool = makePool();
  const client = await pool.connect();
  try {
    const grower = (await client.query<{ consignor_id: string }>(
      `select consignor_id::text consignor_id from core.dim_grower
        where consignor_id is not null and coalesce(is_test,false)=false limit 1`)).rows[0]?.consignor_id;
    if (!grower) throw new Error('no grower consignor found');
    console.log(`grower consignor sample: ${grower}`);

    for (const rel of [
      'core.fact_customer_invoice',
      'core.fact_remittance_line',
      'semantic.ar_customer_invoice',
      'semantic.ar_debtor_open',
      'semantic.ar_remittance_reconciliation',
    ]) await proveRel(client, rel, grower);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    client.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('ar:rls error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
