// ─────────────────────────────────────────────────────────────────────────────
// Order RLS proof (B2) — the order surface is INTERNAL-ONLY. Proves, across the three
// semantic views (order_headers, order_detail, order_sales), that:
//   • internal (app_metadata.is_internal) sees rows
//   • a grower claim (any app_metadata.consignor_id) sees ZERO — including a claim whose
//     consignor_id MATCHES an order's own seller-consignor (RLS is internal-only, not
//     consignor-matched, so a seller-consignor match cannot leak)
//   • no claim / forged TOP-LEVEL is_internal / forged TOP-LEVEL consignor → ZERO (fail-closed;
//     same app_metadata-only contract as migrations 0008/0010/0024)
//
// Connects as a role that can `set role authenticated` (DATABASE_URL), sets request.jwt.claims per
// context, and queries each view in its own rolled-back transaction. Exit 0 = all pass; 1 = any fail.
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

async function underContext<T>(client: PoolClient, claimsJson: string, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claims', $1, true)", [claimsJson]);
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

async function rows(client: PoolClient, view: string, claimsJson: string): Promise<number> {
  return underContext(client, claimsJson, async () => {
    const r = await client.query<{ n: string }>(`select count(*) n from semantic.${view}`);
    return Number(r.rows[0]!.n);
  });
}

async function proveView(client: PoolClient, view: string, orderConsignor: string, grower: string): Promise<void> {
  console.log(`\n--- semantic.${view} ---`);
  const internal = await rows(client, view, claims({ app_metadata: { is_internal: true } }));
  const growerCtx = await rows(client, view, claims({ app_metadata: { consignor_id: grower } }));
  const sellerCtx = await rows(client, view, claims({ app_metadata: { consignor_id: orderConsignor } }));
  const noClaim = await rows(client, view, claims({}));
  const forgedInternal = await rows(client, view, claims({ is_internal: true })); // top-level, not app_metadata
  const forgedConsignor = await rows(client, view, claims({ consignor_id: orderConsignor, is_internal: true }));

  check(`[${view}] internal sees rows`, internal > 0, `rows=${internal}`);
  check(`[${view}] grower claim → 0`, growerCtx === 0, `rows=${growerCtx}`);
  check(`[${view}] claim matching order's seller-consignor → 0 (no leak)`, sellerCtx === 0, `rows=${sellerCtx}`);
  check(`[${view}] no claim → 0 (fail closed)`, noClaim === 0, `rows=${noClaim}`);
  check(`[${view}] forged top-level is_internal → 0`, forgedInternal === 0, `rows=${forgedInternal}`);
  check(`[${view}] forged top-level consignor+is_internal → 0`, forgedConsignor === 0, `rows=${forgedConsignor}`);
}

async function main(): Promise<void> {
  console.log('=== Order RLS proof (internal-only; header + detail + sales) ===');
  const pool = makePool();
  const client = await pool.connect();
  try {
    // The most common order seller-consignor (used to prove a seller-consignor match still yields 0).
    const orderConsignor = (await client.query<{ consignor_id: string }>(
      `select consignor_id::text consignor_id from core.dim_order
        where consignor_id is not null group by 1 order by count(*) desc limit 1`)).rows[0]?.consignor_id;
    if (!orderConsignor) throw new Error('no order with a consignor_id found — load the order domain first');
    // A real grower consignor from dim_grower (a genuine tenant identity that must NOT see orders).
    const grower = (await client.query<{ consignor_id: string }>(
      `select consignor_id::text consignor_id from core.dim_grower
        where consignor_id is not null and coalesce(is_test,false)=false limit 1`)).rows[0]?.consignor_id ?? orderConsignor;
    console.log(`order seller-consignor sample: ${orderConsignor}`);
    console.log(`grower consignor sample: ${grower}`);

    for (const v of ['order_headers', 'order_detail', 'order_sales']) {
      await proveView(client, v, orderConsignor, grower);
    }

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
