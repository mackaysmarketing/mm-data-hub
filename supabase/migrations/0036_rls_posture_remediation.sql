-- 0036_rls_posture_remediation — fix every anomaly the live posture sweep found.
--
-- Companion to scripts/rls_posture.ts (npm run rls:posture), which enumerates every
-- relation in raw/core/semantic and asserts it against a declared posture registry.
-- The 2026-07-11 live sweep found exactly two structural anomalies plus one posture
-- classification to document. This migration is ADDITIVE: it drops no policy, revokes
-- nothing, and weakens nothing — it only makes two already-declared postures effective
-- and writes the third one down.
--
-- ── Anomaly 1+2: core.dim_gp_charge / core.dim_ns_charge — DEAD internal-only policies.
-- 0030 declared these two dims INTERNAL-ONLY and created `internal_only_*` policies for
-- `authenticated` using semantic.is_internal_claim(). But 0030's premise ("created with
-- plain table-level grants to authenticated + cube_readonly") was wrong for these two:
-- no migration ever granted `authenticated` SELECT on them (0019/0015 only picked up
-- cube_readonly via 0011's default privileges). A policy without a grant is dead code —
-- internal staff get "permission denied" instead of rows, so the declared internal-only
-- posture never actually worked. Every OTHER internal-only relation (raw.ft_order*,
-- core.dim_order, core.fact_order_item, core.fact_settlement_bridge,
-- core.fact_revenue_charge) pairs the policy WITH the grant.
--
-- Remediation: add the missing grant. This widens nothing for growers — RLS is ON and
-- the 0030 `internal_only_*` policy still evaluates is_internal_claim() (app_metadata-
-- only, fail-closed), so a grower JWT goes from "permission denied" to 0 rows; internal
-- staff go from "permission denied" to the rows 0030 always intended them to have.
grant select on core.dim_gp_charge to authenticated;
grant select on core.dim_ns_charge to authenticated;

comment on table core.dim_gp_charge is
  'GP charge taxonomy (rate card classification, src/lib/ft_gp_charges.ts). INTERNAL-ONLY: RLS on, authenticated gated by semantic.is_internal_claim() (0030); authenticated SELECT grant added in 0036 (0030''s policy was dead without it); cube_readonly reads all rows. NB GP LA = "Load Adjustment", NOT NetSuite''s Larapinta.';
comment on table core.dim_ns_charge is
  'NetSuite item/charge taxonomy (src/lib/ns_charges.ts). INTERNAL-ONLY: RLS on, authenticated gated by semantic.is_internal_claim() (0030); authenticated SELECT grant added in 0036 (0030''s policy was dead without it); cube_readonly reads all rows.';

-- ── Posture documentation: core.dim_shed is a VIEW — "RLS disabled" is structural, not a gap.
-- The audit flagged core.dim_shed as an RLS-off relation. It is a plain view (0022), so
-- row-level security does not apply to it directly; the question is whether its grants
-- match its consumer surface. They do, and they must stay exactly as they are:
--
--   • SHARED-REFERENCE posture (the 0030 dim_dispatch_state rationale): the grower-facing
--     security_invoker views semantic.grower_dispatch_detail (0022) and
--     semantic.grower_dispatch_shipped (0021) both LEFT JOIN core.dim_shed with the
--     CALLER's role. Even a LEFT JOIN requires SELECT privilege on the joined relation,
--     so revoking the `authenticated` grant would not narrow anything — it would make
--     every grower query on both views fail with "permission denied". The grant is
--     load-bearing.
--   • It is deliberately NOT security_invoker: it resolves raw.ft_entity with OWNER
--     rights so callers need no grant on raw.ft_entity (which carries org_tax_no and
--     must stay unexposed). It surfaces ONLY (shed_id, shed_name) — one row per shed,
--     no consignor dimension — so read-all cannot widen, drop, or re-scope any grower's
--     rows (same argument as core.dim_dispatch_state in 0030).
--
-- Idempotent re-affirmation of the intended grants (no-ops when already present):
grant select on core.dim_shed to authenticated, cube_readonly;

comment on view core.dim_shed is
  'shed_id -> shed_name lookup (owning org name from raw.ft_entity, 1:1). SHARED-REFERENCE posture (0036): owner-rights view (NOT security_invoker) so callers need no raw.ft_entity grant; exposes only shed_id + name; authenticated grant is load-bearing — grower-facing security_invoker views (0021/0022) LEFT JOIN it and would fail with permission denied without it. Asserted by npm run rls:posture.';

-- No other anomalies existed at sweep time: no RLS-off table carries an authenticated
-- grant; every RLS-on table granted to a role has a policy for that role (after the two
-- grants above, every policy also has its grant); all policies are SELECT-only; no
-- grantee exists outside {postgres, authenticated, cube_readonly}. The sweep
-- (npm run rls:posture) re-proves all of this on every run and FAILS on any future drift,
-- including relations added without a registry classification.
