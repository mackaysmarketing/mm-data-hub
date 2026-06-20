-- 0004_raw_ft_entity — grower/consignor/customer master, GraphQL source.
-- Banking + contact fields held out (sparse + financial PII, SPEC §3).
-- is_test is DERIVED (generated): inactive entity with a *TEST code.

create table if not exists raw.ft_entity (
  id                   uuid primary key,
  code                 text,
  org_name             text,
  org_legal_name       text,
  type                 text,          -- 'ORG' / 'IND'
  tags                 text[],
  is_active            boolean,
  is_grower            boolean,
  is_test              boolean generated always as
                         (coalesce(is_active, false) = false and code ilike '%TEST') stored,
  org_tax_no           text,
  ext_link             text,
  consignor_id         uuid,
  consignee_id         uuid,
  marketer_id          uuid,
  carrier_id           uuid,
  supplier_id          uuid,
  farm_id              uuid,
  shed_id              uuid,
  parent_id            uuid,
  org_market_area_id   uuid,
  payment_term_id      uuid,
  _raw                 jsonb,         -- safety net (small table)
  _synced_at           timestamptz not null default now()
);

create index if not exists ix_ft_entity_consignor on raw.ft_entity (consignor_id);
create index if not exists ix_ft_entity_code on raw.ft_entity (code);

comment on table raw.ft_entity is 'FreshTrack EntityNode, trimmed (SPEC §3). Banking/contact PII excluded.';
comment on column raw.ft_entity.is_test is 'DERIVED: inactive entity whose code ends in TEST (TRUGTEST, LARATEST, ANNRTEST).';
comment on column raw.ft_entity.consignor_id is 'Grower identity key (consignor == grower; supplier_id is null on GP).';
