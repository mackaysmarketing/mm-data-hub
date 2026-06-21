// Line-type filtering + bill rollup tests. The rollup case is the REAL ZONTA RCTI (bill 161796),
// so this reproduces the live no-double-count reconciliation entirely in pure TS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, rollupBill, type CategorizedLine } from '../src/lib/ns_lines.ts';

test('classifyLine: mainline → summary, taxline → tax, else by sign', () => {
  assert.equal(classifyLine({ mainline: true, taxline: false, foreignamount: -19390.4 }), 'summary');
  assert.equal(classifyLine({ mainline: false, taxline: true, foreignamount: -424.06 }), 'tax');
  assert.equal(classifyLine({ mainline: false, taxline: false, foreignamount: 2353.8 }), 'gross');
  assert.equal(classifyLine({ mainline: false, taxline: false, foreignamount: -55.05 }), 'deduction');
  assert.equal(classifyLine({ mainline: false, taxline: false, foreignamount: 0 }), 'zero');
  // mainline takes precedence even if amount is positive; null flags treated as false.
  assert.equal(classifyLine({ mainline: true, taxline: null, foreignamount: 100 }), 'summary');
  assert.equal(classifyLine({ mainline: null, taxline: null, foreignamount: -1 }), 'deduction');
});

// The exact 21 lines of grower RCTI 161796 (ZONTA), with their charge categories.
const ZONTA: CategorizedLine[] = [
  { mainline: true,  taxline: false, foreignamount: -19390.4, category: 'OTHER' }, // summary
  { mainline: false, taxline: false, foreignamount: 2353.8,  category: 'PRODUCT' },
  { mainline: false, taxline: false, foreignamount: 1394,    category: 'PRODUCT' },
  { mainline: false, taxline: false, foreignamount: 9415.2,  category: 'PRODUCT' },
  { mainline: false, taxline: false, foreignamount: 2353.8,  category: 'PRODUCT' },
  { mainline: false, taxline: false, foreignamount: 9415.2,  category: 'PRODUCT' },
  { mainline: false, taxline: false, foreignamount: -55.05,  category: 'FR' },
  { mainline: false, taxline: false, foreignamount: -646.49, category: 'FR' },
  { mainline: false, taxline: false, foreignamount: -76.42,  category: 'FR' },
  { mainline: false, taxline: false, foreignamount: -1992,   category: 'WH' },
  { mainline: false, taxline: false, foreignamount: -117.67, category: 'WH' },
  { mainline: false, taxline: false, foreignamount: -1093.88, category: 'MD' },
  { mainline: false, taxline: false, foreignamount: -20.75,  category: 'MD' },
  { mainline: false, taxline: false, foreignamount: -206.53, category: 'MD' },
  { mainline: false, taxline: false, foreignamount: -119.39, category: 'MD' },
  { mainline: false, taxline: false, foreignamount: -47.15,  category: 'MD' },
  { mainline: false, taxline: false, foreignamount: -623.31, category: 'MD' },
  { mainline: false, taxline: false, foreignamount: -118.9,  category: 'MD' },
  { mainline: false, taxline: true,  foreignamount: -424.06, category: 'OTHER' }, // tax
  { mainline: false, taxline: true,  foreignamount: 0,       category: 'OTHER' }, // tax (RCTI Free)
  { mainline: false, taxline: true,  foreignamount: 0,       category: 'OTHER' }, // tax (NCF-AU)
];

test('rollupBill reproduces the live ZONTA reconciliation (sum lines = bill total)', () => {
  const r = rollupBill(ZONTA);
  assert.equal(r.gross, 24932.0);
  assert.equal(r.totalDeductions, -5117.54);
  assert.equal(r.tax, -424.06);
  assert.equal(r.net, 19390.4);
  assert.equal(r.summary, -19390.4);
  assert.equal(r.reconDiff, 0); // net == -(summary) → lines reconcile to the bill total
  assert.equal(r.lineCount, 20); // 21 lines minus the 1 summary line
  // deductions split by category
  assert.equal(r.deductionsByCategory.FR, -777.96);
  assert.equal(r.deductionsByCategory.WH, -2109.67);
  assert.equal(r.deductionsByCategory.MD, -2229.91);
  // gross + Σ(category deductions) + tax reconciles
  const catSum = Object.values(r.deductionsByCategory).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(catSum - r.totalDeductions) < 0.005);
});

test('an unpaid/empty bill rolls up to zeros without throwing', () => {
  const r = rollupBill([{ mainline: true, taxline: false, foreignamount: 0, category: 'OTHER' }]);
  assert.equal(r.net, 0);
  assert.equal(r.lineCount, 0);
});
