// Sprint 7 · Step-0 order lookup (LOAD-SAFE, read-only). Pulls one dispatch load (+ its
// pallets) from the live FreshTrack source so it can be compared field-by-field with the
// FreshTrack app portal. Searches load_no / order_no / sales_order_no / po_no for the token.
//
//   node --experimental-strip-types scripts/ft_dispatch_order_lookup.ts 5021160
//
// Read-only (session pinned). Shows the grower's OWN data for the data owner to eyeball.
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

function noVerifySsl(c: string): string {
  return /[?&]sslmode=/i.test(c) ? c.replace(/sslmode=[^&]*/i, 'sslmode=no-verify') : c + (c.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}
async function ro(url: string, app: string): Promise<pg.Client> {
  const c = new Client({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, application_name: app, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  return c;
}

function showBlock(title: string, row: Record<string, unknown>): void {
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(row)) {
    const disp = v === null ? 'NULL' : String(v);
    console.log(`   ${k.padEnd(24)} ${disp}`);
  }
}

async function main(): Promise<void> {
  const token = process.argv[2] ?? '5021160';
  const like = `%${token}%`;
  const ft = await ro(process.env.FRESHTRACK_DATABASE_URL!, 'mm ft:dispatch order-lookup (ro src)');
  const hub = await ro(process.env.DATABASE_URL!, 'mm ft:dispatch order-lookup (ro hub)');
  try {
    console.log(`Searching FreshTrack public.dispatch_load for "${token}" (load_no/order_no/sales_order_no/po_no)…`);
    const loads = await ft.query(
      `SELECT id::text AS id, load_no, order_no, sales_order_no, po_no,
              consignor_id::text AS consignor_id, order_type,
              is_complete, is_locked, is_archived,
              created_on::text          AS created_on,
              last_modified_on::text    AS last_modified_on,
              scheduled_pickup_on::text AS scheduled_pickup_on,
              actual_pickup_on::text    AS actual_pickup_on,
              scheduled_delivery_on::text AS scheduled_delivery_on,
              actual_delivery_on::text  AS actual_delivery_on,
              pack_date::text           AS pack_date,
              asn_sent_on::text         AS asn_sent_on,
              email_sent_on::text       AS email_sent_on,
              stock_boxes, reconsigned_boxes, rejected_boxes, waste_boxes
         FROM public.dispatch_load
        WHERE load_no ILIKE $1 OR order_no ILIKE $1 OR sales_order_no ILIKE $1 OR po_no ILIKE $1
        ORDER BY created_on DESC
        LIMIT 20`,
      [like],
    );

    if (loads.rows.length === 0) {
      console.log(`\nNo dispatch_load matched "${token}".`);
      return;
    }
    console.log(`Matched ${loads.rows.length} load(s).`);

    // Resolve consignor_id → grower code from the hub.
    const cids = [...new Set(loads.rows.map((r) => (r as any).consignor_id).filter(Boolean))];
    const codeByCid = new Map<string, string>();
    if (cids.length) {
      const g = await hub.query<{ consignor_id: string; code: string; org_name: string }>(
        `SELECT consignor_id::text AS consignor_id, code, org_name FROM core.dim_grower WHERE consignor_id = ANY($1::uuid[])`,
        [cids],
      );
      for (const r of g.rows) codeByCid.set(r.consignor_id, `${r.code} (${r.org_name})`);
    }

    for (const load of loads.rows as any[]) {
      const grower = codeByCid.get(load.consignor_id) ?? '(not in dim_grower)';
      showBlock(`════ LOAD ${load.load_no}  — grower ${grower}`, { ...load, grower });

      // Pallet summary + the view-relevant per-pallet fields.
      const sum = await ft.query(
        `SELECT count(*)::int AS pallets,
                count(box_count)::int AS pallets_with_box,
                sum(box_count)::numeric AS total_box_count,
                count(net_weight_value)::int AS pallets_with_net_wt,
                sum(net_weight_value)::numeric AS total_net_weight
           FROM public.pallet WHERE dispatch_load_id = $1`,
        [load.id],
      );
      showBlock(`   — pallet summary (view "boxes" = box_count, "net_weight" = net_weight_value):`, sum.rows[0] as any);

      const pal = await ft.query(
        `SELECT pallet_no, crop_description, variety_description, product_description,
                box_count, net_weight_value, net_weight_unit, expected_box_count,
                stock_boxes, reconsigned_boxes, packed_on::text AS packed_on,
                loaded_on::text AS loaded_on, is_field, is_archived
           FROM public.pallet WHERE dispatch_load_id = $1
          ORDER BY pallet_no LIMIT 40`,
        [load.id],
      );
      console.log(`   — pallets (${pal.rows.length} shown, max 40):`);
      for (const p of pal.rows as any[]) {
        console.log(
          `      #${String(p.pallet_no).padEnd(10)} ${String(p.crop_description ?? '').padEnd(12)} ${String(p.variety_description ?? '').padEnd(14)} ` +
          `box_count=${p.box_count ?? 'NULL'}  net_wt=${p.net_weight_value ?? 'NULL'}${p.net_weight_unit ?? ''}  packed_on=${p.packed_on ?? 'NULL'}  loaded_on=${p.loaded_on ?? 'NULL'}`,
        );
      }
    }
    console.log('\n=== lookup done (read-only). Compare the dates/boxes above with the FreshTrack portal. ===');
  } finally {
    await ft.end().catch(() => {});
    await hub.end().catch(() => {});
  }
}
main().catch((e) => { console.error('LOOKUP FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
