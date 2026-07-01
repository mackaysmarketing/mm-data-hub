-- 0024_core_order — conform the FreshTrack order domain into core (order grain + line grain).
--
-- The replica has NO order-header dollar total and NO version pointer (A0 finding). So core DERIVES
-- both, mirroring the TS oracle src/lib/ft_order.ts (rollupOrder) — the reconciliation proof checks
-- the two against each other (drift guard), exactly like the GP settlement domain.
--
--   core.fact_order_item — one row per order LINE of the AUTHORITATIVE version only. The build joins
--       order_item → order_version → order and keeps only lines whose version_no = max(version_no)
--       for that order. order_version_no + order_latest_version_no are carried so the "no superseded
--       line leaked" invariant (A6) is a pure query on the fact. Superseded lines stay in raw.
--   core.dim_order — one row per order (PK order id), INCLUDING header-only orders with no lines.
--       Derived: latest_version_no = max version; total_box_count / total_price_value = Σ of the
--       CURRENT-version lines (nulls EXCLUDED, never coalesced — SPEC §9.3); derived_price_value =
--       Σ of the per-line derived extended value (BOX → box×price, PALLET → pallet×price, else the
--       native line total) — the recon anchor vs total_price_value. Carries the downstream join keys
--       (order_id, po_no, order_no, latest_version_no) for the follow-on Sales-by-farm bridge.
--
-- INTERNAL-ONLY: order data carries Mackays' selling prices/margins. RLS on both facts is fail-closed
-- to internal (is_internal_claim) + cube read-all (mirrors 0012/0020) — a grower claim sees ZERO.

-- ── Line-grain fact (current version only) ───────────────────────────────────
create table if not exists core.fact_order_item (
  order_item_id             uuid primary key,
  order_id                  uuid not null,
  order_version_id          uuid not null,
  order_version_no          integer,       -- the line's own version (= latest by construction)
  order_latest_version_no   integer,       -- the order's max version (A6 invariant: equal to the above)
  line_no                   integer,
  product_id                uuid,
  dispatch_load_id          uuid,          -- join key → dispatch (raw.ft_dispatch_load.id)
  po_no                     text,          -- denormalised header join key
  order_no                  text,
  order_type                text,          -- 'S' / 'B'
  consignee_id              uuid,          -- BUYER
  consignor_id              uuid,          -- SELLER (not a grower key)
  marketer_id               uuid,
  price_value               numeric,       -- never coalesced (SPEC §9.3)
  price_currency            text,
  price_per                 text,          -- BOX / WEIGHT_UNIT / ...
  total_box_count           integer,
  total_price_value         numeric,       -- native pre-computed line $
  derived_price_value       numeric,       -- BOX→box×price / PALLET→pallet×price / else native
  pallet_count              integer,
  boxes_per_pallet          integer,
  is_split                  boolean,
  item_no                   text,
  ean13                     text,
  ean14                     text,
  created_on                timestamptz,
  last_modified_on          timestamptz,
  _built_at                 timestamptz not null default now()
);
create index if not exists ix_fact_order_item_order on core.fact_order_item (order_id);
create index if not exists ix_fact_order_item_dispatch_load on core.fact_order_item (dispatch_load_id);
create index if not exists ix_fact_order_item_type on core.fact_order_item (order_type);
comment on table core.fact_order_item is 'Order lines of the AUTHORITATIVE version only (order_version_no = order_latest_version_no by construction; A6). INTERNAL-ONLY (selling prices). derived_price_value mirrors src/lib/ft_order.derivedLineValue.';

-- ── Order-grain dim (one row per order; derived header totals) ────────────────
create table if not exists core.dim_order (
  order_id                  uuid primary key,
  type                      text,          -- 'S' Sell / 'B' Buy
  order_no                  text,
  sales_order_no            text,
  po_no                     text,          -- join key → dispatch
  consignee_id              uuid,          -- BUYER
  consignor_id              uuid,          -- SELLER (not a grower key)
  marketer_id               uuid,
  market_area_id            uuid,
  supplier_id               uuid,
  shed_id                   uuid,
  sale_entity_id            uuid,
  state_id                  uuid,
  scheduled_pickup_on       timestamptz,
  actual_pickup_on          timestamptz,
  scheduled_delivery_on     timestamptz,
  actual_delivery_on        timestamptz,
  is_archived               boolean,
  is_edi                    boolean,
  edi_status                text,
  gs1_order_type            text,
  total_ordered             integer,       -- ordered QTY (boxes), native header field
  latest_version_no         integer,       -- DERIVED max(order_version.version_no); null = no versions
  version_count             integer,       -- number of versions on the order
  line_count                integer,       -- current-version line count (0 = header-only)
  total_box_count           integer,       -- Σ current-version line total_box_count (nulls excluded)
  total_price_value         numeric,       -- Σ current-version line total_price_value (nulls excluded; NEVER coalesced)
  derived_price_value       numeric,       -- Σ current-version derived extended value (recon anchor)
  created_on                timestamptz,
  last_modified_on          timestamptz,
  _built_at                 timestamptz not null default now()
);
create index if not exists ix_dim_order_po_no on core.dim_order (po_no);
create index if not exists ix_dim_order_type on core.dim_order (type);
comment on table core.dim_order is 'One row per FreshTrack order (incl. header-only). Header dollar total is DERIVED (Σ current-version lines) — the replica has none. latest_version_no = max(version_no). total_price_value NEVER coalesced to 0. INTERNAL-ONLY.';
comment on column core.dim_order.consignor_id is 'SELLER on a sell order (Mackays / Mackays-owned farm). NOT a grower identity and NOT the buyer. Do not use as a grower RLS anchor.';

