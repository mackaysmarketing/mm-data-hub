import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePackWeek, stripFormatCodes, deriveIsTest } from '../src/lib/parsers.ts';

test('parsePackWeek decodes Y{YY}W{WW}', () => {
  assert.deepEqual(parsePackWeek('Y25W31'), { year: 2025, week: 31 });
  assert.deepEqual(parsePackWeek('Y25W27'), { year: 2025, week: 27 });
  assert.deepEqual(parsePackWeek(' Y26W01 '), { year: 2026, week: 1 });
});

test('parsePackWeek rejects malformed / out-of-range codes', () => {
  assert.equal(parsePackWeek(''), null);
  assert.equal(parsePackWeek(null), null);
  assert.equal(parsePackWeek('25W31'), null);
  assert.equal(parsePackWeek('Y25W99'), null);
  assert.equal(parsePackWeek('Y25W00'), null);
});

test('stripFormatCodes removes ^{...} display tokens', () => {
  assert.equal(stripFormatCodes('^{b}^{c blue}[60]^{cl} Mackays - Bolinda'), '[60] Mackays - Bolinda');
  assert.equal(stripFormatCodes(''), '');
  assert.equal(stripFormatCodes(null), '');
  assert.equal(stripFormatCodes('plain text'), 'plain text');
});

test('deriveIsTest: inactive *TEST entities are test; active ones are not', () => {
  assert.equal(deriveIsTest('TRUGTEST', false), true);
  assert.equal(deriveIsTest('LARATEST', false), true);
  assert.equal(deriveIsTest('ANNRTEST', false), true);
  assert.equal(deriveIsTest('TRUGTEST', true), false); // active overrides
  assert.equal(deriveIsTest('MACKAYS', false), false); // not a *TEST code
  assert.equal(deriveIsTest(null, false), false);
});
