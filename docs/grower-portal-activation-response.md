# mm-data-hub → grower-portal: portal activation — response (2026-07-21)

Response to "Ask to mm-data-hub: grower portal activation" (Sprint 22). Status: **SHIPPED —
migration `0059` live on the hub, all proofs green.** Both pieces are exactly as asked, with
three security hardenings over the illustrative SQL (§3) that do not change the contract. Your
v3 select will light up on read; the RPC is callable now.

## 1. The contract you're built against — shipped verbatim

**Read:** `semantic.grower_directory` gains
```
portal_enabled   boolean, never null, false when never activated
```
Same staff-only gate, same rows, same v2 hierarchy columns. Your three-tier fallback resolves to
v3 immediately.

**Write:**
```sql
semantic.set_grower_portal_enabled(p_consignor_ids uuid[], p_enabled boolean) returns void
```
Argument names, order, types and return type are exactly as your already-built client calls them:
```ts
supabase.rpc("set_grower_portal_enabled", { p_consignor_ids: ids, p_enabled: true })
```
`execute` granted to `authenticated` (revoked from `PUBLIC`); the function enforces admin itself.
Atomic over the whole array, idempotent, safe to re-send an already-set value.

## 2. Admin-gated, exactly as you required — and proven

`semantic.auth0_is_admin()` (new, alongside `auth0_is_staff()` as you suggested) is true **only**
for `hub_role` ∈ {`admin`, `hub_admin`} as a JSON **string**, under the calling issuer's **own**
claim namespace. Everything else is refused with `42501` (PostgREST → 403). Proven live in
`npm run auth0:rls` §S6 — the matrix that matters to you:

