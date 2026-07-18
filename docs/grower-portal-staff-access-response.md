# mm-data-hub → grower-portal: staff claim + staff RLS + grower directory — response (2026-07-18)

Response to "Ask to mm-data-hub: staff claim + staff RLS + grower directory" (grower-portal
Sprint 18). Status: **AGREED WITH HUB-SIDE AMENDMENTS — AND NOW BUILT: migration `0056` is LIVE
on the hub, all proofs green** (see §6 evidence). Tim signed off the §5 posture change
2026-07-18 (stated direction: ALL user auth moves to Auth0 — growers and, later, the internal
staff hub). The portal can proceed with its §6 sequence (flag the test user, deploy Action v3,
smoke). Companion contracts: `docs/mm-hub-auth0-integration.md` (0050) and
`docs/grower-portal-fix-pack-response.md` (0053–0055).

Terminology note (same as the fix pack): the RLS behind the 7 grower views lives in **this repo
(mm-data-hub)**, not the mm-hub app repo. "mm-hub agrees" in the ask means this repo; nothing
here waits on the mm-hub app.

## 1. Token contract (§2 of the ask) — agreed as written

The claim design is right and matches the 0050 rigor we will hold it to:

- `https://grower-portal.mackays.com.au/staff`, literal boolean `true`, **absence is the
  negative**. The hub will parse it STRICTLY: honored only when the token's `iss` is exactly
  `https://grower-portal.au.auth0.com/` (trailing slash included) AND the claim's JSON type is
  boolean AND its value is `true`. A string `"true"`, number `1`, `false`, a nested object, a
  wrong/missing issuer, or a Supabase-issued token carrying the namespaced claim → not staff,
  fail closed. (Stricter than `is_internal_claim()`'s truthy-list — deliberate; the contract
  says literal `true`, so anything else is malformed.)
- The Action diff is correct (literal `true` only when `app_metadata.mm_staff === true`, both
  tokens, absence otherwise). `role` stays hardcoded `authenticated` — that remains the
  platform-level residual the DB cannot defend (0050 header / CLAUDE.md).
- Claims coexisting (staff + grower) works by construction: permissive policies OR.
- **No deployment-ordering hazard**: the claim is ignored until the hub honors it, and the hub
  predicate is inert until a token carries it — both orders fail closed. The only ordering rule
  is the standing 0050 one: the hub migration and its proof-script updates land together, and
  the migration is applied before the standing suite runs.

## 2. Ask A (staff predicate on the 7 grower relations) — agreed, with two amendments

**Amendment 1 — separate additive policies, not an edit to the existing predicate.** The ask
sketches `... OR staff` appended to the existing policy qual. The hub will instead add a THIRD
permissive policy per relation, `auth0_staff_read_*`, with qual = the staff helper alone. Same
OR semantics, but the §3 requirement "grower access bit-for-bit identical before and after"
becomes true **by construction** — the `grower_own_*` (mm-hub) and `auth0_grower_own_*`
(0050/0054) policies are not touched at all, and the proofs that hard-pin those two policy sets
stay valid unmodified.

