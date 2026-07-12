// Pure-parser unit tests over the committed Coles Circana scan fixture (2 sections × 45 rows —
// the real export is 7 sections with the identical structure). The channel-additivity invariant
// (In store + Online == TOTAL) is the oracle — it holds on the real file, so these run with no
// database. Style follows tests/remittance_coles.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCAN_MEASURE_COLUMNS,
  parseColesScanCsv,
  channelChecksum,
  type ScanSection,
} from '../src/lib/retail_scan_coles.ts';

const FIXTURE_NAME = 'coles_scan_sample.csv';
const fixtureText = readFileSync(
  fileURLToPath(new URL(`./fixtures/retail_scan/${FIXTURE_NAME}`, import.meta.url)),
  'utf8',
);

const parsed = parseColesScanCsv(fixtureText, FIXTURE_NAME);

/** A structurally-shared-safe copy of a section (rows + measures cloned) for tamper tests. */
const cloneSection = (s: ScanSection): ScanSection => ({
  ...s,
  rows: s.rows.map((r) => ({ ...r, measures: { ...r.measures } })),
});

test('fixture parses: title, sourceFile, 2 sections with the right geographies, 45 rows each', () => {
  assert.equal(parsed.title, 'Weekly Sales (Scan)_SUP');
  assert.equal(parsed.sourceFile, FIXTURE_NAME);
  assert.equal(parsed.sections.length, 2);

  const [national, qld] = parsed.sections;
  assert.equal(national!.geography, 'All Geography by Coles Supermarkets');
  assert.equal(qld!.geography, 'QLD');
  for (const s of parsed.sections) {
    assert.equal(s.manufacturer, 'COLES SUPERMARKET');
    assert.equal(s.brand, 'COLES SUPERMARKET');
    assert.equal(s.subbrand, 'COLES SUPERMARKET');
    assert.equal(s.rows.length, 45);
  }
});

test('SCAN_MEASURE_COLUMNS: 57 unique keys, per-group triples in file order', () => {
  assert.equal(SCAN_MEASURE_COLUMNS.length, 57);
  assert.equal(new Set(SCAN_MEASURE_COLUMNS).size, 57);
  assert.deepEqual(SCAN_MEASURE_COLUMNS.slice(0, 3), [
    'unit_sales',
    'unit_sales_ya',
    'unit_sales_pct_2ya',
  ]);
  assert.deepEqual(SCAN_MEASURE_COLUMNS.slice(-3), [
    'incr_volume_sales',
    'incr_volume_sales_ya',
    'incr_volume_sales_pct_2ya',
  ]);
  assert.ok(SCAN_MEASURE_COLUMNS.includes('dollar_sales'));
  assert.ok(SCAN_MEASURE_COLUMNS.includes('avg_wk_dollars_per_store_pct_2ya'));
});

test('every row carries exactly the 57 kept keys — derivable vs-YA variants are discarded', () => {
  const expected = [...SCAN_MEASURE_COLUMNS].sort();
  for (const s of parsed.sections) {
    for (const r of s.rows) {
      assert.deepEqual(Object.keys(r.measures).sort(), expected);
    }
  }
});

test('known row (BANANAS / Latest 52 / TOTAL) parses exactly, scientific notation intact', () => {
  const r = parsed.sections[0]!.rows[0]!;
  assert.equal(r.product, 'BANANAS');
  assert.equal(r.time_label, 'Latest 52 W/E 07-07-26');
  assert.equal(r.causal, 'TOTAL');
  assert.equal(r.measures['unit_sales'], 87783691.936); // 8.7783691936E7
  assert.equal(r.measures['unit_sales_ya'], 83744598.8688); // 8.37445988688E7
  assert.equal(r.measures['dollar_sales'], 381884509.47); // 3.8188450947E8
});

test('scientific notation round-trips across magnitudes (E7, E8, negative-exponent E-5)', () => {
  // QLD section first row: 1.6250736177E7 units, 7.286394821E7 dollars.
  const qld = parsed.sections[1]!.rows[0]!;
  assert.equal(qld.causal, 'TOTAL');
  assert.equal(qld.measures['unit_sales'], 16250736.177);
  assert.equal(qld.measures['dollar_sales'], 72863948.21);

  // National W/E 19-08-25 TOTAL carries a tiny E-5 value in % Stores / % Change vs 2 YA.
  const wk = parsed.sections[0]!.rows.find(
    (r) => r.time_label === 'W/E 19-08-25' && r.causal === 'TOTAL',
  );
  assert.ok(wk, 'expected the W/E 19-08-25 TOTAL row');
  assert.equal(wk!.measures['pct_stores_pct_2ya'], 9.782037190770778e-5);
});

test('empty fields land as null (In store rows have blank ACV / % Stores blocks), never 0', () => {
  const inStore = parsed.sections[0]!.rows[1]!;
  assert.equal(inStore.causal, 'In store');
  for (const key of [
    'acv_distribution',
    'acv_distribution_ya',
    'acv_distribution_pct_2ya',
    'pct_stores',
    'pct_stores_ya',
    'pct_stores_pct_2ya',
  ]) {
    assert.equal(inStore.measures[key], null, `${key} should be null`);
  }
  // …while the same keys on the sibling TOTAL row are real numbers.
  const total = parsed.sections[0]!.rows[0]!;
  assert.equal(typeof total.measures['acv_distribution'], 'number');
  assert.equal(typeof total.measures['pct_stores'], 'number');
});

test('channelChecksum: In store + Online == TOTAL holds on both fixture sections', () => {
  for (const s of parsed.sections) {
    const c = channelChecksum(s);
    assert.deepEqual(c.mismatches, []);
    assert.equal(c.ok, true);
  }
});

