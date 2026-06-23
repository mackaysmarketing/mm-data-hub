// FreshTrack GP (grower-pool settlement) landing specs — column ↔ source-column mapping in one
// auditable place, mirroring ns_specs.ts. The SELECT list is derived from these (ftSelectList) so
// the read query and the upsert can never drift. Source = FreshTrack's Postgres read-replica, so
// column names already match 1:1 (key === col). Date/timestamptz columns carry select: 'col::text'
// so a date is read as text and never round-trips through a +10 JS Date (off-by-one) before the
// hub recasts it (same reasoning as the NetSuite TO_CHAR approach).
//
// Generated from information_schema (scripts/_gen_gp.ts) against the live source, then curated.
import type { UpsertSpec, Column } from './db.ts';

export interface FtColumn extends Column {
  /** Source SELECT expression; defaults to the column name (= key). */
  select?: string;
}
export interface FtSpec extends UpsertSpec {
  columns: FtColumn[];
}

/** `expr AS key` select list — keeps the read query and the upsert mapping in lockstep. */
export function ftSelectList(spec: FtSpec): string {
  return spec.columns.map((c) => `${c.select ?? c.key} AS ${c.key}`).join(', ');
}

// ── raw.ft_gp_schedule (settlement headers) ──────────────────────────────────
export const ftGpScheduleSpec: FtSpec = {
  schema: 'raw', table: 'ft_gp_schedule', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'schedule_no', key: 'schedule_no', kind: 'text' },
    { col: 'date_from', key: 'date_from', kind: 'date', select: 'date_from::text' },
    { col: 'date_to', key: 'date_to', kind: 'date', select: 'date_to::text' },
    { col: 'payable_on', key: 'payable_on', kind: 'date', select: 'payable_on::text' },
    { col: 'week_no', key: 'week_no', kind: 'int' },
    { col: 'box_count', key: 'box_count', kind: 'numeric' },
    { col: 'crop_quantity_value', key: 'crop_quantity_value', kind: 'numeric' },
    { col: 'weight_value', key: 'weight_value', kind: 'numeric' },
    { col: 'weight_unit', key: 'weight_unit', kind: 'text' },
    { col: 'boxes_delivered', key: 'boxes_delivered', kind: 'numeric' },
    { col: 'invoiced_amount_value', key: 'invoiced_amount_value', kind: 'numeric' },
    { col: 'paid_amount_value', key: 'paid_amount_value', kind: 'numeric' },
    { col: 'amount_currency', key: 'amount_currency', kind: 'text' },
    { col: 'remittable_percentage', key: 'remittable_percentage', kind: 'numeric' },
    { col: 'is_organic', key: 'is_organic', kind: 'bool' },
    { col: 'checked_by_user_1_on', key: 'checked_by_user_1_on', kind: 'timestamptz', select: 'checked_by_user_1_on::text' },
    { col: 'checked_by_user_2_on', key: 'checked_by_user_2_on', kind: 'timestamptz', select: 'checked_by_user_2_on::text' },
    { col: 'is_archived', key: 'is_archived', kind: 'bool' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'checked_by_user_1_id', key: 'checked_by_user_1_id', kind: 'uuid' },
    { col: 'checked_by_user_2_id', key: 'checked_by_user_2_id', kind: 'uuid' },
    { col: 'consignee_id', key: 'consignee_id', kind: 'uuid' },
    { col: 'crop_id', key: 'crop_id', kind: 'uuid' },
    { col: 'gp_group_id', key: 'gp_group_id', kind: 'uuid' },
    { col: 'gp_status_id', key: 'gp_status_id', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketer_id', kind: 'uuid' },
    { col: 'supplier_id', key: 'supplier_id', kind: 'uuid' },
    { col: 'variety_id', key: 'variety_id', kind: 'uuid' },
    { col: 'is_locked', key: 'is_locked', kind: 'bool' },
    { col: 'consignor_id', key: 'consignor_id', kind: 'uuid' },
    { col: 'email_sent_by_user_id', key: 'email_sent_by_user_id', kind: 'uuid' },
    { col: 'email_sent_by_user_on', key: 'email_sent_by_user_on', kind: 'timestamptz', select: 'email_sent_by_user_on::text' },
    { col: 'attached_document_count', key: 'attached_document_count', kind: 'int' },
  ],
};

