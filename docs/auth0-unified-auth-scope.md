# Scope: all user auth on Auth0 — grower portal + internal staff hub (2026-07-19)

Tim's direction (2026-07-18): **every human logs in through Auth0** — growers (done) and
Mackays staff. This document scopes what that takes, across the four codebases involved, in
recommended order. Written by mm-data-hub after a code-level recon of `C:\dev\mm-hub`
(2026-07-19) and grounded in the live `data_hub` posture (0050/0056 proofs).

## The plain-English summary

Three findings shape this scope, and two of them make it **smaller than expected**:

1. **The new staff hub has no login system to migrate.** The CRM and returns-estimator modules
   at `C:\dev\mm-hub` currently use a development-only cookie (`mm_dev_user`) with a
   documented, single swap point (`getSession()`) where a real login was always intended to
   plug in. The code comments planned **Microsoft SSO** there — Tim's Auth0 decision supersedes
   that (record it in that repo's docs as step one). So the core job is *implementing* Auth0
   once at a prepared seam, not untangling an existing auth stack. Roughly 30 files, but ~25 of
   them don't change if the session shape (`{role, consignorIds}`) is preserved — and it can be.
2. **There is also a LEGACY live app** — the one that today authenticates growers with Supabase
   email logins and staff with `is_internal` tokens, and that owns the `public` schema
   (`private.portal_*` helpers, the `gr_*` register views). Its code is NOT at `C:\dev\mm-hub`
   (location to confirm — likely an earlier build). The big fork in this scope is what happens
   to it: **retire it as the new modules take over (recommended) or migrate its login too**.
3. **The data hub is already dual-stack by design.** RLS accepts Supabase-issued and
   Auth0-issued tokens side by side (additive policies, each issuer fail-closed on its own) —
   proven green through 0050/0056. Nothing has to be cut over in one jump, and growers, Cube,
   and the Hub MCP are untouched throughout every phase below.

## Where things stand today (the auth map)

| System | Login today | State |
|---|---|---|
| grower-portal (grower UI) | **Auth0** — consignor claim (0050) + staff claim (0056) | ✅ live, proven |
| New staff hub — `crm` + `returns-estimator` (`C:\dev\mm-hub`) | Dev cookie shim; prod login never built (MS-SSO planned, superseded) | the build target |
| Legacy mm-hub app (owns `public` schema) | Supabase email auth; staff = `app_metadata.is_internal` | fate = Decision D1 |
| data hub RLS (this repo) | Honors BOTH issuers, additive, fail-closed | ✅ ready; one optional phase (D) |
| Cube / Hub MCP | Synthetic service contexts (`app_metadata` shape, no issuer) | never changes — these are not human logins |

Useful detail from the recon: the new hub modules talk to Postgres **server-side** (their own
connections + `set_config`-based RLS), not with user JWTs. That means Auth0 lands entirely at
the app seam — their database wiring doesn't change, and they don't need any data-hub RLS work
to go live.

## The phases (recommended order)

### Phase A — Auth0 tenant becomes the company login (config, small)
Owner: Auth0 dashboard (Tim / whoever admins the tenant). Effort: hours.
- Create a **second Auth0 application** on the SAME tenant (`grower-portal`, AU) for the staff
  hub. Same tenant = same issuer = the hub's single-issuer invariant holds and **zero
  deny-guard changes** are needed in the data hub (the 0050 FUTURE-ISSUER rule stays satisfied).
  The tenant's name no longer matching its job ("grower-portal" now serving staff too) is
  cosmetic — renaming the tenant or adding a custom login domain changes the issuer, which is a
  coordinated breaking change across every consumer, so it is explicitly OUT of this scope.
- Enable **MFA required** for any user carrying `mm_staff` (and later `mm_internal`); keep the
  dashboard-admin list minimal. Optional but recommended: tenant log streaming so app_metadata
  changes are reviewable.
- Staff identity source: Auth0 `app_metadata` flags, exactly as 0056 established
  (`mm_staff` today; more per Decision D2). Users cannot set their own app_metadata.
- The post-login Action keeps minting namespaced claims with `role=authenticated` — the staff
  hub reads the same tokens; no second Action needed unless per-application claims are wanted.

### Phase B — the new staff hub gets real login (the main build)
Owner: `C:\dev\mm-hub` repo sessions. Effort: the largest phase — est. 2–4 focused sessions
(CRM app + returns-estimator app, shared pattern).
- First commit: update that repo's docs (`crm/CLAUDE.md`, `returns-estimator-module/docs/ARCHITECTURE.md`,
  HANDOFF) — **MS SSO is superseded by Auth0**, per Tim 2026-07-18.
