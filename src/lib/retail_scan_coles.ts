// PURE Coles Circana "Weekly Sales (Scan)_SUP" CSV parser: text → ParsedScan. No I/O.
//
// Layout (per the committed fixture, tests/fixtures/retail_scan/coles_scan_sample.csv — the real
// export is 7 sections / 5,345 lines with the identical structure):
//   Repeating sections, one per geography, each delimited by the literal title line
//   "Weekly Sales (Scan)_SUP", then four metadata lines (Geography:<g>, Manufacturer:<m>,
//   Brand:<b>, SubBrand:<s>), then TWO header lines:
//     A: Product,Time,Causal + 19 measure-group names each repeated 5×
//     B: Product,Time,Causal + the 5 variant names cycled 19×
//        (Current, % Change vs YA, Change vs YA, Year Ago, % Change vs 2 YA)
//   then data rows: Product,Time,Causal + 95 numeric fields (scientific notation like
//   8.7783691936E7; empty string = null). 98 columns total. Plain CSV (no quoting observed),
//   but fields are split with a proper quote-tolerant CSV splitter anyway.
//
// Contracts:
//   • FAIL LOUDLY, never silently: any drift from the 98-column header signature throws with a
//     precise message (line, column, expected vs got); a data row with ≠ 98 columns throws; a
//     non-numeric non-empty value throws (never coerced to 0/NaN); a section missing any of
//     Geography/Manufacturer/Brand/SubBrand throws.
//   • Kept variants (the DB migration's 57 columns, SCAN_MEASURE_COLUMNS): Current → <name>,
//     Year Ago → <name>_ya, % Change vs 2 YA → <name>_pct_2ya. The two vs-YA delta variants
//     (Change vs YA, % Change vs YA) are pure derivations → validated numeric, then DISCARDED.
//   • Section-embedded repeats of the two header lines (page repeats in larger exports) are
//     skipped — but only if they match the expected signature exactly; otherwise: drift → throw.
//   • channelChecksum: the verified invariant In store + Online == TOTAL per (product, time)
//     for unit_sales / dollar_sales / volume_sales (Current), within max(0.005, |total|·1e-9).
//     (product, time) groups lacking any of the three causals are skipped, not mismatches.
//     The checksum is total/pure (returns mismatches, never throws); the loader enforces.

const SECTION_TITLE = 'Weekly Sales (Scan)_SUP';

const ID_COLUMNS = ['Product', 'Time', 'Causal'] as const;

/** The 19 measure groups, in file column order. `header` = the exact header-A cell (repeated 5×);
 *  `key` = the base column name the DB migration uses (contract: MUST match exactly). */
const MEASURE_GROUPS: ReadonlyArray<{ header: string; key: string }> = [
  { header: 'Unit Sales', key: 'unit_sales' },
  { header: 'Price Per Unit', key: 'price_per_unit' },
  { header: 'Volume Sales', key: 'volume_sales' },
  { header: 'Price per Volume', key: 'price_per_volume' },
  { header: 'Dollar Sales', key: 'dollar_sales' },
  { header: 'Average Weekly ACV Distribution', key: 'acv_distribution' },
  { header: '% Stores', key: 'pct_stores' },
  { header: 'Avg Weekly Dollars per Store Selling', key: 'avg_wk_dollars_per_store' },
  { header: 'Avg Weekly Units per Store Selling', key: 'avg_wk_units_per_store' },
  { header: 'Avg Weekly Volume Per Store Selling', key: 'avg_wk_volume_per_store' },
  { header: 'Dollar Share of Parent', key: 'dollar_share_parent' },
  { header: 'Unit Share of Parent', key: 'unit_share_parent' },
  { header: 'Volume Share of Parent', key: 'volume_share_parent' },
  { header: 'Base Dollar Sales', key: 'base_dollar_sales' },
  { header: 'Incremental Dollars', key: 'incr_dollar_sales' },
  { header: 'Base Unit Sales', key: 'base_unit_sales' },
  { header: 'Incremental Units', key: 'incr_unit_sales' },
  { header: 'Base Volume Sales', key: 'base_volume_sales' },
  { header: 'Incremental Volume', key: 'incr_volume_sales' },
];

