import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftDispatchLoadSpec, ftPalletSpec } from '../src/lib/ft_dispatch_specs.ts';
import { ftSelectList } from '../src/lib/ft_gp_specs.ts';
import { connStringTargetsHub, HUB_PROJECT_REF } from '../src/lib/db.ts';

test('dispatch specs target only the view-backing raw tables', () => {
  assert.equal(ftDispatchLoadSpec.schema, 'raw');
  assert.equal(ftDispatchLoadSpec.table, 'ft_dispatch_load');
  assert.equal(ftDispatchLoadSpec.idColumn, 'id');
  assert.equal(ftDispatchLoadSpec.withRaw, true); // small table keeps _raw
  assert.equal(ftPalletSpec.schema, 'raw');
  assert.equal(ftPalletSpec.table, 'ft_pallet');
  assert.equal(ftPalletSpec.withRaw, false); // large table, no _raw
});

test('source columns map 1:1 by name (key === col), mirroring the GP loader', () => {
  for (const spec of [ftDispatchLoadSpec, ftPalletSpec]) {
    for (const c of spec.columns) assert.equal(c.key, c.col, `${spec.table}.${c.col} must read same-named source col`);
  }
});

test('every column the dispatch view reads is present in the specs', () => {
  const d = new Set(ftDispatchLoadSpec.columns.map((c) => c.col));
  for (const col of ['consignor_id', 'actual_pickup_on', 'pack_date', 'extra_text_2', 'load_no', 'state_id'])
    assert.ok(d.has(col), `dispatch_load missing ${col}`);
  const p = new Set(ftPalletSpec.columns.map((c) => c.col));
  for (const col of ['dispatch_load_id', 'crop_description', 'variety_description', 'product_description',
                     'box_count', 'net_weight_value', 'net_weight_unit', 'is_field', 'is_archived'])
    assert.ok(p.has(col), `pallet missing ${col}`);
});

test('redefinition fields (state + box accounting) land even though the view ignores them today', () => {
  // The dispatched/boxes redefinition (DISPATCH_DEFINITION_PROPOSAL.md) needs these — the backfill
  // must land them so the later view/Cube change is a pure SQL change with no re-load.
  assert.ok(ftDispatchLoadSpec.columns.some((c) => c.col === 'state_id'));
  for (const col of ['stock_boxes', 'reconsigned_boxes'])
    assert.ok(ftPalletSpec.columns.some((c) => c.col === col), `pallet missing ${col}`);
});

test('location_id and harvest_load_id are NOT modelled on the pallet (SPEC §9.1/§9.2)', () => {
  const p = ftPalletSpec.columns.map((c) => c.col);
  assert.ok(!p.includes('location_id'));
  assert.ok(!p.includes('harvest_load_id'));
});

test('date/timestamptz columns are read as ::text to avoid the JS Date off-by-one', () => {
  const tsCols = ['scheduled_pickup_on', 'actual_pickup_on', 'pack_date', 'asn_sent_on'];
  for (const col of tsCols) {
    const c = ftDispatchLoadSpec.columns.find((x) => x.col === col)!;
    assert.equal(c.select, `${col}::text`, `${col} must select ::text`);
  }
  const packed = ftPalletSpec.columns.find((x) => x.col === 'packed_on')!;
  assert.equal(packed.select, 'packed_on::text');
});

test('ftSelectList emits "expr AS key" and keeps read query and upsert in lockstep', () => {
  const sel = ftSelectList(ftDispatchLoadSpec);
  assert.match(sel, /actual_pickup_on::text AS actual_pickup_on/);
  assert.match(sel, /\bid AS id\b/);
  assert.equal(sel.split(',').length, ftDispatchLoadSpec.columns.length);
});

test('connStringTargetsHub gates writes on the hub project ref (in user OR host)', () => {
  // Pooler form: ref lives in the username, not the host — must still pass.
  assert.equal(connStringTargetsHub(`postgresql://postgres.${HUB_PROJECT_REF}:pw@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres`), true);
  // Direct form: ref in the host.
  assert.equal(connStringTargetsHub(`postgresql://postgres:pw@db.${HUB_PROJECT_REF}.supabase.co:5432/postgres`), true);
  // Wrong project → must fail closed.
  assert.equal(connStringTargetsHub('postgresql://postgres.somethingelse:pw@aws-1.pooler.supabase.com:5432/postgres'), false);
  assert.equal(connStringTargetsHub(''), false);
});
