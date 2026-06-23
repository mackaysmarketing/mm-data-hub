// ─────────────────────────────────────────────────────────────────────────────
// GP settlement RLS proof — semantic.grower_gp_settlement (schedule grain) AND
// semantic.grower_gp_settlement_load (load grain) under five security contexts.
//   npm run ft:gp:rls
//
// Connects as a role that can `set role authenticated` (DATABASE_URL), then per context sets
// request.jwt.claims and queries each view (each in its own rolled-back transaction). Proves the
// SAME app_metadata-only, fail-closed contract as 0008/0010/0016/0020, on BOTH grains:
//   • grower A sees ONLY its own settlements (0 of B)        • grower B likewise (disjoint)
//   • internal (app_metadata.is_internal) sees ALL           • no claim → 0 (fail closed)
//   • forged TOP-LEVEL consignor_id / is_internal → 0        • A filtering to B → 0 (no widening)
// RLS anchors on the SCHEDULE consignor on BOTH views (never the gp_detail/original-load consignor).
//
// Exit 0 = all pass; 1 = any failure.
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

interface Vis { rows: number; growers: number; a: number; b: number }
async function visible(client: PoolClient, view: string, claimsJson: string, A: string, B: string): Promise<Vis> {
  return underContext(client, claimsJson, async () => {
    const r = await client.query<{ rows: string; growers: string; a: string; b: string }>(
      `select count(*) rows, count(distinct grower_key) growers,
              count(*) filter (where grower_key = $1) a,
              count(*) filter (where grower_key = $2) b
         from semantic.${view}`,
      [A, B],
    );
    const row = r.rows[0]!;
    return { rows: Number(row.rows), growers: Number(row.growers), a: Number(row.a), b: Number(row.b) };
  });
}

async function proveView(client: PoolClient, view: string, A: string, B: string, aCode: string, bCode: string): Promise<void> {
  console.log(`\n--- ${view} ---`);
  const internal = await visible(client, view, claims({ app_metadata: { is_internal: true } }), A, B);
  const a = await visible(client, view, claims({ app_metadata: { consignor_id: A } }), A, B);
  const b = await visible(client, view, claims({ app_metadata: { consignor_id: B } }), A, B);
  const noClaim = await visible(client, view, claims({}), A, B);
  const forged = await visible(client, view, claims({ consignor_id: A, is_internal: true }), A, B);

  check(`[${view}] internal sees all`, internal.rows > 0 && internal.growers > 1 && internal.a > 0 && internal.b > 0,
    `rows=${internal.rows} growers=${internal.growers}`);
  check(`[${view}] grower ${aCode} sees only itself`, a.rows === internal.a && a.growers === 1 && a.b === 0,
    `rows=${a.rows} (internal-A=${internal.a}) growers=${a.growers} B-rows=${a.b}`);
  check(`[${view}] grower ${bCode} sees only itself`, b.rows === internal.b && b.growers === 1 && b.a === 0,
    `rows=${b.rows} (internal-B=${internal.b}) growers=${b.growers} A-rows=${b.a}`);
  check(`[${view}] A and B disjoint`, a.b === 0 && b.a === 0, 'no shared rows');
  check(`[${view}] no-claim is fail-closed`, noClaim.rows === 0, `rows=${noClaim.rows}`);
  check(`[${view}] forged top-level claims → 0`, forged.rows === 0, `rows=${forged.rows}`);

  // A cannot widen to B even by selecting B explicitly (RLS on the base fact).
  const aFilterB = await underContext(client, claims({ app_metadata: { consignor_id: A } }), async () => {
    const r = await client.query<{ c: string }>(
      `select count(*) c from semantic.${view} where grower_key = $1`, [B]);
    return Number(r.rows[0]!.c);
  });
  check(`[${view}] filter cannot widen scope (A→B = 0)`, aFilterB === 0, `A filtered to B = ${aFilterB}`);
}

async function main(): Promise<void> {
  console.log('=== GP settlement RLS proof (schedule + load grain) ===');
  const pool = makePool();
  const client = await pool.connect();
  try {
    const top = (await client.query<{ consignor_id: string; grower_code: string; n: string }>(
      `select consignor_id, grower_code, count(*) n from core.fact_gp_settlement
        where consignor_id is not null group by 1,2 order by n desc limit 2`,
    )).rows;
    if (top.length < 2) throw new Error('need ≥2 mapped growers with settlements');
    const A = top[0]!, B = top[1]!;
    console.log(`growers: A=${A.grower_code} (${A.n} schedules) · B=${B.grower_code} (${B.n} schedules)`);

    await proveView(client, 'grower_gp_settlement', A.consignor_id, B.consignor_id, A.grower_code, B.grower_code);
    await proveView(client, 'grower_gp_settlement_load', A.consignor_id, B.consignor_id, A.grower_code, B.grower_code);

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
