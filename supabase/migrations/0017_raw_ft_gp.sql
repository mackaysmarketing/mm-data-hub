-- 0017_raw_ft_gp — FreshTrack grower-pool SETTLEMENT landing (GP domain).
--
-- THIRD ingress, and the first via FreshTrack's DIRECT read-replica (Postgres) rather than the
-- GraphQL API. The GP tables (gpDetails lineage) were blocked across Sprints 1–5 — the read-replica
-- credential (cloud_mackaysmarketing_readonly) is now provisioned, so we can land them.
--
-- Grain:
--   ft_gp_schedule — one grower-pool settlement schedule (header). schedule_no, week_no, payable_on,
--                    invoiced/paid amounts. consignor_id = grower identity (RLS anchor).
--   ft_gp_detail   — one settlement line PER DISPATCH LOAD (dispatch_load_id 100%% populated). This is
--                    the load-grain settlement lineage NetSuite settlement (Sprint 5) could NOT give
--                    (NetSuite is product-grain). prices progress quoted → invoiced → paid → remitted.
--   ft_gp_payment  — one payment against a schedule. paid_on + amount_value; sync_status/ext_link tie
--                    to the downstream accounting sync (cf. the NetSuite RCTI net).
--
-- Faithful raw mirror of the source columns (snake_case already matches). text not enum (SPEC §2);
-- amounts numeric, never coalesced (SPEC §9.3). Source NOT NULL/length constraints are intentionally
-- NOT replicated — raw lands tolerantly; integrity is asserted in core/semantic. Temporal columns are
-- loaded via ::text in the loader SELECT so a date never round-trips through a +10 JS Date (off-by-one).
-- _raw jsonb kept on the two small header tables only (SPEC: small tables) — not on the 23k detail.

-- ── ft_gp_schedule (settlement headers) ──────────────────────────────────────
create table if not exists raw.ft_gp_schedule (
  id                                uuid primary key,
  name                              text,
  schedule_no                       text,
  date_from                         date,
  date_to                           date,
  payable_on                        date,
  week_no                           smallint,
  box_count                         numeric,
  crop_quantity_value               numeric,
  weight_value                      numeric,
  weight_unit                       text,
  boxes_delivered                   numeric,
  invoiced_amount_value             numeric,
  paid_amount_value                 numeric,
  amount_currency                   text,
  remittable_percentage             numeric,
  is_organic                        boolean,
  checked_by_user_1_on              timestamptz,
  checked_by_user_2_on              timestamptz,
  is_archived                       boolean,
  created_on                        timestamptz,
  last_modified_on                  timestamptz,
  checked_by_user_1_id              uuid,
  checked_by_user_2_id              uuid,
  consignee_id                      uuid,
  crop_id                           uuid,
  gp_group_id                       uuid,
  gp_status_id                      uuid,
  marketer_id                       uuid,
  supplier_id                       uuid,
  variety_id                        uuid,
  is_locked                         boolean,
  consignor_id                      uuid,
  email_sent_by_user_id             uuid,
  email_sent_by_user_on             timestamptz,
  attached_document_count           integer,
  _raw                              jsonb,
  _synced_at                        timestamptz not null default now()
);
create index if not exists ix_ft_gp_schedule_consignor on raw.ft_gp_schedule (consignor_id);
create index if not exists ix_ft_gp_schedule_payable on raw.ft_gp_schedule (payable_on);
create index if not exists ix_ft_gp_schedule_lastmod on raw.ft_gp_schedule (last_modified_on);
comment on table raw.ft_gp_schedule is 'FreshTrack grower-pool settlement headers (read-replica). consignor_id = grower RLS anchor. Incremental key = last_modified_on; an archive/lock event bumps it (is_archived stays visible — archiving is a soft flag, not a delete).';
comment on column raw.ft_gp_schedule.consignor_id is 'Grower identity key. Same RLS anchor as dispatch (raw.ft_dispatch_load) + NetSuite settlement.';
comment on column raw.ft_gp_schedule.is_archived is 'Soft archive flag. Archived schedules remain fully visible in the replica (most settled schedules are archived). Filter at semantic, never drop at raw.';

