# To grower-portal: the activation admin UI is retired (mm-data-hub 0064)

**From:** mm-data-hub · **Date:** 2026-07-22 · **Status:** applied to prod
**Action needed from you:** remove or disable the activation toggle in the admin UI.

## What changed

`semantic.set_grower_portal_enabled(uuid[], boolean)` **no longer writes.** The signature is
unchanged, so your call still resolves and PostgREST still routes it — but an authorized admin
caller now gets:

```
code:   0A000                     (feature_not_supported → HTTP 501)
message: grower-portal activation is no longer set from the portal admin UI
detail:  Portal access is curated in the mm-data-hub repo:
         src/config/portal_activation.ts, applied with
         "npm run portal:activate -- --apply". Every change is a reviewed git
         diff with a stated reason.
hint:    Ask the data-hub maintainer to add or remove the grower in that file.
         core.portal_grower_activation must not be written from any other path.
```

Reads are **completely unaffected**: `semantic.grower_directory.portal_enabled` works exactly as
before. Only the write path is closed.

## Why

Tim's decision (2026-07-22): activation should be hand-curated and maintained on the data-hub side
rather than through the portal admin UI. The list now lives in version control
(`src/config/portal_activation.ts`), so every change to who can see the portal is a reviewable diff
with a stated reason instead of an untracked click. Two write paths to one table was also a race
waiting to happen — the hub applier would silently revert anything set in the UI.

## What we need you to do

1. **Remove or disable the activation toggle** in the admin screen. If you'd rather leave it
   visible, surface the `detail`/`hint` text — it tells the user exactly what to do next.
2. **Don't retry or swallow the 501.** It is a permanent condition, not a transient failure.
3. Route activation requests to the data-hub maintainer.

## What did NOT change

- **Authorization is still checked first, and is unchanged.** Growers, staff-who-are-not-admin,
  no-claim, mm-hub-internal and wrong-issuer callers still get **42501** exactly as before — they
  never see the retirement message, and learn nothing about the endpoint's state.
- `auth0_is_admin()` and the `hub_role` claim are untouched. The admin tier still exists.
- Every read surface, RLS policy and grower-facing view is untouched.

## Current activation set (29)

25 consignors with a 2026 remittance in SharePoint `TullyAdmin/.../Remittances/Growers/2026`:
ALCOC, DANDY, GJFMF, JUSTE, LAUGO, LMBCO, LMBEP, LRCLA, LRCTU, MACBO, MACGT, MACRR, MACSD, NOUBC,
NOUPA, OBIFW, PRIMO, ROCKR, ROLFE, SANGH, SERAV, SERRA, SLOWE, WADDA, ZONTA.

Plus 4 parent entities retained so **parent-level logins keep working**: GJFLE, LMBFA, LRCOL,
MACKF. These have no remittance of their own — settlement lands on their farms — but the directory
groups by parent and logins are often at parent level.

Newly enabled vs the previous set: ALCOC, JUSTE, OBIFW, SANGH, DANDY (all being paid, all
previously locked out). Deactivated: GJFSD, GJFTF, LMBBF, MACMR, NOUHO, NOUNE, NOUSB, NOUST.

## ⚠ One thing worth knowing on your side

Activation gates the **directory display only**. No RLS policy anywhere in `raw`/`core`/`semantic`
references `portal_grower_activation` — every grower policy is `consignor_id = ANY(claimed set)`.
So a token whose Auth0 claim carries a deactivated consignor's uuid **still reads that consignor's
dispatch, sales and settlement**. Deactivating here does not revoke data access.

Closing that needs a grower predicate inside `semantic.auth0_consignor_ids()` (designed, not yet
built). Until it ships, **the Auth0 claim is the real access control** — whoever mints
`consignor_ids` is the gate. Please keep that in mind when provisioning users.

## Proof

`auth0:rls` 233/233 (S6 encodes the new contract: admin → 0A000, non-admin → 42501, nothing
written) · `portal:verify` 43/43 · `rls:posture` 106/106 (A7 definer sweep unchanged — the function
is still SECURITY DEFINER with an empty search_path and is not PUBLIC-executable) · tests 144/144.

Re-enabling is a one-line revert of `0064_retire_portal_activation_rpc.sql` if this turns out to be
the wrong call.
