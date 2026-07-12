// Coles remittance-advice loader → raw.remittance / raw.remittance_line (AR sprint, Chunk 3).
//
//   npm run remit:load                       the two default Coles PDFs in Downloads (below)
//   npm run remit:load -- <file.pdf | dir> …  explicit file(s) and/or director(y|ies) of PDFs
//
// Channel = manual PDF drop (auto-ingest deferred). PDF→text extraction is IMPURE and lives HERE
// (child-process pypdf, `py -3`); the parser (src/lib/remittance_coles.ts) stays pure/text-only.
// pypdf is used rather than an npm PDF lib because this repo's package.json is off-limits to add a
// dependency and the pypdf extract is clean (no OCR). Each advice's checksum (Σ payment == total) is
// asserted BEFORE any write. Idempotent: header upserts on retailer-payment_no, lines on
// remittance_id-seq, so re-running the same PDFs lands 0 net-new. READ-ONLY out of the source PDFs.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PoolClient } from 'pg';
import { makePool, assertHubTarget, upsertNodes, type UpsertSpec } from '../lib/db.ts';
import { parseColesRemittanceText, assertColesChecksum } from '../lib/remittance_coles.ts';
import type { ParsedRemittance } from '../lib/remittance.ts';
import { isMain, log } from '../lib/util.ts';

// Default drop location + filename pattern (Coles: YYYYMMDD_<colesAcct 942306>_<seq>_<paymentNo>.pdf).
const DEFAULT_DIR = 'C:\\Users\\timwi\\Downloads';
const DEFAULT_PATTERN = /^20260706_942306_.*\.pdf$/i;

// ── landing specs (id/keys match the raw columns; upsertNodes maps key → column) ──────────────
const remittanceSpec: UpsertSpec = {
  schema: 'raw', table: 'remittance', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'retailer', key: 'retailer', kind: 'text' },
    { col: 'payment_no', key: 'payment_no', kind: 'text' },
    { col: 'period_ending', key: 'period_ending', kind: 'date' },
    { col: 'total_amount', key: 'total_amount', kind: 'numeric' },
    { col: 'vendor_no', key: 'vendor_no', kind: 'text' },
    { col: 'source_file', key: 'source_file', kind: 'text' },
    { col: 'line_count', key: 'line_count', kind: 'int' },
  ],
};

const remittanceLineSpec: UpsertSpec = {
  schema: 'raw', table: 'remittance_line', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'remittance_id', key: 'remittance_id', kind: 'text' },
    { col: 'seq', key: 'seq', kind: 'int' },
    { col: 'invoice_no', key: 'invoice_no', kind: 'text' },
    { col: 'doc_type', key: 'doc_type', kind: 'text' },
    { col: 'doc_date', key: 'doc_date', kind: 'date' },
    { col: 'store_no', key: 'store_no', kind: 'text' },
    { col: 'document_amount', key: 'document_amount', kind: 'numeric' },
    { col: 'discount_amount', key: 'discount_amount', kind: 'numeric' },
    { col: 'payment_amount', key: 'payment_amount', kind: 'numeric' },
    { col: 'gst', key: 'gst', kind: 'numeric' },
    { col: 'wt', key: 'wt', kind: 'numeric' },
    { col: 'is_claim', key: 'is_claim', kind: 'bool' },
  ],
};

// Batch line upserts — one INSERT…SELECT over a multi-MB JSON param can exceed the pooler limit
// (house lore from ns_settlement.ts). Advices are small, but keep the guard for a large backfill.
const UPSERT_BATCH = 1000;
async function upsertBatched(
  client: PoolClient,
  spec: UpsertSpec,
  nodes: Record<string, unknown>[],
): Promise<number> {
  let total = 0;
  for (let i = 0; i < nodes.length; i += UPSERT_BATCH) {
    total += await upsertNodes(client, spec, nodes.slice(i, i + UPSERT_BATCH));
  }
  return total;
}

