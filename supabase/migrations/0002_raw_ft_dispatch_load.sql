-- 0002_raw_ft_dispatch_load — dispatch domain, GraphQL source. Grain: one load.
-- Columns = the profiled/trimmed SPEC §3 set. order_type is TEXT ('S'/'B'), never an enum.

create table if not exists raw.ft_dispatch_load (
  id                        uuid primary key,
  load_no                   text,
  order_type                text,          -- 'S' (Sell) / 'B' (Buy) — source code, text not enum
  state_id                  uuid,
  scheduled_pickup_on       timestamptz,
  actual_pickup_on          timestamptz,   -- dispatched_at
  scheduled_delivery_on     timestamptz,
  actual_delivery_on        timestamptz,
  pack_date                 date,
  asn_sent_on               timestamptz,
  latest_order_modified_on  timestamptz,
  consignor_id              uuid,          -- grower identity (RLS anchor)
  consignee_id              uuid,
  marketer_id               uuid,
  carrier_id                uuid,
  shed_id                   uuid,
  market_area_id            uuid,
  order_id                  uuid,
  order_no                  text,
  po_no                     text,
  latest_order_version_no   integer,
  stock_boxes               integer,
  reconsigned_boxes         integer,
  is_complete               boolean,
  is_locked                 boolean,
  attached_document_count   integer,
  manifest_no               text,
  certificate_no            text,
  pallet_transfer_no        text,
  dc_slot_ref               text,
  temperature_profile_id    uuid,
  temperature_value         numeric,
  comment                   text,
  extra_text_2              text,          -- pack-week code Y{YY}W{WW}, e.g. 'Y25W31' (tracks pack week)
  _raw                      jsonb,         -- safety net (small table)
  _synced_at                timestamptz not null default now()
);

create index if not exists ix_ft_dispatch_load_consignor on raw.ft_dispatch_load (consignor_id);
create index if not exists ix_ft_dispatch_load_pickup on raw.ft_dispatch_load (actual_pickup_on);

comment on table raw.ft_dispatch_load is 'FreshTrack DispatchLoadNode, trimmed (SPEC §3). dispatched_at = actual_pickup_on.';
comment on column raw.ft_dispatch_load.order_type is '''S''=Sell, ''B''=Buy (source code; text, never enum).';
comment on column raw.ft_dispatch_load.extra_text_2 is 'Pack-week code Y{YY}W{WW} (e.g. Y25W31). 100%% populated, ~weekly cardinality. Confirmed 2026-06-20.';
comment on column raw.ft_dispatch_load.consignor_id is 'Grower identity key. RLS anchor across dispatch + settlement.';
