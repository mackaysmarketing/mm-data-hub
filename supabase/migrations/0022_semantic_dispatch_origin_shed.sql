-- 0022_semantic_dispatch_origin_shed — ADDITIVE: expose the pallet's own packing shed (farm origin).
--
-- WHY: grower_dispatch_detail (0008) attributes every pallet to the LOAD's consignor (SPEC §9.1) — correct
-- for ownership, but it loses the FARM ORIGIN of a reconsigned pallet. A pallet packed at grower A's shed can
-- be consigned on a load whose consignor is grower B (the reconsignment case Sprint 7 surfaced). The pallet's
-- OWN shed lives on raw.ft_pallet.shed_id and is independent of both the load's shed and the consignor.
--
-- THIS MIGRATION IS PURELY ADDITIVE. Every existing column of semantic.grower_dispatch_detail is preserved,
-- in order; it only APPENDS origin_shed_id (uuid, = raw.ft_pallet.shed_id) and origin_shed_name (text).
-- It does NOT touch raw, does NOT touch public, does NOT apply or depend on the unapplied Sprint 8 work
-- (0021 grower_dispatch_shipped / dim_dispatch_state). The two are independent.
--
-- ORIGIN ≠ CONSIGNOR, ORIGIN ≠ LOAD SHED. origin_shed_id is the pallet's own shed_id, full stop.

-- ── core.dim_shed: shed_id -> name lookup (cardinality 1:1 in raw.ft_entity, verified: 89 sheds, 0 with
--    multiple names). NOT security_invoker → it resolves raw.ft_entity as the view OWNER, so grower / Cube
--    callers need NO direct grant on raw.ft_entity (which carries org_tax_no etc. and must stay unexposed).
--    It surfaces ONLY (shed_id, shed_name) — minimal disclosure. ft_entity has no RLS; a shed name is the
--    owning org's name. Deduped to exactly one row per shed_id so the downstream LEFT JOIN can never fan out.
create or replace view core.dim_shed as
  select shed_id,
         max(org_name) as shed_name
  from raw.ft_entity
  where shed_id is not null
  group by shed_id;

grant select on core.dim_shed to authenticated, cube_readonly;

comment on view core.dim_shed is
  'shed_id -> shed_name lookup (owning org name from raw.ft_entity, 1:1). Owner-rights view so callers need no raw.ft_entity grant; exposes only shed_id + name. Used to label origin_shed_id in semantic.grower_dispatch_detail.';

-- ── semantic.grower_dispatch_detail: unchanged columns + farm origin appended ───────────────────────────
-- security_invoker = true → base-table RLS (raw.ft_dispatch_load / raw.ft_pallet / core.dim_grower from
-- 0008/0010) still scopes the caller exactly as before. core.dim_shed is an owner-rights lookup keyed on
-- shed (NOT consignor) and joined LEFT → it cannot drop, widen, or re-scope any grower's rows. Grower
-- attribution is still the LOAD's consignor (grower_key); origin_shed_* is orthogonal farm-origin lineage.
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
  p.is_archived,
  -- ── APPENDED (additive) farm origin: the pallet's OWN packing shed ──
  p.shed_id                   as origin_shed_id,       -- = raw.ft_pallet.shed_id; NOT load shed, NOT consignor
  sh.shed_name                as origin_shed_name      -- owning org name for that shed (nullable)
from raw.ft_pallet p
join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
join core.dim_grower g      on g.consignor_id = d.consignor_id
left join core.dim_shed sh  on sh.shed_id = p.shed_id
where d.actual_pickup_on is not null
  and coalesce(g.is_test, false) = false;

grant select on semantic.grower_dispatch_detail to authenticated;

comment on view semantic.grower_dispatch_detail is
  'Grower-scoped dispatch detail at pallet grain. RLS via JWT claim consignor_id. grower_key = load consignor (not harvest_load_id). net_weight nullable, never coalesced. origin_shed_id (additive, 0022) = the pallet''s OWN packing shed (raw.ft_pallet.shed_id) — farm origin, independent of the load consignor (reconsignment lineage); origin_shed_name labels it via core.dim_shed.';