- Add Auth0 to both Next.js apps (`@auth0/nextjs-auth0` or equivalent): login/callback/logout
  routes replacing the dev `api/dev/login|logout` routes, plus middleware for route-level
  session checks (none exists today — add it).
- Rewrite the **two `getSession()` seams** — `crm/packages/auth/src/session.ts` and
  `returns-estimator-module/lib/auth/session.ts` — to read the Auth0 session and map claims →
  the existing `{role, consignorIds}` / staff-record shape. Everything downstream (~25 pages,
  API routes, `withRole` guards, `set_config` RLS wiring) stays structurally intact — that was
  the point of the seam.
- Identity mapping: link the CRM `staff` records to Auth0 users (add an `auth0_sub` column, or
  match on verified email at first login — recommend email-match with sub backfill). The
  returns-estimator role enum (`hub_admin|admin|staff|grower_admin|grower`) maps from Auth0
  app_metadata per Decision D2.
- Keep the dev shim behind its existing `ALLOW_DEV_AUTH=1` guard for local work.
- **Also flagged by the recon:** the CRM's MCP server app is currently unauthenticated by
  design (MVP). Putting it behind Auth0/OAuth is its own small follow-up — listed here so it
  isn't forgotten, not part of this phase.

### Phase C — user provisioning + onboarding (who flips the switches)
Owner: grower-portal repo (its admin phase) + Auth0 Management API. Effort: medium; already on
the portal's roadmap.
- Today every flag (`consignor_ids`, `mm_staff`) is set by hand in the Auth0 dashboard. Target:
  the portal's admin section creates/invites users and sets app_metadata through the Management
  API (an M2M application with narrowly-scoped grants), with an audit trail.
- Staff onboarding (for the hub) rides the same mechanism — one place where a person's access
  is granted, changed, and revoked.

### Phase D — data hub: Auth0→internal read path (this repo; build WHEN triggered)
Owner: mm-data-hub. Effort: one session — it is the 0056 pattern scaled up.
The new hub modules do NOT need this (server-side connections). It becomes necessary the moment
any **browser with a user token** must read internal-only hub data — e.g. portal internal
dashboards, or the legacy app's `gr_*` write path if that app migrates rather than retires.
When triggered:
- New claim `https://grower-portal.mackays.com.au/internal` (boolean `true`, from
  `app_metadata.mm_internal`) + `semantic.auth0_is_internal()` — same issuer-pinned,
  strict-boolean, fail-closed shape as `auth0_is_staff()`.
- Additive `auth0_internal_read_*` policies on the ~24 internal-only relations; extended write
  policies on the two register tag tables (the A4 posture rule extends to allow the new
  helper); the two explicit in-view internal gates (`grower_scorecard`,
  `recon_settlement_source`) gain the OR branch; `grower_directory`'s gate extends to internal.
- Pinned sets + proofs, same discipline as 0056: posture internal-only class requires the
  second policy; auth0:rls gains internal sections (read-all parity, staff-does-NOT-escalate,
  forgery suite). **Until this phase lands, an Auth0 staff/internal token still reads ZERO
  internal rows — fail-closed is the default, which is why this phase can safely wait.**