/** Extract all page text from a PDF via pypdf (`py -3`). IMPURE — kept out of the pure parser. */
export function extractPdfText(pdfPath: string): string {
  const script =
    'import sys\n' +
    'from pypdf import PdfReader\n' +
    'sys.stdout.reconfigure(encoding="utf-8")\n' +
    'r = PdfReader(sys.argv[1])\n' +
    'print("\\n".join((p.extract_text() or "") for p in r.pages))\n';
  const res = spawnSync('py', ['-3', '-c', script, pdfPath], {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`remit: pypdf launch failed for ${pdfPath} (is "py -3" on PATH?): ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`remit: pypdf extraction failed for ${pdfPath} (exit ${res.status}): ${res.stderr?.trim()}`);
  }
  return res.stdout ?? '';
}

/** Resolve CLI args → a list of PDF paths. No args → the two default Coles PDFs in Downloads. */
export function resolvePdfPaths(args: string[]): string[] {
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    return readdirSync(DEFAULT_DIR)
      .filter((f) => DEFAULT_PATTERN.test(f))
      .sort()
      .map((f) => join(DEFAULT_DIR, f));
  }
  const out: string[] = [];
  for (const a of positional) {
    const st = statSync(a);
    if (st.isDirectory()) {
      out.push(
        ...readdirSync(a)
          .filter((f) => /\.pdf$/i.test(f))
          .sort()
          .map((f) => join(a, f)),
      );
    } else {
      out.push(a);
    }
  }
  return out;
}

export interface RemitLoadResult {
  source_file: string;
  payment_no: string;
  header_upserted: number;
  lines_upserted: number;
  total_amount: number;
}

/** Parse (pure) + checksum every PDF, then land header + lines into the hub. Idempotent. */
export async function loadRemittances(pdfPaths: string[]): Promise<RemitLoadResult[]> {
  if (pdfPaths.length === 0) throw new Error('remit: no PDF files to load');

  // Phase 1 — extract + parse + checksum every advice BEFORE opening a hub connection. A parse or
  // checksum failure aborts the whole run before any write.
  const advices: ParsedRemittance[] = pdfPaths.map((p) => {
    const text = extractPdfText(p);
    const advice = parseColesRemittanceText(text, basename(p));
    assertColesChecksum(advice);
    log(`  parsed ${advice.source_file}: payment ${advice.payment_no}, ${advice.lines.length} lines, total ${advice.total_amount} (checksum OK)`);
    return advice;
  });

  // Phase 2 — land into the hub (idempotent upserts).
  const pool = makePool();
  const results: RemitLoadResult[] = [];
  try {
    await assertHubTarget(pool);
    const client = await pool.connect();
    try {
      for (const a of advices) {
        const id = `${a.retailer}-${a.payment_no}`;
        const headerNode: Record<string, unknown> = {
          id,
          retailer: a.retailer,
          payment_no: a.payment_no,
          period_ending: a.period_ending,
          total_amount: a.total_amount,
          vendor_no: a.vendor_no,
          source_file: a.source_file,
          line_count: a.lines.length,
        };
        const lineNodes: Record<string, unknown>[] = a.lines.map((l, i) => ({
          id: `${id}-${i + 1}`,
          remittance_id: id,
          seq: i + 1,
          ...l,
        }));
        const header_upserted = await upsertNodes(client, remittanceSpec, [headerNode]);
        const lines_upserted = await upsertBatched(client, remittanceLineSpec, lineNodes);
        log(`  landed ${id}: header=${header_upserted} lines=${lines_upserted}`);
        results.push({
          source_file: a.source_file,
          payment_no: a.payment_no,
          header_upserted,
          lines_upserted,
          total_amount: a.total_amount,
        });
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return results;
}

if (isMain(import.meta.url)) {
  const paths = resolvePdfPaths(process.argv.slice(2));
  log(`Coles remittance load — ${paths.length} PDF(s)`);
  const results = await loadRemittances(paths);
  const lines = results.reduce((n, r) => n + r.lines_upserted, 0);
  log(`done: ${results.length} advice(s), ${lines} line(s) upserted`);
}
