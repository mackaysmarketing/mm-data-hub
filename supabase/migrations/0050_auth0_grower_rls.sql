-- 0050_auth0_grower_rls — accept grower-portal (Auth0) JWTs for grower reads. ADDITIVE-ONLY.
--
-- WHY: grower-portal (the grower-facing UI rebuild, separate repo) authenticates growers with
--   Auth0 on the dedicated tenant `grower-portal` (AU region) and reads the hub through
--   Supabase's REST surface with the anon/publishable key — RLS is the entire security
--   boundary. Supabase third-party auth (enabled at the project level) verifies each Auth0
--   JWT's RS256 signature against the tenant JWKS before PostgREST exposes its claims as
--   request.jwt.claims. This migration teaches grower RLS to scope those tokens.
--   Tenant facts + coordination contract: docs/mm-hub-auth0-integration.md.
--
-- IDENTITY: an Auth0 token carries the grower's consignor SET as a NAMESPACED TOP-LEVEL claim
--     https://grower-portal.mackays.com.au/consignor_ids     (JSON array of uuid strings)
--   set server-side by the tenant's post-login Action from Auth0 app_metadata. An end user
--   cannot mint or alter it: only the tenant Action writes that namespace, and the token
--   signature is verified upstream. The claim is honored ONLY when the token's iss is exactly
--   'https://grower-portal.au.auth0.com/' — under any other issuer (including mm-hub Supabase
--   tokens, Cube/MCP synthetic contexts, and any future signer) the helper returns the empty
--   set, so this claim can never widen a non-Auth0 caller.
--
-- ADDITIVE CONTRACT:
--   * The 0008/0010/0026 mm-hub grower policies are UNTOUCHED. The new auth0_grower_own_*
--     policies are ADDITIONAL permissive policies on exactly the six grower-scoped relations
--     (the 0026 set). Permissive policies OR together: for an mm-hub token the new qual is
--     FALSE (no Auth0 iss), for an Auth0 token the old qual is FALSE (no app_metadata) —
--     each identity path is scoped by its own policy, and both fail closed.
--   * NO internal branch on the new policies: grower-portal is grower-only. is_internal stays
--     an mm-hub app_metadata-only assertion.
--
-- TRUST PARTITION (the one change to the existing helpers — a pure DENY guard):
--   Once third-party auth is on, request.jwt.claims can come from an Auth0-signed token, and
--   the 0010/0026 helpers would honor an `app_metadata` object inside it — so a misconfigured
--   or compromised tenant Action could assert is_internal=true and OR past ALL tenant scoping.
--   Fix: current_consignor_ids() and is_internal_claim() now REFUSE app_metadata claims when
--   iss is the Auth0 issuer (fail closed). Every existing context (mm-hub Supabase tokens,
--   Cube, Hub MCP, proof harnesses — none of which carry the Auth0 iss) behaves byte-
--   identically: current_consignor_ids() is the verbatim 0026 body + the guard, and
--   is_internal_claim() is the verbatim 0010 body + the guard (same parse structure, NO new
--   exception block — a malformed-JSON claims string still errors exactly as 0010 did, and no
--   per-row subtransaction cost is added to the policy quals that call it).
--   Net effect: each issuer's claims flow ONLY through its own helper — a tenant compromise
--   can at worst widen GROWER scope via its own claim (never internal), modulo the
--   platform-level role-claim residual documented in CLAUDE.md.
--
-- ⚠ FUTURE-ISSUER INVARIANT: these guards deny ONLY the grower-portal issuer. Enabling ANY
--   additional third-party issuer on this Supabase project (another tenant, Clerk, Firebase…)
--   re-opens the app_metadata path for THAT issuer — extending the deny guards (or inverting
--   them to an issuer allow-list) is REQUIRED in the same change. Recorded in CLAUDE.md.
--
-- Scope: raw/core/semantic only (this repo's schemas). No public/auth/storage DDL.
-- Proof: npm run auth0:rls (self-deriving) · rls:multifarm · rls:posture unchanged-green.

-- ── New claim helper: the Auth0 (grower-portal) consignor SET — issuer-pinned, fail-closed ────
create or replace function semantic.auth0_consignor_ids() returns uuid[]
language plpgsql stable set search_path = '' as $func$
declare
  raw_claims text;
  claims     jsonb;
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

  -- Trust boundary: the namespaced claim counts ONLY on a grower-portal Auth0 token, whose
  -- signature Supabase third-party auth verified against the tenant JWKS. Any other issuer
  -- (or a missing iss) → empty set. Exact match incl. the trailing slash Auth0 always emits.
  if (claims ->> 'iss') is null
     or (claims ->> 'iss') <> 'https://grower-portal.au.auth0.com/' then
    return '{}'::uuid[];
  end if;

  -- The consignor set: a JSON array of uuid strings, ARRAY-ONLY (no scalar form exists in the
  -- grower-portal contract — anything else is malformed and fails closed).
  arr := claims -> 'https://grower-portal.mackays.com.au/consignor_ids';
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
  'Grower consignor SET from the grower-portal Auth0 claim https://grower-portal.mackays.com.au/consignor_ids. Honored ONLY when iss = https://grower-portal.au.auth0.com/ (third-party auth verifies the signature). Array-only, per-element uuid-validated, de-duplicated, fail-closed (empty on missing/malformed/wrong-issuer). Contract: docs/mm-hub-auth0-integration.md + migration 0050.';

-- Only `authenticated` evaluates the new policies (hub_mcp SET ROLEs into it; cube_readonly has
-- its own read-all policies and never runs authenticated quals) — so that is the only grant.
-- Functions default EXECUTE to PUBLIC; revoke it so the stated grant boundary is real.
revoke execute on function semantic.auth0_consignor_ids() from public;
grant execute on function semantic.auth0_consignor_ids() to authenticated;

-- ── Trust partition: mm-hub helpers refuse app_metadata on an Auth0-issued token ──────────────
-- Verbatim 0026 body + ONE deny guard (Auth0 iss → fail closed). See TRUST PARTITION above.
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

  -- 0050 deny guard: an Auth0-issued (grower-portal) token is a GROWER identity only; its
  -- app_metadata (if a tenant Action ever emitted one) is NOT the mm-hub server-controlled
  -- namespace and must never be honored here. Auth0 identity flows ONLY through
  -- semantic.auth0_consignor_ids(). No existing mm-hub/Cube/MCP context carries this iss.
  if (claims ->> 'iss') = 'https://grower-portal.au.auth0.com/' then
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
  'Grower consignor SET from app_metadata: union of consignor_ids[] (multi-farm) + scalar consignor_id (legacy). app_metadata-only, de-duplicated, fail-closed (empty on missing/malformed). 0050: refuses app_metadata on an Auth0-issued (grower-portal) token — that identity flows only through semantic.auth0_consignor_ids().';

-- Verbatim 0010 body + ONE deny guard. Deliberately NO exception block around the ::jsonb
-- parse: 0010 had none (malformed claims JSON errors exactly as before — PostgREST always sets
-- valid JSON), and an EXCEPTION clause would add a per-call subtransaction to a function the
-- grower policy quals evaluate PER ROW.
create or replace function semantic.is_internal_claim() returns boolean
language plpgsql stable set search_path = '' as $func$
declare raw_claims text; claims jsonb; val text;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or raw_claims = '' then return false; end if;
  claims := raw_claims::jsonb;              -- malformed JSON errors exactly as 0010 (no handler)
  -- 0050 deny guard: is_internal can NEVER be asserted from an Auth0-issued (grower-portal)
  -- token — the tenant is grower-only. Without this, a misconfigured/compromised tenant Action
  -- emitting app_metadata.is_internal would OR past ALL tenant scoping (see 0050 header).
  if (claims ->> 'iss') = 'https://grower-portal.au.auth0.com/' then
    return false;
  end if;
  val := lower(nullif(claims -> 'app_metadata' ->> 'is_internal', ''));
  return val in ('true', 't', '1', 'yes');   -- only explicit truthy app_metadata flag; else false
end $func$;

comment on function semantic.is_internal_claim() is
  'True only when app_metadata.is_internal is truthy (server-controlled; grower cannot self-assert). 0050: always false on an Auth0-issued (grower-portal) token — internal is an mm-hub-issuer-only assertion.';

-- ── ADDITIVE Auth0 grower policies on exactly the six grower-scoped relations (0026 set) ──────
-- Named auth0_grower_own_* (NOT grower_own_*: rls_multi_farm_proof pins exactly 6 of those).
-- No is_internal branch — internal access already ORs in via the untouched grower_own_* policies.

-- Dispatch loads (raw) — anchor = the load's consignor (SPEC §9.1).
drop policy if exists auth0_grower_own_loads on raw.ft_dispatch_load;
create policy auth0_grower_own_loads on raw.ft_dispatch_load
  for select to authenticated
  using (consignor_id = any(semantic.auth0_consignor_ids()));

-- Pallets (raw) — scoped through their load's consignor (the 0008/0026 subquery shape).
drop policy if exists auth0_grower_own_pallets on raw.ft_pallet;
create policy auth0_grower_own_pallets on raw.ft_pallet
  for select to authenticated
  using (
    dispatch_load_id in (
      select id from raw.ft_dispatch_load
      where consignor_id = any(semantic.auth0_consignor_ids())
    )
  );

-- Grower dim (core).
drop policy if exists auth0_grower_own_dim on core.dim_grower;
create policy auth0_grower_own_dim on core.dim_grower
  for select to authenticated
  using (consignor_id = any(semantic.auth0_consignor_ids()));

-- NetSuite settlement fact (core).
drop policy if exists auth0_grower_own_settlement on core.fact_settlement_bill;
create policy auth0_grower_own_settlement on core.fact_settlement_bill
  for select to authenticated
  using (consignor_id = any(semantic.auth0_consignor_ids()));

-- GP settlement — schedule grain (core).
drop policy if exists auth0_grower_own_gp_settlement on core.fact_gp_settlement;
create policy auth0_grower_own_gp_settlement on core.fact_gp_settlement
  for select to authenticated
  using (consignor_id = any(semantic.auth0_consignor_ids()));

-- GP settlement — load grain (core); anchor = the SCHEDULE consignor carried into the fact.
drop policy if exists auth0_grower_own_gp_settlement_load on core.fact_gp_settlement_load;
create policy auth0_grower_own_gp_settlement_load on core.fact_gp_settlement_load
  for select to authenticated
  using (consignor_id = any(semantic.auth0_consignor_ids()));