### Phase E — legacy app endgame (Decision D1)
- **Recommended: retire.** The new hub modules + grower-portal replace it screen by screen; its
  Supabase email logins keep working unchanged during the overlap (dual-stack is the proven
  current state, not a special transition mode). When the last user moves: disable Supabase
  email signups/logins for humans, and `is_internal` app_metadata becomes a **service-only**
  assertion (Cube + Hub MCP keep it forever — they are not human logins and never migrate).
- Alternative (only if the legacy app must live long-term): migrate its login to Auth0 — that
  pulls Phase D forward (its `gr_*` writes need the Auth0-internal path) and adds a rework of
  the `public` schema's `auth.uid()`-keyed policies (Auth0 subs are not UUIDs; today they fail
  closed by error — fine for denial, unusable for access). This is the expensive path; avoid it
  unless retirement is genuinely far away.
- Either way, the FIX-3 residuals (five `using(true)` public reference tables + dead anon
  grants) stay on the legacy/mm-hub side's list — unchanged by this scope.

## What stays true in every phase (the safety rails)
- **One issuer.** Everything rides the existing tenant — no new deny guards, no allow-list
  inversion, the 0050 invariant untouched.
- **Additive only, fail-closed everywhere.** Every new claim is strict-parsed and inert until
  both sides ship; growers stay byte-identical (proven after every hub change, as with 0056).
- **Cube and the Hub MCP never change.** Service contexts are not user logins.
- **`role=authenticated` always** — staff/internal privilege lives in RLS predicates and app
  guards, never in the Postgres role.
- **Accepted residual, restated:** the Auth0 tenant is the keys to everything once Phase D
  lands (internal data, not just grower data). MFA + tiny admin set + reviewable logs (Phase A)
  is the mitigation — this is the design, per Tim's direction, not an accident.

## Decisions — APPROVED by Tim 2026-07-19 ("go with your recommendations")
- **D1 — Legacy app: RETIRE** (Phase E as written). No login migration for the old app; it
  keeps Supabase email auth until the new hub + portal replace it, then email auth is disabled
  for humans and `is_internal` becomes service-only (Cube/MCP).
- **D2 — Role model: namespaced boolean flags + one role field**, continuing 0056:
  `mm_staff` (live) + `mm_internal` (Phase D) + `hub_role`
  (`hub_admin|admin|staff|grower_admin|grower`) in Auth0 app_metadata, surfaced as a namespaced
  claim by an ADDITIVE Action update (v4 — coordinate with grower-portal, whose v3 staff-claim
  deploy is still pending). A roles-array claim may replace these later, additively.
- **D3 — Tenant hardening: yes** — MFA required for `mm_staff`/`mm_internal` users, admin list
  ≤ 2–3, log streaming on. Status: the staff-hub **application is CREATED** (2026-07-19,
  client_id `hp5rUj7broeZ3Uk7RH0teWpLKwLwl2DU` — details in
  `docs/mm-hub-auth0-login-kickoff.md`). MFA policy, admin-list review, and log streaming are
  dashboard-only settings (no API surface in the session's connector) — **still on Tim's
  dashboard checklist.**
- **D4 — Legacy app code location: NOT on this machine** (swept `C:\dev` for its identifiers —
  `portal_is_internal`, `gr_block_tags`, `hub_users`; only documentation in this repo matches).
  Tim to name the repo/host before Phase E retirement planning; nothing else blocks on it.

Phase B kickoff handover for the mm-hub repo: `docs/mm-hub-auth0-login-kickoff.md`.

## Suggested sequence and sizing
| Phase | Owner | Size | Blocks on |
|---|---|---|---|
| A — tenant config | Auth0 dashboard | hours | nothing (do now) |
| B — staff hub login | mm-hub repo | 2–4 sessions | A |
| C — provisioning/onboarding | grower-portal repo | its admin-phase sprint | A (B helps) |
| D — hub internal path | mm-data-hub | 1 session | a real trigger (see phase) |
| E — legacy retirement | cross-repo / ops | gradual | D1 decided |

Nothing in this scope is built yet except what 0056 already delivered. The next concrete step
after decisions: Phase A (config) + the Phase B kickoff in the mm-hub repo.