test('channelChecksum: a tampered TOTAL surfaces as a named mismatch', () => {
  const tampered = cloneSection(parsed.sections[0]!);
  const total = tampered.rows[0]!;
  total.measures['unit_sales'] = (total.measures['unit_sales'] as number) + 1000;
  const c = channelChecksum(tampered);
  assert.equal(c.ok, false);
  assert.equal(c.mismatches.length, 1);
  const m = c.mismatches[0]!;
  assert.equal(m.product, 'BANANAS');
  assert.equal(m.time_label, 'Latest 52 W/E 07-07-26');
  assert.equal(m.measure, 'unit_sales');
  assert.ok(Math.abs(m.total - m.sum - 1000) < 0.01);
});

test('channelChecksum: (product, time) groups lacking a causal are skipped, not mismatches', () => {
  const noOnline: ScanSection = {
    ...parsed.sections[0]!,
    rows: parsed.sections[0]!.rows.filter((r) => r.causal !== 'Online'),
  };
  const c = channelChecksum(noOnline);
  assert.equal(c.ok, true);
  assert.deepEqual(c.mismatches, []);
});

test('header drift throws loudly: tampered measure-group name', () => {
  const tampered = fixtureText.replace(
    'Average Weekly ACV Distribution',
    'Average Weekly ACV Distro',
  );
  assert.throws(
    () => parseColesScanCsv(tampered, FIXTURE_NAME),
    /measure-group header drift at column 29: expected "Average Weekly ACV Distribution", got "Average Weekly ACV Distro"/,
  );
});

test('header drift throws loudly: tampered variant name', () => {
  // First "Year Ago" in the file is in header line B (header A carries no variant names).
  const tampered = fixtureText.replace('Year Ago', 'Yr Ago');
  assert.throws(() => parseColesScanCsv(tampered, FIXTURE_NAME), /variant header drift/);
});

test('a short data row (97 columns) throws', () => {
  const lines = fixtureText.split(/\r?\n/);
  lines[7] = lines[7]!.split(',').slice(0, -1).join(','); // first data row loses its last field
  assert.throws(
    () => parseColesScanCsv(lines.join('\n'), FIXTURE_NAME),
    /line 8: data row has 97 columns, expected 98/,
  );
});

test('a long data row (99 columns) throws', () => {
  const lines = fixtureText.split(/\r?\n/);
  lines[7] = `${lines[7]!},0`;
  assert.throws(
    () => parseColesScanCsv(lines.join('\n'), FIXTURE_NAME),
    /data row has 99 columns, expected 98/,
  );
});

test('a non-numeric non-empty value throws — never coerced to 0/NaN', () => {
  const tampered = fixtureText.replace('8.7783691936E7', '8.77bogus');
  assert.throws(
    () => parseColesScanCsv(tampered, FIXTURE_NAME),
    /non-numeric value "8\.77bogus" in column 4 \(Unit Sales \/ Current\)/,
  );
});

test('a section missing SubBrand throws', () => {
  const lines = fixtureText.split(/\r?\n/).filter((l) => !l.startsWith('SubBrand:'));
  assert.throws(
    () => parseColesScanCsv(lines.join('\n'), FIXTURE_NAME),
    /expected "SubBrand:<value>"/,
  );
});

test('section-embedded repeats of the two header lines are skipped', () => {
  const lines = fixtureText.split(/\r?\n/);
  // Re-inject exact copies of header A (line 6) + header B (line 7) mid-way through section 1.
  lines.splice(20, 0, lines[5]!, lines[6]!);
  const reparsed = parseColesScanCsv(lines.join('\n'), FIXTURE_NAME);
  assert.equal(reparsed.sections.length, 2);
  assert.equal(reparsed.sections[0]!.rows.length, 45); // repeats skipped, no phantom rows
  assert.equal(channelChecksum(reparsed.sections[0]!).ok, true);
});

test('a TAMPERED embedded header repeat still throws (drift is never skipped)', () => {
  const lines = fixtureText.split(/\r?\n/);
  lines.splice(20, 0, lines[5]!.replace('Incremental Volume', 'Incremental Vol'));
  assert.throws(
    () => parseColesScanCsv(lines.join('\n'), FIXTURE_NAME),
    /repeated measure-group header drift/,
  );
});

test('a truncated file (ends mid-headers) throws', () => {
  const truncated = fixtureText.split(/\r?\n/).slice(0, 6).join('\n'); // through header A only
  assert.throws(() => parseColesScanCsv(truncated, FIXTURE_NAME), /truncated section 1/);
});

test('empty or non-scan text throws', () => {
  assert.throws(() => parseColesScanCsv('', FIXTURE_NAME), /no "Weekly Sales \(Scan\)_SUP" sections found/);
  assert.throws(
    () => parseColesScanCsv('hello,world\n1,2\n', FIXTURE_NAME),
    /expected section title/,
  );
});

test('channelChecksum: a null leg on a checksum measure is INCOMPLETE, not a mismatch', () => {
  const s = cloneSection(parsed.sections[0]!);
  // null-out unit_sales on one In store row: that group becomes incomplete for that measure,
  // but MUST NOT be reported as an additivity mismatch (data absence ≠ violation).
  const target = s.rows.find((r) => r.causal === 'In store')!;
  target.measures['unit_sales'] = null;
  const cs = channelChecksum(s);
  assert.equal(cs.ok, true);
  assert.equal(cs.mismatches.length, 0);
  assert.ok(cs.incomplete >= 1, `incomplete=${cs.incomplete}`);
  // and the untampered section reports zero incomplete groups (own-brand export has no null legs)
  assert.equal(channelChecksum(parsed.sections[0]!).incomplete, 0);
});