// ── raw.ft_gp_detail (per-dispatch-load settlement lines) ────────────────────
export const ftGpDetailSpec: FtSpec = {
  schema: 'raw', table: 'ft_gp_detail', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'price_quoted_value', key: 'price_quoted_value', kind: 'numeric' },
    { col: 'price_invoiced_value', key: 'price_invoiced_value', kind: 'numeric' },
    { col: 'price_paid_value', key: 'price_paid_value', kind: 'numeric' },
    { col: 'price_remitted_value', key: 'price_remitted_value', kind: 'numeric' },
    { col: 'price_currency', key: 'price_currency', kind: 'text' },
    { col: 'box_quantity', key: 'box_quantity', kind: 'numeric' },
    { col: 'crop_quantity_value', key: 'crop_quantity_value', kind: 'numeric' },
    { col: 'extra_price_1', key: 'extra_price_1', kind: 'numeric' },
    { col: 'extra_price_2', key: 'extra_price_2', kind: 'numeric' },
    { col: 'extra_price_3', key: 'extra_price_3', kind: 'numeric' },
    { col: 'extra_price_4', key: 'extra_price_4', kind: 'numeric' },
    { col: 'extra_price_5', key: 'extra_price_5', kind: 'numeric' },
    { col: 'extra_price_6', key: 'extra_price_6', kind: 'numeric' },
    { col: 'extra_price_7', key: 'extra_price_7', kind: 'numeric' },
    { col: 'extra_price_8', key: 'extra_price_8', kind: 'numeric' },
    { col: 'extra_price_9', key: 'extra_price_9', kind: 'numeric' },
    { col: 'extra_price_10', key: 'extra_price_10', kind: 'numeric' },
    { col: 'extra_percentage_1', key: 'extra_percentage_1', kind: 'numeric' },
    { col: 'extra_percentage_2', key: 'extra_percentage_2', kind: 'numeric' },
    { col: 'extra_percentage_3', key: 'extra_percentage_3', kind: 'numeric' },
    { col: 'extra_percentage_4', key: 'extra_percentage_4', kind: 'numeric' },
    { col: 'extra_number_1', key: 'extra_number_1', kind: 'numeric' },
    { col: 'extra_number_2', key: 'extra_number_2', kind: 'numeric' },
    { col: 'extra_number_3', key: 'extra_number_3', kind: 'numeric' },
    { col: 'extra_number_4', key: 'extra_number_4', kind: 'numeric' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'consignee_id', key: 'consignee_id', kind: 'uuid' },
    { col: 'consignor_id', key: 'consignor_id', kind: 'uuid' },
    { col: 'dispatch_load_id', key: 'dispatch_load_id', kind: 'uuid' },
    { col: 'gp_schedule_id', key: 'gp_schedule_id', kind: 'uuid' },
    { col: 'harvest_load_id', key: 'harvest_load_id', kind: 'uuid' },
    { col: 'market_area_id', key: 'market_area_id', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketer_id', kind: 'uuid' },
    { col: 'original_dispatch_load_id', key: 'original_dispatch_load_id', kind: 'uuid' },
    { col: 'planting_id', key: 'planting_id', kind: 'uuid' },
    { col: 'product_id', key: 'product_id', kind: 'uuid' },
    { col: 'gp_payment_id', key: 'gp_payment_id', kind: 'uuid' },
    { col: 'pack_date', key: 'pack_date', kind: 'date', select: 'pack_date::text' },
    { col: 'original_dl_box_waste_quantity', key: 'original_dl_box_waste_quantity', kind: 'numeric' },
    { col: 'net_weight_unit', key: 'net_weight_unit', kind: 'text' },
    { col: 'net_weight_value', key: 'net_weight_value', kind: 'numeric' },
    { col: 'consignment_type_id', key: 'consignment_type_id', kind: 'uuid' },
    { col: 'extra_text_1', key: 'extra_text_1', kind: 'text' },
    { col: 'extra_text_2', key: 'extra_text_2', kind: 'text' },
    { col: 'extra_text_3', key: 'extra_text_3', kind: 'text' },
    { col: 'extra_text_4', key: 'extra_text_4', kind: 'text' },
    { col: 'processing_id', key: 'processing_id', kind: 'uuid' },
    { col: 'farm_id', key: 'farm_id', kind: 'uuid' },
    { col: 'extra_percentage_5', key: 'extra_percentage_5', kind: 'numeric' },
    { col: 'extra_percentage_6', key: 'extra_percentage_6', kind: 'numeric' },
    { col: 'extra_price_11', key: 'extra_price_11', kind: 'numeric' },
    { col: 'extra_price_12', key: 'extra_price_12', kind: 'numeric' },
    { col: 'extra_price_13', key: 'extra_price_13', kind: 'numeric' },
    { col: 'extra_price_14', key: 'extra_price_14', kind: 'numeric' },
    { col: 'extra_price_15', key: 'extra_price_15', kind: 'numeric' },
    { col: 'crop_id', key: 'crop_id', kind: 'uuid' },
    { col: 'subvariety_id', key: 'subvariety_id', kind: 'uuid' },
    { col: 'variety_id', key: 'variety_id', kind: 'uuid' },
  ],
};

