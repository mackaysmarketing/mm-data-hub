# Auth0 tenant cutover: grower-portal → mackaysmarketing (started 2026-07-20)

Tim is retiring the `grower-portal` tenant NAME (tenants can't be renamed): a properly-named
production tenant **`mackaysmarketing`** (AU) now exists and everything moves to it. The claim
namespace is renamed in the same move (the one cheap moment — approved with the tenant
decision). This file is the runbook; tick items as they land.

## The mapping

| | OLD (retiring) | NEW |
|---|---|---|
| Tenant | `grower-portal` (AU) | `mackaysmarketing` (AU) |
| Issuer | `https://grower-portal.au.auth0.com/` | `https://mackaysmarketing.au.auth0.com/` |
| Claim namespace | `https://grower-portal.mackays.com.au` | `https://mackaysmarketing.com.au` |
| Claims | `…/consignor_ids`, `…/staff` | same names, new namespace (+ `…/hub_role` for Phase B) |

Each issuer's claims are honored ONLY under its OWN namespace — cross-namespace tokens are
inert (proven, T1).

## ✅ DONE
- [x] New tenant created (Tim, dashboard, 2026-07-20).
- [x] **Hub migration `0057_auth0_tenant_migration` LIVE**: all four claim helpers resolve
  namespace by issuer; the app_metadata deny guards refuse BOTH Auth0 issuers (the 0050
  FUTURE-ISSUER invariant compliance case — landed BEFORE the new tenant touches Supabase, so
  no window ever exists where a new-tenant token could assert `is_internal`). No policy, grant,
  or view changed.
- [x] Proofs: `auth0:rls` **188/188** (T1–T3: new-issuer identity/staff/guards/parity +
  cross-namespace forgeries all inert; B/S re-prove the old path unchanged) · `rls:posture`
  104/104 · `rls:multifarm` 50/50.

## ⬜ REMAINING (in order)

### 1. Reconnect the Auth0 connector to `mackaysmarketing` (Tim)
Tenant creation dropped the connector's login. Reconnect it choosing the NEW tenant so the hub
session can do step 2 — or do step 2 by hand in the dashboard.

### 2. Configure the new tenant (hub session via connector, else dashboard)
- **Applications** (both were on the old tenant; recreate — old client_ids are void):
  - "Grower Portal" — Regular Web App; copy the old app's callback/logout/origin URLs
    (production `growers.mackaysmarketing.com.au` + localhost dev). New client_id/secret → the
    portal repo's env.
  - "Mackays Hub (staff)" — Regular Web App; localhost:3000/3001 dev callbacks (Vercel domains
    at deploy). New client_id/secret → record in `docs/mm-hub-auth0-login-kickoff.md`.
- **API (resource server):** replicate the old tenant's audience setup — the portal requests an
  audience so its access tokens are JWTs (identifier is in the portal repo's Auth0 config; the
  portal team knows it, or read it off the old tenant before parking it).
- **Post-login Action** (ONE action, consolidating old v2 + the pending staff v3 + Phase B's
  hub_role + the D3 MFA rule — the grower-portal repo owns it going forward; this is the
  reference implementation):

  ```js
  exports.onExecutePostLogin = async (event, api) => {
    const NS = "https://mackaysmarketing.com.au";
    // Supabase third-party auth requirement. NEVER any other value — the role claim maps to
    // the Postgres role; a non-authenticated value here is the platform residual documented
    // in mm-data-hub CLAUDE.md.
    api.accessToken.setCustomClaim("role", "authenticated");

    const md = event.user.app_metadata || {};

    const consignorIds = md.consignor_ids;
    if (Array.isArray(consignorIds) && consignorIds.length > 0) {
      api.idToken.setCustomClaim(`${NS}/consignor_ids`, consignorIds);
      api.accessToken.setCustomClaim(`${NS}/consignor_ids`, consignorIds);
    }

    // Staff flag: literal true only; absence IS the negative (0056 contract).
    if (md.mm_staff === true) {
      api.idToken.setCustomClaim(`${NS}/staff`, true);
      api.accessToken.setCustomClaim(`${NS}/staff`, true);
    }

    // Staff-hub role (Phase B contract — mm-hub-auth0-login-kickoff.md).
    const HUB_ROLES = ["hub_admin", "admin", "staff", "grower_admin", "grower"];
    if (typeof md.hub_role === "string" && HUB_ROLES.includes(md.hub_role)) {
      api.idToken.setCustomClaim(`${NS}/hub_role`, md.hub_role);
      api.accessToken.setCustomClaim(`${NS}/hub_role`, md.hub_role);
    }

    // D3: MFA for anyone with staff-tier metadata; growers unaffected.
    if (md.mm_staff === true || md.mm_internal === true || typeof md.hub_role === "string") {
      api.multifactor.enable("any");
    }
  };
  ```

  Deploy + attach to the Login flow. Also: Security → Multi-factor Auth → enable One-time
  Password (the Action's MFA call needs at least one factor on).
- **Tenant hygiene (D3):** admin list ≤ 2–3, log streaming if the plan has it.

### 3. Supabase third-party auth (Tim, Supabase dashboard — AFTER step 2)
`data_hub` project → Authentication → Third-party auth → add Auth0 tenant `mackaysmarketing`
(AU). Hub-side both issuers are already live (0057), so there is no DB risk in any ordering.
⚠ If the dashboard permits only ONE Auth0 integration at a time, this becomes an atomic swap:
do it together with step 4's portal redeploy in one sitting (minutes of grower downtime; with
today's handful of users, acceptable).
Note: new-tenant tokens hit mm-hub's `public` schema exactly like old-tenant ones (the FIX 3
audit conclusions carry over unchanged — `auth.uid()`-keyed tables error closed, the five
`using(true)` reference tables stay readable).

### 4. Portal repo: switch + users (grower-portal session)
- Env: new domain/issuer, client_id/secret, audience; claim-namespace constant
  `https://grower-portal.mackays.com.au` → `https://mackaysmarketing.com.au` wherever the app
  reads its own claims (`lib/auth0.ts`, per their CLAUDE.md). Redeploy.
- Recreate users on the new tenant (the current user base is small — Tim to confirm exact
  list): invite, set `app_metadata.consignor_ids` per grower; `mm_staff: true` on
  tim@mackaysmarketing.com.au. Fresh passwords + MFA enrolment for staff — that's inherent to a
  new tenant.
- Smoke: grower login sees own data only; staff login sees all 7 views + the 100-grower
  directory; no-claim user sees nothing. (DB-side equivalents already proven in T3.)

### 5. Cleanup (hub session, AFTER the portal is stable on the new tenant)
- Remove `grower-portal` from Supabase third-party auth.
- Hub migration **0058**: drop the old issuer + namespace from the four helpers (collapse the
  CASE to the single new tenant); trim the old-path proof sections/constants.
- CLAUDE.md: rewrite the Auth0 section to single-tenant facts.
- Park/delete the old Auth0 tenant (takes the old apps — including the 2026-07-19 staff app,
  which was never used — with it).

## Invariants through the whole cutover
Growers byte-identical on the old path until step 4 flips them; Cube/Hub-MCP/mm-hub service
contexts untouched (proven B7); `role=authenticated` always; both issuers fail closed
independently; staff ≠ internal on both tenants (S4/T2).
