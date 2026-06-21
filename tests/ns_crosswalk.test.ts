// Grower crosswalk resolution tests — the WADDA case (active + inactive dim_grower rows for one code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConsignor } from '../src/lib/ns_crosswalk.ts';

const WADDA_ACTIVE = '01983ad5-2d86-0339-d3fd-2a9863f294d7';   // Wadda Plantation (active)
const WADDA_INACTIVE = '019439d3-95b6-7f3c-41cf-c98000ed4433'; // Wadda Plantation - Gallaghers (inactive)

test('WADDA: resolves to the ACTIVE dim_grower row regardless of input order', () => {
  assert.equal(
    resolveConsignor([
      { consignor_id: WADDA_ACTIVE, is_active: true },
      { consignor_id: WADDA_INACTIVE, is_active: false },
    ]),
    WADDA_ACTIVE,
  );
  // order-independent
  assert.equal(
    resolveConsignor([
      { consignor_id: WADDA_INACTIVE, is_active: false },
      { consignor_id: WADDA_ACTIVE, is_active: true },
    ]),
    WADDA_ACTIVE,
  );
});

test('a single mapped code resolves to that consignor', () => {
  assert.equal(resolveConsignor([{ consignor_id: 'abc', is_active: true }]), 'abc');
  assert.equal(resolveConsignor([{ consignor_id: 'abc', is_active: false }]), 'abc');
});

test('no candidates → null (unmapped, surfaced not dropped)', () => {
  assert.equal(resolveConsignor([]), null);
});

test('two active candidates → deterministic tiebreak (lowest consignor_id)', () => {
  assert.equal(
    resolveConsignor([
      { consignor_id: 'bbb', is_active: true },
      { consignor_id: 'aaa', is_active: true },
    ]),
    'aaa',
  );
});

test('null is_active is treated as not-active (active wins over null)', () => {
  assert.equal(
    resolveConsignor([
      { consignor_id: 'nullrow', is_active: null },
      { consignor_id: 'activerow', is_active: true },
    ]),
    'activerow',
  );
});
