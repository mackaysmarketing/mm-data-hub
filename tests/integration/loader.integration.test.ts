// Integration tests for the DoD behaviours: upsert idempotency, resume bookkeeping, and
// RLS isolation. They require a live DATABASE_URL (run: `npm run test:integration`) and
// SELF-SKIP when it is absent or still the .env placeholder, so they never block `npm test`.
//
// Safety: idempotency runs entirely in a TEMP table; RLS + resume checks are READ-ONLY
// against the hub (they never write to raw.* business tables).
import 'dotenv/config'; // load .env so DATABASE_URL activates these tests when filled in
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePool, upsertNodes, doneWindowStarts } from '../../src/lib/db.ts';
import type { UpsertSpec } from '../../src/lib/db.ts';

const url = process.env.DATABASE_URL ?? '';
const hasDb = url !== '' && !url.includes('REPLACE_');
const opts = { skip: hasDb ? false : 'set DATABASE_URL (non-placeholder) to run integration tests' };

// Two real growers (top by row count) used for the RLS isolation proof.
const GROWER_A = '0191e996-93b7-fcd1-170e-87c6aa517087';
const GROWER_B = '0191f981-c9dc-4203-4f1b-3e9c5f5758d3';

test('upsertNodes is idempotent: re-upserting the same id adds no row and updates in place', opts, async () => {
  const pool = makePool();
  const client = await pool.connect();
  try {
    await client.query('create temp table _idem (id uuid primary key, val text, _synced_at timestamptz)');
    const spec: UpsertSpec = {
      schema: 'pg_temp', table: '_idem', idColumn: 'id', withRaw: false,
      columns: [
        { col: 'id', key: 'id', kind: 'uuid' },
        { col: 'val', key: 'v', kind: 'text' },
      ],
    };
    const id = '00000000-0000-0000-0000-000000000001';
    await upsertNodes(client, spec, [{ id, v: 'first' }]);
    await upsertNodes(client, spec, [{ id, v: 'second' }]); // same id again
    const r = await client.query<{ n: number; val: string }>(
      'select count(*)::int n, max(val) val from pg_temp._idem',
    );
    assert.equal(r.rows[0]!.n, 1, 'no duplicate row created on re-upsert');
    assert.equal(r.rows[0]!.val, 'second', 'on-conflict updated the row in place');
  } finally {
    client.release();
    await pool.end();
  }
});

test('resume bookkeeping: doneWindowStarts returns the completed dispatch windows', opts, async () => {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const done = await doneWindowStarts(client, 'dispatch_load');
    assert.ok(done instanceof Set);
    // After the FY25-26 backfill there are completed weekly windows; the loader skips these.
    assert.ok(done.size > 0, 'expected at least one completed dispatch window to skip on resume');
  } finally {
    client.release();
    await pool.end();
  }
});

async function rowsUnderClaim(claim: Record<string, unknown>): Promise<{ rows: number; foreignA: number; foreignB: number }> {
  const pool = makePool();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query('select set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify(claim)]);
    const r = await client.query<{ n: number; a: number; b: number }>(
      `select count(*)::int n,
              count(*) filter (where grower_key = $1)::int a,
              count(*) filter (where grower_key = $2)::int b
       from semantic.grower_dispatch_detail`,
      [GROWER_A, GROWER_B],
    );
    await client.query('commit');
    return { rows: r.rows[0]!.n, foreignA: r.rows[0]!.a, foreignB: r.rows[0]!.b };
  } finally {
    client.release();
    await pool.end();
  }
}

test('RLS: grower A sees only A; grower B sees only B (app_metadata claim)', opts, async () => {
  const a = await rowsUnderClaim({ role: 'authenticated', app_metadata: { consignor_id: GROWER_A } });
  assert.ok(a.rows > 0 && a.foreignB === 0, 'grower A sees own rows, none of B');
  const b = await rowsUnderClaim({ role: 'authenticated', app_metadata: { consignor_id: GROWER_B } });
  assert.ok(b.rows > 0 && b.foreignA === 0, 'grower B sees own rows, none of A');
});

test('RLS: forged TOP-LEVEL is_internal/consignor_id does NOT bypass scoping', opts, async () => {
  const forged = await rowsUnderClaim({
    role: 'authenticated',
    consignor_id: GROWER_B, // top-level — must be ignored
    is_internal: true, // top-level — must be ignored
  });
  assert.equal(forged.rows, 0, 'top-level claims must not grant any access');
});

test('RLS: malformed app_metadata claim fails closed (0 rows, no error)', opts, async () => {
  const malformed = await rowsUnderClaim({
    role: 'authenticated',
    app_metadata: { consignor_id: 'not-a-uuid', is_internal: 'maybe' },
  });
  assert.equal(malformed.rows, 0, 'malformed claim must fail closed, not error');
});
