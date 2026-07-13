// End-to-end tests over the REAL WOW Q.Checkout parser (scripts/parse_wow_scan.py), driven via
// `py -3` exactly as the loader invokes Python (see src/loaders/remittance.ts precedent). Fixtures:
//   mini_source.csv    — synthetic export whose finest-grain rows SUM to the Australia/Total
//                        anchor rows the file also contains (30 data rows: finest + total-grain
//                        + blank cross-join padding), so row accounting AND reconciliation-style
//                        checks are both testable without the 40 MB real file.
//   renamed_column.csv — the same file with header 'Simple VCU' renamed 'Store VCU' (AC6).
//   clean_sample.csv / sample_meta.json — committed artifacts from the real 13 Jul 2026 sample
//                        run. The clean CSV is a 100 KB excerpt: 613 complete CRLF lines incl.
//                        header, then one dangling partial row with no line terminator.
// Expected drop counts are DERIVED from the fixture in-run with the same rules the parser
// encodes (blank checked before total-grain), so both sides of every accounting assertion are
// computed. Style follows tests/remittance_coles.test.ts. No database, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/parse_wow_scan.py', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/wow_scan', import.meta.url));
const MINI = join(FIXTURE_DIR, 'mini_source.csv');
const RENAMED = join(FIXTURE_DIR, 'renamed_column.csv');

// Mirror of the parser's OUT_COLUMNS — the clean-CSV contract consumed by the wow:load loader.
const OUT_COLUMNS = [
  'week_ending', 'article_number', 'uom', 'article_description',
  'sub_category', 'segment', 'state', 'vcu', 'channel', 'promotion',
  'volume', 'sales', 'units', 'avg_price_per_volume', 'avg_unit_price',
];
// Mirror of the parser's NULL_MARKERS (blank and '-' are what Q.Checkout actually emits).
const NULL_MARKERS = new Set(['', '-', 'n/a', 'na', 'null']);

// ---- drive the real parser ---------------------------------------------------------------
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface ParserRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outPath: string;
  metaPath: string;
}

function runParser(input: string, extraArgs: string[] = []): ParserRun {
  const dir = mkdtempSync(join(tmpdir(), 'wow-scan-test-'));
  tempDirs.push(dir);
  const outPath = join(dir, 'clean.csv');
  const metaPath = join(dir, 'meta.json');
  const res = spawnSync(
    'py',
    ['-3', SCRIPT, input, '--out', outPath, '--meta', metaPath, ...extraArgs],
    { encoding: 'utf8' },
  );
  if (res.error) throw res.error; // `py -3` launcher missing entirely — fail the suite loudly
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outPath, metaPath };
}

type Row = Record<string, string>;

function readCleanCsv(path: string): { header: string[]; rows: Row[] } {
  // The clean output is quote-free by construction (no commas inside any emitted value).
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0]!.split(',');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
  return { header, rows };
}

const main = runParser(MINI);
const keep = runParser(MINI, ['--keep-totals']);
const renamed = runParser(RENAMED);

const mainSidecar = JSON.parse(readFileSync(main.metaPath, 'utf8')) as {
  stats: Record<string, number>;
  export_parameters: Record<string, string>;
};
const keepSidecar = JSON.parse(readFileSync(keep.metaPath, 'utf8')) as {
  stats: Record<string, number>;
};
const stats = mainSidecar.stats;
const clean = readCleanCsv(main.outPath);
const keepClean = readCleanCsv(keep.outPath);

// ---- derive the fixture's own row classification (both-sides-derived accounting) ----------
const srcLines = readFileSync(MINI, 'utf8').split(/\r?\n/);
const hdrIdx = srcLines.findIndex((l) => l.startsWith('Promo Week,'));
assert.ok(hdrIdx >= 0, 'fixture must contain the Promo Week header row');
// Data rows in the fixture are quote-free by construction, so a plain split is faithful.
const srcRows = srcLines
  .slice(hdrIdx + 1)
  .filter((l) => l.trim() !== '')
  .map((l) => l.split(','));

const isNullCell = (c: string): boolean => NULL_MARKERS.has(c.trim().toLowerCase());
const isBlankRow = (r: string[]): boolean => r.slice(8, 13).every((c) => isNullCell(c));
const isTotalGrain = (r: string[]): boolean =>
  r[4] === 'Australia' || r[5] === 'Total' || r[6] === 'Total' || r[7] === 'Total';

const fixtureBlank = srcRows.filter((r) => isBlankRow(r)).length;
// The parser checks blank BEFORE total-grain, so a blank Australia/Total row counts as blank.
const fixtureTotalGrain = srcRows.filter((r) => !isBlankRow(r) && isTotalGrain(r)).length;
const fixtureFinest = srcRows.length - fixtureBlank - fixtureTotalGrain;