| caller | RPC result |
|---|---|
| `hub_role: admin` / `hub_admin` | ✅ accepted |
| **staff (MM User), no hub_role** | ❌ 42501 |
| `hub_role: staff` / `grower_admin` | ❌ 42501 |
| grower token | ❌ 42501 |
| no claims | ❌ 42501 |
| mm-hub internal token | ❌ 42501 |
| `hub_role: admin` under the **wrong issuer** (Supabase, or the old tenant's) | ❌ 42501 |
| `hub_role` smuggled in `app_metadata`, or `"ADMIN"`, `" admin "`, `["admin"]`, `true` | ❌ not admin |

Also proven: **authorization is checked before argument validation** (a staff caller sending bad
args still gets 42501, never a hint about the payload), and **admin widens no data surface** — an
admin-without-staff token reads **0** directory rows and 0 rows on all 7 grower relations. Admin
is a write gate, not a read grant. The staff/grower contracts (0056/0057) are untouched.

## 3. Three hardenings over the illustrative SQL (contract unchanged)

1. **`set search_path = ''`** instead of `= semantic, core, public`. A `security definer`
   function with a writable schema on its search_path is the classic privilege-escalation
   vector — any unqualified reference can be shadowed. Everything inside is schema-qualified.
2. **`revoke execute … from public`.** Postgres grants EXECUTE to PUBLIC by default; on a
   definer-mode write path that would expose it to `anon`. Now `authenticated` only.
3. **Unknown consignor ids are refused loudly** (`23503`, nothing applied) rather than silently
   skipped, and a `null` `p_enabled` is refused (`22004`) rather than coerced. `null`/empty
   arrays are a clean no-op. The table also carries a FK to `core.dim_grower` as a backstop.

These are now permanently enforced: the posture sweep gained an **A7** scan asserting that every
`security definer` function in `raw`/`core`/`semantic` is on a pinned list, pins an empty
search_path, and is not PUBLIC/anon-executable. (This is the repo's first definer function —
before 0059 there were none.)

## 4. Backing store — a separate table, deliberately

`core.portal_grower_activation (consignor_id PK → dim_grower, enabled, updated_at, updated_by)`.
**Not** a column on the grower dimension: `core.refresh_dim_grower()` rebuilds that dim on every
entity sync, and curated state living on a rebuilt dim is exactly how our charge-classification
curation gets silently reset. A separate table survives every refresh by construction. It also
gives you the audit trail — `updated_by` records the admin's JWT `sub`; the two seeded pilot
groups have `updated_by = null`, which distinguishes "seeded by migration" from "an admin did
this". No JWT role can write it directly; the RPC (running as owner) is the only path.

## 5. Seeded: the two pilot groups you named

Per your note, both are activated (resolved by grower code + the 0058 parent hierarchy, never by
hard-coded uuid) — **9 consignors**:
- **L & R Collins** — LRCOL, LRCLA, LRCTU
- **Mac Farms** — MACKF, MACBO, MACGT, MACMR, MACRR, MACSD

Everything else (91 of 100) is `portal_enabled = false` and stays that way until an admin
activates it. Deactivating a pilot group is just an RPC call, so nothing here is baked in.

## 6. Evidence (all self-derived in-run, loaders quiescent, 2026-07-21)
- `npm run auth0:rls` **232/232** — §S6 is the admin tier above; every prior grower/staff/
  tenant section re-proved unchanged (`reports/auth0_rls_proof_2026-07-21.txt`).
- `npm run portal:verify` **33/33** — §F9: `portal_enabled` never null; enabled set == exactly
  the 9 pilot consignors derived in-run; every enabled row is backed by an activation row
  (default-false holds); staff-token write refused 42501. F1–F8 unchanged
  (`reports/grower_portal_fixes_2026-07-21.txt`).
- `npm run rls:posture` **105/105 · 0 anomalies** (new relation registered under a new
  `staff-readable` class; A7 definer scan clean) · `rls:multifarm` **50/50** · typecheck clean ·
  unit tests **139/139**.
- Every RPC call in every proof runs inside a transaction that **rolls back** — the suites stay
  read-only against prod.

## 7. Adversarial review (30 agents, 2026-07-21) — zero surviving findings

Because this is the repo's first `security definer` write path and first privilege tier above
staff, the change was attacked by four independent lenses (definer escalation, claim forgery,
data integrity, posture/consumer drift), and every candidate finding was then put to two
independent verifiers (a refute-by-default skeptic and an exploit engineer asked to name the
exact caller and payload). **No finding survived.** Two conceded facts were acted on anyway:

1. **Seed re-run safety (fixed).** The seed's `on conflict do update` would, if the migration
   were ever re-executed against a live database, revert an admin's considered deactivation of a
   pilot group *and* leave that admin's `sub` in `updated_by` beside a fresh timestamp —
   silently undoing curation and misattributing the undo. Now `on conflict do nothing`: the seed
   is a first-run default only, and admin decisions always win. The applied production state is
   byte-identical either way (all 9 rows were inserted into an empty table), so this is re-run
   safety, not a state change.
2. **Recorded residual, not reachable today.** The Hub MCP's `run_select` keyword guard scans
   for `\bset\b`, which does not match `set_grower_portal_enabled` (underscore is a word
   character), so that string survives the guard. It is inert: an MCP caller's claims are the
   `app_metadata` shape with **no Auth0 issuer**, so `auth0_is_admin()` is false → 42501, and
   the MCP always rolls back. It would only matter if the Hub MCP ever carried an Auth0-issued
   token — the same class of invariant as 0050's FUTURE-ISSUER rule. Noted in the migration
   header and tracked as separate MCP-side hardening; no change to this surface.

Notable *refuted* claims, for the record: dual-issuer acceptance in the admin helper is the
deliberate 0057 cutover idiom (nothing mints `hub_role` on the old tenant, and the only actor
who could — an Auth0 tenant admin — already holds strictly greater capability via `mm_staff`),
and the "admin can escalate" scenarios all reduce to the tenant-admin residual Tim already
accepted, whose blast radius here is a reversible, audit-stamped visibility flag that opens no
data surface.

## 8. Two things worth knowing

1. **`hub_role` must actually be minted.** The `mackays-claims` Action on the `mackaysmarketing`
   tenant already emits `<ns>/hub_role` from `app_metadata.hub_role` (validated against
   `hub_admin|admin|staff|grower_admin|grower`). For the Admin card to work, the admin user needs
   `app_metadata.hub_role = "admin"` (or `hub_admin`) set in Auth0 — **and** `mm_staff: true` to
   read the directory at all. A user with hub_role but no staff flag can write but sees nothing;
   a user with staff but no hub_role sees everything and can write nothing (the MM User case,
   which is the point).
2. **Old tenant:** `hub_role` is only minted by the new tenant's Action, so admin is effectively
   new-tenant-only today. The helper resolves namespace by issuer like its siblings, so it needs
   no change at cutover cleanup (0060) beyond dropping the old branch with the rest.

## 9. Answering the ask's open items
- **Backing store:** our call, taken — separate table (§4).
- **Column name:** `portal_enabled`, as asked.
- **RLS/policy on the 7 grower views:** unchanged, as you specified. This is directory
  visibility only; the portal's UI gating is not a security boundary and we haven't made it one.
