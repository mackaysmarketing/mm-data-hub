// Coles retail-scan loader → raw.retail_scan (Circana "Weekly Sales (Scan)_SUP" CSV export).
//   npm run scan:load                       (default: the Downloads export pattern)
//   npm run scan:load -- <file-or-dir> ...  (explicit files/dirs)
//
// Pure parsing lives in src/lib/retail_scan_coles.ts (header-drift fails loudly). Before ANY write,
// every section must pass the channel checksum (In store + Online == TOTAL on units/dollars/volume)
// — a failed advice aborts the whole batch. Idempotent upsert on the natural key
// (retailer|geography|product|time_label|causal): weekly re-drops of the rolling 52-week window
// simply refresh (retailer revisions win). READ-ONLY on the source file; writes only raw.retail_scan.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { PoolClient } from 'pg';
import { makePool, assertHubTarget, upsertNodes, type UpsertSpec, type Column } from '../lib/db.ts';
import {
  parseColesScanCsv, channelChecksum, SCAN_MEASURE_COLUMNS, type ParsedScan,
} from '../lib/retail_scan_coles.ts';
import { isMain, log } from '../lib/util.ts';

const RETAILER = 'coles';
const DEFAULT_DIR = 'C:/Users/timwi/Downloads';
const DEFAULT_PATTERN = /^Weekly Sales \(Scan\)_SUP.*\.csv$/i;
const BATCH = 500;

const spec: UpsertSpec = {
  schema: 'raw', table: 'retail_scan', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'retailer', key: 'retailer', kind: 'text' },
    { col: 'geography', key: 'geography', kind: 'text' },
    { col: 'manufacturer', key: 'manufacturer', kind: 'text' },
    { col: 'brand', key: 'brand', kind: 'text' },
    { col: 'subbrand', key: 'subbrand', kind: 'text' },
    { col: 'product', key: 'product', kind: 'text' },
    { col: 'time_label', key: 'time_label', kind: 'text' },
    { col: 'causal', key: 'causal', kind: 'text' },
    // the 57 measure columns — SCAN_MEASURE_COLUMNS is the single source of truth (matches 0042)
    ...SCAN_MEASURE_COLUMNS.map((m): Column => ({ col: m, key: m, kind: 'numeric' })),
    { col: 'source_file', key: 'source_file', kind: 'text' },
  ],
};

function resolveFiles(args: string[]): string[] {
  const inputs = args.length > 0 ? args : [DEFAULT_DIR];
  const files: string[] = [];
  for (const p of inputs) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) {
        if ((args.length > 0 ? /\.csv$/i : DEFAULT_PATTERN).test(f)) files.push(join(p, f));
      }
    } else {
      files.push(p);
    }
  }
  if (files.length === 0) throw new Error(`no scan CSVs found in: ${inputs.join(', ')}`);
  // Oldest first: exports overlap on the rolling 52-week window and the upsert is last-write-wins,
  // so the NEWEST export's revision of a shared (geography, product, week, causal) key must land last.
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return files;
}

export interface ScanLoadResult { files: number; sections: number; rows: number; }

export async function loadRetailScan(args: string[]): Promise<ScanLoadResult> {
  const files = resolveFiles(args);
  log(`Coles retail-scan load — ${files.length} CSV(s)`);

  // Phase 1 — parse + validate EVERYTHING before any hub connection (a bad file aborts the batch).
  const parsed: ParsedScan[] = [];
  for (const f of files) {
    const p = parseColesScanCsv(readFileSync(f, 'utf8'), basename(f));
    let incomplete = 0;
    for (const s of p.sections) {
      const cs = channelChecksum(s);
      if (!cs.ok) {
        const first = cs.mismatches[0]!;
        throw new Error(
          `channel checksum FAILED in ${basename(f)} [${s.geography}]: ${cs.mismatches.length} mismatch(es); ` +
          `first: ${first.product} ${first.time_label} ${first.measure} total=${first.total} in_store+online=${first.sum}`);
      }
      incomplete += cs.incomplete;
    }
    const rows = p.sections.reduce((a, s) => a + s.rows.length, 0);
    log(`  parsed ${basename(f)}: ${p.sections.length} section(s), ${rows} rows ` +
        `(checksum OK; ${incomplete} incomplete group(s) skipped — data absence, surfaced)`);
    parsed.push(p);
  }

  // Phase 2 — idempotent upsert.
  const pool = makePool();
  const result: ScanLoadResult = { files: files.length, sections: 0, rows: 0 };
  try {
    await assertHubTarget(pool);
    const c: PoolClient = await pool.connect();
    try {
      for (const p of parsed) {
        for (const s of p.sections) {
          const nodes = s.rows.map((r) => {
            for (const part of [s.geography, r.product, r.time_label, r.causal]) {
              if (part.includes('|')) throw new Error(`'|' in key part: ${part}`);
            }
            return {
              id: [RETAILER, s.geography, r.product, r.time_label, r.causal].join('|'),
              retailer: RETAILER,
              geography: s.geography,
              manufacturer: s.manufacturer,
              brand: s.brand,
              subbrand: s.subbrand,
              product: r.product,
              time_label: r.time_label,
              causal: r.causal,
              ...r.measures,
              source_file: p.sourceFile,
            } as Record<string, unknown>;
          });
          let up = 0;
          for (let i = 0; i < nodes.length; i += BATCH) {
            up += await upsertNodes(c, spec, nodes.slice(i, i + BATCH));
          }
          log(`  landed [${s.geography}]: ${up} rows`);
          result.sections += 1;
          result.rows += up;
        }
      }
    } finally { c.release(); }
  } finally { await pool.end(); }
  return result;
}

if (isMain(import.meta.url)) {
  const r = await loadRetailScan(process.argv.slice(2).filter((a) => !a.startsWith('--')));
  log(`done: files=${r.files} sections=${r.sections} rows=${r.rows}`);
}