-- ── ft_gp_detail (per-dispatch-load settlement lines) ────────────────────────
create table if not exists raw.ft_gp_detail (
  id                                uuid primary key,
  price_quoted_value                numeric,
  price_invoiced_value              numeric,
  price_paid_value                  numeric,
  price_remitted_value              numeric,
  price_currency                    text,
  box_quantity                      numeric,
  crop_quantity_value               numeric,
  extra_price_1                     numeric,
  extra_price_2                     numeric,
  extra_price_3                     numeric,
  extra_price_4                     numeric,
  extra_price_5                     numeric,
  extra_price_6                     numeric,
  extra_price_7                     numeric,
  extra_price_8                     numeric,
  extra_price_9                     numeric,
  extra_price_10                    numeric,
  extra_percentage_1                numeric,
  extra_percentage_2                numeric,
  extra_percentage_3                numeric,
  extra_percentage_4                numeric,
  extra_number_1                    numeric,
  extra_number_2                    numeric,
  extra_number_3                    numeric,
  extra_number_4                    numeric,
  created_on                        timestamptz,
  last_modified_on                  timestamptz,
  consignee_id                      uuid,
  consignor_id                      uuid,
  dispatch_load_id                  uuid,
  gp_schedule_id                    uuid,
  harvest_load_id                   uuid,
  market_area_id                    uuid,
  marketer_id                       uuid,
  original_dispatch_load_id         uuid,
  planting_id                       uuid,
  product_id                        uuid,
  gp_payment_id                     uuid,
  pack_date                         date,
  original_dl_box_waste_quantity    numeric,
  net_weight_unit                   text,
  net_weight_value                  numeric,
  consignment_type_id               uuid,
  extra_text_1                      text,
  extra_text_2                      text,
  extra_text_3                      text,
  extra_text_4                      text,
  processing_id                     uuid,
  farm_id                           uuid,
  extra_percentage_5                numeric,
  extra_percentage_6                numeric,
  extra_price_11                    numeric,
  extra_price_12                    numeric,
  extra_price_13                    numeric,
  extra_price_14                    numeric,
  extra_price_15                    numeric,
  crop_id                           uuid,
  subvariety_id                     uuid,
  variety_id                        uuid,
  _synced_at                        timestamptz not null default now()
);
create index if not exists ix_ft_gp_detail_schedule on raw.ft_gp_detail (gp_schedule_id);
create index if not exists ix_ft_gp_detail_consignor on raw.ft_gp_detail (consignor_id);
create index if not exists ix_ft_gp_detail_dispatch_load on raw.ft_gp_detail (dispatch_load_id);
comment on table raw.ft_gp_detail is 'FreshTrack grower-pool settlement lines, one per dispatch load. dispatch_load_id is the load-grain lineage NetSuite settlement cannot provide. Prices: quoted→invoiced→paid→remitted. The extra_price_*/extra_percentage_*/extra_number_* slots are configurable deduction/adjustment slots — semantics decoded in core (cf. the NetSuite charge taxonomy), landed faithfully here.';
comment on column raw.ft_gp_detail.dispatch_load_id is 'Links a settlement line to its dispatch load (raw.ft_dispatch_load.id). The load↔settlement join FreshTrack provides and NetSuite does not.';
comment on column raw.ft_gp_detail.net_weight_value is 'Produce-dependent, nullable. Never coalesce to 0 in averages (SPEC §9.3).';

-- ── ft_gp_payment (settlement payments) ──────────────────────────────────────
create table if not exists raw.ft_gp_payment (
  id                                uuid primary key,
  payment_no                        text,
  payment_type                      text,
  paid_on                           date,
  amount_value                      numeric,
  amount_currency                   text,
  created_on                        timestamptz,
  last_modified_on                  timestamptz,
  gp_schedule_id                    uuid,
  date_from                         date,
  date_to                           date,
  adjustment_value                  numeric,
  payment_status                    text,
  sync_status                       text,
  ext_link                          text,
  _raw                              jsonb,
  _synced_at                        timestamptz not null default now()
);
create index if not exists ix_ft_gp_payment_schedule on raw.ft_gp_payment (gp_schedule_id);
create index if not exists ix_ft_gp_payment_paid_on on raw.ft_gp_payment (paid_on);
comment on table raw.ft_gp_payment is 'FreshTrack grower-pool payments. paid_on = the paid date (first-class). payment_status/sync_status/ext_link tie to the downstream accounting sync; the FreshTrack paid total reconciles closely to the NetSuite RCTI net (cross-source check, future core work).';
