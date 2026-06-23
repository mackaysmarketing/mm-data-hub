// GP schedule settlement rollup tests — the net formula drift-guard oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollupSchedule, type GpChargeLine } from '../src/lib/ft_gp_settlement.ts';

test('net = gross − deductions − gst; categories summed; non-deductible ignored', () => {
  const lines: GpChargeLine[] = [
    { category: 'FR', isDeductible: true, totalAmount: 100, vatInfo: 'EX' },   // ded 100, gst 10
    { category: 'WH', isDeductible: true, totalAmount: 50, vatInfo: 'FREE' },  // ded 50,  gst 0
    { category: 'MD', isDeductible: true, totalAmount: 110, vatInfo: 'INC' },  // ded 110, gst 10
    { category: 'WH', isDeductible: false, totalAmount: 30, vatInfo: 'EX' },   // informational — NOT netted
  ];
  const r = rollupSchedule(1000, lines);
  assert.equal(r.gross, 1000);
  assert.equal(r.totalDeductions, 260);
  assert.equal(r.gst, 20);
  assert.equal(r.net, 720); // 1000 − 260 − 20
  assert.deepEqual(r.deductionsByCategory, { FR: 100, WH: 50, MD: 110 });
  assert.equal(r.deductibleLineCount, 3);
});

test('LA credits (negative amounts) reduce total deductions (net credit, surfaced not dropped)', () => {
  const lines: GpChargeLine[] = [
    { category: 'MD', isDeductible: true, totalAmount: 500, vatInfo: 'EX' },
    { category: 'LA', isDeductible: true, totalAmount: -120, vatInfo: 'FREE' }, // a load-adjustment credit
  ];
  const r = rollupSchedule(2000, lines);
  assert.equal(r.totalDeductions, 380);          // 500 + (−120)
  assert.equal(r.deductionsByCategory.LA, -120); // surfaced negative
  assert.equal(r.gst, 50);                        // GST only on the +500 EX line
  assert.equal(r.net, 1570);                      // 2000 − 380 − 50
});

test('empty / gross-only schedule nets to gross', () => {
  const r = rollupSchedule(1234.56, []);
  assert.equal(r.net, 1234.56);
  assert.equal(r.totalDeductions, 0);
  assert.equal(r.gst, 0);
  assert.deepEqual(r.deductionsByCategory, {});
});

test('rounds to cents (no float drift)', () => {
  const lines: GpChargeLine[] = [
    { category: 'MD', isDeductible: true, totalAmount: 33.33, vatInfo: 'INC' }, // gst 3.0300
    { category: 'FR', isDeductible: true, totalAmount: 0.1 + 0.2, vatInfo: 'EX' }, // 0.30000000000000004
  ];
  const r = rollupSchedule(100, lines);
  assert.equal(r.deductionsByCategory.FR, 0.3);
  assert.equal(Number.isInteger(Math.round(r.net * 100)), true);
});
