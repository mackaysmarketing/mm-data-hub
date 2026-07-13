// Woolworths Q.Checkout scan loader → raw.wow_scan_loads + raw.wow_scan_export → core.wow_scan_weekly.
//   npm run wow:load <raw_export.csv>            (runs scripts/parse_wow_scan.py, then lands)
//   npm run wow:load -- --clean <clean.csv> --meta <meta.json>   (land a pre-parsed pair)
//
// READ-ONLY on the source file. Each run = a fresh load_id: the sidecar lands in raw.wow_scan_loads,
// the clean rows land verbatim (all text) in raw.wow_scan_export tagged with load_id, then
// core.upsert_wow_scan_weekly types + upserts them onto the finest-grain PK — so a Quantium
// restatement (trailing-overlap re-export) corrects prior core rows and the core count stays stable
// (idempotent at the core grain, AC4). Nullable metrics never coalesced.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

const CLEAN_COLS = [
  'week_ending', 'article_number', 'uom', 'article_description', 'sub_category', 'segment',
  'state', 'vcu', 'channel', 'promotion', 'volume', 'sales', 'units',
  'avg_price_per_volume', 'avg_unit_price',
] as const;
const BATCH = 500;

/** Minimal RFC-4180 CSV parse (the parser's clean output is simple, but descriptions may be quoted). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

interface ParsedInputs { cleanCsv: string; meta: Record<string, unknown>; sourceFilename: string; }

/** Resolve the (cleanCsv, meta) pair — either given directly, or produced by running the Python parser. */
function resolveInputs(args: string[]): ParsedInputs {
  const cleanArg = args[args.indexOf('--clean') + 1];
  const metaArg = args[args.indexOf('--meta') + 1];
  if (args.includes('--clean') && cleanArg && metaArg) {
    const meta = JSON.parse(readFileSync(metaArg, 'utf8')) as Record<string, unknown>;
    return { cleanCsv: readFileSync(cleanArg, 'utf8'), meta,
             sourceFilename: (meta.source_file as string) ?? basename(cleanArg) };
  }
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) throw new Error('usage: wow:load <raw_export.csv>  |  wow:load -- --clean <csv> --meta <json>');
  const dir = mkdtempSync(join(tmpdir(), 'wowscan-'));
  const clean = join(dir, 'clean.csv'), meta = join(dir, 'meta.json');
  try {
    const r = spawnSync('py', ['-3', 'scripts/parse_wow_scan.py', input, '--out', clean, '--meta', meta],
      { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`parse_wow_scan.py failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
    }
    log(r.stdout.trim());
    return { cleanCsv: readFileSync(clean, 'utf8'),
             meta: JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>,
             sourceFilename: basename(input) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface WowLoadResult { load_id: string; raw_rows: number; core_rows: number; }

export async function loadWowScan(args: string[]): Promise<WowLoadResult> {
  const { cleanCsv, meta, sourceFilename } = resolveInputs(args);
  const rows = parseCsv(cleanCsv);
  const header = rows[0]!;
  if (header.join(',') !== CLEAN_COLS.join(',')) {
    throw new Error(`clean CSV header mismatch — expected ${CLEAN_COLS.join(',')}, got ${header.join(',')}`);
  }
  const data = rows.slice(1).filter((r) => r.length === CLEAN_COLS.length);
  const load_id = randomUUID();
  log(`WOW scan load — ${sourceFilename}: ${data.length} clean rows, load_id ${load_id}`);

  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c: PoolClient = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into raw.wow_scan_loads (load_id, source_filename, export_parameters, stats, coverage)
         values ($1, $2, $3, $4, $5)`,
        [load_id, sourceFilename, JSON.stringify(meta.export_parameters ?? {}),
         JSON.stringify(meta.stats ?? {}), JSON.stringify(meta.coverage ?? {})]);

      // verbatim landing (all text) via jsonb array unnest, batched
      const cols = ['load_id', 'source_filename', ...CLEAN_COLS];
      for (let i = 0; i < data.length; i += BATCH) {
        const nodes = data.slice(i, i + BATCH).map((r) => {
          const o: Record<string, string> = { load_id, source_filename: sourceFilename };
          CLEAN_COLS.forEach((col, j) => { o[col] = r[j] ?? ''; });
          return o;
        });
        await c.query(
          `insert into raw.wow_scan_export (${cols.join(', ')})
           select ${cols.map((col) => (col === 'load_id' ? `(elem->>'${col}')::uuid` : `elem->>'${col}'`)).join(', ')}
           from jsonb_array_elements($1::jsonb) as elem`,
          [JSON.stringify(nodes)]);
      }

      const core = (await c.query<{ n: number }>('select core.upsert_wow_scan_weekly($1) as n', [load_id])).rows[0]!.n;
      await c.query('commit');
      log(`  raw.wow_scan_export: ${data.length} rows landed`);
      log(`  core.wow_scan_weekly: ${core} rows upserted`);
      return { load_id, raw_rows: data.length, core_rows: core };
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const r = await loadWowScan(process.argv.slice(2));
  log(`done: load_id=${r.load_id} raw=${r.raw_rows} core=${r.core_rows}`);
}
