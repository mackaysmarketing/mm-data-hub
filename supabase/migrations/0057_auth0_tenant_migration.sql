-- 0057_auth0_tenant_migration — accept the NEW Auth0 tenant `mackaysmarketing` beside the old
-- `grower-portal` tenant during cutover. ADDITIVE-ONLY; both issuers fail closed independently.
--
-- WHY: Tim is retiring the grower-portal tenant NAME (2026-07-20): Auth0 tenants cannot be
--   renamed, so a properly-named production tenant `mackaysmarketing` (AU) was created and
--   everything moves to it — growers, portal staff, and (Phase B) the internal staff hub. The
--   claim NAMESPACE is renamed in the same move (the one cheap moment): the old namespace rode
--   the old tenant's name; the new tenant mints claims under the company domain.
--   Cutover runbook: docs/auth0-tenant-cutover.md · scope: docs/auth0-unified-auth-scope.md.
--
-- ISSUER → NAMESPACE MAP (each issuer's claims are honored ONLY under its OWN namespace —
-- cross-namespace claims are inert, proven in the T sections of auth0:rls):
--   https://grower-portal.au.auth0.com/     →  https://grower-portal.mackays.com.au      (old)
--   https://mackaysmarketing.au.auth0.com/  →  https://mackaysmarketing.com.au           (new)
--   anything else                           →  fail closed (empty set / false)
--
-- ⚠ FUTURE-ISSUER INVARIANT (0050) — THIS MIGRATION IS THE COMPLIANCE CASE: enabling a second
--   third-party issuer on the project REQUIRES extending the app_metadata deny guards to it in
--   the same change. Both guards below now refuse app_metadata under EITHER Auth0 issuer. The
--   invariant itself stands for any FUTURE issuer beyond these two.
--
-- ORDERING: this migration lands BEFORE the mackaysmarketing tenant is enabled in Supabase
--   third-party auth. Until Supabase accepts its tokens, the new branches are unreachable; once
--   it does, the guards are already live. No window exists where a new-tenant token could
--   assert app_metadata.
--
-- CLEANUP (0058, after cutover): when the portal is live on the new tenant and grower-portal is
--   removed from Supabase third-party auth, drop the old issuer+namespace from all four
--   functions and from the proof constants. Until then both paths stay proven.
--
-- Scope: function bodies only — NO policy, grant, or view changes (policies call these helpers).
-- Proof: npm run auth0:rls (T sections: new-issuer identity/staff/guards/parity + cross-
-- namespace forgeries; B/S sections re-prove the old path unchanged) · rls:posture · rls:multifarm.

-- ── auth0_consignor_ids(): issuer-resolved namespace, same 0050 parse rigor ──────────────────
create or replace function semantic.auth0_consignor_ids() returns uuid[]
language plpgsql stable set search_path = '' as $func$
declare
  raw_claims text;
  claims     jsonb;
  ns         text;
  arr        jsonb;
  elem       text;
  result     uuid[] := '{}';
  v          uuid;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then
    return '{}'::uuid[];                    -- no claims → empty set (fail closed)
  end if;

  -- Parse the claims JSON; malformed JSON → empty set, never a 22P02 that aborts the query.
  begin
    claims := raw_claims::jsonb;
  exception when others then
    return '{}'::uuid[];
  end;

  -- Trust boundary (0057): issuer → claim namespace. Exact match incl. the trailing slash
  -- Auth0 always emits; each issuer's claims count ONLY under its own namespace; any other or
  -- missing issuer → empty set.
  ns := case claims ->> 'iss'
          when 'https://grower-portal.au.auth0.com/'    then 'https://grower-portal.mackays.com.au'
          when 'https://mackaysmarketing.au.auth0.com/' then 'https://mackaysmarketing.com.au'
          else null
        end;
  if ns is null then
    return '{}'::uuid[];
  end if;

  -- The consignor set: a JSON array of uuid strings, ARRAY-ONLY (anything else fails closed).
  arr := claims -> (ns || '/consignor_ids');
  if arr is null or jsonb_typeof(arr) <> 'array' then
    return '{}'::uuid[];
  end if;
  for elem in select jsonb_array_elements_text(arr) loop
    begin
      v := nullif(elem, '')::uuid;          -- malformed element → skipped (fail closed for it)
    exception when others then
      v := null;
    end;
    if v is not null and not (v = any(result)) then
      result := result || v;                -- de-duplicated
    end if;
  end loop;

  return result;                            -- may be empty (absent/all-malformed) → 0 grower rows
end $func$;

comment on function semantic.auth0_consignor_ids() is
  'Grower consignor SET from the Auth0 consignor_ids claim, namespace resolved by issuer (0057): grower-portal tenant → grower-portal.mackays.com.au namespace; mackaysmarketing tenant → mackaysmarketing.com.au namespace; cross-namespace/off-issuer → empty. Array-only, per-element uuid-validated, de-duplicated, fail-closed. Cutover: docs/auth0-tenant-cutover.md.';

