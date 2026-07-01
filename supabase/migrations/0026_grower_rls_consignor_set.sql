-- 0026_grower_rls_consignor_set — switch grower RLS from a SINGLE consignor_id to a SET.
--
-- WHY: a real grower can operate several farms, each landed under its own consignor_id (e.g.
--   L & R Collins = LRCLA Lakeland + LRCTU Tully). One grower login must see ALL of its farms.
--   Until now RLS scoped to exactly one consignor (semantic.current_consignor_id()); this widens
--   the anchor to a SET while keeping every other property of the 0008/0010 contract identical.
--
-- CONTRACT (unchanged from 0010): identity is read ONLY from the SERVER-controlled `app_metadata`
--   namespace — never top-level / user_metadata a grower could self-set. Fail-closed on missing /
--   malformed claims (no error, no rows). is_internal_claim() is untouched.
--
-- BACKWARD-COMPATIBLE: a legacy token carrying only `app_metadata.consignor_id` (a scalar) still
--   works — current_consignor_ids() folds it into a one-element set, so its row counts are IDENTICAL
--   to the pre-0026 single-value policies. New multi-farm tokens carry `app_metadata.consignor_ids`
--   (a JSON array of uuid). Both may be present (transitional): the set is their de-duplicated union.
--
-- SCOPE: touches raw/core/semantic only (this repo's schemas). No public/auth/storage DDL.
--   THIS SPRINT DOES NOT build the group reference table, grants, the grower-admin role, delegated
--   user creation, the subset check, the grant resolver, or any JWT stamping — that is the portal
--   sprint. mm-hub remains responsible for stamping the correct consignor_ids into app_metadata.

-- ── New claim helper: the grower's consignor SET (app_metadata, fail-closed) ──────────────────
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
  'Grower consignor SET from app_metadata: union of consignor_ids[] (multi-farm) + scalar consignor_id (legacy). app_metadata-only, de-duplicated, fail-closed (empty on missing/malformed).';

-- ── current_consignor_id() is now a FIRST-ELEMENT SHIM over the set ───────────────────────────
-- Kept ONLY so any non-policy caller of the scalar helper keeps compiling; NO grower policy
-- references it any more. On a legacy single-consignor token it returns that consignor (element 1);
-- on an empty set it returns NULL — never used to widen scope.
create or replace function semantic.current_consignor_id() returns uuid
language sql stable set search_path = '' as $func$
  select (semantic.current_consignor_ids())[1];   -- 1-based; NULL when the set is empty
$func$;

comment on function semantic.current_consignor_id() is
  'DEPRECATED shim: first element of semantic.current_consignor_ids(). Grower policies use the SET, not this.';

grant execute on function semantic.current_consignor_ids() to authenticated;
grant execute on function semantic.current_consignor_ids() to cube_readonly;

-- ── Rewrite every grower_own_* policy to SET membership (= ANY(...) OR internal) ──────────────
-- Dispatch loads (raw) — anchor = the load's consignor (SPEC §9.1).
drop policy if exists grower_own_loads on raw.ft_dispatch_load;
create policy grower_own_loads on raw.ft_dispatch_load
  for select to authenticated
  using (consignor_id = any(semantic.current_consignor_ids()) or semantic.is_internal_claim());

-- Pallets (raw) — scoped through their load's consignor; subquery now uses the SET too.
drop policy if exists grower_own_pallets on raw.ft_pallet;
create policy grower_own_pallets on raw.ft_pallet
  for select to authenticated
  using (
    semantic.is_internal_claim()
    or dispatch_load_id in (
         select id from raw.ft_dispatch_load
         where consignor_id = any(semantic.current_consignor_ids())
       )
  );

-- Grower dim (core).
drop policy if exists grower_own_dim on core.dim_grower;
create policy grower_own_dim on core.dim_grower
  for select to authenticated
  using (consignor_id = any(semantic.current_consignor_ids()) or semantic.is_internal_claim());

-- NetSuite settlement fact (core).
drop policy if exists grower_own_settlement on core.fact_settlement_bill;
create policy grower_own_settlement on core.fact_settlement_bill
  for select to authenticated
  using (consignor_id = any(semantic.current_consignor_ids()) or semantic.is_internal_claim());

-- GP settlement — schedule grain (core).
drop policy if exists grower_own_gp_settlement on core.fact_gp_settlement;
create policy grower_own_gp_settlement on core.fact_gp_settlement
  for select to authenticated
  using (consignor_id = any(semantic.current_consignor_ids()) or semantic.is_internal_claim());

-- GP settlement — load grain (core); anchor = the SCHEDULE consignor carried into the fact.
drop policy if exists grower_own_gp_settlement_load on core.fact_gp_settlement_load;
create policy grower_own_gp_settlement_load on core.fact_gp_settlement_load
  for select to authenticated
  using (consignor_id = any(semantic.current_consignor_ids()) or semantic.is_internal_claim());
