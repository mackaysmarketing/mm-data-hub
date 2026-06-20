-- 0006_core_dim_grower — conformed grower dimension, keyed on consignor_id (the RLS anchor).
-- Built from raw.ft_entity (consignor entities). Carries is_grower / is_active / is_test.

create table if not exists core.dim_grower (
  consignor_id     uuid primary key,
  entity_id        uuid,
  code             text,
  org_name         text,
  is_grower        boolean,
  is_active        boolean,
  is_test          boolean,
  market_area_id   uuid,
  payment_term_id  uuid,
  _built_at        timestamptz not null default now()
);

comment on table core.dim_grower is 'Conformed grower dim keyed on consignor_id. RLS anchor for grower-scoped views.';

-- Idempotent (re)build from the entity master. Returns rows affected.
create or replace function core.refresh_dim_grower() returns integer
language plpgsql as $$
declare n integer;
begin
  insert into core.dim_grower
    (consignor_id, entity_id, code, org_name, is_grower, is_active, is_test, market_area_id, payment_term_id, _built_at)
  select distinct on (e.consignor_id)
    e.consignor_id, e.id, e.code, e.org_name, e.is_grower, e.is_active, e.is_test,
    e.org_market_area_id, e.payment_term_id, now()
  from raw.ft_entity e
  where e.consignor_id is not null
  order by e.consignor_id, e.is_active desc nulls last, e._synced_at desc
  on conflict (consignor_id) do update set
    entity_id       = excluded.entity_id,
    code            = excluded.code,
    org_name        = excluded.org_name,
    is_grower       = excluded.is_grower,
    is_active       = excluded.is_active,
    is_test         = excluded.is_test,
    market_area_id  = excluded.market_area_id,
    payment_term_id = excluded.payment_term_id,
    _built_at       = now();
  get diagnostics n = row_count;
  return n;
end $$;

comment on function core.refresh_dim_grower() is 'Idempotent upsert of core.dim_grower from raw.ft_entity.';
