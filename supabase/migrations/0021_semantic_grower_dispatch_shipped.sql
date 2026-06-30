-- 0021_semantic_grower_dispatch_shipped — ADDITIVE shipped-state dispatch surface (Sprint 8, Option C).
--
-- WHY: the existing governed dispatch metric defines "dispatched" = actual_pickup_on IS NOT NULL and
-- "boxes" = pallet.box_count. Both mis-state FreshTrack reality (DISPATCH_DEFINITION_PROPOSAL.md, validated
-- across the active grower set + the live portal): actual_pickup_on is barely captured (null on ~61% of
-- shipped Sell loads here; 100% of LMB's loads), and box_count is OWN-STOCK only — reconsigned cartons live
-- in reconsigned_boxes. Result: ~21 active non-test growers (incl. LMB) are invisible on the current surface.
--
-- THIS MIGRATION IS PURELY ADDITIVE (Option C, NOT Option B). It does NOT touch
-- semantic.grower_dispatch_detail (0008/0022), the dispatch Cube cubes, or any existing consumer. It adds,
-- ALONGSIDE them, a new SHIPPED-state view with contract-compliant definitions:
--   • "dispatched"    = the load has reached a Shipped-or-later lifecycle state  (dim_dispatch_state.sequence >= 5)
--   • "dispatched_on" = coalesce(actual_pickup_on, scheduled_pickup_on)
--   • "boxes"         = coalesce(stock_boxes,0) + coalesce(reconsigned_boxes,0)  (the portal's "Boxes Packed")
-- The existing actual_pickup_on / box_count surface is unchanged byte-for-byte; consumers OPT IN to this one.
--
-- THRESHOLD IS A SINGLE, CLEARLY-MARKED CONDITION. The gate is one literal line in the view below
-- (`st.sequence >= 5`). To move the dispatch line (e.g. require Delivered = seq >= 7) ops edit that ONE line.
-- It is intentionally NOT baked into stored data, so the view is the single source of truth for the gate.
--
-- STATE DIM SOURCING: the SPRINT permits seeding the 14 enumerated states in-migration when the FreshTrack
-- lookup is not readily ingestable this sprint. We mirror the gp_status raw->core pattern (raw landing +
-- conformed core dim built by an idempotent refresh fn) AND seed raw with the 14 states captured live from
-- the FreshTrack `dispatchLoadStates` GraphQL lookup on 2026-06-30 (id/code/name/sequence are stable). A
-- future loader can upsert raw.ft_dispatch_load_state and re-run refresh with no schema change.

-- ── raw: faithful mirror of the dispatch lifecycle lookup (FreshTrack DispatchLoadStateNode, 14 rows) ─────
create table if not exists raw.ft_dispatch_load_state (
  id               uuid primary key,
  code             text,            -- OP/WO/FI/RTCO/SH/IT/DE/PDEL/RI/IN/CAPP/RP/PA/CL
  name             text,            -- Open / Work in Progress / … / Shipped / … / Paid / Closed
  sequence         integer,         -- lifecycle order (Open=1 … Shipped=5 … Paid=13 … Closed=14)
  is_active        boolean,
  color            text,
  _raw             jsonb,
  _synced_at       timestamptz not null default now()
);
comment on table raw.ft_dispatch_load_state is
  'FreshTrack DispatchLoadState lookup (the load lifecycle, 14 states). sequence orders the states; Shipped=5 is the dispatch line. Seeded in 0021 from the live GraphQL lookup (2026-06-30); upsertable by a future loader.';

-- Seed the 14 states (documented interim; values captured live 2026-06-30). Idempotent.
insert into raw.ft_dispatch_load_state (id, code, name, sequence, is_active, color) values
  ('701c6ce6-a51a-45af-bb8a-84bda8866df0','OP','Open',1,true,null),
  ('22703ca3-e263-49f0-872c-2d1ffafe7df8','WO','Work in Progress',2,true,null),
  ('01920316-c091-a650-36ba-b207699e41b6','FI','Filled',3,true,null),
  ('019cfda1-7dee-a18f-8eb7-7ddf0c789e87','RTCO','Ready to Collect',4,true,null),
  ('c09dfa92-a8d7-4a5f-945c-606275163f68','SH','Shipped',5,true,null),
  ('0191371e-b27f-a19b-1f6a-5ac6925ae11d','IT','In Transit',6,true,null),
  ('4dad6c7d-e3f4-4786-9b64-ce6b20cb6d45','DE','Delivered',7,true,null),
  ('019602e6-cd14-0288-e8fd-b569e1a1757c','PDEL','Partially Delivered',8,true,null),
  ('147139f9-c2ed-4f6c-a8dc-b8a26d5df98a','RI','Ready to Invoice',9,true,null),
  ('2ad4d1f7-d011-43b0-9ce5-d1742929278d','IN','Invoiced',10,true,null),
  ('0197760b-5933-d010-9c22-a250193f78bf','CAPP','Charges Applied',11,true,null),
  ('0197430f-882d-c887-c954-519734fbf47c','RP','Ready for Payment',12,true,null),
  ('a7418974-b630-46e9-83ce-ad7b3c93e734','PA','Paid',13,true,null),
  ('fb04b52d-693d-4ab4-8f64-40a3428ce42b','CL','Closed',14,true,null)
on conflict (id) do update set
  code=excluded.code, name=excluded.name, sequence=excluded.sequence,
  is_active=excluded.is_active, color=excluded.color, _synced_at=now();

-- ── core: conformed dim, keyed on the state_id used by raw.ft_dispatch_load.state_id ─────────────────────
-- Pure lookup: state_id -> (code, name, sequence). NO threshold flag is stored — the dispatch gate lives in
-- the view as a single literal condition (the rubric's "one-edit-to-change" requirement). Mirrors gp_status.
create table if not exists core.dim_dispatch_state (
  state_id        uuid primary key,
  code            text,
  name            text,
  sequence        integer,
  is_active       boolean,
  _built_at       timestamptz not null default now()
);
comment on table core.dim_dispatch_state is
  'Conformed FreshTrack dispatch lifecycle dim (14 states), built from raw.ft_dispatch_load_state. Keyed on state_id (= raw.ft_dispatch_load.state_id). sequence orders the lifecycle (Open=1 … Shipped=5 … Paid=13 … Closed=14). The "shipped" gate (sequence >= 5) is applied in semantic.grower_dispatch_shipped, not stored here.';

-- Idempotent (re)build from the raw lookup. Returns rows in the dim. search_path '' + fully-qualified (0009).
create or replace function core.refresh_dim_dispatch_state() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.dim_dispatch_state;
  insert into core.dim_dispatch_state (state_id, code, name, sequence, is_active, _built_at)
  select s.id, s.code, s.name, s.sequence, s.is_active, now()
  from raw.ft_dispatch_load_state s;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_dim_dispatch_state() is
  'Idempotent rebuild of core.dim_dispatch_state from raw.ft_dispatch_load_state (raw is the source of truth).';

select core.refresh_dim_dispatch_state();

-- ── grants (mirror the dispatch surface: authenticated reads the core dim; Cube reads via cube_readonly) ──
grant select on core.dim_dispatch_state to authenticated, cube_readonly;
grant select on raw.ft_dispatch_load_state to cube_readonly;
grant execute on function core.refresh_dim_dispatch_state() to service_role;

-- ── semantic: the SHIPPED view (corrected dispatched/boxes), same grain + RLS posture as 0008/0022 ───────
-- security_invoker => base-table RLS (raw.ft_dispatch_load / raw.ft_pallet / core.dim_grower from 0008/0010)
-- scopes the caller exactly as for grower_dispatch_detail. core.dim_dispatch_state is a non-grower lookup
-- (every row is a lifecycle state; no consignor) joined on state_id — it CANNOT widen, drop, or re-scope any
-- grower's rows. Grower attribution = the LOAD's consignor (grower_key; SPEC §9.1), never harvest lineage.
-- Pallet grain (one row per pallet), matching grower_dispatch_detail.
create or replace view semantic.grower_dispatch_shipped
  with (security_invoker = true) as
select
  d.consignor_id                                            as grower_key,        -- = consignor_id (RLS anchor)
  d.id                                                      as load_id,           -- for exact distinct-load counts
  coalesce(d.actual_pickup_on, d.scheduled_pickup_on)::date as dispatched_on,      -- effective date: actual, else scheduled
  coalesce(d.actual_pickup_on, d.scheduled_pickup_on)       as dispatched_at,
  d.actual_pickup_on,                                                              -- raw actual kept (nullable) for transparency
  d.scheduled_pickup_on,                                                           -- raw scheduled kept for transparency
  st.code                                                   as dispatch_state,     -- lifecycle state (SH/IT/DE/…)
  st.name                                                   as dispatch_state_name,
  st.sequence                                               as dispatch_state_seq,
  d.pack_date,
  d.extra_text_2                                            as pack_week,           -- Y{YY}W{WW}
  d.load_no,
  p.id                                                      as pallet_id,
  p.pallet_no,
  p.crop_description                                        as crop,
  p.variety_description                                     as variety,
  p.product_description                                     as product,            -- may carry ^{...} codes; parse in the portal
  (coalesce(p.stock_boxes, 0) + coalesce(p.reconsigned_boxes, 0)) as boxes,        -- corrected: "Boxes Packed" (stock + reconsigned)
  p.box_count                                              as boxes_own_stock,     -- old definition kept for transparency (= stock_boxes)
  p.net_weight_value                                       as net_weight,          -- nullable, NEVER coalesced (SPEC §9.3)
  p.net_weight_unit,
  p.shed_id                                                as origin_shed_id,      -- pallet's OWN packing shed (farm origin), as in 0022
  sh.shed_name                                             as origin_shed_name,
  p.is_field,
  p.is_archived
from raw.ft_pallet p
join raw.ft_dispatch_load d     on d.id = p.dispatch_load_id
join core.dim_dispatch_state st on st.state_id = d.state_id
join core.dim_grower g          on g.consignor_id = d.consignor_id
left join core.dim_shed sh      on sh.shed_id = p.shed_id
where st.sequence >= 5                 -- ◀── SHIPPED GATE: Shipped-or-later. SINGLE ops-tunable line (raise to 7=Delivered, 10=Invoiced, …).
  and d.order_type = 'S'               -- Sell loads only (baked-in; mirrors the governed dispatch contract)
  and coalesce(g.is_test, false) = false;

grant select on semantic.grower_dispatch_shipped to authenticated, cube_readonly;

comment on view semantic.grower_dispatch_shipped is
  'ADDITIVE shipped-state dispatch detail (pallet grain). dispatched = dim_dispatch_state.sequence >= 5 (Shipped+, single tunable gate); dispatched_on = coalesce(actual,scheduled) pickup; boxes = stock_boxes + reconsigned_boxes (portal "Boxes Packed"). Sell loads only, non-test. grower_key = load consignor (RLS anchor). RLS = same security_invoker + app_metadata-only fail-closed contract as grower_dispatch_detail (0008/0010). Does NOT replace grower_dispatch_detail — both coexist (Option C).';
