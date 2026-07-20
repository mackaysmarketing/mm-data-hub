-- 0058_grower_directory_hierarchy — grower directory v2: FreshTrack parent-hierarchy columns
-- (grower-portal Sprint 19 ask, 2026-07-20; Tim's call — grouping derives from the ENTITY
-- PARENT HIERARCHY, e.g. Mac Farms is MACSD's parent, NOT a curated table).
--
-- THE CONTRACT (portal binds to these names): three columns added to semantic.grower_directory —
--   entity_id         uuid  — the consignor's own FreshTrack entity id
--   parent_entity_id  uuid  — null when no parent (e.g. GJFSD today)
--   parent_name       text  — null when no parent
-- Same rows, same staff-only gate (0056/0057). The portal groups by IMMEDIATE parent, merges
-- self-parents (LRCOL/MACKF anchor their own groups), and dissolves umbrella parents whose
-- children are themselves parents (the "Mackays Growers" pool) — all portal-side from these
-- three columns; fixing a wrong/missing parent happens in FreshTrack and flows through on sync.
--
-- WHY BUILD-TIME DENORMALIZATION (not the ask's literal "resolved at view level"): the
-- directory is a security_invoker view, and the hierarchy source raw.ft_entity is deliberately
-- UNGRANTED (etl-only posture — it carries org_tax_no). An invoker view joining it would be
-- permission-denied for every caller. So the parent columns land on core.dim_grower at refresh
-- (the 0054 "denormalise at build time" pattern) — same data, flows through on the same
-- entity-sync + refresh_dim_grower() cadence the portal already expects. Source: the ALREADY
-- LANDED raw.ft_entity.parent_id (0004) — populated on 136/320 entities; verified live:
-- MACBO/MACGT/MACMR/MACRR/MACSD → MACKF "Mac Farms"; LRCLA/LRCTU → LRCOL "L & R Collins";
-- LRCOL → MG "Mackays Growers" (the umbrella); GJFSD → none. No loader change needed.
--
-- Posture: NO policy/grant/RLS change. dim_grower stays grower-scoped (a grower can read their
-- own row's parent columns — their own grouping, not sensitive); the directory stays
-- staff-gated. parent_name is an org display name (no PII; org_tax_no never leaves raw).
-- Proof: npm run portal:verify (new F8 hierarchy section) · rls:posture · auth0:rls unchanged.
-- NOTE: the tenant-cutover cleanup migration previously reserved as "0058" in docs is now 0059.

-- ── dim: parent columns, populated at refresh ─────────────────────────────────────────────────
alter table core.dim_grower
  add column if not exists parent_entity_id uuid,
  add column if not exists parent_name      text;

comment on column core.dim_grower.parent_entity_id is
  'raw.ft_entity.parent_id of the consignor''s resolved entity row — the FreshTrack grouping hierarchy (0058). Null = no parent.';
comment on column core.dim_grower.parent_name is
  'org_name of the parent entity (denormalized at refresh — raw.ft_entity is ungranted; 0058).';

create or replace function core.refresh_dim_grower() returns integer
language plpgsql as $$
declare n integer;
begin
  insert into core.dim_grower
    (consignor_id, entity_id, code, org_name, is_grower, is_active, is_test,
     market_area_id, payment_term_id, parent_entity_id, parent_name, _built_at)
  select distinct on (e.consignor_id)
    e.consignor_id, e.id, e.code, e.org_name, e.is_grower, e.is_active, e.is_test,
    e.org_market_area_id, e.payment_term_id,
    e.parent_id, p.org_name, now()
  from raw.ft_entity e
  left join raw.ft_entity p on p.id = e.parent_id
  where e.consignor_id is not null
  order by e.consignor_id, e.is_active desc nulls last, e._synced_at desc
  on conflict (consignor_id) do update set
    entity_id        = excluded.entity_id,
    code             = excluded.code,
    org_name         = excluded.org_name,
    is_grower        = excluded.is_grower,
    is_active        = excluded.is_active,
    is_test          = excluded.is_test,
    market_area_id   = excluded.market_area_id,
    payment_term_id  = excluded.payment_term_id,
    parent_entity_id = excluded.parent_entity_id,
    parent_name      = excluded.parent_name,
    _built_at        = now();
  get diagnostics n = row_count;
  return n;
end $$;

comment on function core.refresh_dim_grower() is
  'Idempotent upsert of core.dim_grower from raw.ft_entity (+ parent hierarchy denormalized, 0058).';

-- ── directory v2: same rows, same staff gate, three new columns ───────────────────────────────
create or replace view semantic.grower_directory
  with (security_invoker = true) as
select
  g.consignor_id,
  g.org_name as consignor_name,
  g.code     as farm_code,
  g.is_active,
  g.entity_id,
  g.parent_entity_id,
  g.parent_name
from core.dim_grower g
where semantic.auth0_is_staff()             -- explicit gate: growers (and mm-hub tokens) get 0 rows
  and g.is_grower is true
  and coalesce(g.is_test, false) = false;   -- *TEST consignors never listed (SPEC §9.4)

comment on view semantic.grower_directory is
  'Staff-only grower list for the portal''s selection modal / onboarding (0056; v2 hierarchy 0058). One row per consignor: consignor_id, consignor_name, farm_code, is_active + entity_id / parent_entity_id / parent_name (FreshTrack parent hierarchy — the portal groups by immediate parent, merges self-parents, dissolves umbrella parents). Explicit auth0_is_staff() WHERE gate — grower/mm-hub/Cube/MCP contexts get 0 rows.';

-- ── populate now ──────────────────────────────────────────────────────────────────────────────
select core.refresh_dim_grower();
