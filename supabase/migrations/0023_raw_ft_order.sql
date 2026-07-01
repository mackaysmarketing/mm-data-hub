-- 0023_raw_ft_order — FreshTrack ORDER-domain landing (the commercial / sell side).
--
-- FOURTH ingress; sourced from FreshTrack's DIRECT read-replica (Postgres), like the GP domain
-- (0017/0018). The warehouse lands dispatch_load + pallet (fulfilment); this lands the ORDER
-- (commerce) — ordered quantities, unit prices and line dollars that were previously invisible.
--
-- Grain (A0-confirmed against the replica, snapshot reconciliation/replica_order_schema_2026-07-01.md):
--   ft_order         — one order header. NO dollar total and NO version pointer on the header
--                      (order.total_price_value / latest_version_no do NOT exist on the replica) —
--                      those are DERIVED in core from the current-version lines. total_ordered =
--                      ordered QTY (boxes). consignor_id = SELLER on a sell order (NOT a grower key;
--                      buyer = consignee_id, seller = marketer_id).
--   ft_order_version — each version is a full re-issue of the lines. version_no ranks them; the
--                      authoritative version = max(version_no) per order (derived in core).
--   ft_order_item    — priced lines. price_value/price_currency/price_per + pre-computed
--                      total_box_count/total_price_value. dispatch_load_id = the join key to dispatch.
--
-- Faithful raw mirror (snake_case already matches). enums (type/edi_status/gs1_order_type/
-- price_currency/price_per/*_currency) land as TEXT (SPEC §9.6 — never enum). amounts numeric, never
-- coalesced (SPEC §9.3). Source NOT NULL/length constraints intentionally NOT replicated — raw lands
-- tolerantly; integrity is asserted in core/semantic. Temporal columns loaded via ::text in the loader
-- SELECT so a timestamp never round-trips through a JS Date. _raw jsonb kept on ft_order +
-- ft_order_version (header-ish, small) — NOT on the 73k ft_order_item lines (mirrors _raw on
-- dispatch_load/entity, not pallet).
--
-- This ingress is INTERNAL-ONLY: order data carries Mackays' selling prices/margins, so no grower is
-- ever granted access. RLS is enabled and fail-closed to internal (unlike the grower-scoped dispatch
-- raw) — a grower claim sees ZERO order rows. Mirrors the STRUCTURE of raw.ft_dispatch_load's RLS
-- (enable RLS + authenticated grant + cube read-all) but with an internal-only USING clause.

-- ── ft_order (order headers) ─────────────────────────────────────────────────
create table if not exists raw.ft_order (
  id                        uuid primary key,
  type                      text,          -- 'S' (Sell) / 'B' (Buy) — text, never enum (source has only S today)
  order_no                  text,
  sales_order_no            text,
  po_no                     text,          -- join key → dispatch (raw.ft_dispatch_load.po_no)
  scheduled_pickup_on       timestamptz,
  actual_pickup_on          timestamptz,
  scheduled_delivery_on     timestamptz,
  actual_delivery_on        timestamptz,
  is_archived               boolean,
  created_on                timestamptz,
  last_modified_on          timestamptz,
  consignee_id              uuid,          -- BUYER (retailer)
  consignor_id              uuid,          -- SELLER on a sell order — NOT a grower RLS key
  market_area_id            uuid,
  marketer_id               uuid,          -- Mackays Marketing on the majority of sells
  load_description          text,
  comment                   text,
  state_id                  uuid,
  attached_document_count   integer,
  edi_status                text,
  gs1_order_type            text,
  parent_id                 uuid,
  shed_id                   uuid,
  supplier_id               uuid,
  highlights                text,          -- display format codes (^{b}^{c blue}[..]) — parse, don't display raw (SPEC §9.7)
  is_edi                    boolean,
  delivery_contact_id       uuid,
  b2b_integration_id        uuid,
  allocation_percentage     numeric,
  production_percentage     numeric,
  total_ordered             integer,       -- ordered QTY (boxes) — NOT a dollar total
  info                      text,
  pallet_overview           text,
  sale_entity_id            uuid,
  priority                  smallint,
  discount_currency         text,
  discount_percentage       numeric,
  discount_value            numeric,
  payment_term_id           uuid,
  _raw                      jsonb,
  _synced_at                timestamptz not null default now()
);
create index if not exists ix_ft_order_po_no on raw.ft_order (po_no);
create index if not exists ix_ft_order_consignee on raw.ft_order (consignee_id);
create index if not exists ix_ft_order_lastmod on raw.ft_order (last_modified_on);
create index if not exists ix_ft_order_type on raw.ft_order (type);
comment on table raw.ft_order is 'FreshTrack order headers (read-replica). The commercial/sell side. NO header dollar total or version pointer on the replica — DERIVED in core from current-version lines. consignor_id = SELLER (not a grower key). Incremental key = last_modified_on. INTERNAL-ONLY (selling prices).';
comment on column raw.ft_order.consignor_id is 'SELLER on a sell order (Mackays / Mackays-owned farm). NOT a grower identity and NOT the buyer. Buyer = consignee_id; seller-of-record = marketer_id.';
comment on column raw.ft_order.total_ordered is 'Ordered QUANTITY (boxes). The replica has no order-header dollar total — that is derived in core.dim_order from the current-version line total_price_value.';

-- ── ft_order_version (each = a full re-issue of the lines) ───────────────────
create table if not exists raw.ft_order_version (
  id                        uuid primary key,
  version_no                integer,
  received_on               timestamptz,
  created_on                timestamptz,
  last_modified_on          timestamptz,
  order_id                  uuid,
  _raw                      jsonb,
  _synced_at                timestamptz not null default now()
);
create index if not exists ix_ft_order_version_order on raw.ft_order_version (order_id);
create index if not exists ix_ft_order_version_lastmod on raw.ft_order_version (last_modified_on);
comment on table raw.ft_order_version is 'FreshTrack order versions (read-replica). Each version_no is a full re-issue of the order lines. Authoritative version = max(version_no) per order_id (derived in core). Superseded versions are retained here.';

-- ── ft_order_item (priced lines) — no _raw (large table) ─────────────────────
create table if not exists raw.ft_order_item (
  id                        uuid primary key,
  pallet_count              integer,
  boxes_per_pallet          integer,
  price_value               numeric,       -- unit price; never coalesced to 0 (SPEC §9.3)
  price_currency            text,          -- AUD (asserted for Mackays sales; non-AUD flagged)
  price_per                 text,          -- BOX / WEIGHT_UNIT / ... (text, never enum)
  total_box_count           integer,       -- pre-computed line box count
  total_price_value         numeric,       -- pre-computed line $ (the native total; preferred anchor)
  created_on                timestamptz,
  last_modified_on          timestamptz,
  product_id                uuid,
  order_version_id          uuid,          -- → order_version.id (selects the version)
  remitted_price_currency   text,
  remitted_price_value      numeric,
  bottom_hi                 integer,
  ti                        integer,
  is_split                  boolean,
  top_hi                    integer,
  unsplit_hi                integer,
  hand_stack                integer,
  line_no                   integer,
  shed_id                   uuid,
  ean13                     text,
  ean14                     text,
  item_no                   text,
  dispatch_load_id          uuid,          -- join key → dispatch (raw.ft_dispatch_load.id); nullable
  proposed_price_currency   text,
  proposed_price_value      numeric,
  proposed_quantity         integer,
  discount_currency         text,
  discount_percentage       numeric,
  discount_value            numeric,
  _synced_at                timestamptz not null default now()
);
create index if not exists ix_ft_order_item_version on raw.ft_order_item (order_version_id);
create index if not exists ix_ft_order_item_dispatch_load on raw.ft_order_item (dispatch_load_id);
create index if not exists ix_ft_order_item_lastmod on raw.ft_order_item (last_modified_on);
comment on table raw.ft_order_item is 'FreshTrack order lines (read-replica). price_value/price_currency/price_per + pre-computed total_box_count/total_price_value. dispatch_load_id = the order↔dispatch join key. Superseded-version lines retained; core exposes current-version only.';
comment on column raw.ft_order_item.total_price_value is 'Native pre-computed line dollar value. For BOX lines = total_box_count × price_value (verified). Never coalesced to 0 (SPEC §9.3).';
comment on column raw.ft_order_item.dispatch_load_id is 'Links an order line to its dispatch load (raw.ft_dispatch_load.id). The order↔dispatch join key (exposed for the follow-on Sales-by-farm bridge; the bridge is NOT built here).';

-- ── RLS: INTERNAL-ONLY, fail-closed (A10) ────────────────────────────────────
-- Structure mirrors raw.ft_dispatch_load (enable RLS + authenticated grant + cube read-all) so these
-- tables don't extend the anon/authenticated exposure the advisor flags — but the USING clause is
-- is_internal_claim() (NOT grower-scoped): order data is internal-only, so a grower claim sees ZERO.
alter table raw.ft_order         enable row level security;
alter table raw.ft_order_version enable row level security;
alter table raw.ft_order_item    enable row level security;
grant select on raw.ft_order, raw.ft_order_version, raw.ft_order_item to authenticated;

drop policy if exists internal_only_ft_order on raw.ft_order;
create policy internal_only_ft_order on raw.ft_order
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_ft_order_version on raw.ft_order_version;
create policy internal_only_ft_order_version on raw.ft_order_version
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_ft_order_item on raw.ft_order_item;
create policy internal_only_ft_order_item on raw.ft_order_item
  for select to authenticated using (semantic.is_internal_claim());

-- Cube's least-privilege read role reads all rows (it re-applies scope itself; the order view is
-- internal-only + public:false, so growers cannot reach it anyway). Mirrors 0012.
grant select on raw.ft_order, raw.ft_order_version, raw.ft_order_item to cube_readonly;
drop policy if exists cube_readonly_read_all on raw.ft_order;
create policy cube_readonly_read_all on raw.ft_order for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on raw.ft_order_version;
create policy cube_readonly_read_all on raw.ft_order_version for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on raw.ft_order_item;
create policy cube_readonly_read_all on raw.ft_order_item for select to cube_readonly using (true);