-- ── auth0_is_staff(): same dual-issuer resolution, strict boolean-true (0056 rigor) ──────────
create or replace function semantic.auth0_is_staff() returns boolean
language plpgsql stable set search_path = '' as $func$
declare
  raw_claims text;
  claims     jsonb;
  ns         text;
  v          jsonb;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then
    return false;                           -- no claims → not staff (fail closed)
  end if;

  begin
    claims := raw_claims::jsonb;
  exception when others then
    return false;
  end;

  -- Trust boundary (0057): issuer → claim namespace, exact match; see auth0_consignor_ids().
  ns := case claims ->> 'iss'
          when 'https://grower-portal.au.auth0.com/'    then 'https://grower-portal.mackays.com.au'
          when 'https://mackaysmarketing.au.auth0.com/' then 'https://mackaysmarketing.com.au'
          else null
        end;
  if ns is null then
    return false;
  end if;

  -- STRICT literal boolean true (0056 contract: absence is the negative; anything else is
  -- malformed → false).
  v := claims -> (ns || '/staff');
  return v is not null and jsonb_typeof(v) = 'boolean' and v = 'true'::jsonb;
end $func$;

comment on function semantic.auth0_is_staff() is
  'True only for an Auth0 token (either recognized tenant, 0057) whose OWN-namespace /staff claim is JSON boolean true. Strict, fail-closed. Opens the grower-scoped surface + semantic.grower_directory ONLY — never internal-only relations. Contract: docs/grower-portal-staff-access-response.md + migrations 0056/0057.';

-- ── Trust-partition deny guards: refuse app_metadata under EITHER Auth0 issuer ───────────────
-- Verbatim 0050 bodies with the single-issuer equality widened to the two-issuer set.
create or replace function semantic.current_consignor_ids() returns uuid[]
language plpgsql stable set search_path = '' as $func$
declare
  raw_claims text;
  claims     jsonb;
  am         jsonb;
  arr        jsonb;
  elem       text;
  single     text;
  result     uuid[] := '{}';
  v          uuid;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then
    return '{}'::uuid[];                    -- no claim → empty set (fail closed)
  end if;

  -- Parse the claims JSON; malformed JSON → empty set, never a 22P02 that aborts the query.
  begin
    claims := raw_claims::jsonb;
  exception when others then
    return '{}'::uuid[];
  end;

  -- 0050/0057 deny guard: an Auth0-issued token (either tenant) is a GROWER-or-STAFF identity
  -- only; its app_metadata is NOT the mm-hub server-controlled namespace and is never honored
  -- here. Auth0 identity flows ONLY through the auth0_* helpers.
  if (claims ->> 'iss') in ('https://grower-portal.au.auth0.com/',
                            'https://mackaysmarketing.au.auth0.com/') then
    return '{}'::uuid[];
  end if;

  am := claims -> 'app_metadata';           -- app_metadata ONLY (never top-level / user_metadata)
  if am is null or jsonb_typeof(am) <> 'object' then
    return '{}'::uuid[];
  end if;

  -- (1) Multi-farm: app_metadata.consignor_ids as a JSON array of uuid strings.
  arr := am -> 'consignor_ids';
  if arr is not null and jsonb_typeof(arr) = 'array' then
    for elem in select jsonb_array_elements_text(arr) loop
      begin
        v := nullif(elem, '')::uuid;        -- malformed element → skipped (fail closed for it)
      exception when others then
        v := null;
      end;
      if v is not null and not (v = any(result)) then
        result := result || v;
      end if;
    end loop;
  end if;

  -- (2) Backward-compat: a scalar app_metadata.consignor_id folds into the SET (de-duplicated).
  single := nullif(am ->> 'consignor_id', '');
  if single is not null then
    begin
      v := single::uuid;
    exception when others then
      v := null;
    end;
    if v is not null and not (v = any(result)) then
      result := result || v;
    end if;
  end if;

  return result;                            -- may be empty (all-malformed / absent) → 0 grower rows
end $func$;

comment on function semantic.current_consignor_ids() is
  'Grower consignor SET from app_metadata: union of consignor_ids[] (multi-farm) + scalar consignor_id (legacy). app_metadata-only, de-duplicated, fail-closed. 0050/0057: refuses app_metadata on ANY Auth0-issued token (grower-portal OR mackaysmarketing tenant) — Auth0 identity flows only through the auth0_* helpers.';

-- Verbatim 0050 body with the widened guard. Deliberately NO exception block around the ::jsonb
-- parse (0010 contract: PostgREST always sets valid JSON; a handler would add a per-row
-- subtransaction to policy-qual evaluation).
create or replace function semantic.is_internal_claim() returns boolean
language plpgsql stable set search_path = '' as $func$
declare raw_claims text; claims jsonb; val text;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then return false; end if;
  claims := raw_claims::jsonb;              -- malformed JSON errors exactly as 0010 (no handler)
  -- 0050/0057 deny guard: is_internal can NEVER be asserted from an Auth0-issued token (either
  -- tenant) — internal remains an mm-hub-issuer/service-context assertion.
  if (claims ->> 'iss') in ('https://grower-portal.au.auth0.com/',
                            'https://mackaysmarketing.au.auth0.com/') then
    return false;
  end if;
  val := lower(nullif(claims -> 'app_metadata' ->> 'is_internal', ''));
  return val in ('true', 't', '1', 'yes');   -- only explicit truthy app_metadata flag; else false
end $func$;

comment on function semantic.is_internal_claim() is
  'True only when app_metadata.is_internal is truthy (server-controlled; grower cannot self-assert). 0050/0057: always false on ANY Auth0-issued token (grower-portal OR mackaysmarketing tenant) — internal is an mm-hub/service-context-only assertion.';
