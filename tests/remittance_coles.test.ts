// Pure-parser unit tests over the two committed Coles remittance fixtures. The checksum
// (Σ payment_amount == Total Amount) is the oracle — it holds on the real files, so these run with
// no database and no PDF. Style follows tests/ns_lines.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseColesRemittanceText,
  colesChecksum,
  assertColesChecksum,
} from '../src/lib/remittance_coles.ts';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/remittance/${name}`, import.meta.url)), 'utf8');

const small = parseColesRemittanceText(fixture('coles_small.txt'), 'coles_small.txt');
const large = parseColesRemittanceText(fixture('coles_large.txt'), 'coles_large.txt');

test('small advice: header fields + 2 lines', () => {
  assert.equal(small.retailer, 'coles');
  assert.equal(small.payment_no, '3300005573');
  assert.equal(small.period_ending, '2026-07-06');
  assert.equal(small.total_amount, 1169.41);
  assert.equal(small.vendor_no, '6007716');
  assert.equal(small.source_file, 'coles_small.txt');
  assert.equal(small.lines.length, 2);
});

test('large advice: header fields + 72 lines', () => {
  // 72, not the SPRINT prose "81": the 72 parsed payment amounts sum EXACTLY to the header total
  // (checksum below), so the fixture is complete and 72 is the true document count.
  assert.equal(large.payment_no, '3300004309');
  assert.equal(large.period_ending, '2026-07-06');
  assert.equal(large.total_amount, 1898521.87);
  assert.equal(large.lines.length, 72);
});

test('checksum holds on both advices (Σ payment_amount == Total Amount)', () => {
  const cs = colesChecksum(small);
  assert.equal(cs.ok, true);
  assert.equal(cs.sum, 1169.41);
  assert.equal(cs.diff, 0);

  const cl = colesChecksum(large);
  assert.equal(cl.ok, true);
  assert.equal(cl.sum, 1898521.87);
  assert.equal(cl.diff, 0);

  // The assert variant must not throw on a valid advice.
  assert.doesNotThrow(() => assertColesChecksum(small));
  assert.doesNotThrow(() => assertColesChecksum(large));
});

test('assertColesChecksum throws on a tampered advice', () => {
  const tampered = { ...small, lines: [...small.lines, { ...small.lines[0]! }] };
  assert.throws(() => assertColesChecksum(tampered), /checksum FAILED/);
});

test('first small line parses field-for-field (KD invoice, ISO date, store)', () => {
  const l = small.lines[0]!;
  assert.equal(l.invoice_no, 'FT003402A');
  assert.equal(l.doc_type, 'KD');
  assert.equal(l.doc_date, '2025-08-25');
  assert.equal(l.store_no, 'C9314FV');
  assert.equal(l.document_amount, 374.4);
  assert.equal(l.discount_amount, 9.36);
  assert.equal(l.payment_amount, 365.04);
  assert.equal(l.gst, 0);
  assert.equal(l.wt, 0);
});

test('suffix variant is kept literally, not stripped (FT003402A ≠ FT003402)', () => {
  const l = small.lines[0]!;
  assert.equal(l.invoice_no, 'FT003402A'); // trailing A preserved
  assert.equal(l.is_claim, false); // KD + FT number → a real invoice, not a claim
});

test('is_claim classification: LJ and non-FT refs are claims, KD FT lines are not', () => {
  // small line 2 = REV1294074 / LJ → claim (LJ, and not an FT number)
  const rev = small.lines[1]!;
  assert.equal(rev.invoice_no, 'REV1294074');
  assert.equal(rev.doc_type, 'LJ');
  assert.equal(rev.is_claim, true);

  // every KD FT line is a non-claim invoice
  const kdInvoices = large.lines.filter((l) => l.doc_type === 'KD');
  assert.ok(kdInvoices.length > 0);
  assert.ok(kdInvoices.every((l) => l.is_claim === false && /^FT\d+[A-Z]?$/.test(l.invoice_no)));
});

test('negative claim line 1295067 is parsed with its sign intact', () => {
  const claim = large.lines.find((l) => l.invoice_no === '1295067');
  assert.ok(claim, 'expected the 1295067 claim line to be parsed');
  assert.equal(claim!.doc_type, 'LJ');
  assert.equal(claim!.doc_date, '2026-06-26');
  assert.equal(claim!.store_no, 'C9541FV');
  assert.equal(claim!.document_amount, -4996.2);
  assert.equal(claim!.discount_amount, -124.91);
  assert.equal(claim!.payment_amount, -4871.29);
  assert.equal(claim!.is_claim, true); // LJ + bare numeric ref → claim/deduction
});

test('exactly one claim (LJ) line in the large advice; the rest are KD invoices', () => {
  const claims = large.lines.filter((l) => l.doc_type === 'LJ');
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.invoice_no, '1295067');
});