// ---- (a) exit 0, columns, accounting -------------------------------------------------------
test('mini fixture parses exit-0; clean columns == OUT_COLUMNS; accounting balances', () => {
  assert.equal(main.status, 0, `parser failed:\n${main.stderr}\n${main.stdout}`);
  assert.deepEqual(clean.header, OUT_COLUMNS);
  assert.equal(clean.rows.length, stats.rows_out, 'clean CSV row count == sidecar rows_out');

  // The load-accounting contract: everything in must be accounted for.
  assert.equal(
    stats.rows_in,
    stats.rows_out! + stats.rows_blank_dropped! + stats.rows_total_grain_dropped!,
  );

  // Both sides derived: sidecar counts == the fixture's own classification.
  assert.equal(stats.rows_in, srcRows.length);
  assert.equal(stats.rows_out, fixtureFinest);
  assert.equal(stats.rows_blank_dropped, fixtureBlank);
  assert.equal(stats.rows_total_grain_dropped, fixtureTotalGrain);

  // Sanity on the fixture's designed shape (guards against fixture edits gutting coverage).
  assert.ok(fixtureFinest >= 9 && fixtureBlank >= 9 && fixtureTotalGrain >= 12);
});

// ---- (b) null markers -----------------------------------------------------------------------
test("'-' metric cells land as empty (null), never 0", () => {
  // 30/06 QLD banana row carries '-' in avg_price_per_volume only.
  const qld = clean.rows.find(
    (r) => r.week_ending === '2026-06-30' && r.article_number === '0133211' && r.state === 'QUEENSLAND',
  );
  assert.ok(qld, 'expected the 2026-06-30 QUEENSLAND banana row in the clean output');
  assert.equal(qld!.avg_price_per_volume, '', "'-' must become an empty cell");
  assert.equal(Number(qld!.avg_unit_price), 3.46, 'neighbouring real value survives');
  assert.equal(Number(qld!.sales), 155.9);

  // EA article: volume and avg_price_per_volume are '-' on every row — all must be null.
  const ea = clean.rows.filter((r) => r.article_number === '0104424');
  assert.ok(ea.length > 0, 'expected EA article rows');
  for (const r of ea) {
    assert.equal(r.volume, '', 'EA volume must be null, never 0');
    assert.equal(r.avg_price_per_volume, '');
    assert.notEqual(r.volume, '0');
    assert.notEqual(r.volume, '0.0');
  }
});

// ---- (c) total-grain filtering + --keep-totals ---------------------------------------------
test('Total-grain rows dropped (count derived from fixture); --keep-totals keeps them', () => {
  // Default run: no Australia / Total residue at any dimension.
  for (const r of clean.rows) {
    assert.notEqual(r.state, 'Australia');
    assert.notEqual(r.vcu, 'Total');
    assert.notEqual(r.channel, 'TOTAL'); // channel/promotion are uppercased by the parser
    assert.notEqual(r.promotion, 'TOTAL');
  }
  assert.equal(stats.rows_total_grain_dropped, fixtureTotalGrain);

  // --keep-totals: nothing dropped as total-grain; those rows land in the output instead.
  assert.equal(keep.status, 0, keep.stderr);
  assert.equal(keepSidecar.stats.rows_total_grain_dropped, 0);
  assert.equal(keepSidecar.stats.rows_out, stats.rows_out! + stats.rows_total_grain_dropped!);
  assert.equal(keepSidecar.stats.rows_blank_dropped, stats.rows_blank_dropped, 'blank rows drop either way');
  const australiaRows = keepClean.rows.filter((r) => r.state === 'Australia');
  assert.ok(australiaRows.length > 0, '--keep-totals must retain Australia rows');
});

// ---- (d) product parse ----------------------------------------------------------------------
test('product splits into article/uom/description for KG and EA; unparsed == 0', () => {
  const banana = clean.rows.find((r) => r.article_number === '0133211');
  assert.ok(banana, 'expected 0133211 rows');
  assert.equal(banana!.uom, 'KG');
  assert.equal(banana!.article_description, 'BANANA 1KG');
  assert.equal(banana!.sub_category, 'BANANA');

  const passion = clean.rows.find((r) => r.article_number === '0104424');
  assert.ok(passion, 'expected 0104424 rows');
  assert.equal(passion!.uom, 'EA');
  assert.equal(passion!.article_description, 'PASSIONFRUIT 8EA');
  assert.equal(passion!.sub_category, 'TROPICAL FRUIT');

  assert.equal(stats.rows_unparsed_product, 0);
});

