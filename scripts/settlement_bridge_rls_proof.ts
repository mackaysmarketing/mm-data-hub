// ─────────────────────────────────────────────────────────────────────────────
// Settlement-bridge RLS proof — the bridge surface is INTERNAL-ONLY (selling prices +
// Mackays revenue must never reach a grower surface or the grower MCP). Proves, across the
// bridge fact, the revenue fact, and all four semantic views, that:
//   • internal (app_metadata.is_internal) sees rows
//   • a REAL grower claim sees ZERO — including a grower who genuinely has settled rows in the
//     bridge (their own settlement data does NOT entitle them to the sell side)
//   • no claim / forged TOP-LEVEL is_internal / forged TOP-LEVEL consignor → ZERO (fail-closed;
//     same app_metadata-only contract as migrations 0008/0010/0024/0031)
//
// The revenue surfaces (fact_revenue_charge, mackays_revenue_fresh) are EMPTY until the
// revenue-class checkpoint marking: until dim_gp_charge.revenue_class is populated, the internal
// context is expected to see 0 rows there; once marked, this same proof requires > 0.
//   npm run ft:bridge:rls
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
    const r = await client.query<{ n: string }>(`select count(*) n from ${rel}`);
    return Number(r.rows[0]!.n);
  } finally {
    await client.query('rollback');
  }
}

async function proveRel(client: PoolClient, rel: string, grower: string, internalMayBeEmpty: boolean): Promise<void> {
  console.log(`\n--- ${rel} ---`);
  const internal = await rows(client, rel, claims({ app_metadata: { is_internal: true } }));
  const growerCtx = await rows(client, rel, claims({ app_metadata: { consignor_id: grower } }));
  const noClaim = await rows(client, rel, claims({}));
  const forgedInternal = await rows(client, rel, claims({ is_internal: true })); // top-level, not app_metadata
  const forgedBoth = await rows(client, rel, claims({ consignor_id: grower, is_internal: true }));

  if (internalMayBeEmpty) {
    check(`[${rel}] internal readable (pre-checkpoint: 0 rows expected)`, internal >= 0, `rows=${internal}`);
  } else {
    check(`[${rel}] internal sees rows`, internal > 0, `rows=${internal}`);
  }
  check(`[${rel}] settled grower's own claim → 0 (sell side never leaks)`, growerCtx === 0, `rows=${growerCtx}`);
  check(`[${rel}] no claim → 0 (fail closed)`, noClaim === 0, `rows=${noClaim}`);
  check(`[${rel}] forged top-level is_internal → 0`, forgedInternal === 0, `rows=${forgedInternal}`);
  check(`[${rel}] forged top-level consignor+is_internal → 0`, forgedBoth === 0, `rows=${forgedBoth}`);
}

async function main(): Promise<void> {
  console.log('=== Settlement-bridge RLS proof (internal-only; fact + revenue fact + 4 views) ===');
  const pool = makePool();
  const client = await pool.connect();
  try {
    // A grower who actually HAS rows in the bridge — the strongest no-leak subject.
    const grower = (await client.query<{ consignor_id: string }>(
      `select consignor_id::text consignor_id from core.fact_settlement_bridge
        where consignor_id is not null group by 1 order by count(*) desc limit 1`)).rows[0]?.consignor_id;
    if (!grower) throw new Error('bridge fact is empty — run ft:bridge:core first');
    console.log(`settled grower consignor (has bridge rows): ${grower}`);

    // Revenue surfaces stay empty until the checkpoint marking lands.
    const marked = Number((await client.query<{ n: string }>(
      `select count(*)::text n from core.dim_gp_charge where revenue_class is not null`)).rows[0]!.n);
    console.log(`dim_gp_charge rows with revenue_class marked: ${marked}`);

    await proveRel(client, 'core.fact_settlement_bridge', grower, false);
    await proveRel(client, 'core.fact_revenue_charge', grower, marked === 0);
    await proveRel(client, 'semantic.settlement_bridge_by_grower', grower, false);
    await proveRel(client, 'semantic.settlement_bridge_by_product', grower, false);
    await proveRel(client, 'semantic.settlement_bridge_by_customer', grower, false);
    await proveRel(client, 'semantic.mackays_revenue_fresh', grower, marked === 0);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    client.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('RLS proof error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
