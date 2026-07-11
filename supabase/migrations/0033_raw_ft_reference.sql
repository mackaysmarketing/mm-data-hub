-- 0033_raw_ft_reference — FreshTrack REFERENCE tables (read-replica source), Sprint: closeout C1.
--
-- Lands the five small reference tables that back the conformed dimensions (0034):
--   ft_consignee (135) — the CUSTOMER id space. Every consignee_id on loads / GP details /
--                        GP schedules / orders / pallets lives here (verified live 2026-07-11:
--                        104/104 hub-referenced ids present). Names do NOT live here — they come
--                        from the entity BACKLINK (raw.ft_entity.consignee_id → consignee.id;
--                        134 of 135 consignees carry a backlink, all with non-blank org_name).
--   ft_product  (251) — the product master. Covers 159/159 hub product_ids (union of ft_pallet,
--                        ft_order_item, ft_gp_detail). Source name/description are CLEAN of the
--                        SPEC §9.7 display codes (0/251 carry ^{…} or [nn] — those live only in
--                        pallet display strings).
--   ft_crop (7) / ft_variety (22) / ft_pack_type (25) — lookups for dim_product denormalisation.
--
-- Same contract as the raw GP tables (0017/0018, copied): faithful useful-subset mirror of the
-- source columns (snake_case already matches), text not enum (SPEC §2), numerics never coalesced
-- (SPEC §9.3), temporal columns read via ::text in the loader (never through a +10 JS Date).
-- _raw jsonb on all five (small tables). Source NOT NULL constraints intentionally not replicated
-- (raw lands tolerantly; integrity asserted in core).
--
-- POSTURE (matches 0017/0018 raw GP): NO authenticated grant, RLS NOT enabled — raw is reachable
-- only by service_role (ETL) and cube_readonly. The explicit cube_readonly grant is belt-and-braces
-- over the 0011 default privileges.

-- ── ft_consignee (the customer id space) ─────────────────────────────────────
create table if not exists raw.ft_consignee (
  id                uuid primary key,
  is_active         boolean,
  vendor_no         text,          -- source is '' when unset; landed faithfully
  b2b_code          text,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_consignee is 'FreshTrack consignee (read-replica) — the CUSTOMER id space (loads/GP/orders/pallets reference it). Carries NO name: names come from the raw.ft_entity backlink (entity.consignee_id → this.id). Full-sync (135 rows).';
comment on column raw.ft_consignee.vendor_no is 'Customer vendor number. Source declares NOT NULL but uses empty string for unset — landed faithfully as text.';

-- ── ft_product (product master) ──────────────────────────────────────────────
create table if not exists raw.ft_product (
  id                    uuid primary key,
  code                  text,
  name                  text,          -- clean of SPEC §9.7 display codes at source (verified 0/251)
  description           text,
  unit                  text,
  count                 integer,
  price_value           numeric,
  boxes_per_pallet      integer,
  net_weight_value      numeric,       -- produce-dependent, nullable — never coalesce (SPEC §9.3)
  net_weight_unit       text,
  size_equivalent       numeric,
  ean13                 text,
  ean14                 text,
  crop_id               uuid,
  variety_id            uuid,
  subvariety_id         uuid,
  pack_type_id          uuid,
  type_id               uuid,
  is_organic            boolean,
  is_sellable           boolean,
  is_active             boolean,
  consignee_description text,
  account_code          text,
  netsuite_id           text,
  created_on            timestamptz,
  last_modified_on      timestamptz,
  _raw                  jsonb,
  _synced_at            timestamptz not null default now()
);
create index if not exists ix_ft_product_crop on raw.ft_product (crop_id);
comment on table raw.ft_product is 'FreshTrack product master (read-replica). Covers 159/159 hub product_ids (pallet ∪ order_item ∪ gp_detail, verified 2026-07-11). Feeds core.dim_product. Full-sync (251 rows).';
comment on column raw.ft_product.net_weight_value is 'Produce-dependent, nullable. Never coalesce to 0 in averages (SPEC §9.3).';

-- ── ft_crop ──────────────────────────────────────────────────────────────────
create table if not exists raw.ft_crop (
  id                uuid primary key,
  code              text,
  name              text,
  family            text,
  account_code      text,
  netsuite_id       text,
  is_active         boolean,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_crop is 'FreshTrack crop lookup (read-replica). Denormalised into core.dim_product.crop_name. Full-sync (7 rows).';

-- ── ft_variety ───────────────────────────────────────────────────────────────
create table if not exists raw.ft_variety (
  id                uuid primary key,
  code              text,
  name              text,
  description       text,
  crop_id           uuid,
  is_active         boolean,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_variety is 'FreshTrack variety lookup (read-replica). Denormalised into core.dim_product.variety_name. Full-sync (22 rows).';

-- ── ft_pack_type ─────────────────────────────────────────────────────────────
create table if not exists raw.ft_pack_type (
  id                uuid primary key,
  code              text,
  name              text,
  tare_value        numeric,
  tare_unit         text,
  is_pre_pack       boolean,
  is_active         boolean,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_pack_type is 'FreshTrack pack-type lookup (read-replica). Denormalised into core.dim_product.pack_type_name. Full-sync (25 rows).';

-- ── Grants (belt-and-braces over 0011 default privileges; NO authenticated grant, no RLS) ──
grant select on raw.ft_consignee, raw.ft_product, raw.ft_crop, raw.ft_variety, raw.ft_pack_type
  to cube_readonly;
