import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchLoadSpec, palletSpec, entitySpec, fieldSelection } from '../src/lib/specs.ts';
import { upsertNodes } from '../src/lib/db.ts';
import type { PoolClient } from 'pg';

test('field selection requests exactly the mapped keys', () => {
  const sel = fieldSelection(dispatchLoadSpec).split(/\s+/);
  assert.ok(sel.includes('actualPickupOn'));
  assert.ok(sel.includes('extraText2'));
  assert.ok(sel.includes('consignorId'));
  assert.equal(sel.length, dispatchLoadSpec.columns.length);
});

test('dispatch load spec carries the full SPEC §3 trimmed set', () => {
  assert.equal(dispatchLoadSpec.columns.length, 34);
  assert.equal(dispatchLoadSpec.withRaw, true);
  assert.equal(dispatchLoadSpec.idColumn, 'id');
});

test('pallet spec has no _raw and does not model location_id / harvest_load_id', () => {
  assert.equal(palletSpec.withRaw, false);
  const cols = palletSpec.columns.map((c) => c.col);
  assert.ok(!cols.includes('location_id'));
  assert.ok(!cols.includes('harvest_load_id'));
  assert.ok(cols.includes('is_field'));
});

test('entity spec excludes the generated is_test column', () => {
  const cols = entitySpec.columns.map((c) => c.col);
  assert.ok(!cols.includes('is_test'));
  assert.ok(cols.includes('consignor_id'));
  assert.equal(entitySpec.withRaw, true);
});

test('upsertNodes is a no-op on empty input (no DB call)', async () => {
  let called = false;
  const fakeClient = {
    query: async () => {
      called = true;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as PoolClient;
  const n = await upsertNodes(fakeClient, dispatchLoadSpec, []);
  assert.equal(n, 0);
  assert.equal(called, false);
});
