-- 0025_semantic_order — internal order surface (header + line + sales), security_invoker.
--
-- INTERNAL-ONLY (A9): order data carries Mackays' selling prices/margins, so these views are NOT
-- grower-scoped — no grower_* prefix, no grower-own policy. They are security_invoker over the core
-- facts (core.dim_order / core.fact_order_item), whose RLS is fail-closed to internal
-- (is_internal_claim, migration 0024). Net effect via security_invoker: an internal/hub context sees
-- every order; a grower claim sees ZERO rows (fail-closed) — proven in scripts/order_rls_proof.ts.
-- The downstream join keys (dispatch_load_id, order_id, po_no, latest_version_no) are EXPOSED so the
-- follow-on Sales-by-farm bridge can join order↔dispatch without rework — that bridge is NOT built here.

-- ── Order-grain header view ──────────────────────────────────────────────────
create or replace view semantic.order_headers
  with (security_invoker = true) as
select
  order_id,
  type                     as order_type,   -- 'S' Sell / 'B' Buy
  order_no,
  sales_order_no,
  po_no,                                     -- join key → dispatch
  latest_version_no        as latest_order_version_no,
  version_count,
  line_count,
  consignee_id,                              -- BUYER
  consignor_id,                              -- SELLER (not a grower key)
  marketer_id,
  market_area_id,
  supplier_id,
  shed_id,
  scheduled_pickup_on,
  actual_pickup_on,
  scheduled_delivery_on,
  actual_delivery_on,
  is_archived,
  is_edi,
  edi_status,
  total_ordered,                             -- ordered QTY (boxes)
  total_box_count,                           -- Σ current-version line boxes (nulls excluded)
  total_price_value,                         -- Σ current-version line $ (native; NEVER coalesced)
  derived_price_value,                       -- Σ derived extended value (recon anchor)
  created_on,
  last_modified_on
from core.dim_order;
grant select on semantic.order_headers to authenticated, cube_readonly;
comment on view semantic.order_headers is 'Internal order headers (one row per order). Header dollar total DERIVED from current-version lines. Join keys (order_id/po_no/latest_order_version_no) exposed for the Sales-by-farm bridge. security_invoker → RLS fail-closed to internal (grower sees 0).';

-- ── Line-grain detail view (current version only) ────────────────────────────
create or replace view semantic.order_detail
  with (security_invoker = true) as
select
  order_item_id,
  order_id,
  order_version_id,
  order_version_no,
  order_latest_version_no,
  line_no,
  order_type,
  po_no,                                     -- join key → dispatch
  order_no,
  dispatch_load_id,                          -- join key → dispatch (raw.ft_dispatch_load.id)
  consignee_id,
  consignor_id,
  marketer_id,
  product_id,
  price_value,
  price_currency,
  price_per,
  total_box_count,
  total_price_value,
  derived_price_value,
  pallet_count,
  boxes_per_pallet,
  is_split,
  item_no,
  ean13,
  ean14,
  created_on,
  last_modified_on
from core.fact_order_item;
grant select on semantic.order_detail to authenticated, cube_readonly;
comment on view semantic.order_detail is 'Internal order lines (authoritative version only). Carries the order↔dispatch join keys (dispatch_load_id, po_no). security_invoker → RLS fail-closed to internal.';

-- ── Sales view — the S-filtered surface the Cube reads (A8) ───────────────────
create or replace view semantic.order_sales
  with (security_invoker = true) as
select * from semantic.order_detail where order_type = 'S';
grant select on semantic.order_sales to authenticated, cube_readonly;
comment on view semantic.order_sales is 'SALES lines only (order_type = S) — the governed line surface the Cube order view reads. Buy (B) orders land in raw but are not modelled for reporting. security_invoker → RLS fail-closed to internal.';
