// ─────────────────────────────────────────────────────────────────────────────
// Dispatch RLS proof — semantic.grower_dispatch_detail under five security contexts.
//   npm run ft:dispatch:rls
//
// The Sprint-7 backfill writes only to the RLS-protected base tables (raw.ft_dispatch_load,
// raw.ft_pallet); this proves the view still fail-closes after the load — the SAME
// app_metadata-only contract as migrations 0008/0010 (helpers hardened by 0010):
//   • grower A sees ONLY its own dispatch rows (0 of B)   • grower B likewise (disjoint)
//   • internal (app_metadata.is_internal) sees ALL        • no claim → 0 (fail closed)
//   • forged TOP-LEVEL consignor_id / is_internal → 0     • A filtering to B → 0 (no widening)
// grower_key = the LOAD consignor (SPEC §9.1), never harvest lineage.
//
// Exit 0 = all pass; 1 = any failure. Read-only (every context rolls back).
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass });
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
async function visible(client: PoolClient, claimsJson: string, A: string, B: string): Promise<Vis> {
  return underContext(client, claimsJson, async () => {
    const r = await client.query<{ rows: string; growers: string; a: string; b: string }>(
      `select count(*) rows, count(distinct grower_key) growers,
              count(*) filter (where grower_key = $1) a,
              count(*) filter (where grower_key = $2) b
         from semantic.grower_dispatch_detail`,
      [A, B],
    );
    const row = r.rows[0]!;
    return { rows: Number(row.rows), growers: Number(row.growers), a: Number(row.a), b: Number(row.b) };
  });
}

async function main(): Promise<void> {
  console.log('=== Dispatch RLS proof — semantic.grower_dispatch_detail ===');
  const pool = makePool();
  const client = await pool.connect();
  try {
    // Pick the top 2 growers with visible dispatch rows, under an internal context (sees all).
    const top = await underContext(client, claims({ app_metadata: { is_internal: true } }), async () =>
      (await client.query<{ grower_key: string; n: string }>(
        `select grower_key, count(*) n from semantic.grower_dispatch_detail
          where grower_key is not null group by 1 order by n desc limit 2`,
      )).rows,
    );
    if (top.length < 2) throw new Error('need ≥2 growers with dispatch rows in the view (run the backfill/slice first)');
    const A = top[0]!.grower_key, B = top[1]!.grower_key;
    console.log(`growers: A=${A.slice(0, 8)}… (${top[0]!.n} rows) · B=${B.slice(0, 8)}… (${top[1]!.n} rows)\n`);

    const internal = await visible(client, claims({ app_metadata: { is_internal: true } }), A, B);
    const a = await visible(client, claims({ app_metadata: { consignor_id: A } }), A, B);
    const b = await visible(client, claims({ app_metadata: { consignor_id: B } }), A, B);
    const noClaim = await visible(client, claims({}), A, B);
    const forged = await visible(client, claims({ consignor_id: A, is_internal: true }), A, B); // TOP-LEVEL = forged

    check('internal sees all', internal.rows > 0 && internal.growers > 1 && internal.a > 0 && internal.b > 0,
      `rows=${internal.rows} growers=${internal.growers}`);
    check('grower A sees only itself', a.rows === internal.a && a.growers === 1 && a.b === 0,
      `rows=${a.rows} (internal-A=${internal.a}) growers=${a.growers} B-rows=${a.b}`);
    check('grower B sees only itself', b.rows === internal.b && b.growers === 1 && b.a === 0,
      `rows=${b.rows} (internal-B=${internal.b}) growers=${b.growers} A-rows=${b.a}`);
    check('A and B disjoint', a.b === 0 && b.a === 0, 'no shared rows');
    check('no-claim is fail-closed', noClaim.rows === 0, `rows=${noClaim.rows}`);
    check('forged top-level claims → 0', forged.rows === 0, `rows=${forged.rows}`);

    const aFilterB = await underContext(client, claims({ app_metadata: { consignor_id: A } }), async () =>
      Number((await client.query<{ c: string }>(
        `select count(*) c from semantic.grower_dispatch_detail where grower_key = $1`, [B])).rows[0]!.c),
    );
    check('filter cannot widen scope (A→B = 0)', aFilterB === 0, `A filtered to B = ${aFilterB}`);

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
