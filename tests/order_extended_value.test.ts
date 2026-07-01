import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivedLineValue, latestVersion, rollupOrder, type OrderLine } from '../src/lib/ft_order.ts';

const line = (o: Partial<OrderLine>): OrderLine => ({
  order_version_id: 'v', price_per: 'BOX', price_value: null, total_box_count: null,
  pallet_count: null, total_price_value: null, ...o,
});

test('derivedLineValue: BOX = total_box_count × price_value', () => {
  assert.equal(derivedLineValue(line({ price_per: 'BOX', total_box_count: 480, price_value: 25 })), 12000);
});

test('derivedLineValue: PALLET = pallet_count × price_value', () => {
  assert.equal(derivedLineValue(line({ price_per: 'PALLET', pallet_count: 5, price_value: 100 })), 500);
});

test('derivedLineValue: WEIGHT_UNIT defers to native total_price_value (no line quantity)', () => {
  assert.equal(derivedLineValue(line({ price_per: 'WEIGHT_UNIT', total_price_value: 731.5 })), 731.5);
});

test('derivedLineValue: never coalesces missing inputs to 0 — falls back to native', () => {
  // price_value null on a BOX line → cannot derive → native total (here null), never 0.
  assert.equal(derivedLineValue(line({ price_per: 'BOX', total_box_count: 100, price_value: null })), null);
});

test('latestVersion picks the highest version_no', () => {
  assert.deepEqual(latestVersion([{ id: 'a', version_no: 1 }, { id: 'c', version_no: 3 }, { id: 'b', version_no: 2 }]),
    { id: 'c', version_no: 3 });
});

test('rollupOrder sums only current-version lines; superseded excluded', () => {
  const versions = [{ id: 'v1', version_no: 1 }, { id: 'v2', version_no: 2 }];
  const lines = [
    line({ order_version_id: 'v1', total_box_count: 999, total_price_value: 99999 }), // superseded — must be ignored
    line({ order_version_id: 'v2', total_box_count: 480, price_value: 25, total_price_value: 12000 }),
    line({ order_version_id: 'v2', total_box_count: 72, price_value: 30, total_price_value: 2160 }),
  ];
  const r = rollupOrder(versions, lines);
  assert.equal(r.latest_version_no, 2);
  assert.equal(r.line_count, 2);
  assert.equal(r.total_box_count, 552);
  assert.equal(r.total_price_value, 14160);
  assert.equal(r.derived_price_value, 14160); // BOX derivation == native
});

test('rollupOrder: header-only order (no versions/lines) → null totals, not 0', () => {
  const r = rollupOrder([], []);
  assert.equal(r.latest_version_no, null);
  assert.equal(r.total_price_value, null);
  assert.equal(r.total_box_count, null);
  assert.equal(r.line_count, 0);
});
