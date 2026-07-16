# mm-hub public-schema hardening checklist (before enabling Auth0 third-party auth)

Written 2026-07-16 from a read-only audit of the live `data_hub` project (`uqzfkhsdyeokwnkpcxui`).
Context: mm-data-hub migration `0050` made the hub schemas (raw/core/semantic) ready for
grower-portal Auth0 logins. Enabling Supabase **third-party auth** is PROJECT-level, so it also
lets Auth0 tokens reach mm-hub's `public` schema + storage. This checklist is what mm-hub should
fix/confirm first. All items are in mm-hub's territory — mm-data-hub must not touch `public`.

## P0 — fix regardless of Auth0 (exposed via the anon key TODAY)
Seven `public` tables have **RLS disabled** with **full grants (SELECT/INSERT/UPDATE/DELETE/
TRUNCATE) to both `anon` and `authenticated`**. Anyone holding the app's publishable key can read
and write them right now, no login required:

- `public.growers`
- `public.gr_banana_blocks`
- `public.gr_block_parcel`
- `public.gr_block_tags`
- `public.gr_grower_crop_area`
- `public.gr_grower_tags`
- `public.gr_parcels`

Fix: `alter table … enable row level security` on each + explicit policies (or revoke the
anon/authenticated grants entirely if these are service-role-only ETL surfaces). Supabase's
security advisor (`rls_disabled_in_public`) flags these too.

Related (same workstream, hub-schema side): six grower-register relations were also created inside
raw/core/semantic with anon grants/policies — tracked separately in mm-data-hub (rls:posture
FAILs + task chip); do not fix those from mm-hub.

## P1 — review before flipping the third-party auth switch
These are reachable by ANY authenticated JWT, which after enablement includes every grower-portal
Auth0 login (role=authenticated):

1. **`using(true)` read policies** — readable by all authenticated users:
   `distribution_centres`, `ft_products`, `products`, `product_retailer_mappings`, `retailers`,
   `quote_daily_prices`, `quotes`, `file_uploads`. Decide per table whether "any grower-portal
   grower can read this" is acceptable (reference data probably yes; `quotes` /
   `quote_daily_prices` review for commercial sensitivity).
2. **`with check (true)` INSERT policies** — writable by all authenticated users:
   `quotes`, `file_uploads`. Auth0 growers could insert rows. If unintended, gate on
   `private.portal_role() is not null` (or equivalent membership check).

## Verified SAFE (no action, recorded for the audit trail)
- **`private.portal_*` / `private.is_hub_admin()` helpers do NOT read JWT claims** beyond `sub`:
  they key on `auth.uid()` → lookups in `hub_users` / `module_access`. A grower-portal Auth0 token
  has a non-uuid `sub` (`auth0|…`), so `auth.uid()`'s uuid cast errors → query fails CLOSED (and
  even a uuid-shaped sub matches no row → null/false). No issuer guard needed on mm-hub helpers.
- **storage.objects "documents bucket scoped read"** routes through the same helpers → same
  fail-closed behavior for Auth0 tokens.
- `hub_users` / `module_access` "own row" policies use `auth.uid()` → same fail-closed behavior.

## grower-portal (Auth0 tenant) requirements — coordinate, don't skip
- The post-login Action must pin **`role: 'authenticated'`** on the access token and must never
  derive `role` from user-controllable input. A token claiming `role=service_role` would bypass
  ALL RLS project-wide — no database-side rule can defend this.
- Keep tenant admin access + the Action code locked down; the consignor claim
  (`https://grower-portal.mackays.com.au/consignor_ids`) is the grower's entire data scope.

## Then: the two project-config steps (either Tim in the dashboard, or ask mm-data-hub's agent)
1. **Enable third-party auth**: Dashboard → Authentication → Third Party Auth → add **Auth0**,
   tenant `grower-portal`, region AU (issuer `https://grower-portal.au.auth0.com/`).
2. **Expose the `semantic` schema** to the REST API: Settings → API → Exposed schemas → add
   `semantic` (grower-portal reads the grower views over REST; grants + RLS are already correct).

After enablement, re-run the hub proofs (`npm run auth0:rls`, `npm run rls:multifarm` in
mm-data-hub) and smoke-test one real Auth0 login end-to-end.