/** The 5 variants, in file column order. `suffix` null = derivable → parse-and-discard. */
const VARIANTS: ReadonlyArray<{ header: string; suffix: string | null }> = [
  { header: 'Current', suffix: '' },
  { header: '% Change vs YA', suffix: null }, // = change/year_ago — pure derivation, not landed
  { header: 'Change vs YA', suffix: null }, // = current − year_ago — pure derivation, not landed
  { header: 'Year Ago', suffix: '_ya' },
  { header: '% Change vs 2 YA', suffix: '_pct_2ya' }, // embeds the 2-years-ago value → landed
];

const EXPECTED_COLS = ID_COLUMNS.length + MEASURE_GROUPS.length * VARIANTS.length; // 98

/** The 57 kept measure keys, in file column order (per group: <name>, <name>_ya, <name>_pct_2ya).
 *  The DB migration's column list — the naming contract lives HERE. */
export const SCAN_MEASURE_COLUMNS: readonly string[] = Object.freeze(
  MEASURE_GROUPS.flatMap((g) =>
    VARIANTS.filter((v) => v.suffix !== null).map((v) => `${g.key}${v.suffix}`),
  ),
);

/** Expected header line A (measure-group names), all 98 cells. */
const EXPECTED_HEADER_A: readonly string[] = [
  ...ID_COLUMNS,
  ...MEASURE_GROUPS.flatMap((g) => VARIANTS.map(() => g.header)),
];

/** Expected header line B (variant cycle), all 98 cells. */
const EXPECTED_HEADER_B: readonly string[] = [
  ...ID_COLUMNS,
  ...MEASURE_GROUPS.flatMap(() => VARIANTS.map((v) => v.header)),
];

/** Column index → kept measure key (null = id column or discarded derivable variant). */
const COLUMN_KEYS: ReadonlyArray<string | null> = EXPECTED_HEADER_A.map((_, i) => {
  if (i < ID_COLUMNS.length) return null;
  const group = MEASURE_GROUPS[Math.floor((i - ID_COLUMNS.length) / VARIANTS.length)]!;
  const variant = VARIANTS[(i - ID_COLUMNS.length) % VARIANTS.length]!;
  return variant.suffix === null ? null : `${group.key}${variant.suffix}`;
});

/** Column index → human label ("Unit Sales / Year Ago") for precise error messages. */
const COLUMN_LABELS: readonly string[] = EXPECTED_HEADER_A.map((_, i) => {
  if (i < ID_COLUMNS.length) return ID_COLUMNS[i]!;
  return `${EXPECTED_HEADER_A[i]} / ${EXPECTED_HEADER_B[i]}`;
});

/** Strict numeric grammar: plain/decimal/scientific, optional leading '-'. Deliberately narrower
 *  than Number() (which would accept '0x10', 'Infinity', whitespace) — anything outside throws. */
const NUMERIC_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export interface ScanRow {
  product: string;
  time_label: string;
  causal: string;
  /** The 57 kept measures (SCAN_MEASURE_COLUMNS); empty source field = null, never 0. */
  measures: Record<string, number | null>;
}

export interface ScanSection {
  geography: string;
  manufacturer: string;
  brand: string;
  subbrand: string;
  rows: ScanRow[];
}

export interface ParsedScan {
  title: string;
  sourceFile: string;
  sections: ScanSection[];
}

/** Split one CSV line into fields, tolerant of quoted fields with `""` escapes.
 *  (The Coles export is plain unquoted CSV; this is defensive.) */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function fail(sourceFile: string, lineNo: number, message: string): never {
  throw new Error(`Coles scan (${sourceFile}) line ${lineNo}: ${message}`);
}

