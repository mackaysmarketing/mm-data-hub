-- 0051_revoke_anon_grower_register_drift — strip EVERY anon foothold from the hub schemas.
--
-- WHY (urgent, 2026-07-16): the grower-register migrations (applied 2026-07-13/14 from outside
--   this repo) left anon grants/policies on six relations inside raw/core/semantic, plus anon
--   USAGE on the core and semantic schemas. That drift was posture-sweep-red but unreachable —
--   until today, when `semantic` was added to PostgREST's exposed schemas for grower-portal:
--   a live probe then returned HTTP 200 [] for GET /rest/v1/grower_crop_area (Accept-Profile:
--   semantic) with the publishable anon key. semantic.grower_crop_area is an OWNER-RIGHTS view
--   (bypasses base RLS), so the moment register data loads, grower_name/grower_code/est_ha
--   would be publicly readable. Verified live before and after this migration.
--
-- CONTRACT: anon/PUBLIC must NEVER appear in raw/core/semantic (rls_posture A5). This migration
--   is revoke/drop-only and touches ONLY anon:
--   * authenticated grants are deliberately UNTOUCHED — mm-hub's gr_* public views are now
--     security_invoker and route hub logins through these base grants/RLS (their hardening
--     migration, same day). Classifying the six relations in the posture registry (+ fixing the
--     owner-rights view, dead grants, cube posture) remains the separate drift-cleanup task.
--   * No RLS policies for other roles are altered.
--
-- Scope: raw/core/semantic only. Idempotent (revoke/drop-if-exists are no-ops when clean).

-- ── Schema-level: anon must not even have USAGE on the hub schemas ────────────────────────────
-- (anon had USAGE on core + semantic from the register drift; raw was already clean — included
-- for idempotent completeness.)
revoke usage on schema raw    from anon;
revoke usage on schema core   from anon;
revoke usage on schema semantic from anon;

-- ── Relation grants: strip anon from all six drift relations ──────────────────────────────────
revoke all on raw.atcm_crop_blocks_fnq   from anon;
revoke all on raw.qscf_lots_banana_belt  from anon;
revoke all on core.block_grower_tag      from anon;   -- had SELECT/INSERT/UPDATE/DELETE
revoke all on core.crop_block_parcel     from anon;
revoke all on core.parcel_grower_tag     from anon;   -- had SELECT/INSERT/UPDATE/DELETE
revoke all on semantic.grower_crop_area  from anon;   -- the anon-REST-reachable owner-rights view

-- ── Policies: drop the anon ALL using(true) policies (rls_posture A4 + A5 violations) ─────────
drop policy if exists anon_all_block_tags on core.block_grower_tag;
drop policy if exists anon_all_tags       on core.parcel_grower_tag;

-- ── Belt-and-braces: no future accidental anon default-privileges from the migration role ─────
-- (No ALTER DEFAULT PRIVILEGES existed for anon in these schemas; nothing to change — recorded
-- so the next reader knows it was checked.)
