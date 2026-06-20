// The SPEC §3 column ↔ FreshTrack-field mapping, in one auditable place.
// The GraphQL selection is derived from these specs (see fieldSelection) so the query and
// the upsert can never drift apart. snake_case col ← camelCase key.
import type { UpsertSpec } from './db.ts';

export const dispatchLoadSpec: UpsertSpec = {
  schema: 'raw',
  table: 'ft_dispatch_load',
  idColumn: 'id',
  withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'load_no', key: 'loadNo', kind: 'text' },
    { col: 'order_type', key: 'orderType', kind: 'text' },
    { col: 'state_id', key: 'stateId', kind: 'uuid' },
    { col: 'scheduled_pickup_on', key: 'scheduledPickupOn', kind: 'timestamptz' },
    { col: 'actual_pickup_on', key: 'actualPickupOn', kind: 'timestamptz' },
    { col: 'scheduled_delivery_on', key: 'scheduledDeliveryOn', kind: 'timestamptz' },
    { col: 'actual_delivery_on', key: 'actualDeliveryOn', kind: 'timestamptz' },
    { col: 'pack_date', key: 'packDate', kind: 'date' },
    { col: 'asn_sent_on', key: 'asnSentOn', kind: 'timestamptz' },
    { col: 'latest_order_modified_on', key: 'latestOrderModifiedOn', kind: 'timestamptz' },
    { col: 'consignor_id', key: 'consignorId', kind: 'uuid' },
    { col: 'consignee_id', key: 'consigneeId', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketerId', kind: 'uuid' },
    { col: 'carrier_id', key: 'carrierId', kind: 'uuid' },
    { col: 'shed_id', key: 'shedId', kind: 'uuid' },
    { col: 'market_area_id', key: 'marketAreaId', kind: 'uuid' },
    { col: 'order_id', key: 'orderId', kind: 'uuid' },
    { col: 'order_no', key: 'orderNo', kind: 'text' },
    { col: 'po_no', key: 'poNo', kind: 'text' },
    { col: 'latest_order_version_no', key: 'latestOrderVersionNo', kind: 'int' },
    { col: 'stock_boxes', key: 'stockBoxes', kind: 'int' },
    { col: 'reconsigned_boxes', key: 'reconsignedBoxes', kind: 'int' },
    { col: 'is_complete', key: 'isComplete', kind: 'bool' },
    { col: 'is_locked', key: 'isLocked', kind: 'bool' },
    { col: 'attached_document_count', key: 'attachedDocumentCount', kind: 'int' },
    { col: 'manifest_no', key: 'manifestNo', kind: 'text' },
    { col: 'certificate_no', key: 'certificateNo', kind: 'text' },
    { col: 'pallet_transfer_no', key: 'palletTransferNo', kind: 'text' },
    { col: 'dc_slot_ref', key: 'dcSlotRef', kind: 'text' },
    { col: 'temperature_profile_id', key: 'temperatureProfileId', kind: 'uuid' },
    { col: 'temperature_value', key: 'temperatureValue', kind: 'numeric' },
    { col: 'comment', key: 'comment', kind: 'text' },
    { col: 'extra_text_2', key: 'extraText2', kind: 'text' },
  ],
};

export const palletSpec: UpsertSpec = {
  schema: 'raw',
  table: 'ft_pallet',
  idColumn: 'id',
  withRaw: false, // large table
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'pallet_no', key: 'palletNo', kind: 'text' },
    { col: 'barcode', key: 'barcode', kind: 'text' },
    { col: 'dispatch_load_id', key: 'dispatchLoadId', kind: 'uuid' },
    { col: 'product_id', key: 'productId', kind: 'uuid' },
    { col: 'product_description', key: 'productDescription', kind: 'text' },
    { col: 'crop_description', key: 'cropDescription', kind: 'text' },
    { col: 'variety_description', key: 'varietyDescription', kind: 'text' },
    { col: 'consignee_id', key: 'consigneeId', kind: 'uuid' },
    { col: 'shed_id', key: 'shedId', kind: 'uuid' },
    { col: 'state_id', key: 'stateId', kind: 'uuid' },
    { col: 'type_id', key: 'typeId', kind: 'uuid' },
    { col: 'spaces', key: 'spaces', kind: 'numeric' },
    { col: 'expected_box_count', key: 'expectedBoxCount', kind: 'numeric' },
    { col: 'box_count', key: 'boxCount', kind: 'numeric' },
    { col: 'stock_boxes', key: 'stockBoxes', kind: 'int' },
    { col: 'reconsigned_boxes', key: 'reconsignedBoxes', kind: 'int' },
    { col: 'net_weight_value', key: 'netWeightValue', kind: 'numeric' },
    { col: 'net_weight_unit', key: 'netWeightUnit', kind: 'text' },
    { col: 'packed_on', key: 'packedOn', kind: 'timestamptz' },
    { col: 'is_archived', key: 'isArchived', kind: 'bool' },
    { col: 'is_field', key: 'isField', kind: 'bool' },
    { col: 'supplier_highlights', key: 'supplierHighlights', kind: 'text' },
    { col: 'comment', key: 'comment', kind: 'text' },
  ],
};

export const entitySpec: UpsertSpec = {
  schema: 'raw',
  table: 'ft_entity',
  idColumn: 'id',
  withRaw: true,
  // is_test is a generated column — intentionally NOT inserted.
  columns: [
    { col: 'id', key: 'id', kind: 'uuid' },
    { col: 'code', key: 'code', kind: 'text' },
    { col: 'org_name', key: 'orgName', kind: 'text' },
    { col: 'org_legal_name', key: 'orgLegalName', kind: 'text' },
    { col: 'type', key: 'type', kind: 'text' },
    { col: 'tags', key: 'tags', kind: 'text[]' },
    { col: 'is_active', key: 'isActive', kind: 'bool' },
    { col: 'is_grower', key: 'isGrower', kind: 'bool' },
    { col: 'org_tax_no', key: 'orgTaxNo', kind: 'text' },
    { col: 'ext_link', key: 'extLink', kind: 'text' },
    { col: 'consignor_id', key: 'consignorId', kind: 'uuid' },
    { col: 'consignee_id', key: 'consigneeId', kind: 'uuid' },
    { col: 'marketer_id', key: 'marketerId', kind: 'uuid' },
    { col: 'carrier_id', key: 'carrierId', kind: 'uuid' },
    { col: 'supplier_id', key: 'supplierId', kind: 'uuid' },
    { col: 'farm_id', key: 'farmId', kind: 'uuid' },
    { col: 'shed_id', key: 'shedId', kind: 'uuid' },
    { col: 'parent_id', key: 'parentId', kind: 'uuid' },
    { col: 'org_market_area_id', key: 'orgMarketAreaId', kind: 'uuid' },
    { col: 'payment_term_id', key: 'paymentTermId', kind: 'uuid' },
  ],
};

/** GraphQL field selection derived from a spec's keys — query and upsert stay in lockstep. */
export function fieldSelection(spec: UpsertSpec): string {
  return spec.columns.map((c) => c.key).join(' ');
}
