-- 0056_auth0_staff_rls — Mackays STAFF read access via the grower-portal Auth0 tenant. ADDITIVE-ONLY.
--
-- WHY: grower-portal's admin phase (staff experience + grower onboarding) needs staff logins
--   (e.g. tim@mackaysmarketing.com.au) to read EVERY grower's portal data plus a grower list for
--   the selection modal. Contract agreed in docs/grower-portal-staff-access-response.md; Tim
--   signed off 2026-07-18 (direction: all user auth moves to Auth0, growers AND staff).
--
-- IDENTITY: one new claim in the existing namespace, minted by the same post-login Action:
--     https://grower-portal.mackays.com.au/staff = true    (boolean literal)
--   from Auth0 app_metadata.mm_staff === true (tenant-admin-controlled; users cannot write their
--   own app_metadata). ABSENCE IS THE NEGATIVE — never `false`. Parsed STRICTLY here: honored
--   only under iss = https://grower-portal.au.auth0.com/ (exact, trailing slash) AND JSON type
--   boolean AND value true. String "true", 1, false, nested, wrong/missing iss → not staff.
--
-- ADDITIVE CONTRACT (the 0050 pattern, third permissive policy per relation):
--   * auth0_staff_read_* policies on exactly the 7 grower-scoped relations (0026 six + 0054
--     fact_load_sale), qual = semantic.auth0_is_staff() alone. The grower_own_* (mm-hub) and
--     auth0_grower_own_* (0050/0054) policies are UNTOUCHED — grower access is bit-for-bit
--     identical before and after, by construction. Permissive policies OR; staff+grower claims
--     coexisting on one token compose naturally.
--   * STAFF ≠ INTERNAL. This claim opens the GROWER-SCOPED surface + the directory below and
--     NOTHING else: internal-only relations (customer book, AR, orders, scan, insight) never
--     reference auth0_is_staff() and stay closed to every Auth0 token. is_internal remains an
--     mm-hub-issuer-only assertion; the 0050 trust-partition deny guards are untouched.
--
-- POSTURE CHANGE (Tim-approved, amending 0050's "Auth0 tokens are grower-only"): Auth0 tokens
--   are now grower-OR-STAFF. A rogue/compromised Auth0 tenant admin flipping mm_staff grants
--   read of the whole grower-scoped surface + grower enumeration (never internal data). The
--   Auth0 dashboard is the control point by design — keep its admin set small, MFA'd, and
--   review tenant logs for app_metadata changes.
--
-- ⚠ FUTURE-ISSUER INVARIANT (0050) unchanged: auth0_is_staff() is issuer-pinned like its
--   siblings; enabling any additional third-party issuer still requires extending the deny
--   guards in the same change.
--
-- semantic.grower_directory — the staff-only grower list (selection modal / onboarding):
--   security_invoker over core.dim_grower with an EXPLICIT auth0_is_staff() WHERE gate (the
--   0035 recon_settlement_source pattern). The gate is REQUIRED on top of RLS: without it a
--   grower token would see its OWN dim_grower row through the view — the contract says growers
--   get ZERO rows. Gate is staff-claim-only (deliberate: mm-hub internal tokens read dim_grower
--   directly and get 0 here — asserted in the proof, not an accident). Baked-in filters:
--   is_grower, non-test (SPEC §9.4 — *TEST consignors must never appear in an onboarding list).
--
-- Scope: raw/core/semantic only. No public/auth/storage DDL. No ordering hazard with the portal
-- Action deploy (claim ignored until honored; predicate inert until a token carries it) — but
-- this migration lands together with the rls_posture/auth0_rls_proof pinned-set updates and is
-- applied before the standing suite runs (the 0050 rule).
-- Proof: npm run auth0:rls (staff sections) · rls:multifarm · rls:posture.

-- ── Staff claim helper — issuer-pinned, strict-boolean, fail-closed ───────────────────────────
create or replace function semantic.auth0_is_staff() returns boolean
language plpgsql stable set search_path = '' as $func$
declare
  raw_claims text;
  claims     jsonb;
  v          jsonb;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then
    return false;                           -- no claims → not staff (fail closed)
  end if;

  -- Parse the claims JSON; malformed JSON → false, never a parse error that aborts the query.
  begin
    claims := raw_claims::jsonb;
  exception when others then
    return false;
  end;

  -- Trust boundary: the namespaced claim counts ONLY on a grower-portal Auth0 token (signature
  -- verified upstream by third-party auth). Any other/missing issuer → false. Exact match incl.
  -- the trailing slash Auth0 always emits.
  if (claims ->> 'iss') is null
     or (claims ->> 'iss') <> 'https://grower-portal.au.auth0.com/' then
    return false;
  end if;

  -- STRICT literal boolean true — the contract says absence is the negative and the Action only
  -- ever emits `true`. A string "true", number, false, array, or object is malformed → false.
  v := claims -> 'https://grower-portal.mackays.com.au/staff';
  return v is not null and jsonb_typeof(v) = 'boolean' and v = 'true'::jsonb;
end $func$;

comment on function semantic.auth0_is_staff() is
  'True only for a grower-portal Auth0 token (iss pinned exactly) whose namespaced claim https://grower-portal.mackays.com.au/staff is JSON boolean true. Strict, fail-closed (false on missing/malformed/wrong-issuer/non-boolean). Opens the grower-scoped surface + semantic.grower_directory ONLY — never internal-only relations. Contract: docs/grower-portal-staff-access-response.md + migration 0056.';

-- authenticated evaluates the policies and the directory gate; cube_readonly needs EXECUTE only
-- because semantic.grower_directory embeds the gate and carries the standard invoker-view cube
-- grant (under every Cube context the helper returns false → 0 rows, fail closed).
revoke execute on function semantic.auth0_is_staff() from public;
grant execute on function semantic.auth0_is_staff() to authenticated, cube_readonly;

-- ── ADDITIVE staff policies on exactly the 7 grower-scoped relations ──────────────────────────
-- Named auth0_staff_read_* (NOT grower_own_* / auth0_grower_own_*: rls_multifarm and auth0:rls
-- hard-pin those two sets; this is the third pinned set).

drop policy if exists auth0_staff_read_loads on raw.ft_dispatch_load;
create policy auth0_staff_read_loads on raw.ft_dispatch_load
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists auth0_staff_read_pallets on raw.ft_pallet;
create policy auth0_staff_read_pallets on raw.ft_pallet
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists auth0_staff_read_dim on core.dim_grower;
create policy auth0_staff_read_dim on core.dim_grower
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists auth0_staff_read_settlement on core.fact_settlement_bill;
create policy auth0_staff_read_settlement on core.fact_settlement_bill
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists auth0_staff_read_gp_settlement on core.fact_gp_settlement;
create policy auth0_staff_read_gp_settlement on core.fact_gp_settlement
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists auth0_staff_read_gp_settlement_load on core.fact_gp_settlement_load;
create policy auth0_staff_read_gp_settlement_load on core.fact_gp_settlement_load
  for select to authenticated using (semantic.auth0_is_staff());

drop policy if exists auth0_staff_read_load_sale on core.fact_load_sale;
create policy auth0_staff_read_load_sale on core.fact_load_sale
  for select to authenticated using (semantic.auth0_is_staff());

-- ── semantic.grower_directory — staff-only grower list ────────────────────────────────────────
create or replace view semantic.grower_directory
  with (security_invoker = true) as
select
  g.consignor_id,
  g.org_name as consignor_name,
  g.code     as farm_code,
  g.is_active
from core.dim_grower g
where semantic.auth0_is_staff()             -- explicit gate: growers (and mm-hub tokens) get 0 rows
  and g.is_grower is true
  and coalesce(g.is_test, false) = false;   -- *TEST consignors never listed (SPEC §9.4)

comment on view semantic.grower_directory is
  'Staff-only grower list for the portal''s selection modal / onboarding (0056). One row per consignor (consignor_id, consignor_name=org_name, farm_code=code, is_active); growers + non-test only. Explicit semantic.auth0_is_staff() WHERE gate (0035 pattern) — grower tokens, mm-hub tokens, Cube, and MCP contexts all get 0 rows; no grouping columns (no grower→consignors grouping exists hub-side — grouping lives in auth metadata).';

grant select on semantic.grower_directory to authenticated, cube_readonly;
