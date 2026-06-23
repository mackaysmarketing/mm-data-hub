// GP grower crosswalk tests — the reconsignment (original-load consignor) case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementConsignor, detailOnlyConsignors } from '../src/lib/ft_gp_crosswalk.ts';

const A = '0196ccf2-0000-0000-0000-000000000001'; // settled grower
const B = '0196ccf2-0000-0000-0000-000000000002'; // settled grower
const ORIG = '0196ccf2-0000-0000-0000-000000000099'; // original grower on a reconsigned load

test('settlement anchor is ALWAYS the schedule consignor, never the detail (original-load) one', () => {
  assert.equal(settlementConsignor(A), A);
  // even if a detail line carries ORIG, the schedule (A) is the settled party — the caller passes the
  // schedule consignor here; the detail consignor is irrelevant to the RLS anchor.
  assert.equal(settlementConsignor(null), null);
  assert.equal(settlementConsignor(undefined), null);
});

test('detail-only consignors (reconsignment originals) are surfaced, not dropped', () => {
  const schedule = [A, B, A];          // settled parties
  const detail = [A, B, ORIG, A, ORIG]; // ORIG appears only on detail lines (reconsigned load)
  assert.deepEqual(detailOnlyConsignors(schedule, detail), [ORIG]);
});

test('no reconsignment → no detail-only consignors', () => {
  assert.deepEqual(detailOnlyConsignors([A, B], [A, B, A]), []);
});

test('nulls are ignored on both sides', () => {
  assert.deepEqual(detailOnlyConsignors([A, null, undefined], [A, ORIG, null]), [ORIG]);
});
