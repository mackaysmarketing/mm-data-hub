-- 0011_cube_readonly_role — least-privilege read-only role for the Cube semantic layer.
--
-- Cube enforces tenant RLS ITSELF (queryRewrite on app_metadata.consignor_id — see
-- cube/cube.js), so its database role legitimately reads all rows but is granted SELECT
-- only, and ONLY on this repo's schemas (raw / core / semantic). It is granted NOTHING on
-- public (mm-hub), auth, or storage — the schema-ownership boundary, enforced in the grant.
--
-- The password is NOT stored here (never commit secrets). Set it out-of-band and add LOGIN:
--   ALTER ROLE cube_readonly WITH LOGIN PASSWORD '<secret>';
-- Then repoint Cube Cloud's data source at  cube_readonly.<project_ref>  on the session pooler
-- (aws-1-ap-southeast-2.pooler.supabase.com:5432). NB: confirm Supavisor accepts the custom
-- role (session pooler supports non-default DB users).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cube_readonly') then
    create role cube_readonly nologin;
  end if;
end $$;

-- Schema usage + SELECT on existing objects (raw/core/semantic ONLY).
grant usage on schema raw, core, semantic to cube_readonly;
grant select on all tables in schema raw to cube_readonly;
grant select on all tables in schema core to cube_readonly;
grant select on all tables in schema semantic to cube_readonly;

-- Future tables/views created by this owner in these schemas stay readable.
alter default privileges in schema raw      grant select on tables to cube_readonly;
alter default privileges in schema core     grant select on tables to cube_readonly;
alter default privileges in schema semantic grant select on tables to cube_readonly;

-- The claim helpers are read-only; allow execute so semantic.* views resolve if queried directly.
grant execute on function semantic.current_consignor_id(), semantic.is_internal_claim() to cube_readonly;

comment on role cube_readonly is
  'Read-only role for the Cube Cloud data source. SELECT on raw/core/semantic only; no public/auth/storage. Tenant RLS enforced in Cube queryRewrite.';
