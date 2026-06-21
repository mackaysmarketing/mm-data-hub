-- 0013_hub_mcp_role — least-privilege login role for the Hub MCP's detail / run_select path.
--
-- THE IDENTITY-PROPAGATION ANCHOR (SPEC §5/§7). The Hub MCP holds NO standing data access.
-- For tools that read semantic.* (list_grower_dispatches, run_select) it connects as THIS role
-- and, per request, drops to `authenticated` and presents the CALLER's JWT claims:
--
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"app_metadata":{"consignor_id":"…"}}';  -- the caller
--     SET LOCAL statement_timeout = '…ms';
--     SELECT … FROM semantic.grower_dispatch_detail … LIMIT <cap>;
--   ROLLBACK;
--
-- The existing RLS (migrations 0008 + 0010) then scopes every row to that caller — grower →
-- own consignor only; app_metadata.is_internal → all; neither/malformed → 0 rows (fail closed).
-- This mirrors EXACTLY how Supabase's own `authenticator` role serves PostgREST, but scoped
-- down to `authenticated` ONLY (never `service_role`, which bypasses RLS).
--
-- Why a NEW role (not cube_readonly): cube_readonly is NOT a member of `authenticated` (so it
-- cannot SET ROLE authenticated) and it carries a permissive read-all policy (0012) that would
-- DEFEAT tenant scoping. The metric path keeps using Cube REST (queryRewrite RLS); only this
-- Postgres detail path needs `hub_mcp`.
--
-- Least privilege, by construction:
--   • NOINHERIT  → zero standing privileges; every query MUST explicitly drop to authenticated.
--   • member of `authenticated` ONLY → can become authenticated, nothing higher.
--   • NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS → no escape from RLS.
--   • No direct grants on any schema → on its own, hub_mcp can read NOTHING. Fail-closed is
--     structural: a request that sets no claims runs as authenticated with no consignor → 0 rows.
--
-- Touches NO public/auth/storage objects — only a cluster role + membership (same pattern as 0011).
--
-- The password is NOT stored here (never commit secrets). Set it out-of-band, then put the
-- connection string in .env as MCP_DB_URL (session pooler, user `hub_mcp.<project_ref>`):
--   ALTER ROLE hub_mcp WITH LOGIN PASSWORD '<secret>';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hub_mcp') then
    create role hub_mcp
      login
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls;
  else
    alter role hub_mcp
      login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

-- The ONLY privilege hub_mcp gets: the ability to become `authenticated`. All actual data
-- access (SELECT on the view + base tables, EXECUTE on the claim helpers) is already granted
-- to `authenticated` by migrations 0008/0010 and applies once hub_mcp SET ROLEs into it.
grant authenticated to hub_mcp;

comment on role hub_mcp is
  'Hub MCP detail-path login role. NOINHERIT, member of authenticated ONLY. No standing data '
  'access: every request does SET ROLE authenticated + SET request.jwt.claims (the caller), so '
  'RLS (0008/0010) scopes each query. Never service_role; never BYPASSRLS.';
