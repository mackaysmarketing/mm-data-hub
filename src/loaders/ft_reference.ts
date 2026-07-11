// FreshTrack REFERENCE loader → raw.ft_consignee / ft_product / ft_crop / ft_variety /
// ft_pack_type (read-replica source). Sprint: closeout C1 (conformed dimensions).
//   npm run ft:ref:load
//
// READ-ONLY out of FreshTrack (src/lib/freshtrack_db.ts, session pinned read-only). The five
// tables are TINY (135/251/7/22/25 rows) so this is a FULL SYNC every run — no windowing, no
// sync_window bookkeeping. Idempotent: upsert on id. All replica fetches complete BEFORE the hub
// connection is opened for the upserts (a hub connection left idle through a fetch gets dropped
// by the pooler — house lore from the NetSuite loader).
//
// Specs follow the ft_gp_specs.ts contract: column ↔ source column in one auditable place,
// temporal columns read via ::text so a date never round-trips through a +10 JS Date.
import type { PoolClient } from 'pg';
import { makePool, assertHubTarget, upsertNodes } from '../lib/db.ts';
import { connectFreshtrackRead } from '../lib/freshtrack_db.ts';
import { ftSelectList, type FtSpec } from '../lib/ft_gp_specs.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;

// ── Landing specs (hub table = ft_ + source table) ────────────────────────────
export const ftConsigneeSpec: FtSpec = {
  schema: 'raw', table: 'ft_consignee', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'vendor_no', key: 'vendor_no', kind: 'text' },
    { col: 'b2b_code', key: 'b2b_code', kind: 'text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

export const ftProductSpec: FtSpec = {
  schema: 'raw', table: 'ft_product', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'description', key: 'description', kind: 'text' },
    { col: 'unit', key: 'unit', kind: 'text' },
    { col: 'count', key: 'count', kind: 'int' },
    { col: 'price_value', key: 'price_value', kind: 'numeric' },
    { col: 'boxes_per_pallet', key: 'boxes_per_pallet', kind: 'int' },
    { col: 'net_weight_value', key: 'net_weight_value', kind: 'numeric' },
    { col: 'net_weight_unit', key: 'net_weight_unit', kind: 'text' },
    { col: 'size_equivalent', key: 'size_equivalent', kind: 'numeric' },
    { col: 'ean13', key: 'ean13', kind: 'text' },
    { col: 'ean14', key: 'ean14', kind: 'text' },
    { col: 'crop_id', key: 'crop_id', kind: 'uuid' },
    { col: 'variety_id', key: 'variety_id', kind: 'uuid' },
    { col: 'subvariety_id', key: 'subvariety_id', kind: 'uuid' },
    { col: 'pack_type_id', key: 'pack_type_id', kind: 'uuid' },
    { col: 'type_id', key: 'type_id', kind: 'uuid' },
    { col: 'is_organic', key: 'is_organic', kind: 'bool' },
    { col: 'is_sellable', key: 'is_sellable', kind: 'bool' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'consignee_description', key: 'consignee_description', kind: 'text' },
    { col: 'account_code', key: 'account_code', kind: 'text' },
    { col: 'netsuite_id', key: 'netsuite_id', kind: 'text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

export const ftCropSpec: FtSpec = {
  schema: 'raw', table: 'ft_crop', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'family', key: 'family', kind: 'text' },
    { col: 'account_code', key: 'account_code', kind: 'text' },
    { col: 'netsuite_id', key: 'netsuite_id', kind: 'text' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

export const ftVarietySpec: FtSpec = {
  schema: 'raw', table: 'ft_variety', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'description', key: 'description', kind: 'text' },
    { col: 'crop_id', key: 'crop_id', kind: 'uuid' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

export const ftPackTypeSpec: FtSpec = {
  schema: 'raw', table: 'ft_pack_type', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'tare_value', key: 'tare_value', kind: 'numeric' },
    { col: 'tare_unit', key: 'tare_unit', kind: 'text' },
    { col: 'is_pre_pack', key: 'is_pre_pack', kind: 'bool' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

const SPECS: FtSpec[] = [ftConsigneeSpec, ftProductSpec, ftCropSpec, ftVarietySpec, ftPackTypeSpec];

/** Source table = hub table minus the `ft_` prefix (ft_consignee → consignee). */
function sourceTable(spec: FtSpec): string {
  return spec.table.replace(/^ft_/, '');
}

export type RefLoadResult = Record<string, { seen: number; upserted: number }>;

/** Full sync of the five reference tables: fetch all (replica), then upsert all (hub). */
export async function loadReference(): Promise<RefLoadResult> {
  // Phase 1 — fetch everything from the replica (no hub connection held).
  const ft = await connectFreshtrackRead();
  const fetched = new Map<string, Node[]>();
  try {
    log('Reference full sync (read-only replica) — consignee, product, crop, variety, pack_type');
    for (const spec of SPECS) {
      const sql = `SELECT ${ftSelectList(spec)} FROM public.${sourceTable(spec)} ORDER BY id`;
      fetched.set(spec.table, (await ft.query(sql)).rows as Node[]);
    }
  } finally { await ft.end(); }

  // Phase 2 — upsert into the hub (idempotent on id).
  const pool = makePool();
  const result: RefLoadResult = {};
  try {
    await assertHubTarget(pool);
    const client: PoolClient = await pool.connect();
    try {
      for (const spec of SPECS) {
        const rows = fetched.get(spec.table) ?? [];
        const upserted = await upsertNodes(client, spec, rows);
        result[spec.table] = { seen: rows.length, upserted };
        log(`  ${spec.table}: seen=${rows.length} upserted=${upserted}`);
      }
    } finally { client.release(); }
  } finally { await pool.end(); }
  return result;
}

if (isMain(import.meta.url)) {
  const r = await loadReference();
  const parts = Object.entries(r).map(([t, x]) => `${t.replace(/^ft_/, '')}=${x.upserted}`);
  log(`done: ${parts.join(' ')}`);
}
