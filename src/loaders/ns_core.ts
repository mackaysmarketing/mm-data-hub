// Core conformance for NetSuite settlement (Sprint 5). Run after ns:backfill.
//   npm run ns:core
// 1) Populate core.dim_ns_charge from raw.ns_item via the unit-tested classifier.
// 2) Rebuild core.fact_settlement_bill (SQL refresh — crosswalk + sign-based rollup + paid status).
import type { PoolClient } from 'pg';
import { makePool } from '../lib/db.ts';
import { classifyCharge } from '../lib/ns_charges.ts';
import { isMain, log } from '../lib/util.ts';

/** Classify every raw.ns_item and upsert core.dim_ns_charge. Returns rows affected. */
export async function refreshCharges(client: PoolClient): Promise<number> {
  const items = await client.query<{ id: string; itemid: string | null; displayname: string | null }>(
    'select id, itemid, displayname from raw.ns_item',
  );
  const nodes = items.rows.map((r) => {
    const c = classifyCharge(r.itemid, r.displayname);
    return {
      item_id: r.id,
      itemid: r.itemid,
      displayname: r.displayname,
      category: c.category,
      category_label: c.categoryLabel,
      subcategory: c.subcategory,
      detail: c.detail,
      produce: c.produce,
      is_product: c.isProduct,
    };
  });
  if (nodes.length === 0) return 0;
  // Direct upsert (core.dim_ns_charge uses _built_at, not the raw _synced_at convention).
  const res = await client.query(
    `insert into core.dim_ns_charge
       (item_id, itemid, displayname, category, category_label, subcategory, detail, produce, is_product, _built_at)
     select (e->>'item_id')::bigint, e->>'itemid', e->>'displayname', e->>'category',
            e->>'category_label', e->>'subcategory', e->>'detail', e->>'produce',
            (e->>'is_product')::boolean, now()
       from jsonb_array_elements($1::jsonb) e
     on conflict (item_id) do update set
       itemid=excluded.itemid, displayname=excluded.displayname, category=excluded.category,
       category_label=excluded.category_label, subcategory=excluded.subcategory,
       detail=excluded.detail, produce=excluded.produce, is_product=excluded.is_product, _built_at=now()`,
    [JSON.stringify(nodes)],
  );
  return res.rowCount ?? 0;
}

/** Rebuild core.fact_settlement_bill. Returns rows inserted. */
export async function refreshFact(client: PoolClient): Promise<number> {
  const r = await client.query<{ refresh_fact_settlement: number }>(
    'select core.refresh_fact_settlement()',
  );
  return r.rows[0]?.refresh_fact_settlement ?? 0;
}

export async function buildCore(client: PoolClient): Promise<{ charges: number; bills: number }> {
  const charges = await refreshCharges(client);
  const bills = await refreshFact(client);
  return { charges, bills };
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const r = await buildCore(client);
    log(`core: dim_ns_charge=${r.charges} fact_settlement_bill=${r.bills}`);
  } finally {
    client.release();
    await pool.end();
  }
}