/** Assert a header line matches the expected 98-cell signature; throw on ANY drift. */
function assertHeader(
  cells: string[],
  expected: readonly string[],
  which: string,
  sourceFile: string,
  lineNo: number,
): void {
  if (cells.length !== expected.length) {
    fail(
      sourceFile,
      lineNo,
      `${which} header has ${cells.length} columns, expected ${expected.length}`,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (cells[i] !== expected[i]) {
      fail(
        sourceFile,
        lineNo,
        `${which} header drift at column ${i + 1}: expected "${expected[i]}", got "${cells[i]}"`,
      );
    }
  }
}

function arrayEquals(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const META_FIELDS = [
  { prefix: 'Geography:', key: 'geography' },
  { prefix: 'Manufacturer:', key: 'manufacturer' },
  { prefix: 'Brand:', key: 'brand' },
  { prefix: 'SubBrand:', key: 'subbrand' },
] as const;

/** Parse a Coles Circana scan CSV into sections. Pure; throws loudly on ANY structural drift. */
export function parseColesScanCsv(text: string, sourceFile: string): ParsedScan {
  // Tolerate a UTF-8 BOM (the sampled export is plain ASCII; this is defensive).
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);

  const sections: ScanSection[] = [];
  type State = 'expect-title' | 'meta' | 'header-a' | 'header-b' | 'data';
  let state: State = 'expect-title';
  let metaIdx = 0;
  let meta: Record<string, string> = {};
  let rows: ScanRow[] = [];

  const finishSection = (lineNo: number): void => {
    if (rows.length === 0) {
      fail(sourceFile, lineNo, `section ${sections.length + 1} ("${meta['geography']}") has no data rows`);
    }
    sections.push({
      geography: meta['geography']!,
      manufacturer: meta['manufacturer']!,
      brand: meta['brand']!,
      subbrand: meta['subbrand']!,
      rows,
    });
    meta = {};
    rows = [];
  };

  const parseDataRow = (cells: string[], lineNo: number): ScanRow => {
    if (cells.length !== EXPECTED_COLS) {
      fail(
        sourceFile,
        lineNo,
        `data row has ${cells.length} columns, expected ${EXPECTED_COLS} ` +
          `(product "${cells[0] ?? ''}", time "${cells[1] ?? ''}", causal "${cells[2] ?? ''}")`,
      );
    }
    const measures: Record<string, number | null> = {};
    for (let c = ID_COLUMNS.length; c < EXPECTED_COLS; c += 1) {
      const token = cells[c]!;
      let value: number | null;
      if (token === '') {
        value = null; // empty source field = null — NEVER coerced to 0
      } else if (NUMERIC_RE.test(token)) {
        value = Number(token); // covers scientific notation (8.7783691936E7)
      } else {
        fail(
          sourceFile,
          lineNo,
          `non-numeric value "${token}" in column ${c + 1} (${COLUMN_LABELS[c]})`,
        );
      }
      const key = COLUMN_KEYS[c];
      if (key !== null && key !== undefined) measures[key] = value; // derivable variants: validated, then discarded
    }
    return { product: cells[0]!, time_label: cells[1]!, causal: cells[2]!, measures };
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    if (raw.trim() === '') continue; // blank/trailing lines carry nothing

    switch (state) {
      case 'expect-title': {
        if (raw !== SECTION_TITLE) {
          fail(sourceFile, lineNo, `expected section title "${SECTION_TITLE}", got "${raw}"`);
        }
        state = 'meta';
        metaIdx = 0;
        break;
      }
      case 'meta': {
        const field = META_FIELDS[metaIdx]!;
        if (!raw.startsWith(field.prefix)) {
          fail(
            sourceFile,
            lineNo,
            `section ${sections.length + 1}: expected "${field.prefix}<value>", got "${raw}"`,
          );
        }
        meta[field.key] = raw.slice(field.prefix.length);
        metaIdx += 1;
        if (metaIdx === META_FIELDS.length) state = 'header-a';
        break;
      }
      case 'header-a': {
        assertHeader(splitCsvLine(raw), EXPECTED_HEADER_A, 'measure-group', sourceFile, lineNo);
        state = 'header-b';
        break;
      }
      case 'header-b': {
        assertHeader(splitCsvLine(raw), EXPECTED_HEADER_B, 'variant', sourceFile, lineNo);
        state = 'data';
        break;
      }
      case 'data': {
        if (raw === SECTION_TITLE) {
          finishSection(lineNo);
          state = 'meta';
          metaIdx = 0;
          break;
        }
        const cells = splitCsvLine(raw);
        if (cells[0] === 'Product' && cells[1] === 'Time' && cells[2] === 'Causal') {
          // Section-embedded repeat of a header line: skip ONLY an exact match; drift → throw.
          if (arrayEquals(cells, EXPECTED_HEADER_A) || arrayEquals(cells, EXPECTED_HEADER_B)) break;
          const expected = cells[3] === EXPECTED_HEADER_B[3] ? EXPECTED_HEADER_B : EXPECTED_HEADER_A;
          const which = expected === EXPECTED_HEADER_B ? 'variant' : 'measure-group';
          assertHeader(cells, expected, `repeated ${which}`, sourceFile, lineNo);
          break; // (unreachable — a repeat that fully matches was skipped above)
        }
        rows.push(parseDataRow(cells, lineNo));
        break;
      }
    }
  }

  const lastLineNo = lines.length;
  if (state === 'expect-title') {
    fail(sourceFile, lastLineNo, `no "${SECTION_TITLE}" sections found`);
  }
  if (state !== 'data') {
    fail(sourceFile, lastLineNo, `truncated section ${sections.length + 1}: file ended mid-${state}`);
  }
  finishSection(lastLineNo);

  return { title: SECTION_TITLE, sourceFile, sections };
}

/** The three Current-variant measures the channel-additivity invariant is asserted over. */
const CHECKSUM_MEASURES = ['unit_sales', 'dollar_sales', 'volume_sales'] as const;

const CAUSAL_TOTAL = 'TOTAL';
const CAUSAL_IN_STORE = 'In store';
const CAUSAL_ONLINE = 'Online';

export interface ChannelChecksumMismatch {
  product: string;
  time_label: string;
  measure: string;
  /** The TOTAL row's value. */
  total: number;
  /** In store + Online. */
  sum: number;
}

/** Assert In store + Online == TOTAL per (product, time_label) for unit/dollar/volume sales
 *  (Current), within max(0.005, |total|·1e-9). Groups lacking any of the three causals are
 *  skipped (not mismatches), and so is a MEASURE whose value is null on any leg — data absence is
 *  not an additivity violation (the manufacturer-split export legitimately carries nulls on thin
 *  manufacturer×state cells; observed 432 null unit_sales rows). Skips are counted in `incomplete`
 *  so the loader can log them — absence is surfaced, never asserted away and never coalesced to 0.
 *  Pure — never throws; the loader enforces. */
export function channelChecksum(section: ScanSection): {
  ok: boolean;
  mismatches: ChannelChecksumMismatch[];
  /** groups with an absent causal row or a null checksum-measure leg (not assertable). */
  incomplete: number;
} {
  const byProductTime = new Map<string, Map<string, ScanRow>>();
  for (const row of section.rows) {
    const key = `${row.product}\u0000${row.time_label}`;
    let causals = byProductTime.get(key);
    if (!causals) {
      causals = new Map();
      byProductTime.set(key, causals);
    }
    causals.set(row.causal, row);
  }

  const mismatches: ChannelChecksumMismatch[] = [];
  let incomplete = 0;
  for (const causals of byProductTime.values()) {
    const total = causals.get(CAUSAL_TOTAL);
    const inStore = causals.get(CAUSAL_IN_STORE);
    const online = causals.get(CAUSAL_ONLINE);
    if (!total || !inStore || !online) { incomplete++; continue; } // absent causal row → skipped
    let groupIncomplete = false;
    for (const measure of CHECKSUM_MEASURES) {
      const t = total.measures[measure];
      const i = inStore.measures[measure];
      const o = online.measures[measure];
      if (t == null || i == null || o == null) { groupIncomplete = true; continue; } // null leg → not assertable
      const sum = i + o;
      const tolerance = Math.max(0.005, Math.abs(t) * 1e-9); // sub-cent floor: source is exactly additive (adversarial review — 0.02 could never catch a 1-cent corruption)
      if (!(Math.abs(sum - t) <= tolerance)) {
        mismatches.push({
          product: total.product,
          time_label: total.time_label,
          measure,
          total: t,
          sum,
        });
      }
    }
    if (groupIncomplete) incomplete++;
  }
  return { ok: mismatches.length === 0, mismatches, incomplete };
}
