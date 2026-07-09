-- 0030_dim_rls_hardening — close the RLS gap on three core dimension tables.
--
-- WHY: dim_dispatch_state, dim_gp_charge, and dim_ns_charge were created (0021 / 0019 / 0015)
-- with plain table-level grants to `authenticated` + `cube_readonly` but WITHOUT row-level
-- security. Every other object a grower can reach is RLS-protected; these three were the
-- remaining un-gated reads. This migration enables RLS and adds the least-privilege policies —
-- shared reference vs internal-only — matching each dim's actual consumer surface.
--
-- Two postures, chosen by whether a GROWER-facing view depends on the dim:
--
--   • dim_dispatch_state = SHARED REFERENCE. It is INNER-JOINed by the security_invoker view
--     semantic.grower_dispatch_shipped (0021: `join core.dim_dispatch_state st on st.state_id =
--     d.state_id`). Because that view runs with the caller's own role, a grower reads the state
--     dim directly — so the state lookup MUST stay readable to `authenticated`, or every grower's
--     rows would inner-join to nothing and the view would return ZERO rows. The
--     `authenticated_read_reference … using (true)` policy is exactly what keeps
--     grower_dispatch_shipped returning rows with state names intact. It is a non-grower lookup
--     (one row per lifecycle state, no consignor) so read-all cannot widen, drop, or re-scope any
--     grower's rows. Cube reads it via cube_readonly (read-all, mirroring 0012).
--
--   • dim_gp_charge / dim_ns_charge = INTERNAL-ONLY fee-structure metadata. These are referenced
--     ONLY inside the core fact-rebuild functions (0019 core.refresh_fact_gp_settlement*,
--     0015 core.fact_settlement_bill builder), which run as service_role during ETL and bypass
--     RLS — so gating them does NOT affect ingestion. No grower-facing semantic.* view joins them,
--     so a grower has no legitimate need to read the rate card / NetSuite item taxonomy directly.
--     They are gated to `is_internal` via the same app_metadata-only, fail-closed helper
--     (semantic.is_internal_claim()) used across 0010/0016/0020. Cube reads all rows via
--     cube_readonly (mirroring 0012).
--
-- This migration is ADDITIVE and does not alter any existing policy, view, grant, or the ETL path.

-- dim_dispatch_state: shared reference (grower dispatch view depends on it)
alter table core.dim_dispatch_state enable row level security;
create policy cube_readonly_read_all on core.dim_dispatch_state
  for select to cube_readonly using (true);
create policy authenticated_read_reference on core.dim_dispatch_state
  for select to authenticated using (true);

-- dim_gp_charge: internal-only (fee-structure metadata, no grower dependency)
alter table core.dim_gp_charge enable row level security;
create policy cube_readonly_read_all on core.dim_gp_charge
  for select to cube_readonly using (true);
create policy internal_only_dim_gp_charge on core.dim_gp_charge
  for select to authenticated using (semantic.is_internal_claim());

-- dim_ns_charge: internal-only (NetSuite item metadata)
alter table core.dim_ns_charge enable row level security;
create policy cube_readonly_read_all on core.dim_ns_charge
  for select to cube_readonly using (true);
create policy internal_only_dim_ns_charge on core.dim_ns_charge
  for select to authenticated using (semantic.is_internal_claim());
