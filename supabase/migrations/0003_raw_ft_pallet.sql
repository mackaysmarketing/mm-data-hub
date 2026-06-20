-- 0003_raw_ft_pallet — dispatch domain, GraphQL source. Grain: one pallet.
-- SPEC §3 set. NO _raw (large table). location_id deliberately NOT modelled
-- (declared non-null upstream but returns null — selecting it errors the query, SPEC §9.2).
-- harvest_load_id deliberately NOT modelled here (null on outbound — SPEC §9.1).

create table if not exists raw.ft_pallet (
  id                   uuid primary key,
  pallet_no            text,
  barcode              text,
  dispatch_load_id     uuid,
  product_id           uuid,
  product_description  text,          -- may carry display format codes ^{...}; parse, don't show raw
  crop_description     text,
  variety_description  text,
  consignee_id         uuid,
  shed_id              uuid,
  state_id             uuid,
  type_id              uuid,
  spaces               numeric,
  expected_box_count   numeric,
  box_count            numeric,        -- frequently null (e.g. reconsigned pallets)
  stock_boxes          integer,
  reconsigned_boxes    integer,
  net_weight_value     numeric,        -- nullable, produce-dependent — NEVER coalesce to 0
  net_weight_unit      text,
  packed_on            timestamptz,
  is_archived          boolean,
  is_field             boolean,        -- retained; varies by produce
  supplier_highlights  text,          -- may carry display format codes ^{...}
  comment              text,
  _synced_at           timestamptz not null default now()
);

create index if not exists ix_ft_pallet_dispatch_load on raw.ft_pallet (dispatch_load_id);
create index if not exists ix_ft_pallet_packed_on on raw.ft_pallet (packed_on);

comment on table raw.ft_pallet is 'FreshTrack PalletNode, trimmed (SPEC §3). location_id & harvest_load_id intentionally not modelled (SPEC §9.1/§9.2).';
comment on column raw.ft_pallet.net_weight_value is 'Produce-dependent & nullable (~100%% papaya, ~88%% banana, ~41%% avocado). Never coalesce to 0 in averages.';
comment on column raw.ft_pallet.box_count is 'Often null (reconsigned/in-place pallets). See core.load_box_reconciliation.';
