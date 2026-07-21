-- 0062_grower_classification_override — force a grower/non-grower classification in the hub when
-- FreshTrack cannot be corrected (2026-07-21).
--
-- ═══ WHY ══════════════════════════════════════════════════════════════════════════════════════
-- `core.dim_grower.is_grower` is copied verbatim from `raw.ft_entity.is_grower` by
-- `core.refresh_dim_grower()`. Tim found **AGSCU ("Sculli - Agent", legal name Sculli & Co
-- Melbourne Pty Ltd, tagged Agent, market area Melbourne Markets)** flagged `is_grower = true`.
-- It is the ONLY `AG*`-coded entity so flagged — the other ten (AGDBM, AGRRF, AGPER, AGQPI,
-- AGSQB, AGPFM, AGLMB, AGPFS, AGAPP, AGBTA) are all false. A clear misclassification at source.
--
-- Correcting it in FreshTrack currently FAILS with a vendor-side crash:
--   `'NoneType' object has no attribute 'is_grower'`
-- Diagnosed: AGSCU carries a Farm association, and FreshTrack requires a Farm's contact **or its
-- parent** to be a supplier/grower. Clearing Grower? disqualifies AGSCU's own supplier, so the
-- validator falls through to the parent — Sculli & Co (SCULL) — which has NO supplier record at
-- all, so it dereferences None. AGSCU is **1 of 105 Farm entities, and the only one whose parent
-- has no supplier record**, which is why nothing else hits this path. That is FreshTrack's bug to
-- fix; this migration lets the hub hold the correct value in the meantime.
--
-- ═══ WHY A SEPARATE TABLE, NOT AN UPDATE ══════════════════════════════════════════════════════
-- `refresh_dim_grower()` runs on EVERY entity sync and does `is_grower = excluded.is_grower`.
-- A manual `update core.dim_grower set is_grower = false` would be silently reverted by the next
-- `npm run load:entities`. Same lesson as `dim_gp_charge.revenue_class` and the reason
-- `core.portal_grower_activation` (0059) is its own table. Curated state NEVER lives on a
-- rebuilt dim.
--
-- ═══ SHAPE ════════════════════════════════════════════════════════════════════════════════════
-- `dim_grower.is_grower` stays THE column every consumer reads, and becomes the EFFECTIVE value
-- (override applied). The untouched FreshTrack value is preserved beside it as
-- `is_grower_source`, so drift is visible: once FreshTrack is fixed, `is_grower_source` catches up
-- and the override row is provably redundant and can be retired. Never silently permanent.
--
-- Blast radius of is_grower today: `semantic.grower_directory` (0056/0058) filters
-- `g.is_grower is true`, so AGSCU leaves the staff onboarding list — the intent. AGSCU has NO
-- portal activation row (verified), so no live portal user is affected. Cube exposes is_grower as
-- a dimension only (no filter). Nothing else reads it.
--
-- NOT a security boundary: no grower-scoped view gates on is_grower today (they gate on is_test +
-- the RLS consignor claim + portal activation). Whether the grower surface SHOULD gate on
-- is_grower is a separate open decision — deliberately not made here.

-- ── The override store (survives every dim rebuild; carries the audit trail) ───────────────────
create table if not exists core.grower_classification_override (
  consignor_id uuid primary key
    references core.dim_grower (consignor_id),   -- unknown consignors cannot be overridden
  is_grower    boolean     not null,             -- the FORCED effective value
  reason       text        not null,             -- why — never override without stating it
  updated_at   timestamptz not null default now(),
  updated_by   text                              -- who (JWT sub or a human/system name)
);

comment on table core.grower_classification_override is
  'Forced grower/non-grower classification per consignor (0062), applied by core.refresh_dim_grower() so it SURVIVES every entity sync. SEPARATE from core.dim_grower deliberately — the dim is rebuilt and curated state on a rebuilt dim gets silently reset (the dim_gp_charge.revenue_class lesson; same reason as core.portal_grower_activation, 0059). Use ONLY where the source system cannot be corrected; state the reason, and retire the row once dim_grower.is_grower_source agrees.';
comment on column core.grower_classification_override.reason is
  'Mandatory. Why the source value is being overridden, including what blocks fixing it upstream.';
comment on column core.grower_classification_override.is_grower is
  'The effective value forced onto core.dim_grower.is_grower. The untouched FreshTrack value stays visible as core.dim_grower.is_grower_source.';

