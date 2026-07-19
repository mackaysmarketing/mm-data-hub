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
- [x] Connector re-authed to `mackaysmarketing` (Tim, 2026-07-20).
- [x] **New tenant configured** (hub session via connector, 2026-07-20):
  - "Grower Portal" — Regular Web App, client_id `jT38ddvo8XpDYdMho5X2p55eq1bmsnSS`;
    callbacks localhost:3000 + `https://growers.mackaysmarketing.com.au/api/auth/callback`
    (⚠ portal repo: verify the callback PATH against your Auth0 SDK's route and adjust in the
    dashboard if yours differs). Secret: dashboard → portal env; never committed.
  - "Mackays Hub (staff)" — Regular Web App, client_id `3RSODfrlKAWvEIXS7NNqgJoiZaLgW38o`;
    localhost:3000/3001 dev callbacks (Vercel domains at deploy).
  - API (audience): **`https://uqzfkhsdyeokwnkpcxui.supabase.co`** ("Mackays Data Hub
    (Supabase)", RS256, consent skipped for first-party). Portal env sets this as the requested
    audience so access tokens are JWTs. (If the OLD tenant used a different identifier string,
    nothing carries over anyway — the portal env changes regardless; this is the identifier
    going forward.)
  - Post-login Action **`mackays-claims`** created + deployed (v2) — consignor_ids + staff +
    hub_role + staff-MFA with remember-browser (~30-day re-challenge per browser),
    `role=authenticated` hardcoded. Reference copy below; the deployed Action is owned by the
    grower-portal repo going forward.

- [x] **Tim's dashboard clicks done (2026-07-20, per Tim):** `mackays-claims` (v2, with
  remember-browser MFA) attached to the Login flow; One-time Password factor enabled
  (tenant-wide policy stays "Never" — the Action enforces MFA for staff only). Action v2
  verified `all_changes_deployed` via the connector; flow attachment is dashboard-only, taken
  on Tim's word.

## ⬜ REMAINING (in order)

### Reference — the deployed Action code (v1, verbatim)

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

    // D3: MFA for anyone with staff-tier metadata; growers unaffected. allowRememberBrowser
    // lets each user tick "remember this browser" (~30 days per browser; new device/incognito
    // always challenges) — without it, staff would be challenged on EVERY login (v2 change).
    if (md.mm_staff === true || md.mm_internal === true || typeof md.hub_role === "string") {
      api.multifactor.enable("any", { allowRememberBrowser: true });
    }
  };
  ```

  Deploy + attach to the Login flow. Also: Security → Multi-factor Auth → enable One-time
  Password (the Action's MFA call needs at least one factor on).

### 2. Supabase third-party auth (Tim, Supabase dashboard — AFTER step 1)
`data_hub` project → Authentication → Third-party auth → add Auth0 tenant `mackaysmarketing`
(AU). Hub-side both issuers are already live (0057), so there is no DB risk in any ordering.
⚠ If the dashboard permits only ONE Auth0 integration at a time, this becomes an atomic swap:
do it together with step 3's portal redeploy in one sitting (minutes of grower downtime; with
today's handful of users, acceptable).
Note: new-tenant tokens hit mm-hub's `public` schema exactly like old-tenant ones (the FIX 3
audit conclusions carry over unchanged — `auth.uid()`-keyed tables error closed, the five
`using(true)` reference tables stay readable).

### 3. Portal repo: switch + users (grower-portal session)
- Env: new domain/issuer, client_id/secret, audience; claim-namespace constant
  `https://grower-portal.mackays.com.au` → `https://mackaysmarketing.com.au` wherever the app
  reads its own claims (`lib/auth0.ts`, per their CLAUDE.md). Redeploy.
- Recreate users on the new tenant (the current user base is small — Tim to confirm exact
  list): invite, set `app_metadata` per user (User Management → Users → pick user →
  app_metadata). Fresh passwords + MFA enrolment for staff — inherent to a new tenant.
  Ready-to-paste app_metadata:
  - tim@mackaysmarketing.com.au (staff): `{ "mm_staff": true }`
  - the test grower (LRCLA "L & R Collins - Lakeland" + LRCTU "L & R Collins - Tully"):
    ```json
    { "consignor_ids": ["019439a6-fb95-f543-c2e0-40d9f9b719fa",
                        "019439a8-7d01-187c-89ff-970d71bdba6c"] }
    ```
  - any other grower: `consignor_ids` uuids come from `core.dim_grower` by grower code (ask
    the hub session).
- Smoke: grower login sees own data only; staff login sees all 7 views + the 100-grower
  directory; no-claim user sees nothing. (DB-side equivalents already proven in T3.)

- Portal env facts: domain `mackaysmarketing.au.auth0.com` · client_id
  `jT38ddvo8XpDYdMho5X2p55eq1bmsnSS` (secret from dashboard) · audience
  `https://uqzfkhsdyeokwnkpcxui.supabase.co`.

### 4. Cleanup (hub session, AFTER the portal is stable on the new tenant)
- Remove `grower-portal` from Supabase third-party auth.
- Hub migration **0058**: drop the old issuer + namespace from the four helpers (collapse the
  CASE to the single new tenant); trim the old-path proof sections/constants.
- CLAUDE.md: rewrite the Auth0 section to single-tenant facts.
- Park/delete the old Auth0 tenant (takes the old apps — including the 2026-07-19 staff app,
  which was never used — with it).

## Invariants through the whole cutover
Growers byte-identical on the old path until step 3 flips them; Cube/Hub-MCP/mm-hub service
contexts untouched (proven B7); `role=authenticated` always; both issuers fail closed
independently; staff ≠ internal on both tenants (S4/T2).
