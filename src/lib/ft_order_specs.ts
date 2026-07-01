// FreshTrack ORDER-domain landing specs (Sprint: order-domain ingest) — column ↔ source-column map
// in one auditable place, mirroring ft_gp_specs.ts. The SELECT list is derived from these
// (ftSelectList) so the read query and the upsert can never drift. Source = FreshTrack's Postgres
// read-replica (public.order / order_version / order_item), so column names already match 1:1
// (key === col). Timestamptz columns carry select:'col::text' so a timestamp is read as text and
// never round-trips through a JS Date before the hub recasts it (same reasoning as the GP loader).
//
// Grain: order (header) 1─* order_version (each a full re-issue) 1─* order_item (priced lines).
// _raw jsonb kept on the two header-ish tables (ft_order + ft_order_version) — NOT on the 73k
// ft_order_item lines (mirrors _raw on dispatch_load/entity, not pallet). enums (type, edi_status,
// gs1_order_type, price_currency, price_per, *_currency) all land as TEXT (SPEC §9.6 — never enum).
import type { UpsertSpec, Column } from './db.ts';
import type { FtSpec } from './ft_gp_specs.ts';
export { ftSelectList } from './ft_gp_specs.ts';
export type { FtSpec } from './ft_gp_specs.ts';

// ── raw.ft_order (order headers) — faithful 40-col mirror, _raw kept ──────────
export const ftOrderSpec: FtSpec = {
  schema: 'raw', table: 'ft_order', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'type', key: 'type', kind: 'text' },                 // 'S'/'B' — text, never enum
    { col: 'order_no', key: 'order_no', kind: 'text' },
    { col: 'sales_order_no', key: 'sales_order_no', kind: 'text' },
    { col: 'po_no', key: 'po_no', kind: 'text' },               // join key → dispatch
    { col: 'scheduled_pickup_on', key: 'scheduled_pickup_on', kind: 'timestamptz', select: 'scheduled_pickup_on::text' },
    { col: 'actual_pickup_on', key: 'actual_pickup_on', kind: 'timestamptz', select: 'actual_pickup_on::text' },
    { col: 'scheduled_delivery_on', key: 'scheduled_delivery_on', kind: 'timestamptz', select: 'scheduled_delivery_on::text' },
    { col: 'actual_delivery_on', key: 'actual_delivery_on', kind: 'timestamptz', select: 'actual_delivery_on::text' },
    { col: 'is_archived', key: 'is_archived', kind: 'bool' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'consignee_id', key: 'consignee_id', kind: 'uuid' }, // BUYER (retailer)
    { col: 'consignor_id', key: 'consignor_id', kind: 'uuid' }, // SELLER on a sell order (NOT a grower key)
    { col: 'market_area_id', key: 'market_area_id', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketer_id', kind: 'uuid' },   // Mackays Marketing on the majority
    { col: 'load_description', key: 'load_description', kind: 'text' },
    { col: 'comment', key: 'comment', kind: 'text' },
    { col: 'state_id', key: 'state_id', kind: 'uuid' },
    { col: 'attached_document_count', key: 'attached_document_count', kind: 'int' },
    { col: 'edi_status', key: 'edi_status', kind: 'text' },
    { col: 'gs1_order_type', key: 'gs1_order_type', kind: 'text' },
    { col: 'parent_id', key: 'parent_id', kind: 'uuid' },
    { col: 'shed_id', key: 'shed_id', kind: 'uuid' },
    { col: 'supplier_id', key: 'supplier_id', kind: 'uuid' },
    { col: 'highlights', key: 'highlights', kind: 'text' },
    { col: 'is_edi', key: 'is_edi', kind: 'bool' },
    { col: 'delivery_contact_id', key: 'delivery_contact_id', kind: 'uuid' },
    { col: 'b2b_integration_id', key: 'b2b_integration_id', kind: 'uuid' },
    { col: 'allocation_percentage', key: 'allocation_percentage', kind: 'numeric' },
    { col: 'production_percentage', key: 'production_percentage', kind: 'numeric' },
    { col: 'total_ordered', key: 'total_ordered', kind: 'int' }, // ordered QTY (boxes) — not a dollar total
    { col: 'info', key: 'info', kind: 'text' },
    { col: 'pallet_overview', key: 'pallet_overview', kind: 'text' },
    { col: 'sale_entity_id', key: 'sale_entity_id', kind: 'uuid' },
    { col: 'priority', key: 'priority', kind: 'int' },
    { col: 'discount_currency', key: 'discount_currency', kind: 'text' },
    { col: 'discount_percentage', key: 'discount_percentage', kind: 'numeric' },
    { col: 'discount_value', key: 'discount_value', kind: 'numeric' },
    { col: 'payment_term_id', key: 'payment_term_id', kind: 'uuid' },
  ],
};

