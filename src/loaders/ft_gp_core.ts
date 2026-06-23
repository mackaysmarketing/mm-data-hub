// Core conformance for FreshTrack GP settlement (Sprint 6). Run after ft:gp:load.
//   npm run ft:gp:core
// 1) Populate core.dim_gp_charge from raw.ft_charge (+ charge_type) via the unit-tested classifier.
// 2) Rebuild core.fact_gp_settlement (schedule grain) + core.fact_gp_settlement_load (load grain).
import type { PoolClient } from 'pg';
import { makePool } from '../lib/db.ts';
import { classifyGpCharge } from '../lib/ft_gp_charges.ts';
import { isMain, log } from '../lib/util.ts';

interface ChargeRow {
  charge_id: string;
  name: string | null;
  charge_type_id: string | null;
  ct_code: string | null;
  ct_scope: string | null;
  account_code: string | null;
  is_deductible: boolean | null;
  vat_info: string | null;
  netsuite_id: string | null;
}

/** Classify every raw.ft_charge and upsert core.dim_gp_charge. Returns rows affected. */
export async function refreshGpCharges(client: PoolClient): Promise<number> {
  // The charge's own account_code is the classifier primary; charge_type.scope/name are the fallback.
  const rows = (await client.query<ChargeRow>(
    `select c.id as charge_id, c.name, c.charge_type_id,
            ct.code as ct_code, ct.scope as ct_scope,
            coalesce(nullif(btrim(c.account_code),''), ct.account_code) as account_code,
            coalesce(ct.is_deductible, false) as is_deductible,
            c.vat_info, c.netsuite_id
       from raw.ft_charge c
       left join raw.ft_charge_type ct on ct.id = c.charge_type_id`,
  )).rows;

  const nodes = rows.map((r) => {
    const cls = classifyGpCharge(r.account_code, r.ct_scope, r.name);
    return {
      charge_id: r.charge_id,
      name: r.name,
      charge_type_id: r.charge_type_id,
      ct_code: r.ct_code,
      ct_scope: r.ct_scope,
      account_code: r.account_code,
      category: cls.category,
      category_label: cls.categoryLabel,
      subcategory: cls.subcategory,
      is_deductible: r.is_deductible,
      vat_info: r.vat_info,
      netsuite_id: r.netsuite_id,
    };
  });
  if (nodes.length === 0) return 0;

  const res = await client.query(
    `insert into core.dim_gp_charge
       (charge_id, name, charge_type_id, ct_code, ct_scope, account_code, category, category_label,
        subcategory, is_deductible, vat_info, netsuite_id, _built_at)
     select (e->>'charge_id')::uuid, e->>'name', nullif(e->>'charge_type_id','')::uuid,
            e->>'ct_code', e->>'ct_scope', e->>'account_code', e->>'category', e->>'category_label',
            e->>'subcategory', (e->>'is_deductible')::boolean, e->>'vat_info', e->>'netsuite_id', now()
       from jsonb_array_elements($1::jsonb) e
     on conflict (charge_id) do update set
       name=excluded.name, charge_type_id=excluded.charge_type_id, ct_code=excluded.ct_code,
       ct_scope=excluded.ct_scope, account_code=excluded.account_code, category=excluded.category,
       category_label=excluded.category_label, subcategory=excluded.subcategory,
       is_deductible=excluded.is_deductible, vat_info=excluded.vat_info,
       netsuite_id=excluded.netsuite_id, _built_at=now()`,
    [JSON.stringify(nodes)],
  );
  return res.rowCount ?? 0;
}

export async function refreshFactSchedule(client: PoolClient): Promise<number> {
  const r = await client.query<{ refresh_fact_gp_settlement: number }>(
    'select core.refresh_fact_gp_settlement()',
  );
  return r.rows[0]?.refresh_fact_gp_settlement ?? 0;
}

export async function refreshFactLoad(client: PoolClient): Promise<number> {
  const r = await client.query<{ refresh_fact_gp_settlement_load: number }>(
    'select core.refresh_fact_gp_settlement_load()',
  );
  return r.rows[0]?.refresh_fact_gp_settlement_load ?? 0;
}

export async function buildGpCore(client: PoolClient): Promise<{ charges: number; schedules: number; loads: number }> {
  const charges = await refreshGpCharges(client);
  const schedules = await refreshFactSchedule(client);
  const loads = await refreshFactLoad(client);
  return { charges, schedules, loads };
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const r = await buildGpCore(client);
    log(`core: dim_gp_charge=${r.charges} fact_gp_settlement=${r.schedules} fact_gp_settlement_load=${r.loads}`);
  } finally {
    client.release();
    await pool.end();
  }
}