-- ── Rebuild the line-grain fact (idempotent). Current version only. ──────────
create or replace function core.refresh_fact_order_item() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_order_item;
  insert into core.fact_order_item (
    order_item_id, order_id, order_version_id, order_version_no, order_latest_version_no, line_no,
    product_id, dispatch_load_id, po_no, order_no, order_type, consignee_id, consignor_id, marketer_id,
    price_value, price_currency, price_per, total_box_count, total_price_value, derived_price_value,
    pallet_count, boxes_per_pallet, is_split, item_no, ean13, ean14, created_on, last_modified_on, _built_at
  )
  with latest as (
    select order_id, max(version_no) as mv from raw.ft_order_version group by order_id
  )
  select
    oi.id, ov.order_id, oi.order_version_id, ov.version_no, l.mv, oi.line_no,
    oi.product_id, oi.dispatch_load_id, o.po_no, o.order_no, o.type, o.consignee_id, o.consignor_id, o.marketer_id,
    oi.price_value, oi.price_currency, oi.price_per, oi.total_box_count, oi.total_price_value,
    -- derived extended value — mirrors src/lib/ft_order.derivedLineValue (never coalesced to 0)
    case upper(coalesce(oi.price_per,''))
      when 'BOX'    then case when oi.total_box_count is null or oi.price_value is null then oi.total_price_value
                              else round(oi.total_box_count * oi.price_value, 2) end
      when 'PALLET' then case when oi.pallet_count is null or oi.price_value is null then oi.total_price_value
                              else round(oi.pallet_count * oi.price_value, 2) end
      else oi.total_price_value
    end,
    oi.pallet_count, oi.boxes_per_pallet, oi.is_split, oi.item_no, oi.ean13, oi.ean14,
    oi.created_on, oi.last_modified_on, now()
  from raw.ft_order_item oi
  join raw.ft_order_version ov on ov.id = oi.order_version_id
  join latest l on l.order_id = ov.order_id and ov.version_no = l.mv
  join raw.ft_order o on o.id = ov.order_id;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_order_item() is 'Idempotent rebuild of core.fact_order_item (authoritative-version lines only). Superseded-version lines never admitted (A6).';

-- ── Rebuild the order-grain dim (idempotent). Aggregates the fact. ───────────
create or replace function core.refresh_dim_order() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.dim_order;
  insert into core.dim_order (
    order_id, type, order_no, sales_order_no, po_no, consignee_id, consignor_id, marketer_id,
    market_area_id, supplier_id, shed_id, sale_entity_id, state_id, scheduled_pickup_on, actual_pickup_on,
    scheduled_delivery_on, actual_delivery_on, is_archived, is_edi, edi_status, gs1_order_type,
    total_ordered, latest_version_no, version_count, line_count, total_box_count, total_price_value,
    derived_price_value, created_on, last_modified_on, _built_at
  )
  with latest as (
    select order_id, max(version_no) as mv, count(*) as vc from raw.ft_order_version group by order_id
  ),
  agg as (
    -- Aggregate the CURRENT-version fact. sum() excludes nulls and returns null if all null → the
    -- header total is never coalesced to 0 (SPEC §9.3).
    select order_id,
           count(*)                    as line_count,
           sum(total_box_count)        as total_box_count,
           sum(total_price_value)      as total_price_value,
           sum(derived_price_value)    as derived_price_value
    from core.fact_order_item group by order_id
  )
  select
    o.id, o.type, o.order_no, o.sales_order_no, o.po_no, o.consignee_id, o.consignor_id, o.marketer_id,
    o.market_area_id, o.supplier_id, o.shed_id, o.sale_entity_id, o.state_id, o.scheduled_pickup_on, o.actual_pickup_on,
    o.scheduled_delivery_on, o.actual_delivery_on, o.is_archived, o.is_edi, o.edi_status, o.gs1_order_type,
    o.total_ordered, l.mv, coalesce(l.vc, 0), coalesce(a.line_count, 0),
    a.total_box_count, a.total_price_value, a.derived_price_value,
    o.created_on, o.last_modified_on, now()
  from raw.ft_order o
  left join latest l on l.order_id = o.id
  left join agg a on a.order_id = o.id;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_dim_order() is 'Idempotent rebuild of core.dim_order. Header totals DERIVED from current-version lines (fact), nulls excluded. latest_version_no = max(version_no). Run AFTER core.refresh_fact_order_item().';

-- ── RLS: INTERNAL-ONLY on both facts (fail-closed) + cube read-all ───────────
alter table core.fact_order_item enable row level security;
alter table core.dim_order       enable row level security;
grant select on core.fact_order_item, core.dim_order to authenticated;

drop policy if exists internal_only_fact_order_item on core.fact_order_item;
create policy internal_only_fact_order_item on core.fact_order_item
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_dim_order on core.dim_order;
create policy internal_only_dim_order on core.dim_order
  for select to authenticated using (semantic.is_internal_claim());

grant select on core.fact_order_item, core.dim_order to cube_readonly;
drop policy if exists cube_readonly_read_all on core.fact_order_item;
create policy cube_readonly_read_all on core.fact_order_item for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on core.dim_order;
create policy cube_readonly_read_all on core.dim_order for select to cube_readonly using (true);
