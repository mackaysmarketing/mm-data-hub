-- 0008_semantic_grower_dispatch_detail — the grower-scoped dispatch detail view + RLS.
--
-- Cross-repo contract: mm-hub authenticates the grower and presents JWT claim
--   request.jwt.claims.consignor_id  (uuid)   → the grower
--   request.jwt.claims.is_internal   (bool)   → hub staff / service (sees all)
-- service_role bypasses RLS (ingestion, Cube/Steep).
--
-- Grower attribution = the LOAD's consignor (pallet.harvest_load_id is null on outbound, SPEC §9.1).

-- ── Claim helpers ────────────────────────────────────────────────────────────
create or replace function semantic.current_consignor_id() returns uuid
language sql stable as $$
  select case
    when current_setting('request.jwt.claims', true) is null
      or current_setting('request.jwt.claims', true) = '' then null
    else nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'consignor_id', '')::uuid
  end
$$;

create or replace function semantic.is_internal_claim() returns boolean
language sql stable as $$
  select case
    when current_setting('request.jwt.claims', true) is null
      or current_setting('request.jwt.claims', true) = '' then false
    else coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'is_internal')::boolean, false)
  end
$$;

comment on function semantic.current_consignor_id() is 'Grower identity from JWT claim request.jwt.claims.consignor_id.';
comment on function semantic.is_internal_claim() is 'True when JWT claim request.jwt.claims.is_internal = true (hub staff / service).';

-- ── RLS on the base tables the view reads ────────────────────────────────────
alter table raw.ft_dispatch_load enable row level security;
alter table raw.ft_pallet        enable row level security;
alter table core.dim_grower      enable row level security;

grant select on raw.ft_dispatch_load, raw.ft_pallet to authenticated;
grant select on core.dim_grower to authenticated;
grant execute on function semantic.current_consignor_id(), semantic.is_internal_claim() to authenticated;

-- A grower sees only their own loads; internal claims see all.
drop policy if exists grower_own_loads on raw.ft_dispatch_load;
create policy grower_own_loads on raw.ft_dispatch_load
  for select to authenticated
  using (consignor_id = semantic.current_consignor_id() or semantic.is_internal_claim());

-- A pallet is scoped through its load's consignor (filter restated explicitly, not via nested RLS).
drop policy if exists grower_own_pallets on raw.ft_pallet;
create policy grower_own_pallets on raw.ft_pallet
  for select to authenticated
  using (
    semantic.is_internal_claim()
    or dispatch_load_id in (
         select id from raw.ft_dispatch_load
         where consignor_id = semantic.current_consignor_id()
       )
  );

-- A grower sees only their own dim row; internal claims see all.
drop policy if exists grower_own_dim on core.dim_grower;
create policy grower_own_dim on core.dim_grower
  for select to authenticated
  using (consignor_id = semantic.current_consignor_id() or semantic.is_internal_claim());

-- ── The view (security_invoker → base-table RLS applies to the caller) ───────
create or replace view semantic.grower_dispatch_detail
  with (security_invoker = true) as
select
  d.consignor_id              as grower_key,          -- = consignor_id; NOT harvest_load_id
  d.actual_pickup_on::date    as dispatched_on,
  d.actual_pickup_on          as dispatched_at,
  d.pack_date,
  d.extra_text_2              as pack_week,            -- Y{YY}W{WW}
  d.load_no,
  p.id                        as pallet_id,
  p.pallet_no,
  p.crop_description          as crop,
  p.variety_description       as variety,
  p.product_description       as product,             -- may carry ^{...} codes; parse in the portal
  p.box_count                 as boxes,
  p.net_weight_value          as net_weight,          -- nullable, NOT coalesced
  p.net_weight_unit           as net_weight_unit,
  p.is_field,
  p.is_archived
from raw.ft_pallet p
join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
join core.dim_grower g      on g.consignor_id = d.consignor_id
where d.actual_pickup_on is not null
  and coalesce(g.is_test, false) = false;

grant select on semantic.grower_dispatch_detail to authenticated;

comment on view semantic.grower_dispatch_detail is
  'Grower-scoped dispatch detail at pallet grain. RLS via JWT claim consignor_id. grower_key = load consignor (not harvest_load_id). net_weight nullable, never coalesced.';