// ── raw.ft_gp_payment (settlement payments) ──────────────────────────────────
export const ftGpPaymentSpec: FtSpec = {
  schema: 'raw', table: 'ft_gp_payment', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'payment_no', key: 'payment_no', kind: 'text' },
    { col: 'payment_type', key: 'payment_type', kind: 'text' },
    { col: 'paid_on', key: 'paid_on', kind: 'date', select: 'paid_on::text' },
    { col: 'amount_value', key: 'amount_value', kind: 'numeric' },
    { col: 'amount_currency', key: 'amount_currency', kind: 'text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'gp_schedule_id', key: 'gp_schedule_id', kind: 'uuid' },
    { col: 'date_from', key: 'date_from', kind: 'date', select: 'date_from::text' },
    { col: 'date_to', key: 'date_to', kind: 'date', select: 'date_to::text' },
    { col: 'adjustment_value', key: 'adjustment_value', kind: 'numeric' },
    { col: 'payment_status', key: 'payment_status', kind: 'text' },
    { col: 'sync_status', key: 'sync_status', kind: 'text' },
    { col: 'ext_link', key: 'ext_link', kind: 'text' },
  ],
};

// ── raw.ft_charge_type (taxonomy dim, Sprint 6) ──────────────────────────────
export const ftChargeTypeSpec: FtSpec = {
  schema: 'raw', table: 'ft_charge_type', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'scope', key: 'scope', kind: 'text' },
    { col: 'account_code', key: 'account_code', kind: 'text' },
    { col: 'is_deductible', key: 'is_deductible', kind: 'bool' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'sequence', key: 'sequence', kind: 'numeric' },
    { col: 'description', key: 'description', kind: 'text' },
    { col: 'netsuite_id', key: 'netsuite_id', kind: 'text' },
    { col: 'ext_link', key: 'ext_link', kind: 'text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

// ── raw.ft_charge (rate-card dim, Sprint 6) ──────────────────────────────────
export const ftChargeSpec: FtSpec = {
  schema: 'raw', table: 'ft_charge', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'vat_info', key: 'vat_info', kind: 'text' },
    { col: 'account_code', key: 'account_code', kind: 'text' },
    { col: 'charge_type_id', key: 'charge_type_id', kind: 'uuid' },
    { col: 'consignor_id', key: 'consignor_id', kind: 'uuid' },
    { col: 'product_id', key: 'product_id', kind: 'uuid' },
    { col: 'crop_id', key: 'crop_id', kind: 'uuid' },
    { col: 'market_area_id', key: 'market_area_id', kind: 'uuid' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'sequence', key: 'sequence', kind: 'numeric' },
    { col: 'netsuite_id', key: 'netsuite_id', kind: 'text' },
    { col: 'ext_link', key: 'ext_link', kind: 'text' },
    { col: 'ext_code', key: 'ext_code', kind: 'text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

// ── raw.ft_gp_status (PA/PD/DR dim, Sprint 6) ────────────────────────────────
export const ftGpStatusSpec: FtSpec = {
  schema: 'raw', table: 'ft_gp_status', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'name', key: 'name', kind: 'text' },
    { col: 'sequence', key: 'sequence', kind: 'numeric' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
  ],
};

// ── raw.ft_charge_applied (the charge ledger, Sprint 6) — faithful all-36-cols, no _raw ──
export const ftChargeAppliedSpec: FtSpec = {
  schema: 'raw', table: 'ft_charge_applied', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'text_1', key: 'text_1', kind: 'text' },
    { col: 'text_2', key: 'text_2', kind: 'text' },
    { col: 'text_3', key: 'text_3', kind: 'text' },
    { col: 'account_code', key: 'account_code', kind: 'text' },
    { col: 'quantity_value', key: 'quantity_value', kind: 'numeric' },
    { col: 'quantity_unit', key: 'quantity_unit', kind: 'text' },
    { col: 'amount_value', key: 'amount_value', kind: 'numeric' },
    { col: 'amount_currency', key: 'amount_currency', kind: 'text' },
    { col: 'total_amount_value', key: 'total_amount_value', kind: 'numeric' },
    { col: 'total_amount_currency', key: 'total_amount_currency', kind: 'text' },
    { col: 'vat_info', key: 'vat_info', kind: 'text' },
    { col: 'applied_on', key: 'applied_on', kind: 'timestamptz', select: 'applied_on::text' },
    { col: 'created_on', key: 'created_on', kind: 'timestamptz', select: 'created_on::text' },
    { col: 'last_modified_on', key: 'last_modified_on', kind: 'timestamptz', select: 'last_modified_on::text' },
    { col: 'created_on_auto', key: 'created_on_auto', kind: 'timestamptz', select: 'created_on_auto::text' },
    { col: 'is_active', key: 'is_active', kind: 'bool' },
    { col: 'is_deductible', key: 'is_deductible', kind: 'bool' },
    { col: 'is_auto', key: 'is_auto', kind: 'bool' },
    { col: 'reference', key: 'reference', kind: 'text' },
    { col: 'ext_code', key: 'ext_code', kind: 'text' },
    { col: 'box_id', key: 'box_id', kind: 'uuid' },
    { col: 'charge_id', key: 'charge_id', kind: 'uuid' },
    { col: 'dispatch_load_id', key: 'dispatch_load_id', kind: 'uuid' },
    { col: 'original_dispatch_load_id', key: 'original_dispatch_load_id', kind: 'uuid' },
    { col: 'harvest_load_id', key: 'harvest_load_id', kind: 'uuid' },
    { col: 'harvest_load_bin_id', key: 'harvest_load_bin_id', kind: 'uuid' },
    { col: 'order_id', key: 'order_id', kind: 'uuid' },
    { col: 'pallet_id', key: 'pallet_id', kind: 'uuid' },
    { col: 'product_id', key: 'product_id', kind: 'uuid' },
    { col: 'gp_detail_id', key: 'gp_detail_id', kind: 'uuid' },
    { col: 'gp_schedule_id', key: 'gp_schedule_id', kind: 'uuid' },
    { col: 'gp_payment_id', key: 'gp_payment_id', kind: 'uuid' },
    { col: 'gp_group_id', key: 'gp_group_id', kind: 'uuid' },
    { col: 'supplier_id', key: 'supplier_id', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketer_id', kind: 'uuid' },
  ],
};