alter table core.grower_classification_override enable row level security;
grant select on core.grower_classification_override to authenticated, cube_readonly;

-- INTERNAL-ONLY read (mirrors core.dim_ns_charge, 0030/0036). No write policy for ANY JWT role:
-- this is internal curation, edited by service_role / migration only. If the portal ever needs to
-- curate it, add an admin-gated SECURITY DEFINER RPC (the 0059 pattern) and pin it in rls_posture A7.
drop policy if exists internal_only_grower_classification_override on core.grower_classification_override;
create policy internal_only_grower_classification_override on core.grower_classification_override
  for select to authenticated using (semantic.is_internal_claim());

drop policy if exists cube_readonly_read_all on core.grower_classification_override;
create policy cube_readonly_read_all on core.grower_classification_override
  for select to cube_readonly using (true);

-- ── dim_grower keeps the source value beside the effective one ────────────────────────────────
alter table core.dim_grower
  add column if not exists is_grower_source boolean;

comment on column core.dim_grower.is_grower is
  'EFFECTIVE grower flag (0062): raw.ft_entity.is_grower with core.grower_classification_override applied. This is the column every consumer reads.';
comment on column core.dim_grower.is_grower_source is
  'The UNTOUCHED raw.ft_entity.is_grower (0062). Differs from is_grower only where an override row exists — once the source system is corrected these agree and the override can be retired.';

-- ── refresh applies the override (body otherwise unchanged from 0058) ──────────────────────────
create or replace function core.refresh_dim_grower() returns integer
language plpgsql as $$
declare n integer;
begin
  insert into core.dim_grower
    (consignor_id, entity_id, code, org_name, is_grower, is_grower_source, is_active, is_test,
     market_area_id, payment_term_id, parent_entity_id, parent_name, _built_at)
  select distinct on (e.consignor_id)
    e.consignor_id, e.id, e.code, e.org_name,
    coalesce(o.is_grower, e.is_grower),          -- ◀── the override wins; absent = source value
    e.is_grower,                                 -- ◀── source preserved, always
    e.is_active, e.is_test,
    e.org_market_area_id, e.payment_term_id,
    e.parent_id, p.org_name, now()
  from raw.ft_entity e
  left join raw.ft_entity p on p.id = e.parent_id
  left join core.grower_classification_override o on o.consignor_id = e.consignor_id
  where e.consignor_id is not null
  order by e.consignor_id, e.is_active desc nulls last, e._synced_at desc
  on conflict (consignor_id) do update set
    entity_id        = excluded.entity_id,
    code             = excluded.code,
    org_name         = excluded.org_name,
    is_grower        = excluded.is_grower,
    is_grower_source = excluded.is_grower_source,
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
  'Idempotent upsert of core.dim_grower from raw.ft_entity (+ parent hierarchy denormalized, 0058). 0062: core.grower_classification_override is applied to is_grower (the effective value) while the untouched source is kept as is_grower_source — so a forced classification survives every entity sync and its drift stays visible.';

-- ── Seed: the one row Tim identified ──────────────────────────────────────────────────────────
-- `do update` is deliberate here and safe: the seed is authoritative for THIS consignor and the
-- migration is re-runnable. (Contrast 0059, where do-update would have reverted an admin's own
-- later change — there is no interactive write path to this table.)
insert into core.grower_classification_override (consignor_id, is_grower, reason, updated_by)
select g.consignor_id, false,
       'Agent, not a grower: "Sculli - Agent" (Sculli & Co Melbourne Pty Ltd), tagged Agent, market area Melbourne Markets, and the only AG*-coded entity flagged is_grower=true (the other ten are false). Cannot be corrected in FreshTrack: clearing Grower? crashes with "NoneType object has no attribute is_grower" because AGSCU carries a Farm association and its parent SCULL has no supplier record (1 of 105 farm entities in that shape). Retire this row once dim_grower.is_grower_source reads false.',
       'tim/0062'
from core.dim_grower g
where g.code = 'AGSCU'
on conflict (consignor_id) do update set
  is_grower  = excluded.is_grower,
  reason     = excluded.reason,
  updated_at = now(),
  updated_by = excluded.updated_by;

-- ── Apply now ─────────────────────────────────────────────────────────────────────────────────
select core.refresh_dim_grower();