**Amendment 2 — a dedicated issuer-pinned helper**, `semantic.auth0_is_staff()`, mirroring
`semantic.auth0_consignor_ids()` (0050) exactly: parse-with-handler, exact-issuer check, strict
boolean-true check, `stable`, `search_path=''`, EXECUTE revoked from public / granted to
`authenticated` only. Staff is **never** read through `is_internal_claim()` — the 0050 trust
partition (each issuer's claims flow only through its own helper) is preserved untouched,
including the deny guards.

Scope, confirmed as the ask states it:

- The predicate lands on the **7 base relations** behind the views (`raw.ft_dispatch_load`,
  `raw.ft_pallet`, `core.dim_grower`, `core.fact_settlement_bill`, `core.fact_gp_settlement`,
  `core.fact_gp_settlement_load`, `core.fact_load_sale`) — the views are `security_invoker`,
  so staff read-all flows through all 7 automatically.
- SELECT only. The portal's key has no write path; these policies are `for select`.
- **Staff ≠ internal.** The staff claim opens the GROWER-SCOPED surface plus the directory —
  nothing else. Internal-only relations (customer book / `dim_customer`, AR, orders, scan,
  insight, `grower_scorecard`, `recon_settlement_source`) never reference the new helper and
  stay closed to every Auth0 token, staff or not. Consignee names remain invisible to portal
  staff (`grower_load_sale` carries `retailer_group` only — 0054 posture). If portal staff ever
  need an internal surface, that is a new ask, not an extension of this claim.

## 3. Ask B (grower_directory) — agreed, with one load-bearing design note

**RLS on the underlying table cannot deliver "zero rows for growers" here.** The directory will
be a `security_invoker` view over `core.dim_grower`, and a grower token legitimately reads its
OWN dim_grower rows — so without more, a grower would see themselves in the directory (a leak of
nothing, but a violation of the stated contract and of least surprise). The view therefore gets
an **explicit staff gate in its WHERE clause** (`semantic.auth0_is_staff()`), the same pattern as
the 0035 `recon_settlement_source` explicit `is_internal_claim()` gate. Grower token → gate
false → 0 rows, regardless of their dim_grower policies. Staff token → gate true, and Ask A's
staff policy on `dim_grower` supplies the all-rows read underneath.

Proposed contract for `semantic.grower_directory`:

| column | source | notes |
|---|---|---|
| `consignor_id` | `dim_grower.consignor_id` | uuid, the identity key everywhere |
| `consignor_name` | `dim_grower.org_name` | text |
| `farm_code` | `dim_grower.code` | text, the grower code (LRCLA, WADDA, …) |
| `is_active` | `dim_grower.is_active` | portal decides whether to show inactive |

Baked-in filters: `is_grower = true` and `is_test = false` — the `*TEST` consignors
(SPEC §9.4) must never appear in an onboarding list. One row per consignor (`dim_grower` is
keyed on `consignor_id`; the active entity row already wins at build time). No
`grower_key`/`grower_name` grouping columns — see §4 Q1. Hundreds of rows, SELECT only, gate =
staff claim only (mm-hub internal tokens don't need this view; they read `dim_grower` directly).

## 4. Answers to the §7 open questions

**Q1 — grouping entity: none exists hub-side; the portal groups.** One caution so nobody is
misled: the `grower_key` column on the existing grower views is **`consignor_id` aliased**
(0008: "grower_key = load consignor"), NOT a grouping key — do not build grouping on it. The
FreshTrack entity master carries no grower→consignors grouping, so the hub never landed one; the
only place the grouping exists today is auth metadata (`app_metadata.consignor_ids` on both
identity paths — e.g. the LRCLA+LRCTU pair is one grower only because its Auth0 user says so).
Practical consequence: the Auth0 tenant (soon: the portal's onboarding flow) is the system of
record for grouping, so the portal grouping by its own onboarding data — falling back to
`consignor_name` — is the right call. If a durable hub-side grouping dim is wanted later, its
source would be the onboarding flow feeding the hub, which is a new (small) ask.

**Q2 — boolean vs role array: boolean, as proposed.** It matches the fail-closed strict parse
(§1), and future roles don't break it: new roles arrive as additive new claims (or a later
migration to an array, with the hub honoring both during transition — additive-only contract
evolution, same rule as the metric contracts). Also note: grower-admin vs grower-user are
portal-authorization concerns that don't change ROW scope, so they likely never reach hub RLS
at all — no reason to pre-build a role array for them.

**Q3 — confirmed, out of scope.** The five `using (true)` public tables are mm-hub's schema;
this repo cannot touch `public` (ownership boundary, CLAUDE.md). The FIX-3 audit
(`docs/mm-hub-public-rest-audit-2026-07-17.md`) stands as written — and it is unchanged by this
ask: a staff token is just an Auth0 token with one extra claim no `public` policy references.

## 5. The one real posture change — SIGNED OFF (Tim, 2026-07-18)

0050's documented guarantee was: *"a tenant compromise can at worst widen GROWER scope via its
own claim (never internal)"* — and CLAUDE.md says *"Auth0 tokens are grower-only."* This ask
deliberately revises that. After it lands:

- A compromised tenant Action, or a rogue/phished **Auth0 tenant admin** flipping
  `mm_staff: true` on any user, grants **read of the entire grower-scoped surface** (every
  grower's dispatch, settlement, and retailer-sales rows) **plus full grower enumeration** via
  the directory.
- In practice this is a bounded widening, not a new class of exposure: a compromised Action
  could already assert arbitrary `consignor_ids`, so it could already read any grower whose
  uuid it knew — the staff claim removes the need to know uuids (and the directory hands them
  out). Internal-only data stays unreachable either way (§2).
- Mitigations, all portal-side: the existing tenant-lockdown residual gets more important;
  `mm_staff` becomes a security-critical bit — keep the staff set tiny, and log/review
  Management-API and dashboard changes to it (Auth0 tenant logs cover this).

Tim accepted this on 2026-07-18 — his stated direction is that ALL user auth moves to Auth0
(growers and the internal staff hub), which makes the Auth0 tenant the intended control point
for staff access, not an incidental risk. The 0050 language ("grower-only" → "grower-or-staff;
staff = grower-surface-wide read, never internal") is amended in the 0056 migration header and
CLAUDE.md. The FUTURE-ISSUER invariant is unaffected (the new helper is issuer-pinned like the
rest; enabling any additional third-party issuer still requires extending the deny guards).
Note for later: moving the internal staff hub (mm-hub) itself onto Auth0 is a SEPARATE future
change — it needs an Auth0→internal claim design and an mm-hub app migration; 0056 deliberately
does not open any internal surface.

## 6. Built and proven (2026-07-18): migration `0056_auth0_staff_rls` + pinned-set updates

All of the following is live on the hub (`data_hub`, applied via MCP `apply_migration`):

1. **Migration `0056_auth0_staff_rls`**: `semantic.auth0_is_staff()` + 7 × `auth0_staff_read_*`
   policies + `semantic.grower_directory` (invoker view, explicit gate, authenticated grant).
2. **Pinned sets, same change**: `scripts/rls_posture.ts` (grower-scoped class now REQUIRES the
   third policy quals exactly `semantic.auth0_is_staff()`; directory registered; helper added to
   the A6 preflight) and `scripts/auth0_rls_proof.ts` (S1–S5 staff sections); CLAUDE.md amended.
   `rls_multi_farm_proof` needed no change (its pins are name-prefixed and untouched — verified
   by a green run, not assumption).
3. **Evidence (all run 2026-07-18, self-derived in-run, no hardcoded counts)**:
   - `npm run auth0:rls` **140/140** (report `reports/auth0_rls_proof_2026-07-18.txt`) —
     staff token == owner totals on all 7 relations; every grower view staff == mm-hub-internal
     parity; hybrid staff+grower = staff (OR); forgeries all fail closed (`"true"` string, `1`,
     `false`, `[true]`, wrong/missing/Supabase iss, un-namespaced `app_metadata.mm_staff`);
     staff ≠ internal (customer book/orders = 0, etl/ungranted = permission denied);
     directory: staff = 100 growers (non-test), grower/mm-hub-internal/no-claim/forged = 0.
   - `npm run rls:posture` **104/104** · `rls:multifarm` **50/50** (grower path untouched) ·
     `portal:verify` **24/24** (grower regression: pair still 238 loads / 104 schedules / 240
     sales) · typecheck clean · unit tests 139/139.
4. **Now the portal's turn** (the ask's §6 sequence): flag `mm_staff: true` on
   tim@mackaysmarketing.com.au in the Auth0 dashboard, deploy Action v3 (the §2 diff), then run
   the portal smoke: staff token reads all 7 views unscoped + the 100-grower directory; grower
   token gets 0 directory rows; existing grower totals identical. No ordering hazard either way
   (both sides fail closed until the other is live).
