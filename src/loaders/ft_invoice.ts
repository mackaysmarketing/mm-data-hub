// FreshTrack CUSTOMER INVOICE loader → raw.ft_invoice + raw.ft_dispatch_load_invoice
// (read-replica source). Sprint: AR — the receivable-side ORIGIN.
//   npm run ft:invoice:load                        # FULL sync (~14k invoice + ~14k junction rows)
//   npm run ft:invoice:load -- --since=2026-06-01   # INCREMENTAL by last_modified_on (change capture)
//
// READ-ONLY out of FreshTrack (src/lib/freshtrack_db.ts, session pinned read-only). Mirrors the
// reference loader (ft_reference.ts): fetch EVERYTHING from the replica first, THEN open the hub
// connection for the upserts — a hub connection left idle through a fetch gets dropped by the pooler
// (house lore from the NetSuite loader). Idempotent: upsert on id, so a re-run lands 0 net-new.
//
// Raw lands EVERY invoice faithfully (all invoice_types incl. RCTI). The customer-AR scope filter
// (invoice_type IN PI/SI/CN/DR, exclude RCTI) is applied downstream in core, never at pull.
//
// Specs follow the ft_gp_specs.ts contract: column ↔ source column in one auditable place, the
// SELECT list derived from them (ftSelectList) so the read query and the upsert can never drift.
// Source column names already match 1:1 (key === col). Temporal columns carry select: 'col::text'
// so a date is read as text and never round-trips through a +10 JS Date before the hub recasts it.
import type { PoolClient } from 'pg';
import { makePool, assertHubTarget, upsertNodes } from '../lib/db.ts';
import { connectFreshtrackRead } from '../lib/freshtrack_db.ts';
import { ftSelectList, type FtSpec } from '../lib/ft_gp_specs.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;

// ── Landing specs (hub table = ft_ + source table) ────────────────────────────
export const ftInvoiceSpec: FtSpec = {
  schema: 'raw', table: 'ft_invoice', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'invoice_no', key: 'invoice_no', kind: 'text' },
    { col: 'invoice_type', key: 'invoice_type', kind: 'text' },
    { col: 'amount_value', key: 'amount_value', kind: 'numeric' },
    { col: 'amount_currency', key: 'amount_currency', kind: 'text' },
    { col: 'payment_status', key: 'payment_status', kind: 'text' },
    { col: 'sync_status', key: 'sync_status', kind: 'text' },
    { col: 'ext_link', key: 'ext_link', kind: 'text' },
    { col: 'sent_on', key: 'sent_on', kind: 'timestamptz', select: 'sent_on::text' },
    { col: 'paid_on', key: 'paid_on', kind: 'timestamptz', select: 'paid_on::text' },
    { col: 'paid_value', key: 'paid_value', kind: 'numeric' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'sync_on', key: 'sync_on', kind: 'timestamptz', select: 'sync_on::text' },
  ],
};

export const ftDispatchLoadInvoiceSpec: FtSpec = {
  schema: 'raw', table: 'ft_dispatch_load_invoice', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'invoice_id', key: 'invoice_id', kind: 'uuid' },
    { col: 'dispatch_load_id', key: 'dispatch_load_id', kind: 'uuid' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

const SPECS: FtSpec[] = [ftInvoiceSpec, ftDispatchLoadInvoiceSpec];

/** Source table = hub table minus the `ft_` prefix (ft_invoice → invoice). */
function sourceTable(spec: FtSpec): string {
  return spec.table.replace(/^ft_/, '');
}

// A single INSERT…SELECT over a multi-MB JSON parameter can exceed the pooler's limits; batch it
// (same idiom as ft_gp.ts — the reference tables are tiny and skip this, but invoice is ~14k rows).
const UPSERT_BATCH = 1000;
async function upsertBatched(client: PoolClient, spec: FtSpec, nodes: Node[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < nodes.length; i += UPSERT_BATCH) {
    total += await upsertNodes(client, spec, nodes.slice(i, i + UPSERT_BATCH));
  }
  return total;
}

export type InvoiceLoadResult = Record<string, { seen: number; upserted: number }>;

/**
 * Load the invoice header + dispatch-load junction. `since` (YYYY-MM-DD) filters both source tables
 * by last_modified_on for an incremental run; omitted → full sync. Fetch-all (replica) THEN upsert
 * (hub), idempotent on id.
 */
export async function loadInvoices(since?: string): Promise<InvoiceLoadResult> {
  // Phase 1 — fetch everything from the replica (no hub connection held).
  const ft = await connectFreshtrackRead();
  const fetched = new Map<string, Node[]>();
  try {
    log(since
      ? `Invoice incremental since ${since} (last_modified_on watermark) — invoice, dispatch_load_invoice`
      : 'Invoice full sync (read-only replica) — invoice, dispatch_load_invoice');
    const where = since ? 'WHERE last_modified_on >= $1::timestamptz' : '';
    const params = since ? [since] : [];
    for (const spec of SPECS) {
      const sql = `SELECT ${ftSelectList(spec)} FROM public.${sourceTable(spec)} ${where} ORDER BY id`;
      fetched.set(spec.table, (await ft.query(sql, params)).rows as Node[]);
    }
  } finally { await ft.end(); }

  // Phase 2 — upsert into the hub (idempotent on id, batched).
  const pool = makePool();
  const result: InvoiceLoadResult = {};
  try {
    await assertHubTarget(pool);
    const client: PoolClient = await pool.connect();
    try {
      for (const spec of SPECS) {
        const rows = fetched.get(spec.table) ?? [];
        const upserted = await upsertBatched(client, spec, rows);
        result[spec.table] = { seen: rows.length, upserted };
        log(`  ${spec.table}: seen=${rows.length} upserted=${upserted}`);
      }
    } finally { client.release(); }
  } finally { await pool.end(); }
  return result;
}

if (isMain(import.meta.url)) {
  const since = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const r = await loadInvoices(since);
  const parts = Object.entries(r).map(([t, x]) => `${t.replace(/^ft_/, '')}=${x.upserted}`);
  log(`done: ${parts.join(' ')}`);
}
