// ─────────────────────────────────────────────────────────────────────────────
// Settlement RLS proof — semantic.grower_settlement under five security contexts.
//   npm run ns:rls
//
// Connects as a role that can `set role authenticated` (DATABASE_URL), then per context sets
// request.jwt.claims and queries the view (each in its own transaction, rolled back). Proves the
// SAME app_metadata-only, fail-closed contract as migrations 0008/0010:
//   • grower A sees ONLY its own settlements (0 of B)         • grower B likewise (disjoint)
//   • internal (app_metadata.is_internal) sees ALL            • no claim → 0 (fail closed)
//   • forged TOP-LEVEL consignor_id / is_internal → 0         • A filtering to B → 0 (no widening)
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

/** Run `fn` as `authenticated` with the given JWT claims, in a rolled-back transaction. */
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

async function visible(client: PoolClient, claimsJson: string, otherId?: string): Promise<{ rows: number; growers: number; other: number }> {
  return underContext(client, claimsJson, async () => {
    const r = await client.query<{ rows: string; growers: string; other: string }>(
      `select count(*) as rows, count(distinct grower_key) as growers,
              count(*) filter (where grower_key = $1) as other
         from semantic.grower_settlement`,
      [otherId ?? '00000000-0000-0000-0000-000000000000'],
    );
    const row = r.rows[0]!;
    return { rows: Number(row.rows), growers: Number(row.growers), other: Number(row.other) };
  });
}

async function main(): Promise<void> {
  console.log('=== Settlement RLS proof (semantic.grower_settlement) ===\n');
  const pool = makePool();
  const client = await pool.connect();
  try {
    // Pick the two growers with the most RCTIs (as the unscoped owner connection).
    const top = (await client.query<{ consignor_id: string; grower_code: string; n: string }>(
      `select consignor_id, grower_code, count(*) n from core.fact_settlement_bill
        where consignor_id is not null group by 1,2 order by n desc limit 2`,
    )).rows;
    if (top.length < 2) throw new Error('need ≥2 mapped growers with settlements');
    const A = top[0]!, B = top[1]!;
    const baseline = (await client.query<{ c: string; g: string }>(
      `select count(*) c, count(distinct consignor_id) g from core.fact_settlement_bill`,
    )).rows[0]!;
    console.log(`baseline: ${baseline.c} bills / ${baseline.g} growers | A=${A.grower_code} (${A.n}) B=${B.grower_code} (${B.n})\n`);

    const internal = await visible(client, claims({ app_metadata: { is_internal: true } }), B.consignor_id);
    const a = await visible(client, claims({ app_metadata: { consignor_id: A.consignor_id } }), B.consignor_id);
    const b = await visible(client, claims({ app_metadata: { consignor_id: B.consignor_id } }), A.consignor_id);
    const noClaim = await visible(client, claims({}));
    const forged = await visible(client, claims({ consignor_id: A.consignor_id, is_internal: true }));

    check('internal sees all bills', internal.rows === Number(baseline.c) && internal.growers > 1, `rows=${internal.rows} growers=${internal.growers}`);
    check('grower A sees only A', a.rows === Number(A.n) && a.growers === 1 && a.other === 0, `rows=${a.rows} growers=${a.growers} B-rows=${a.other}`);
    check('grower B sees only B', b.rows === Number(B.n) && b.growers === 1 && b.other === 0, `rows=${b.rows} growers=${b.growers} A-rows=${b.other}`);
    check('A and B disjoint', A.consignor_id !== B.consignor_id && a.other === 0 && b.other === 0, 'no shared rows');
    check('no-claim is fail-closed', noClaim.rows === 0, `rows=${noClaim.rows}`);
    check('forged top-level claims → 0', forged.rows === 0, `rows=${forged.rows}`);

    // A cannot widen to B even by selecting B explicitly (RLS on the base table).
    const aFilterB = await underContext(client, claims({ app_metadata: { consignor_id: A.consignor_id } }), async () => {
      const r = await client.query<{ c: string }>(
        `select count(*) c from semantic.grower_settlement where grower_key = $1`, [B.consignor_id]);
      return Number(r.rows[0]!.c);
    });
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
