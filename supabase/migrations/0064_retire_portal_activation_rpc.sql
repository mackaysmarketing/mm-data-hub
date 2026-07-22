-- 0064_retire_portal_activation_rpc — the grower-portal admin write path is retired; activation is
-- curated in this repo (2026-07-22).
--
-- Tim, 2026-07-22: "I just want to hand select the growers that are able to access the portal and
-- for that status to be maintained on the data-hub side rather than via the admin UI on the
-- grower-portal side." Then, on how to close the second write path: "go with the friendly break".
--
-- ═══ WHAT CHANGES ════════════════════════════════════════════════════════════════════════════
-- `semantic.set_grower_portal_enabled(uuid[], boolean)` keeps its EXACT signature — grower-portal
-- is already built against it, so the call still resolves and PostgREST still routes it — but it
-- no longer writes. An admin caller now gets a specific, actionable error instead of a silent
-- toggle that the next `npm run portal:activate` would quietly revert.
--
-- THE SOURCE OF TRUTH IS `src/config/portal_activation.ts` in mm-data-hub, applied by
-- `npm run portal:activate -- --apply`. Git is the audit trail.
--
-- ═══ WHY THE ADMIN GATE STAYS FIRST ══════════════════════════════════════════════════════════
-- Authorization is still evaluated BEFORE the retirement notice, deliberately:
--   • an unauthorized caller must not learn anything about the endpoint's state — growers, staff,
--     no-claim, wrong-issuer and mm-hub-internal callers still get 42501, exactly as before;
--   • the 0059 security posture (and every proof of it) is unchanged;
--   • only a caller who WOULD have been allowed to write is told the path is retired — which is
--     precisely who needs to read the message.
--
-- The retirement raise sits immediately after the gate, so argument validation is now unreachable:
-- the call is refused whatever the arguments are. That is intended — there is nothing to validate
-- for an operation that cannot happen.
--
-- ═══ WHY IT STAYS SECURITY DEFINER ═══════════════════════════════════════════════════════════
-- It no longer needs owner rights, but keeping the function shape identical (definer, empty
-- search_path, EXECUTE never granted to PUBLIC) means the rls_posture A7 definer sweep and its
-- pinned list need no change, and re-enabling is a one-line revert if Tim ever wants the UI back.
--
-- ⚠ CROSS-REPO: this is a deliberate, visible break of grower-portal's admin toggle. Their page
-- will surface the message below rather than appearing to succeed. Coordinate before deploying.

create or replace function semantic.set_grower_portal_enabled(
  p_consignor_ids uuid[],
  p_enabled       boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $func$
begin
  -- (1) AUTHORIZATION FIRST — unchanged from 0059. Staff (MM Users), growers, no-claim and
  -- wrong-issuer callers all land here. 42501 = insufficient_privilege (PostgREST → 403).
  if not semantic.auth0_is_admin() then
    raise exception 'not authorised: semantic.set_grower_portal_enabled requires hub_role admin or hub_admin'
      using errcode = '42501';
  end if;

  -- (2) RETIRED (0064). Authorized, but this write path no longer exists.
  -- 0A000 = feature_not_supported (PostgREST → 501).
  raise exception 'grower-portal activation is no longer set from the portal admin UI'
    using errcode = '0A000',
          detail  = 'Portal access is curated in the mm-data-hub repo: src/config/portal_activation.ts, '
                 || 'applied with "npm run portal:activate -- --apply". Every change is a reviewed git '
                 || 'diff with a stated reason.',
          hint    = 'Ask the data-hub maintainer to add or remove the grower in that file. '
                 || 'core.portal_grower_activation must not be written from any other path.';
end $func$;

comment on function semantic.set_grower_portal_enabled(uuid[], boolean) is
  'RETIRED 0064 — signature preserved for grower-portal compatibility, but it no longer writes. Non-admin callers are still refused 42501 (0059 authorization unchanged, and checked FIRST so an unauthorized caller learns nothing); an admin caller gets 0A000 with a pointer to src/config/portal_activation.ts in mm-data-hub, which is the source of truth (applied by npm run portal:activate). Kept SECURITY DEFINER with an empty search_path so the rls_posture A7 pinned definer list is unchanged and re-enabling is a one-line revert.';
