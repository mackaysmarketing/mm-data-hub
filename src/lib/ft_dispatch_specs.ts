// FreshTrack DISPATCH landing specs (Sprint 7) — source-column ↔ hub-column map in one
// auditable place, mirroring ft_gp_specs.ts. Source = FreshTrack prod Postgres, so columns
// match 1:1 (key === col); the recon (DISPATCH_COLUMN_MAP.md) confirmed 0 gaps against the
// existing raw.ft_dispatch_load / raw.ft_pallet shape the dashboard view reads. Date/timestamptz
// columns carry select: 'col::text' so a date is read as text and never round-trips through a
// +10h JS Date (off-by-one) before the hub recasts it (same reasoning as the GP loader).
//
// The hub tables keep the curated SPEC §3 set only — the many extra source columns
// (gross_weight, created_on, last_modified_on, location_id, harvest_load_id, …) are
// intentionally NOT landed (see DISPATCH_COLUMN_MAP.md §2/§3). location_id (SPEC §9.2) and
// harvest_load_id (SPEC §9.1) stay unmodelled.
import type { FtSpec } from './ft_gp_specs.ts';

// ── raw.ft_dispatch_load ← public.dispatch_load (grain: one load) ─────────────
export const ftDispatchLoadSpec: FtSpec = {
  schema: 'raw', table: 'ft_dispatch_load', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'load_no', key: 'load_no', kind: 'text' },
    { col: 'order_type', key: 'order_type', kind: 'text' },                 // 'S'/'B' text, never enum
    { col: 'state_id', key: 'state_id', kind: 'uuid' },                     // → dispatch_load_state (lifecycle; redefinition next step)
    { col: 'scheduled_pickup_on', key: 'scheduled_pickup_on', kind: 'timestamptz', select: 'scheduled_pickup_on::text' },
    { col: 'actual_pickup_on', key: 'actual_pickup_on', kind: 'timestamptz', select: 'actual_pickup_on::text' }, // view dispatched_on/at
    { col: 'scheduled_delivery_on', key: 'scheduled_delivery_on', kind: 'timestamptz', select: 'scheduled_delivery_on::text' },
    { col: 'actual_delivery_on', key: 'actual_delivery_on', kind: 'timestamptz', select: 'actual_delivery_on::text' },
    { col: 'pack_date', key: 'pack_date', kind: 'date', select: 'pack_date::text' },
    { col: 'asn_sent_on', key: 'asn_sent_on', kind: 'timestamptz', select: 'asn_sent_on::text' },
    { col: 'latest_order_modified_on', key: 'latest_order_modified_on', kind: 'timestamptz', select: 'latest_order_modified_on::text' },
    { col: 'consignor_id', key: 'consignor_id', kind: 'uuid' },             // grower key / RLS anchor / view grower_key
    { col: 'consignee_id', key: 'consignee_id', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketer_id', kind: 'uuid' },
    { col: 'carrier_id', key: 'carrier_id', kind: 'uuid' },
    { col: 'shed_id', key: 'shed_id', kind: 'uuid' },
    { col: 'market_area_id', key: 'market_area_id', kind: 'uuid' },
    { col: 'order_id', key: 'order_id', kind: 'uuid' },
    { col: 'order_no', key: 'order_no', kind: 'text' },
    { col: 'po_no', key: 'po_no', kind: 'text' },
    { col: 'latest_order_version_no', key: 'latest_order_version_no', kind: 'int' },
    { col: 'stock_boxes', key: 'stock_boxes', kind: 'int' },
    { col: 'reconsigned_boxes', key: 'reconsigned_boxes', kind: 'int' },
    { col: 'is_complete', key: 'is_complete', kind: 'bool' },
    { col: 'is_locked', key: 'is_locked', kind: 'bool' },
    { col: 'attached_document_count', key: 'attached_document_count', kind: 'int' },
    { col: 'manifest_no', key: 'manifest_no', kind: 'text' },
    { col: 'certificate_no', key: 'certificate_no', kind: 'text' },
    { col: 'pallet_transfer_no', key: 'pallet_transfer_no', kind: 'text' },
    { col: 'dc_slot_ref', key: 'dc_slot_ref', kind: 'text' },
    { col: 'temperature_profile_id', key: 'temperature_profile_id', kind: 'uuid' },
    { col: 'temperature_value', key: 'temperature_value', kind: 'numeric' },
    { col: 'comment', key: 'comment', kind: 'text' },
    { col: 'extra_text_2', key: 'extra_text_2', kind: 'text' },             // pack-week Y{YY}W{WW}; view pack_week
  ],
};

// ── raw.ft_pallet ← public.pallet (grain: one pallet) ─────────────────────────
export const ftPalletSpec: FtSpec = {
  schema: 'raw', table: 'ft_pallet', idColumn: 'id', withRaw: false,        // large table, no _raw
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },                                 // view pallet_id
    { col: 'pallet_no', key: 'pallet_no', kind: 'text' },
    { col: 'barcode', key: 'barcode', kind: 'text' },
    { col: 'dispatch_load_id', key: 'dispatch_load_id', kind: 'uuid' },     // FK → ft_dispatch_load.id (view join)
    { col: 'product_id', key: 'product_id', kind: 'uuid' },
    { col: 'product_description', key: 'product_description', kind: 'text' }, // view product; may carry ^{…} codes
    { col: 'crop_description', key: 'crop_description', kind: 'text' },       // view crop
    { col: 'variety_description', key: 'variety_description', kind: 'text' }, // view variety
    { col: 'consignee_id', key: 'consignee_id', kind: 'uuid' },
    { col: 'shed_id', key: 'shed_id', kind: 'uuid' },
    { col: 'state_id', key: 'state_id', kind: 'uuid' },
    { col: 'type_id', key: 'type_id', kind: 'uuid' },
    { col: 'spaces', key: 'spaces', kind: 'numeric' },
    { col: 'expected_box_count', key: 'expected_box_count', kind: 'numeric' },
    { col: 'box_count', key: 'box_count', kind: 'numeric' },                 // view boxes (own-stock only; see DISPATCH_DEFINITION_PROPOSAL.md)
    { col: 'stock_boxes', key: 'stock_boxes', kind: 'int' },                 // own-stock packed boxes
    { col: 'reconsigned_boxes', key: 'reconsigned_boxes', kind: 'int' },     // reconsigned boxes (where reconsignment volume lives)
    { col: 'net_weight_value', key: 'net_weight_value', kind: 'numeric' },   // view net_weight; nullable — NEVER coalesce to 0 (SPEC §9.3)
    { col: 'net_weight_unit', key: 'net_weight_unit', kind: 'text' },
    { col: 'packed_on', key: 'packed_on', kind: 'timestamptz', select: 'packed_on::text' },
    { col: 'is_archived', key: 'is_archived', kind: 'bool' },                // view is_archived
    { col: 'is_field', key: 'is_field', kind: 'bool' },                      // view is_field
    { col: 'supplier_highlights', key: 'supplier_highlights', kind: 'text' },
    { col: 'comment', key: 'comment', kind: 'text' },
  ],
};
