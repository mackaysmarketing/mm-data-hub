-- 0052_grower_register_posture — classify + gate the grower-register relations (drift cleanup).
--
-- WHY: the grower-register workstream (2026-07-13/14, applied from outside this repo) landed six
--   relations in raw/core/semantic with no posture: RLS on but NO policies (dead grants — every
--   caller got 0 rows / denied writes), anon footholds (stripped by 0051 after the anon-REST
--   incident), and an owner-rights semantic view. This migration gives each relation its
--   declared posture; scripts/rls_posture.ts registers all six in the same change.
--
-- WHAT THE RELATIONS ARE (inspected 2026-07-16):
--   raw.atcm_crop_blocks_fnq   — ATCM (public dataset) crop blocks, FNQ; spatial landing.
--   raw.qscf_lots_banana_belt  — QLD cadastre lots, banana belt; spatial landing.
--   core.crop_block_parcel     — computed block×parcel overlap (derived from the two public
--                                datasets; carries NO grower info).
--   core.block_grower_tag      — grower attribution tags (grower_name/code, notes, tagged_by):
--   core.parcel_grower_tag       commercially sensitive; the register UI's WRITE surface.
--   semantic.grower_crop_area  — grower × crop area rollup over the tags.
--
-- POSTURE DECISIONS (house rule: the criterion is whether a GROWER-FACING view needs the
-- relation — none does; the register is a staff feature behind mm-hub's gr_* invoker views):
--   * All five tables → INTERNAL-ONLY reads: authenticated gated by semantic.is_internal_claim()
--     (the 0024/0040 pattern) + cube_readonly read-all. Growers and grower-portal (Auth0) tokens
--     see 0 rows; the deny guards (0050) mean an Auth0 token can never assert internal.
--   * The two TAG tables additionally get INTERNAL-GATED WRITE policies — the hub's FIRST
--     registered interactive-write surface: mm-hub's gr_block_tags / gr_grower_tags are
--     security_invoker auto-updatable views, so staff tag edits in the register UI write through
--     to these tables as the logged-in user. Until now the A4 invariant said "writes only via
--     service_role"; that stays the DEFAULT — a write policy is legal ONLY when the posture
--     registry entry declares writes:'internal' AND the policy is exactly
--     is_internal_claim()-gated (rls_posture.ts enforces both, same change).
--   * semantic.grower_crop_area → SECURITY_INVOKER (was owner-rights = RLS bypass, the 0051
--     incident surface): base-table RLS now applies to the caller — internal sees the rollup,
--     growers/Auth0/anon get nothing.
--
-- Scope: raw/core/semantic only. Idempotent. authenticated/cube grants already exist from the
-- register migrations; re-granted here so the migration stands alone on a fresh database.

-- ── Spatial landings + derived overlap: internal-only reads ────────────────────────────────────
alter table raw.atcm_crop_blocks_fnq  enable row level security;
alter table raw.qscf_lots_banana_belt enable row level security;
alter table core.crop_block_parcel    enable row level security;

grant select on raw.atcm_crop_blocks_fnq, raw.qscf_lots_banana_belt, core.crop_block_parcel
  to authenticated, cube_readonly;

drop policy if exists internal_only_read on raw.atcm_crop_blocks_fnq;
create policy internal_only_read on raw.atcm_crop_blocks_fnq
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists cube_readonly_read_all on raw.atcm_crop_blocks_fnq;
create policy cube_readonly_read_all on raw.atcm_crop_blocks_fnq
  for select to cube_readonly using (true);

drop policy if exists internal_only_read on raw.qscf_lots_banana_belt;
create policy internal_only_read on raw.qscf_lots_banana_belt
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists cube_readonly_read_all on raw.qscf_lots_banana_belt;
create policy cube_readonly_read_all on raw.qscf_lots_banana_belt
  for select to cube_readonly using (true);

drop policy if exists internal_only_read on core.crop_block_parcel;
create policy internal_only_read on core.crop_block_parcel
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists cube_readonly_read_all on core.crop_block_parcel;
create policy cube_readonly_read_all on core.crop_block_parcel
  for select to cube_readonly using (true);

-- ── Grower attribution tags: internal-only reads + REGISTERED internal-gated writes ───────────
alter table core.block_grower_tag  enable row level security;
alter table core.parcel_grower_tag enable row level security;

grant select on core.block_grower_tag, core.parcel_grower_tag to cube_readonly;
grant select, insert, update, delete on core.block_grower_tag, core.parcel_grower_tag
  to authenticated;

drop policy if exists internal_only_read on core.block_grower_tag;
create policy internal_only_read on core.block_grower_tag
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_insert on core.block_grower_tag;
create policy internal_only_insert on core.block_grower_tag
  for insert to authenticated with check (semantic.is_internal_claim());
drop policy if exists internal_only_update on core.block_grower_tag;
create policy internal_only_update on core.block_grower_tag
  for update to authenticated
  using (semantic.is_internal_claim()) with check (semantic.is_internal_claim());
drop policy if exists internal_only_delete on core.block_grower_tag;
create policy internal_only_delete on core.block_grower_tag
  for delete to authenticated using (semantic.is_internal_claim());
drop policy if exists cube_readonly_read_all on core.block_grower_tag;
create policy cube_readonly_read_all on core.block_grower_tag
  for select to cube_readonly using (true);

drop policy if exists internal_only_read on core.parcel_grower_tag;
create policy internal_only_read on core.parcel_grower_tag
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_insert on core.parcel_grower_tag;
create policy internal_only_insert on core.parcel_grower_tag
  for insert to authenticated with check (semantic.is_internal_claim());
drop policy if exists internal_only_update on core.parcel_grower_tag;
create policy internal_only_update on core.parcel_grower_tag
  for update to authenticated
  using (semantic.is_internal_claim()) with check (semantic.is_internal_claim());
drop policy if exists internal_only_delete on core.parcel_grower_tag;
create policy internal_only_delete on core.parcel_grower_tag
  for delete to authenticated using (semantic.is_internal_claim());
drop policy if exists cube_readonly_read_all on core.parcel_grower_tag;
create policy cube_readonly_read_all on core.parcel_grower_tag
  for select to cube_readonly using (true);

comment on table core.block_grower_tag is
  'Grower attribution tags for ATCM crop blocks (register UI write surface). INTERNAL-ONLY read + internal-gated writes (0052 — the hub''s first registered interactive-write posture); anon stripped 0051. mm-hub public.gr_block_tags (security_invoker, auto-updatable) is the app door.';
comment on table core.parcel_grower_tag is
  'Grower attribution tags for cadastral parcels (register UI write surface). Same 0052 posture as block_grower_tag; mm-hub door = public.gr_grower_tags.';

-- ── The rollup view: owner-rights → security_invoker (base RLS applies to the caller) ─────────
alter view semantic.grower_crop_area set (security_invoker = true);
grant select on semantic.grower_crop_area to authenticated, cube_readonly;

comment on view semantic.grower_crop_area is
  'Grower × crop estimated area from register tags (blocks + non-overlapping parcels). security_invoker (0052; was owner-rights — the 0051 anon-REST incident): base internal-only RLS applies to the caller, so only internal claims see rows. Wrapped by mm-hub public.gr_grower_crop_area.';