// ── raw.ft_order_version (each version = a full re-issue of the lines) ────────
export const ftOrderVersionSpec: FtSpec = {
  schema: 'raw', table: 'ft_order_version', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'version_no', key: 'version_no', kind: 'int' },
    { col: 'received_on', key: 'received_on', kind: 'timestamptz', select: 'received_on::text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'order_id', key: 'order_id', kind: 'uuid' },
  ],
};

// ── raw.ft_order_item (priced lines) — faithful 32-col mirror, NO _raw ───────
export const ftOrderItemSpec: FtSpec = {
  schema: 'raw', table: 'ft_order_item', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'pallet_count', key: 'pallet_count', kind: 'int' },
    { col: 'boxes_per_pallet', key: 'boxes_per_pallet', kind: 'int' },
    { col: 'price_value', key: 'price_value', kind: 'numeric' },       // NEVER coalesced (SPEC §9.3)
    { col: 'price_currency', key: 'price_currency', kind: 'text' },
    { col: 'price_per', key: 'price_per', kind: 'text' },              // BOX / WEIGHT_UNIT / ...
    { col: 'total_box_count', key: 'total_box_count', kind: 'int' },   // pre-computed line box count
    { col: 'total_price_value', key: 'total_price_value', kind: 'numeric' }, // pre-computed line $ (native)
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'product_id', key: 'product_id', kind: 'uuid' },
    { col: 'order_version_id', key: 'order_version_id', kind: 'uuid' }, // → order_version.id (version selector)
    { col: 'remitted_price_currency', key: 'remitted_price_currency', kind: 'text' },
    { col: 'remitted_price_value', key: 'remitted_price_value', kind: 'numeric' },
    { col: 'bottom_hi', key: 'bottom_hi', kind: 'int' },
    { col: 'ti', key: 'ti', kind: 'int' },
    { col: 'is_split', key: 'is_split', kind: 'bool' },
    { col: 'top_hi', key: 'top_hi', kind: 'int' },
    { col: 'unsplit_hi', key: 'unsplit_hi', kind: 'int' },
    { col: 'hand_stack', key: 'hand_stack', kind: 'int' },
    { col: 'line_no', key: 'line_no', kind: 'int' },
    { col: 'shed_id', key: 'shed_id', kind: 'uuid' },
    { col: 'ean13', key: 'ean13', kind: 'text' },
    { col: 'ean14', key: 'ean14', kind: 'text' },
    { col: 'item_no', key: 'item_no', kind: 'text' },
    { col: 'dispatch_load_id', key: 'dispatch_load_id', kind: 'uuid' }, // join key → dispatch (nullable)
    { col: 'proposed_price_currency', key: 'proposed_price_currency', kind: 'text' },
    { col: 'proposed_price_value', key: 'proposed_price_value', kind: 'numeric' },
    { col: 'proposed_quantity', key: 'proposed_quantity', kind: 'int' },
    { col: 'discount_currency', key: 'discount_currency', kind: 'text' },
    { col: 'discount_percentage', key: 'discount_percentage', kind: 'numeric' },
    { col: 'discount_value', key: 'discount_value', kind: 'numeric' },
  ],
};

// Re-export the base Column/UpsertSpec types for callers that want them.
export type { Column, UpsertSpec };
