# mm-hub × Auth0 integration brief (grower-portal)

For whoever configures the mm-hub Supabase project. Written 2026-07-16.
grower-portal (the grower-facing UI rebuild) authenticates growers with
Auth0 on a dedicated tenant and needs mm-hub Supabase to accept those
tokens for RLS-scoped data access. Until this lands, grower-portal ships
no data views.

## Auth0 tenant facts (stable — coordinate before changing anything here)
- Tenant: grower-portal (Auth0, AU region)
- Issuer: https://grower-portal.au.auth0.com/
- JWKS: https://grower-portal.au.auth0.com/.well-known/jwks.json
- Signing: RS256
- Application (grower web app) client_id: puhT9mQDhYPsffYZOfBblbiU9ZaFLA8r
- Consignor scoping claim (set by a post-login Action from the user's
  app_metadata.consignor_ids, a string array):
    https://grower-portal.mackays.com.au/consignor_ids
  This claim is present on both ID and access tokens. Renaming it is a
  breaking change for both sides — don't.

## What mm-hub needs to do (Supabase side)
1. Enable third-party auth for Auth0 on the mm-hub project
   (Dashboard → Authentication → Third-party auth → Auth0; tenant
   grower-portal, AU region). This makes Supabase accept Auth0-issued
   JWTs alongside its own.
2. RLS: grower-facing policies must scope rows by the consignor claim.
   The claim is a JSON array of consignor IDs; access pattern:
     auth.jwt() -> 'https://grower-portal.mackays.com.au/consignor_ids'
   e.g. (illustrative only — mm-hub owns its policy SQL):
     consignor_id IN (
       SELECT jsonb_array_elements_text(
         auth.jwt() -> 'https://grower-portal.mackays.com.au/consignor_ids'
       )
     )
3. Confirm which tables/views growers may read. grower-portal uses the
   anon/publishable key only — RLS is the entire security boundary.

## What grower-portal will do on its side (planned, not yet built)
- Supabase requires third-party JWTs to carry role=authenticated: we will
  extend the Auth0 Action to set that claim on the access token.
- Auth0 access tokens are only JWTs when an audience is requested: we
  will register an Auth0 API (resource server) for mm-hub data access and
  request it as the audience in the login flow.
- supabase-js will be configured with the Auth0 access token via its
  accessToken option (no Supabase session, no service role key).

## Source of truth for consignor assignment
- Today: app_metadata.consignor_ids is set manually per user in the Auth0
  dashboard. The provisioning flow (who sets it, from which mm-hub data)
  is an open design question — flag if mm-hub wants to own it.

## Contact / coordination
- Changes to the claim name, issuer, or audience must be coordinated with
  the grower-portal repo (CLAUDE.md + lib/auth0.ts + the Auth0 Action).
