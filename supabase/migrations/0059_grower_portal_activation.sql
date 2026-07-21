-- 0059_grower_portal_activation — portal activation: staff see only growers an ADMIN has
-- switched on (grower-portal Sprint 22 ask, 2026-07-21; Tim's direction after the first staff
-- login: internal staff should only see growers explicitly ACTIVATED on the portal).
--
-- THE CONTRACT (portal is already built against these names):
--   semantic.grower_directory  + portal_enabled  boolean NOT NULL (false when never activated)
--   semantic.set_grower_portal_enabled(p_consignor_ids uuid[], p_enabled boolean) returns void
-- Activation is per grower GROUP portal-side; the RPC takes the whole consignor array in one
-- atomic call. Idempotent: re-setting the same value is a no-op write.
--
-- ⚠ THIS IS THIS REPO'S FIRST SECURITY DEFINER FUNCTION AND FIRST JWT-CALLER WRITE PATH.
-- Three deliberate hardenings over the ask's illustrative SQL:
--   1. `set search_path = ''` (the ask showed `= semantic, core, public`). A SECURITY DEFINER
--      function with a writable schema on its search_path is THE classic privilege-escalation
--      vector: any object it references unqualified can be shadowed by a same-named object in
--      an earlier schema. Everything below is schema-qualified; pg_catalog is implicit.
--   2. EXECUTE revoked from PUBLIC (functions grant it by default) and granted to
--      `authenticated` ONLY — `anon` must never even reach the authorization check.
--   3. ADMIN gate is a dedicated issuer-pinned helper, evaluated FIRST, fail-closed, and the
--      function is otherwise pure parameterized plpgsql (no dynamic SQL → no injection surface).
--
-- AUTHORIZATION — admin, NOT staff (the ask's core requirement): the portal restricts this
--   action to internal admins; if the RPC only checked auth0_is_staff() every MM User (staff,
--   deliberately no admin rights) could call it directly and the portal's restriction would be
--   mere convention. Gate = `hub_role` claim ∈ {admin, hub_admin}, minted by the tenant Action
--   from server-controlled app_metadata.hub_role (a user cannot self-assert it). Growers, MM
--   Users (staff-not-admin), no-claim, and wrong-issuer callers are all REFUSED (42501).
--   Read stays staff-gated (portal_enabled rides the existing staff-only directory).
--
-- BACKING STORE = a SEPARATE TABLE, not a column on core.dim_grower. dim_grower is rebuilt by
--   core.refresh_dim_grower() on every entity sync; curated state living on a rebuilt dim is
--   exactly how dim_gp_charge.revenue_class gets silently reset (CLAUDE.md's standing warning).
--   core.portal_grower_activation survives every refresh by construction, and carries the audit
--   trail the ask asked for (updated_at / updated_by = the admin's JWT sub).
--
-- DEFAULT FALSE is enforced by ABSENCE + coalesce in the view: a consignor with no activation
--   row reads portal_enabled = false, so a brand-new FreshTrack consignor never auto-appears.
--
-- SEED: the two pilot groups the ask names — "L & R Collins" (LRCOL + LRCLA + LRCTU) and
--   "Mac Farms" (MACKF + MACBO/MACGT/MACMR/MACRR/MACSD) — resolved BY GROWER CODE + the 0058
--   parent hierarchy, never by uuid constant. Everything else stays false until an admin
--   activates it. Fully reversible through the RPC.
--
-- Posture: NO change to the 7 grower relations, no RLS/policy change on any existing object,
--   no new grant to anon. The new table is a new posture class `staff-readable` (registered in
--   scripts/rls_posture.ts — a new relation MUST be registered or the sweep fails).
--
-- ⚠ RESIDUAL (recorded by adversarial review 2026-07-21, NOT reachable today): the Hub MCP's
--   run_select keyword guard scans for `\bset\b`, which does NOT match `set_grower_portal_enabled`
--   (underscore is a word character), so that string survives the guard. It is inert because an
--   MCP caller's claims are the app_metadata shape with NO Auth0 `iss` → auth0_is_admin() is
--   false → 42501, and the MCP always rolls back. It would only matter if the MCP ever carried
--   an Auth0-issued token — the same class of invariant as 0050's FUTURE-ISSUER rule. Hardening
--   the MCP guard against definer/function calls is tracked separately (not this migration's
--   surface); if the MCP gains an Auth0 identity path, harden the guard IN THAT CHANGE.
-- Proof: npm run portal:verify (F9) · npm run auth0:rls (S6/T4 admin sections) · rls:posture.

-- ── Activation store (survives every dim rebuild; carries the audit trail) ─────────────────────
create table if not exists core.portal_grower_activation (
  consignor_id uuid primary key
    references core.dim_grower (consignor_id),   -- unknown consignors cannot be activated
  enabled      boolean     not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   text                                -- JWT sub of the admin who last set it
);

comment on table core.portal_grower_activation is
  'Portal activation per consignor (0059). Curated by internal admins via semantic.set_grower_portal_enabled(); read through semantic.grower_directory.portal_enabled. SEPARATE from core.dim_grower deliberately — dim_grower is rebuilt by refresh_dim_grower() and curated state on a rebuilt dim gets silently reset (the dim_gp_charge.revenue_class lesson). Absence of a row = not activated.';
comment on column core.portal_grower_activation.updated_by is
  'request.jwt.claims->>sub of the admin who last toggled this row (audit trail; null for the 0059 seed).';

alter table core.portal_grower_activation enable row level security;
grant select on core.portal_grower_activation to authenticated, cube_readonly;

-- Read = staff (the directory audience). WRITES are NOT policy-granted to any JWT role: they
-- happen only inside the SECURITY DEFINER RPC below, which runs as owner and enforces admin.
drop policy if exists staff_read_activation on core.portal_grower_activation;
create policy staff_read_activation on core.portal_grower_activation
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists cube_readonly_read_all on core.portal_grower_activation;
create policy cube_readonly_read_all on core.portal_grower_activation
  for select to cube_readonly using (true);

-- ── Admin claim helper — issuer-pinned, strict enum, fail-closed (the 0056/0057 idiom) ────────
create or replace function semantic.auth0_is_admin() returns boolean
language plpgsql stable set search_path = '' as $func$
declare
  raw_claims text;
  claims     jsonb;
  ns         text;
  v          jsonb;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then
    return false;                           -- no claims → not admin (fail closed)
  end if;

  begin
    claims := raw_claims::jsonb;
  exception when others then
    return false;                           -- malformed claims JSON → not admin
  end;

  -- Trust boundary (0057): issuer → claim namespace, exact match incl. trailing slash. Each
  -- issuer's claims count ONLY under its own namespace; any other/missing issuer → false.
  -- (hub_role is minted only by the mackaysmarketing tenant Action today; honoring the old
  -- namespace too keeps ONE resolution idiom across all five helpers — 0060 collapses them.)
  ns := case claims ->> 'iss'
          when 'https://grower-portal.au.auth0.com/'    then 'https://grower-portal.mackays.com.au'
          when 'https://mackaysmarketing.au.auth0.com/' then 'https://mackaysmarketing.com.au'
          else null
        end;
  if ns is null then
    return false;
  end if;

  -- STRICT: a JSON *string* exactly 'admin' or 'hub_admin'. Arrays, booleans, objects, other
  -- roles (staff / grower_admin / grower), and absence are all NOT admin.
  v := claims -> (ns || '/hub_role');
  return v is not null
     and jsonb_typeof(v) = 'string'
     and (v #>> '{}') in ('admin', 'hub_admin');
end $func$;

comment on function semantic.auth0_is_admin() is
  'True only for an Auth0 token (recognized tenant, own namespace) whose /hub_role claim is the JSON string admin or hub_admin. Strict, issuer-pinned, fail-closed. Gates semantic.set_grower_portal_enabled() ONLY — it opens no data surface (staff/grower row scope is unchanged). Contract: docs/grower-portal-activation-response.md + migration 0059.';

revoke execute on function semantic.auth0_is_admin() from public;
grant execute on function semantic.auth0_is_admin() to authenticated;

-- ── The RPC — admin-gated, atomic, idempotent, no dynamic SQL ─────────────────────────────────
create or replace function semantic.set_grower_portal_enabled(
  p_consignor_ids uuid[],
  p_enabled       boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $func$
declare
  ids     uuid[];
  unknown uuid[];
  actor   text;
begin
  -- (1) AUTHORIZATION FIRST — admin only. Staff (MM Users), growers, no-claim and wrong-issuer
  -- callers all land here. 42501 = insufficient_privilege (PostgREST → 403).
  if not semantic.auth0_is_admin() then
    raise exception 'not authorised: semantic.set_grower_portal_enabled requires hub_role admin or hub_admin'
      using errcode = '42501';
  end if;

  -- (2) Argument validation — explicit, never silently coerced.
  if p_enabled is null then
    raise exception 'p_enabled must be true or false, not null' using errcode = '22004';
  end if;

  -- Null array → empty; null elements dropped; duplicates collapsed (idempotent by construction).
  select coalesce(array_agg(distinct e), '{}'::uuid[])
    into ids
    from unnest(coalesce(p_consignor_ids, '{}'::uuid[])) as e
   where e is not null;

  if array_length(ids, 1) is null then
    return;                                 -- nothing asked for → nothing done (no-op, not an error)
  end if;

  -- (3) Surface unknown consignors LOUDLY rather than silently dropping them (SPEC ethos);
  -- the FK is the backstop, this is the readable error. Whole call is one transaction: all or none.
  select coalesce(array_agg(i), '{}'::uuid[])
    into unknown
    from unnest(ids) as i
   where not exists (select 1 from core.dim_grower g where g.consignor_id = i);

  if array_length(unknown, 1) is not null then
    raise exception 'unknown consignor_id(s): %', unknown using errcode = '23503';
  end if;

  -- (4) Audit actor: the caller's JWT subject (never trusted for authorization — only recorded).
  begin
    actor := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '');
  exception when others then
    actor := null;
  end;

  -- (5) Upsert. Re-setting the same value still refreshes the audit stamp (harmless, and keeps
  -- "who last confirmed this" honest); the enabled value itself is idempotent.
  insert into core.portal_grower_activation (consignor_id, enabled, updated_at, updated_by)
  select i, p_enabled, now(), actor from unnest(ids) as i
  on conflict (consignor_id) do update set
    enabled    = excluded.enabled,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;
end $func$;

comment on function semantic.set_grower_portal_enabled(uuid[], boolean) is
  'Activate/deactivate growers on the portal (0059). SECURITY DEFINER (writes core.portal_grower_activation, which no JWT role may write directly) gated on semantic.auth0_is_admin() — hub_role admin/hub_admin ONLY; staff/growers/no-claim are refused 42501. Atomic over the whole array (unknown consignor_id → 23503, nothing applied), idempotent, no dynamic SQL, search_path pinned empty.';

-- Functions grant EXECUTE to PUBLIC by default — for a SECURITY DEFINER write path that would
-- expose it to anon. Revoke, then grant to authenticated only (the RPC still enforces admin).
revoke execute on function semantic.set_grower_portal_enabled(uuid[], boolean) from public;
grant execute on function semantic.set_grower_portal_enabled(uuid[], boolean) to authenticated;

-- ── Directory v3: + portal_enabled (same rows, same staff-only gate) ──────────────────────────
create or replace view semantic.grower_directory
  with (security_invoker = true) as
select
  g.consignor_id,
  g.org_name as consignor_name,
  g.code     as farm_code,
  g.is_active,
  g.entity_id,
  g.parent_entity_id,
  g.parent_name,
  coalesce(a.enabled, false) as portal_enabled   -- absence = never activated = false
from core.dim_grower g
left join core.portal_grower_activation a on a.consignor_id = g.consignor_id
where semantic.auth0_is_staff()             -- explicit gate: growers (and mm-hub tokens) get 0 rows
  and g.is_grower is true
  and coalesce(g.is_test, false) = false;   -- *TEST consignors never listed (SPEC §9.4)

comment on view semantic.grower_directory is
  'Staff-only grower list for the portal (0056; v2 hierarchy 0058; v3 activation 0059). Per consignor: consignor_id, consignor_name, farm_code, is_active, entity_id/parent_entity_id/parent_name (FreshTrack parent hierarchy — portal groups by immediate parent), portal_enabled (admin-curated activation; false when never activated). Explicit auth0_is_staff() WHERE gate — grower/mm-hub/Cube/MCP contexts get 0 rows. Toggle via semantic.set_grower_portal_enabled() (admin-gated).';

-- ── Seed the two pilot groups the ask names (by CODE + 0058 hierarchy, never by uuid) ─────────
-- updated_by stays null = "seeded by migration 0059", distinguishable from admin action.
-- ⚠ DO NOTHING, deliberately (adversarial review, 2026-07-21): with DO UPDATE, re-running this
-- migration over a live database would REVERT an admin's considered deactivation of a pilot
-- group and re-stamp updated_at while leaving that admin's sub in updated_by — i.e. silently
-- undo curation and misattribute the undo. DO NOTHING makes the seed a first-run-only default:
-- a fresh database gets the pilots enabled, an existing one keeps whatever admins decided.
-- (The prod run of this migration inserted all 9 rows on an empty table, so this correction is
-- re-run safety only — the applied state is byte-identical to what this form produces.)
insert into core.portal_grower_activation (consignor_id, enabled, updated_at, updated_by)
with anchors as (
  select consignor_id, entity_id from core.dim_grower where code in ('LRCOL', 'MACKF')
)
select g.consignor_id, true, now(), null
from core.dim_grower g
where g.is_grower is true
  and coalesce(g.is_test, false) = false
  and (g.consignor_id in (select consignor_id from anchors)          -- the parents themselves
    or g.parent_entity_id in (select entity_id from anchors))        -- their farms
on conflict (consignor_id) do nothing;
