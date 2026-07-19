# mm-hub (staff hub): Auth0 login — Phase B kickoff (2026-07-19)

Hand this file to the `C:\dev\mm-hub` repo/session — it is self-contained. Written by
mm-data-hub after Tim approved the unified-auth scope
(`mm-data-hub/docs/auth0-unified-auth-scope.md`, decisions D1–D3, 2026-07-19). It replaces the
MS-SSO plan written into this repo's docs: **the production login for the staff hub is Auth0.**

## What you're building
Real login for the two Next.js apps (`crm/apps/web`, `returns-estimator-module`) at the seam
your own code documents: the dev-cookie shim (`mm_dev_user`) gives way to an Auth0 session at
`getSession()`, and everything downstream (`withRole`, guards, `set_config` RLS wiring, ~25
pages/routes) keeps its shape. Your database access model does not change — server-side
connections + transaction-local `set_config`; no Supabase JWTs, no data-hub RLS work.

## Tenant facts (UPDATED 2026-07-20 — tenant cutover; coordinate before changing ANY of these)
- Tenant: **`mackaysmarketing`** (Auth0, AU region) — the company login tenant, replacing the
  old `grower-portal` tenant (cutover runbook: `mm-data-hub/docs/auth0-tenant-cutover.md`).
- Issuer: `https://mackaysmarketing.au.auth0.com/` · JWKS:
  `https://mackaysmarketing.au.auth0.com/.well-known/jwks.json` · RS256.
- Claim namespace: `https://mackaysmarketing.com.au` — claims: `…/consignor_ids` (string
  array), `…/staff` (boolean true), `…/hub_role` (this doc). The hub's RLS already honors this
  issuer+namespace (migration 0057, proven).
- **Staff-hub application: CREATED on the new tenant 2026-07-20** — "Mackays Hub (staff)",
  Regular Web App, OIDC-conformant, RS256.
  - client_id: `3RSODfrlKAWvEIXS7NNqgJoiZaLgW38o`
  - client_secret: Auth0 dashboard (Applications → Mackays Hub (staff) → Settings) → each
    app's env (`AUTH0_CLIENT_SECRET`); never commit.
  - Dev callbacks `http://localhost:3000/api/auth/callback` + `:3001`, logout
    `http://localhost:3000` + `:3001`; add Vercel domains at deploy; first session hygiene:
    trim grant_types to `authorization_code` + `refresh_token`. One application serves both
    apps; split later only if session policies diverge.
  - API audience (if the hub apps ever call Supabase REST with user tokens):
    `https://uqzfkhsdyeokwnkpcxui.supabase.co`.

## First commit (do this before any code)
Update this repo's own docs — `crm/CLAUDE.md` (§Auth), `returns-estimator-module/docs/ARCHITECTURE.md`
(line ~15 "MS SSO"), `returns-estimator-module/lib/auth/session.ts` header comment, HANDOFF —
**MS SSO is superseded by Auth0** (Tim, 2026-07-18). Future sessions must not re-plan SSO.

## The build, per app
1. **Auth0 SDK** (`@auth0/nextjs-auth0`, current major with App Router support): env vars
   (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`,
   `APP_BASE_URL`), the SDK's auth routes (login/callback/logout) replacing
   `app/api/dev/login|logout/route.ts`, and a `middleware.ts` (none exists today) for
   route-level session validation.
2. **Rewrite the two seams** to read the Auth0 session and emit the EXISTING shapes:
   - `returns-estimator-module/lib/auth/session.ts` → `{ id, role, consignorIds }`:
     `role` from the `…/hub_role` claim (see next section) mapped onto your
     `EstimatorRole` enum; `consignorIds` from the existing `…/consignor_ids` claim
     (grower_admin/grower roles); staff+ roles need no consignor ids, same as today.
   - `crm/packages/auth/src/session.ts` → the staff record: resolve the Auth0 user to a
     `staff` row — match on verified email at first login and backfill an `auth0_sub` column
     (add it); sub match wins thereafter. Remove the `tw` fallback for production sessions.
   - Fail closed: no session, no `hub_role` claim, or no staff match → no access (the absence
     of a claim is always the negative — the 0056 contract style).
3. **Keep the dev shim** strictly behind the existing `ALLOW_DEV_AUTH=1` guard (estimator
   already throws in prod without it; give the CRM the same guard — today its `getSession()`
   falls back to `tw`, which must never survive into production).

## The `hub_role` claim (coordinate with grower-portal — they own the Action)
Role source is Auth0 `app_metadata.hub_role` ∈
`hub_admin | admin | staff | grower_admin | grower` (per-user, tenant-admin/onboarding-set;
users cannot write their own app_metadata), surfaced as the namespaced claim
`https://mackaysmarketing.com.au/hub_role`. The NEW tenant's post-login Action mints it from
day one — the consolidated reference implementation (consignor_ids + staff + hub_role + the
staff-MFA rule, `role` hardcoded `authenticated`) lives in
`mm-data-hub/docs/auth0-tenant-cutover.md` step 2. The grower-portal repo owns the deployed
Action going forward — coordinate any change. Parse strictly app-side: exact enum match,
anything else → unauthenticated.

## Explicitly OUT of this kickoff
- **The CRM MCP server app** (`crm/apps/mcp`) — unauthenticated by design (MVP). Putting it
  behind OAuth is its own follow-up; note it, don't fold it in.
- **data-hub (raw/core/semantic) work** — none needed for this build (your DB access is
  server-side). The hub's Auth0→internal REST path is scoped separately (Phase D of the scope
  doc) and is fail-closed until built.
- **The legacy hub app** — being retired (decision D1), not migrated. Don't touch it.

## Acceptance (prove, don't assert)
1. Both apps: full login round-trip via Auth0 (login → callback → session → logout) in dev.
2. Role mapping: a user per role lands with the right `role`/`consignorIds`; a user with NO
   `hub_role` claim gets no session/access anywhere (fail-closed), and the CRM `tw` fallback
   is unreachable outside `ALLOW_DEV_AUTH=1`.
3. `grower_admin`/`grower` personas in the estimator see only their consignors' rows (the
   existing `withRole`/RLS path, now fed by real claims).
4. Dev shim still works locally behind the guard; disabled paths verified in a prod build.
5. Docs updated (the "first commit" above) + HANDOFF entry with evidence.