// ---- (e) AC6: header change fails loudly ----------------------------------------------------
test('renamed dimension column (Simple VCU -> Store VCU) exits non-zero naming both headers', () => {
  assert.notEqual(renamed.status, 0, 'a changed header must NEVER parse silently');
  const message = renamed.stderr + renamed.stdout;
  assert.match(message, /dimension columns changed/);
  assert.ok(message.includes('Simple VCU'), 'message must show the expected column');
  assert.ok(message.includes('Store VCU'), 'message must show the got column');
});

// ---- (f) date conversion --------------------------------------------------------------------
test('DD/MM/YYYY converts to ISO; weeks are Tuesdays', () => {
  const weeks = [...new Set(clean.rows.map((r) => r.week_ending ?? ''))].sort();
  assert.deepEqual(weeks, ['2026-06-30', '2026-07-07']);
  for (const w of weeks) {
    assert.match(w, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!w.includes('/'), 'no DD/MM/YYYY residue');
    assert.equal(new Date(`${w}T00:00:00Z`).getUTCDay(), 2, `WOW promo weeks end Tuesday: ${w}`);
  }
});

// ---- reconciliation: finest grain sums to the export's own Australia/Total slice ------------
test("finest-grain rows sum to the file's Australia/Total anchor rows (volume/sales/units)", () => {
  const anchors = keepClean.rows.filter(
    (r) => r.state === 'Australia' && r.vcu === 'Total' && r.channel === 'TOTAL' && r.promotion === 'TOTAL',
  );
  assert.equal(anchors.length, 4, 'fixture carries one Australia/Total anchor per week x article');

  const sumOrNull = (rows: Row[], col: string): number | null => {
    const vals = rows.map((r) => r[col] ?? '').filter((v) => v !== '');
    if (vals.length === 0) return null;
    return vals.reduce((acc, v) => acc + Number(v), 0);
  };

  for (const anchor of anchors) {
    const legs = clean.rows.filter(
      (r) => r.week_ending === anchor.week_ending && r.article_number === anchor.article_number,
    );
    assert.ok(legs.length > 0, `no finest-grain legs for ${anchor.week_ending} ${anchor.article_number}`);
    for (const col of ['volume', 'sales', 'units']) {
      const anchorCell = anchor[col] ?? '';
      const legSum = sumOrNull(legs, col);
      if (anchorCell === '') {
        // EA volume: null in the anchor AND null on every leg — never coalesced to 0.
        assert.equal(legSum, null, `${col} anchor is null but legs sum to ${legSum}`);
      } else {
        assert.ok(legSum !== null, `${col} anchor has a value but all legs are null`);
        assert.ok(
          Math.abs(legSum! - Number(anchorCell)) < 1e-9,
          `${anchor.week_ending} ${anchor.article_number} ${col}: legs ${legSum} != anchor ${anchorCell}`,
        );
      }
    }
  }
});

// ---- committed real-sample artifacts --------------------------------------------------------
test('committed real-sample fixtures exist and are self-consistent', () => {
  const cleanPath = join(FIXTURE_DIR, 'clean_sample.csv');
  const metaPath = join(FIXTURE_DIR, 'sample_meta.json');
  assert.ok(existsSync(cleanPath), 'clean_sample.csv must be committed');
  assert.ok(existsSync(metaPath), 'sample_meta.json must be committed');

  // The excerpt holds 613 complete (newline-terminated) lines incl. header; the 100 KB cut
  // leaves a dangling partial row with no terminator, which is NOT a complete line.
  const content = readFileSync(cleanPath, 'utf8');
  const completeLines = (content.match(/\n/g) ?? []).length;
  assert.equal(completeLines, 613);
  assert.equal(content.split(/\r?\n/)[0], OUT_COLUMNS.join(','), 'excerpt header matches the contract');

  // Accounting balances per the sidecar's OWN numbers (no external constants).
  const sample = JSON.parse(readFileSync(metaPath, 'utf8')) as {
    stats: Record<string, number>;
    coverage: { states: string[]; week_min: string; week_max: string };
  };
  const s = sample.stats;
  assert.equal(s.rows_in, s.rows_out! + s.rows_blank_dropped! + s.rows_total_grain_dropped!);
  assert.equal(s.rows_unparsed_product, 0);

  // Coverage sanity: finest grain only (no Australia), Tuesday week bounds.
  assert.ok(!sample.coverage.states.includes('Australia'));
  for (const w of [sample.coverage.week_min, sample.coverage.week_max]) {
    assert.equal(new Date(`${w}T00:00:00Z`).getUTCDay(), 2, `${w} should be a Tuesday`);
  }
});
