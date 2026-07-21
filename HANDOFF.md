# Handoff (2026-07-22c): the activation list moves INTO the repo — hub is the source of truth

Status: **✅ built, applied, idempotent, proofs green.** Push manual.

Tim, 2026-07-22: *"I just want to hand select the growers that are able to access the portal and for
that status to be maintained on the data-hub side rather than via the admin UI on the grower-portal
side."*

## How it works now
**`src/config/portal_activation.ts` is THE source of truth.** A hand-curated list of `{ code, note }`
— note is mandatory. Edit the file, then:
```
npm run portal:activate              # DRY RUN — prints the diff, writes NOTHING
npm run portal:activate -- --apply   # writes core.portal_grower_activation
```
Git becomes the audit trail: every change to who can see the portal is a reviewable diff with a
stated reason, instead of an untracked click in an admin screen.

**Anything not in the list is deactivated on the next `--apply`.** Absence means no portal.

## Safety properties (all deliberate)
- **Dry run is the default**; writing needs an explicit `--apply`.
- `assertHubTarget()` before any write.
- Every code must resolve to **exactly one ACTIVE, non-test, is_grower row**. `dim_grower.code` is
  NOT unique (WADDA is active + inactive) — ambiguity is a hard stop, never a guess.
- Refuses to enable a test / inactive / non-grower consignor (checked again after the write).
- **Post-write read-back happens INSIDE the transaction** — a wrong set rolls back rather than
  going live.
- Rows are updated to `enabled=false`, **never deleted** — the audit trail is the point.
- File-level validation before touching the DB: no duplicate codes, no missing notes.
- Idempotent: a second run reports `ENABLE 0 / DISABLE 0` and writes nothing.
- Unit-tested in `tests/portal_activation_list.test.ts` (5 tests, incl. one that asserts the four
  retained parents are present and labelled, so nobody prunes them for "never being paid").

## Drift detection (the bit that matters for the cross-repo question)
The applier separates two things that look alike:
- **DRIFT** — a row whose current state came from outside this file *and disagrees with it*. Listed
  loudly; `--apply` reverts it. Currently: **0**.
- **stale provenance** — a row that already agrees but carries an older `updated_by` (e.g. the
  Auth0 admin sub from the portal UI). Not drift, just history; `--apply` re-stamps it to
  `mm-data-hub/portal_activation.ts` and deliberately leaves `updated_at` alone, because that
  column records when the STATE last changed. 21 such rows were re-stamped on the first apply.

## ⚠ OPEN — the grower-portal admin RPC is still live
`semantic.set_grower_portal_enabled()` (0059, admin-gated) still works, so a portal admin can still
toggle activation. Nothing diverges silently — the next `portal:activate` run detects it as DRIFT
and reverts it — but the portal UI is no longer the mechanism Tim wants, and two write paths to one
table is a race waiting to happen. **Not revoked here: that breaks grower-portal's admin page and
is a cross-repo change needing coordination.** Options when Tim decides: revoke EXECUTE (hard
break), make the RPC raise a "managed in mm-data-hub" error (friendly break), or leave it with
drift-revert as the guard.

## Evidence
`portal:activate` dry-run + `--apply` + idempotent re-run · `portal:verify` **43/43** ·
tests **144/144** · typecheck clean. State unchanged by this change (29 enabled, same set as 0063);
only provenance converged.

---

# Handoff (2026-07-22b): portal activation = the 2026 remittance book (0063)

Status: **✅ applied to prod, all proofs green (portal:verify 43/43 — first fully-green run this
session).** Push manual.

## The rule
Tim, verbatim: *"The growers that have remittances there are the only ones that should be included
in the grower portal"*, then *"only use the 2026 files"*.

**Source of truth = SharePoint**, TullyAdmin site:
`Shared Documents / MBM Admin / 1. New MBM / Remittances / Growers / 2026 / {month} / {pay week}`.
All **30 pay-week folders** (07.01.2026 → 15.07.2026) enumerated, every file read. One PDF per
grower per pay week. Read via the Microsoft 365 connector (`read_resource` walking from
`file:///{driveId}/root`) — **SharePoint search is NOT reliable here**: a folder-scoped search
returned 8 hits for a tree holding hundreds of files. Walk the tree, don't search it.

Excluded as non-remittances: weekly `Mackays Excel Remittance *.xlsx`, `EXCEL` subfolders,
lot/load-adjustment PDFs, a stray `debug.log`. Folded into their farm (separate PDF, no separate
dim row): "Rolfe Papaya" → ROLFE, "Mackays Gold Tyne Passionfruit" → MACGT.

## The result: 32 → 29 enabled
- **25 consignors have a 2026 remittance** — ALCOC DANDY GJFMF JUSTE LAUGO LMBCO LMBEP LRCLA LRCTU
  MACBO MACGT MACRR MACSD NOUBC NOUPA OBIFW PRIMO ROCKR ROLFE SANGH SERAV SERRA SLOWE WADDA ZONTA.
- **+4 parents retained by Tim's explicit decision** — MACKF, LRCOL, LMBFA, GJFLE. They have NO
  remittance (settlement lands on their farms) but are the 0058 grouping entities and logins are
  often at parent level; deactivating them would strand a parent login while its farms stayed live.
  **A deliberate exception to the rule, not an oversight.**
- **+5 newly enabled — growers being paid but locked out of the portal:** ALCOC (11 schedules in
  2026), JUSTE (11), OBIFW (7), SANGH (4), DANDY (1).
- **−8 deactivated (row kept, enabled=false — the audit trail is the point):** GJFSD, GJFTF,
  LMBBF, MACMR, NOUHO, NOUNE, NOUSB, NOUST.

## Corroboration — the folder and hub settlement agree independently
| code | SharePoint 2026 | core.fact_gp_settlement |
|---|---|---|
| SANGH | 4 "Sangha Bros" PDFs: 18.02, 04.03, 11.03, 18.03 | 4 schedules, last payable **2026-03-18** |
| DANDY | 1 PDF: 08.07.2026 | 1 schedule, payable **2026-07-08** |
| OBIFW | Mar/Apr/Jun | 7 schedules, last 2026-07-01 |
| JUSTE | Jan–Jul | 11 schedules, last 2026-07-01 |
| ALCOC | Jan–May | 11 schedules, last 2026-05-06 |
| LMBBF, GJFLE | **absent from 2026** | **0 schedules in 2026** (last 2025) |

Plain "Flegler Remittance" → **GJFMF**: every disambiguated filename says "Mareeba Farm", and GJFMF
has 27 schedules in 2026 vs GJFLE's 0.

## Traps handled
- **`dim_grower.code` is NOT unique** — WADDA exists twice (active "Wadda Plantation" + inactive
  "Wadda Plantation - Gallaghers"). 0063 resolves by **code + is_active** and RAISES if any code
  fails to resolve to exactly one active row, rather than activating the wrong entity.
- **F9 in `portal:verify` was a frozen membership list** (the 9 pilot consignors) — the hardcoded
  baseline CLAUDE.md forbids; it rotted the moment an admin used the 0059 RPC and would have rotted
  again here. **Replaced with invariants + a reported set:** portal_enabled never null · directory
  enabled == activation-store enabled · **no test / inactive / non-grower consignor is ever
  portal-enabled** · every enabled row backed by an activation row · staff cannot toggle.

## ⚠ What this does NOT do
`portal_grower_activation` feeds exactly ONE display column (`grower_directory.portal_enabled`).
**No RLS policy anywhere references it.** Deactivating a consignor removes it from the portal's
directory; it does NOT revoke data access — a token whose Auth0 claim carries that consignor's uuid
still reads its dispatch, sales and settlement. Closing that still needs the claim-side grower gate
in `semantic.auth0_consignor_ids()` (designed, still on hold).

## Evidence
`portal:verify` **43/43** · `rls:posture` **106/106 · 0 anomalies** · `auth0:rls` **232/232** ·
tests **139/139** · typecheck clean.

---

# Handoff (2026-07-22): grower classification override (0062) + two audits — DECISIONS PENDING

Status: **✅ 0062 built, applied to prod, proofs green. Both audits complete and filed. Everything
else HELD at Tim's instruction — do not build further without his call.** Push manual.

## What landed — `0062_grower_classification_override`
`core.dim_grower.is_grower` is a verbatim copy of a FreshTrack checkbox, and `refresh_dim_grower()`
rebuilds it on every entity sync — so a manual `update` is reverted by the next
`npm run load:entities`. Same lesson as `dim_gp_charge.revenue_class` / `portal_grower_activation`
(0059): **curated state never lives on a rebuilt dim.**
- `core.grower_classification_override` (consignor_id → dim_grower, is_grower, **mandatory reason**,
  updated_at/by), applied inside `refresh_dim_grower()`. Internal-only posture, **no write policy
  for any JWT role** (service_role/migration only; add an admin-gated definer per 0059 if the portal
  ever needs to curate it).
- `dim_grower.is_grower` stays the column every consumer reads and is now the **EFFECTIVE** value;
  the untouched source is preserved as **`is_grower_source`**, so drift is visible and an override
  is provably retirable once upstream is corrected. Never silently permanent.
- Seeded: **AGSCU "Sculli - Agent" = false.** The only `AG*`-coded entity flagged true (the other
  ten are false). **Cannot be fixed in FreshTrack** — clearing Grower? crashes the vendor app with
  `'NoneType' object has no attribute 'is_grower'`: AGSCU carries a Farm association, FreshTrack
  requires a Farm's contact-or-parent to be a supplier/grower, and the parent SCULL has **no
  supplier record**. AGSCU is **1 of 105 farm entities in that shape** — nobody has hit the path
  before. Its farm is vestigial (0 pallets, 0 gp_detail rows). Vendor bug; repro sent.
- Effect: `grower_directory` 100 → 99. AGSCU has no activation row → no portal user affected.
- Evidence: `rls:posture` **106/106** · `auth0:rls` **232/232** · `portal:verify` **41/42** ·
  tests **139/139** · typecheck clean. (The 1 failure is the pre-existing F9 frozen-baseline issue
  documented in the 0061 handoff below — still Tim's call.)

## Two audits — `docs/audit-is-grower-classification.md`, `docs/audit-annrd-processing-purchased-stock.md`
Multi-agent, every finding re-derived by an adversarial verifier re-running the SQL. **Read these
before acting on anything below.** (is_grower audit: 4 of 13 agents died on connection errors,
including the whole buyloads track — its Buy-load detail is thinner than the rest.)

**Assumptions that did NOT survive:**
- **`order_type='B'` is a LEG type, not commercial terms.** 62.8% of Buy loads are consigned by
  `is_grower=true` entities vs 41.7% of Sell loads; **73% are consigned to a Mackays site**
  (MMTRU 1,813 · MMANN 440 · MMLAR 317). B = fruit arriving at our own DC, and Buy loads settle
  through the commission mechanism with a full deduction ledger.
- **Ann Rd is RIPENING / cross-dock, not freezing.** $674,792 of `WH - Ripening - Ann Rd`; the one
  frozen charge in the rate card has been **applied 0 times**. Freezing = MMPRO/MMLAR. The hub has
  no site/address table, so whether MMPRO physically sits at Ann Rd is unanswerable here.
  **⚠ Excluding Ann Rd would delete $12,035,467.12 of genuine grower settlement** across 12
  portal-enabled growers — its loads are reconsignment ORIGINS; the $0-gross appearance is a grain
  artefact.
- **The agents are on the standard commission rate card** (median 4.39%, same as growers, retail
  rebate passed through). No purchase-price or fixed-$/box line exists anywhere in GP charge data.
- **`raw.ft_gp_detail.processing_id` is NOT a processing flag** — non-null on all 25,119 rows
  including ordinary Coles/WOW fresh settlement, and joins to nothing landed (0 matches across 14
  FreshTrack PKs). **The price ladder is dead too** (`price_paid_value` 1.5% populated; quoted ==
  invoiced 99.86%).

**What IS true:**
- The processing/freezing stream is cleanly identifiable (7 products; MMPRO/MMLAR; 607 loads) and
  has **ZERO GP settlement rows**. Nothing to exclude.
- Purchased stock IS separable **on the NetSuite surface**: **82 commission-free, deduction-free,
  single-line bills, $519,142.40**, item `910128`, vs 1,085 bills carrying commission at
  3.000–4.566%. Perfect separation. **Caveat: all three vendors are Mackays' own farms
  (MACBO/MACSD/MACGT), every line `INTERCOEXPENSE` — related-party, not arm's-length.** Sibling
  item `910129` "Mackays Growers - 1kg" exists with 0 lines.
- **13 `dim_grower` rows contradict their own FreshTrack tags** (AGSCU handled; 12 pending).
  **No false negatives** — no `is_grower=false` entity outside the six agents has any settlement,
  so tightening locks nobody out.

## ⚠ SECURITY FINDING — surfaced, NOT yet fixed (Tim's call)
**Portal activation gates nothing but a display column.** No RLS policy anywhere in
`raw`/`core`/`semantic` references `is_grower`, `is_test`, `order_type`, or activation — every
grower policy is `consignor_id = ANY(claimed set)`, and `auth0_consignor_ids()` never joins
`dim_grower`. **The only gate is whoever edits the Auth0 claim.** Proven live: a minted MMTRU claim
reads **$95,918,521.15** of load-sale revenue + 54,147 pallet rows; an AGDBM claim reads that
agent's full $1.42m settlement. Secondary: `set_grower_portal_enabled` validates only that the uuid
exists in `dim_grower`, so an admin can activate a Mackays DC or a `*TEST` consignor directly.
**Nothing is mis-exposed today** — all 32 activated consignors are genuine, active, non-test growers.
Proposed fix (NOT built): intersect the claimed set against a grower predicate inside
`auth0_consignor_ids()` / `current_consignor_ids()` — one change covers all 7 relations, every view,
Cube and the MCP.

## Held at Tim's instruction (2026-07-22) — do not build without his say-so
1. The claim-side grower gate (above).
2. Flagging the 82 commission-free NetSuite bills as purchases in `core.fact_settlement_bill`.
3. The 12 further classification overrides (QPIWA, SIMPS, COSAV, AVCOL, HAPVA, ROMEO, AVOCO, PINAT,
   STAHM, MAJES, MG; AVOLU ambiguous — tagged Vendor but a NetSuite cat-110 grower with $134,880).
4. Everything from the grower-portal NetSuite ask still unbuilt (see the 0061 handoff).
5. The F9 frozen-baseline fix in `portal:verify`.

## Open business questions blocking the above
Is the freezing at Ann Rd or is MMPRO elsewhere? · Are the 82 MACKF bills genuinely agreed-rate
purchases or just a processing-grade product line on a normal RCTI? · Do we buy processing-grade
fruit from third parties (item 910129 unused)? · Should the ~$1.2m of Buy-origin settlement on
LMBEP/LMBCO/LMBBF (all portal-enabled) be visible to those growers? · Should retailers appearing as
consignors (Coles/WOW Townsville returns) be scrubbed from the grower dimension?

## Also worth landing when someone picks this up
`raw.ft_entity` last synced **2026-07-11** — any FreshTrack reclassification since is invisible.
Re-run `npm run load:entities` (then `core.refresh_dim_grower()`) once AGSCU is fixed at source,
with loaders quiescent. And the NetSuite bill-line loader lands **no `quantity`/`rate`** and no
`item.parent` — adding them is what would let rate-per-kg be tested against commission-discovered
price, the one test that could actually settle the purchase-vs-commission question.

---

# Handoff (2026-07-21b): archived-pallet load fix + settlement origin lineage (0061)

Status: **✅ built, applied to prod, proofs green.** Push manual. Input: grower-portal ask
"NetSuite grower payments as the settlement source" (2026-07-21) — this landed the piece Tim
picked (the load-visibility fix); the other three asks are answered but NOT built (below).

## The finding — the loads were never missing; a pallet filter was deleting them
The portal reported 1,577 settlement lines ($11.5m) resolving to dispatch loads "absent from
`grower_dispatch_load`" and asked whether they were archived, filtered, or a genuine gap.
**Filtered.** `semantic.grower_dispatch_load` (0055) rolled pallets up to load grain with
`where not is_archived` — a filter written to drop pallets REMOVED from a live load. Measured live:

| shipped Sell loads with pallets | 19,205 |
|---|---|
| all pallets live (visible) | 14,577 |
| **ALL pallets archived (load vanishes)** | **4,628** |
| MIXED — what the filter was actually written for | **3** |

`is_archived` is effectively a LOAD-level flag, so grouping after the filter silently deleted the
load. Every one of the 19,042 settlement lines' origin loads **does** exist in
`raw.ft_dispatch_load` — 0 absent. The hidden loads are real, not voided duplicates: they carry
**$58,698,021 of customer invoices** (3,326 loads, 29% of all invoiced sales gross) and
**$8,952,319 of grower settlement** (752 loads); all 4,628 load_nos are unique to them; and only
4.2% are reconsignment ORIGINS (vs 26.1% of live loads) while 2,917 RECEIVED reconsigned boxes —
they sit at the END of the chain, so counting their boxes cannot double-count.
(`pallet_no` was deliberately NOT used as evidence — it is reused across loads: 48,338 pallet_nos
appear on more than one load among LIVE pallets alone.)

## What landed — `0061_grower_archived_loads_and_origin`
- **`semantic.grower_dispatch_load`:** the archived-pallet exclusion is kept for MEASURES (correct
  on the 3 mixed loads) but no longer deletes the row. Measures come from live pallets, falling
  back to the load's own pallets when none are live; **`is_archived`** appended at the tail (a
  `create or replace view` cannot reorder columns) so the portal can badge or filter — the hub
  does not decide that. **14,577 → 19,205 rows; 0 lost, 0 changed** (regression-proven).
- **`core.fact_gp_settlement_load` + `semantic.grower_gp_settlement_load`:** the ask's
  "expose `origin_load_no` directly". Denormalised at BUILD time (the 0020/0054 pattern — a grower
  invoker view must not depend on an RLS'd join that can silently drop rows):
  **`origin_dispatch_load_id` / `origin_load_no` / `origin_load_count`**. Origin =
  `coalesce(original_dispatch_load_id, dispatch_load_id)` **per detail row**; detail lines win and
  a deduction line's origin is consulted only for the 37 rows with deductions and no detail (a
  freight charge spanning the whole sale load must not blur an origin the produce pins down).
- **⚠ Where the grain genuinely cannot carry one origin:** 1,158 of 19,005 (schedule × sale-load)
  groups draw from **more than one** origin load. `origin_load_count` states it; `origin_*` are
  **NULL rather than an arbitrary pick**. (`original_dispatch_load_id` has always been a `max()`
  over the group — an arbitrary pick — left untouched for compatibility; prefer `origin_*`.)

## The 1,577 bucket, fully partitioned — $0 unexplained
| bucket | lines | |
|---|---|---|
| origin resolved and visible in the view | 16,841 | of which **860 recovered by this fix** |
| pooled — grain draws from >1 origin ($13.6m) | 1,158 | now flagged, not silently collapsed |
| **`order_type = 'B'` (Buy) loads** ($4.04m) | 1,043 | shipped, in raw, with pallets — excluded by the Sell-only gate |
| unexplained | **0** | |
| | **19,042** | |

**Open question for Tim:** the last 1,043 lines are settled **Buy** loads. `grower_dispatch_shipped`
is Sell-only (`order_type = 'S'`), a baked-in governed contract mirrored from the Cube dispatch
metric. Should a grower see Buy loads they were settled for? That is a business call, and relaxing
the gate would redefine an existing metric (forbidden as a silent change) — so it was NOT touched.

## Evidence (2026-07-21, self-derived, loaders quiescent)
`portal:verify` **41/42** (new §F10 origin lineage + §F4 rewritten to the new contract with an
explicit pre-0061 regression guard: lost=0, changed=0) · `rls:posture` **105/105 · 0 anomalies** ·
`auth0:rls` **232/232** · `ft:gp:reconcile` drift PASS, cash 1225/1277 within 1%, NetSuite Δ −0.43%
(unchanged — the rebuild did not move money) · typecheck clean · tests **139/139**.

**The one failure is PRE-EXISTING and unrelated to 0061:** `portal:verify` §F9 asserts the enabled
set equals the 9 seeded pilot consignors, but **32 are now enabled** — an Auth0 admin
(`auth0|6a5d13b7ae26d3ed16e6adc0`) activated 23 more on 2026-07-21 10:24–10:25 UTC through the 0059
RPC, i.e. the write path working as designed. The assertion is a frozen membership list — exactly
the hardcoded baseline CLAUDE.md forbids. It should become a self-deriving invariant (the
"every enabled row is backed by an activation row" check beside it already passes). **Not changed
here — Tim's call**, since it is the guard on the activation surface.

## Answered but NOT built (the rest of the ask)
1. **The NetSuite ↔ FreshTrack key EXISTS.** `ns_vendor_bill.tranid` is structured
   `yyww-CODE[-CROP][-N]` where `ww` = `ft_gp_schedule.week_no` and CODE = grower code (10/10
   consecutive weeks on MACSD). **(grower_code, date) is NOT 1:1** — 152 crop-split bills
   (`2625-SERRA-AVOCADO`), 78 side bills (`MACKF 2627 - MACBO`). Aggregated to (code, year, week):
   912 cells both sides, **781 tie to the cent**, 131 differ ($12.1m), 59 NS-only, 187 GP-only.
   Drivers: MACBO (+$7.6m NS-only against −$6.7m differs — an offsetting shape = week/year
   misalignment), SERRA/SERAV (crop-split bills use a different code than the schedules), AG*
   sub-entity granularity (known). A real `core.crosswalk_ns_gp_settlement` is buildable and
   provable; the portal must not infer it from dates.
2. **Produce-grain money is ALREADY LANDED and already exact** — no new ingestion needed for the
   headline ask. Bill `2625-MACSD` out of `raw.ns_vendor_bill_line` today: produce 401,943.00 −
   MD 37,986.12 − FR 9,724.19 − WH 3,512.40 − GST 3,729.85 = **−346,990.44, the bill total to the
   cent**. 260 product items already classified PRODUCT in `core.dim_ns_charge`; `displayname` is
   structured (`BananaCavendishPremium XL15kg CartonGreen` — Carton vs Collars/Bands is right
   there). **Missing:** `quantity`/`rate` on lines and `item.parent` (the loader selects 4 item
   columns) — a small loader extension. The ask's "hierarchy is incomplete" worry is moot: the hub
   already classifies by `itemid` prefix, which is the rule the ask recommends.
3. **`PA` = "Payable"** (FreshTrack DR/PA/PD). It does **not** mean unpaid: all 33 PA schedules
   have a `gp_payment` paid date, and 7 PD schedules have none. Status lags cash in both
   directions — the cash is the truth, which is what `consignment_status` already encodes (0055).
4. **Customer transparency:** the linkage already exists — `core.fact_load_sale` (0054) is
   load × customer with `retailer_group`, exposed as `semantic.grower_load_sale`. What is withheld
   is the customer NAME (deliberate) and there is no `channel` field. Tim's 10% rule changes the
   policy, not the plumbing.

---

# Handoff (2026-07-21): portal activation — first write path + admin tier (0059)

Status: **✅ built, applied to prod, all proofs green, adversarially reviewed (0 surviving
findings).** Push manual. Input: grower-portal Sprint 22 ask. Cross-repo response:
`docs/grower-portal-activation-response.md`.

## What landed
- **`0059_grower_portal_activation`:** `core.portal_grower_activation` (consignor_id PK → FK
  dim_grower, enabled, updated_at, updated_by) — a SEPARATE table, NOT a dim column, because
  `refresh_dim_grower()` rebuilds the dim and curated state on a rebuilt dim gets silently reset
  (the revenue_class lesson). `semantic.grower_directory` v3 gains **`portal_enabled`**
  (`coalesce(a.enabled,false)` — absence = false, so a new FreshTrack consignor never
  auto-appears). Seeded: the 2 pilot groups = 9 consignors (LRCOL+LRCLA+LRCTU,
  MACKF+MACBO/MACGT/MACMR/MACRR/MACSD), resolved by CODE + the 0058 hierarchy.
- **THE REPO'S FIRST SECURITY DEFINER FUNCTION + FIRST JWT-CALLER WRITE PATH:**
  `semantic.set_grower_portal_enabled(p_consignor_ids uuid[], p_enabled boolean) returns void`
  (signature verbatim from the ask — the portal is already built against it), gated on the new
  **`semantic.auth0_is_admin()`** (`hub_role` ∈ {admin, hub_admin}, JSON string, issuer-pinned,
  namespace-by-issuer, fail-closed). Three hardenings over the ask's illustrative SQL:
  `search_path = ''` (theirs had `public` on it — the classic definer escalation vector),
  EXECUTE revoked from PUBLIC, and loud failure on unknown ids (23503) / null p_enabled (22004).
- **ADMIN ≠ STAFF ≠ INTERNAL:** admin is a WRITE gate only — an admin-without-staff token reads
  0 rows on the directory AND all 7 grower relations (proven); staff cannot toggle (42501);
  authorization is checked BEFORE argument validation.
- **New standing guard — `rls_posture` A7:** every SECURITY DEFINER function in raw/core/semantic
  must be on a pinned list, pin an EMPTY search_path, and never be PUBLIC/anon-executable.
  (Before 0059 there were zero definer functions; now exactly one.) New posture class
  `staff-readable` for the activation table (read = `auth0_is_staff()`; NO write policy for any
  JWT role by design — writes go only through the definer RPC).

## Evidence (2026-07-21, self-derived, loaders quiescent)
`auth0:rls` **232/232** (new §S6 = the full authorization matrix; every RPC call inside a
rolled-back transaction so the proof stays read-only) · `portal:verify` **33/33** (new §F9:
portal_enabled never null, enabled set == the 9 pilot consignors derived in-run, default-false
holds, staff write refused) · `rls:posture` **105/105 · 0 anomalies** · `rls:multifarm` 50/50 ·
typecheck clean · tests 139/139.

## Adversarial review (30 agents, 4 lenses × 2 refute-by-default verifiers) — 0 survivors
Two conceded facts acted on: (1) **fixed** — the seed's `on conflict do update` would have
reverted an admin's deactivation on any re-run and misattributed it via a stale `updated_by`;
now `do nothing` (first-run default only; applied prod state byte-identical). (2) **recorded
residual, unreachable today** — the Hub MCP `run_select` guard's `\bset\b` does not match
`set_grower_portal_enabled`; inert because MCP claims carry no Auth0 `iss` (→ 42501) and the MCP
always rolls back. Would matter only if the MCP ever carries an Auth0 token — harden the guard
IN THAT CHANGE. Tracked as a separate MCP-side task.

## Numbering
The tenant-cutover CLEANUP migration is now **0060** (0058 = directory hierarchy, 0059 = this).
It must drop the old issuer/namespace from **five** helpers — `auth0_consignor_ids`,
`auth0_is_staff`, `auth0_is_admin`, plus the two deny guards. Docs updated.

# Handoff (2026-07-20): grower directory v2 — parent hierarchy (0058)

Status: **✅ built, applied to prod, all proofs green.** Push manual.
Input: grower-portal Sprint 19 ask (revised same-day: hierarchy from FreshTrack parents, NOT a
curated table — Tim's call after the first staff login rendered ~40 ungrouped consignor pills).
Cross-repo response: `docs/grower-directory-v2-response.md`.

## What landed
- **`0058_grower_directory_hierarchy`:** `core.dim_grower` + `parent_entity_id`/`parent_name`
  (denormalized in `refresh_dim_grower()` from the ALREADY-LANDED `raw.ft_entity.parent_id` —
  no loader change; build-time because raw.ft_entity is ungranted (org_tax_no) and the
  directory is an invoker view). `semantic.grower_directory` v2 exposes `entity_id` +
  the two parent columns — same rows, same staff-only gate. NO policy/RLS change.
- **Portal binding verified live:** MACKF "Mac Farms" parents exactly its 5 farms;
  LRCLA/LRCTU share parent "L & R Collins" (LRCOL), which itself parents to "Mackays Growers"
  (the umbrella their dissolution rule handles); GJFSD parent = null (as their doc predicted).
  Parent coverage 39/100 (surfaced; grows as FreshTrack parents are curated).
- **Proof: `portal:verify` F8** (drift guard dim↔raw, staff full-read parity, pair-shares-
  parent, MACKF member parity, grower→0) — **29/29** · `auth0:rls` 188/188 · `rls:posture`
  104/104 · tests 139/139.
- ⚠ Numbering: the tenant-cutover CLEANUP migration formerly promised as "0058" is now **0059**
  (docs updated).

# Handoff (2026-07-18): staff claim + grower directory (0056) — portal admin phase unblocked

Status: **✅ built, applied to prod via MCP apply_migration, all proofs green.** Push manual.
Input: grower-portal's "Ask to mm-data-hub: staff claim + staff RLS + grower directory"
(Sprint 18). Cross-repo response (contract + amendments + evidence, portal-facing):
`docs/grower-portal-staff-access-response.md`. **Tim signed off the posture change 2026-07-18**
("Auth0 tokens are grower-only" → grower-OR-staff); his stated direction is ALL user auth on
Auth0 — growers now, the internal staff hub (mm-hub) as a separate future change.

## What landed
- **`0056_auth0_staff_rls`:** `semantic.auth0_is_staff()` (issuer-pinned, STRICT boolean-true —
  string `"true"`/`1`/`false`/array all fail closed; the 0050 rigor) + additive
  `auth0_staff_read_*` policies on the 7 grower-scoped relations (THIRD permissive set —
  `grower_own_*` and `auth0_grower_own_*` untouched, grower access bit-identical by
  construction) + **`semantic.grower_directory`** (staff-only grower list for the portal's
  selection modal: consignor_id, consignor_name, farm_code, is_active; is_grower + non-test
  baked in; explicit `auth0_is_staff()` WHERE gate — REQUIRED because a grower's own dim_grower
  row would otherwise show through the invoker view; mm-hub internal tokens also get 0 rows,
  deliberate + asserted).
- **Staff ≠ internal:** the claim never opens internal-only surfaces (customer book, AR, orders,
  scan, insight) — proven (S4). `is_internal` stays mm-hub-issuer-only; 0050 deny guards
  untouched; FUTURE-ISSUER invariant unchanged.
- **Pinned sets:** `rls_posture.ts` (grower-scoped class now REQUIRES a policy quals exactly
  `semantic.auth0_is_staff()`; `grower_directory` registered semantic-invoker; helper in the A6
  preflight) · `auth0_rls_proof.ts` (S1–S5: helper semantics, policy pins, staff read-all +
  view parity vs mm-hub internal, staff≠internal, directory) · CLAUDE.md (staff bullet; "ALL
  THREE policies" rule for new grower-scoped relations). `rls_multi_farm_proof` unchanged
  (name-prefixed pins unaffected — verified green, not assumed).

## Evidence (all run 2026-07-18, loaders quiescent, self-derived in-run)
- `auth0:rls` **140/140** (`reports/auth0_rls_proof_2026-07-18.txt`): staff == owner totals on
  all 7 relations; staff == mm-hub-internal on all 7 grower views; hybrid staff+grower = staff
  (policy OR); all forgery shapes → 0/false; directory staff=100 growers, everyone else 0.
- `rls:posture` **104/104 · 0 problems** · `rls:multifarm` **50/50** · `portal:verify` **24/24**
  (grower regression: pair still 238 loads / 104 schedules / 240 sales) · typecheck clean ·
  tests 139/139.

## Portal's turn (no hub work left on this ask)
1. Flag `mm_staff: true` on tim@mackaysmarketing.com.au (Auth0 dashboard), deploy Action v3
   (the ask's §2 diff — `role` stays hardcoded `authenticated`).
2. Smoke: staff token → 7 views unscoped + 100-grower directory; grower token → 0 directory
   rows + unchanged totals. No deploy-ordering hazard (both sides fail closed alone).
3. Ops note (accepted residual): the Auth0 dashboard is now the staff-access control point —
   keep tenant admins few + MFA'd; review tenant logs for app_metadata changes.

## Deferred / notes
- **mm-hub on Auth0** (Tim's stated direction): separate future change — needs an
  Auth0→internal claim design (0056 deliberately opens no internal surface) + mm-hub app/public
  audit. Not started.
- Open question 2 of the ask (boolean vs role array): boolean shipped; future roles arrive as
  additive claims. Q1: no hub-side grower grouping entity exists (`grower_key` = consignor_id
  aliased); grouping lives in auth metadata — portal groups. Q3: the five `using(true)` public
  tables stay mm-hub's call (FIX 3 audit unchanged).

# Handoff (2026-07-17): grower-portal fix pack (0053/0054/0055) — FIX 1–7 delivered

Status: **✅ built, applied to prod via MCP apply_migration, all proofs green.** Push manual.
Input: grower-portal's handover doc ("mm-data-hub: fix instructions", 2026-07-18 their time).
Cross-repo response for the portal side: `docs/grower-portal-fix-pack-response.md`.

## What landed
- **`0053_core_gp_settlement_dates` (FIX 1):** `date_from/date_to` derived from `week_no`
  (ISO-week Monday, year = latest week-start ≤ coalesce(payable_on, created_on)) — the SOURCE
  columns are null on 1,329/1,332 and garbage on the 3 TEST rows. 1,327/1,332 derive, 0
  misaligned, 5 null-week AG* schedules stay null + `dates_derived` flag surfaced on fact + view.
  Test pair: 104 schedules, 0 null dates.
- **`0054_core_fact_load_sale` (FIX 5/7.2):** load × customer fact denormalised at build time
  from internal-only `fact_customer_invoice` × `crosswalk_customer_retail`; carries
  `retailer_group` (never consignee_name), CN subtracts, share_of_load_gross windowed. The **7th
  grower-scoped relation**: `grower_own_load_sale` + `auth0_grower_own_load_sale` + cube read-all.
  Wired into `ar:core` (order: after fact_customer_invoice; `insight:core` refreshes the crosswalk).
  12,940 rows / $206.0M; 141 pre-landing-window invoices surfaced as dropped; 0 unmapped retailers.
- **`0055_semantic_grower_load_views` (FIX 2/4/6 + the FIX 5 view):**
  - `semantic.clean_product_label()` + product cleaned in `grower_dispatch_shipped`/`_detail`
    (raw stays verbatim; `product_raw` appended; ⚠ detail view's LIVE shape includes the 0022
    origin-shed columns — `create or replace view` must preserve them).
  - `semantic.grower_dispatch_load` — load grain + `consignment_status` (Not Consigned /
    Consigned / Sold / Paid). **Connote = `manifest_no`** (no connote column exists anywhere in
    FreshTrack — replica searched; 100% populated on the pair's shipped loads). Signals exposed;
    global distribution Paid=10,807 / Sold=3,337 / Consigned=402 / Not Consigned=31.
  - `semantic.grower_load_sale` — retailer/gross/share per (load, customer), grower-readable.
- **Pinned-set updates:** `rls_posture.ts` (+3 registry entries, 103/103), `rls_multi_farm_proof.ts`
  (7 grower_own_*), `auth0_rls_proof.ts` (7 auth0 policies, +2 grower views in B8, fixture
  derivation now also requires fact_load_sale rows). CLAUDE.md "exactly six" wording updated.
- **New proof: `npm run portal:verify`** (scripts/grower_portal_fixes_verify.ts) — 24 checks
  mirroring the portal's acceptance queries, all self-deriving; report committed per run.

## Evidence (all run 2026-07-17, loaders quiescent)
- `portal:verify` **24/24** (pair = exactly **238** loads — the portal's number; Σboxes/Σweight tie
  exactly; schedule 1329 → 2 loads, woolworths, deductions visible via grower token).
- `rls:posture` **103/103 · 0 problems** · `rls:multifarm` **50/50** · `auth0:rls` **91/91**
  (incl. B8 parity on both new views) · `ft:gp:rls` 14/14 · `ft:gp:reconcile` drift=PASS ·
  typecheck clean · tests 139/139.

## FIX 3 (public REST exposure) — audited, NO hub-side change (mm-hub owns public)
- anon: **zero policies** on all 38 public tables → fail-closed everywhere (the broad default
  grants are dead; recommend mm-hub strip them for hygiene, as this repo did in 0051).
- Auth0 grower token (behavioral probe): identity-scoped tables **error closed** — `auth.uid()`
  22P02-fails casting an `auth0|…` sub inside `private.portal_group_id()` → query aborts, 0 rows.
- Residual: five `using(true)` authenticated-read tables — `retailers` (3 rows),
  `distribution_centres` (15), `products`/`ft_products`/`product_retailer_mappings` (0 rows
  today). An Auth0 grower CAN read those. mm-hub's call: accept as shared reference or gate.
- `pm_price_snapshots`/`pm_run_log`: RLS on, no policies → fail-closed dead grants.

## Deferred / notes
- Cube exposure of the new load-grain/sale surfaces: not requested; add as ADDITIVE cubes later.
- FIX 2 note: 484 in-scope pallets have no product/variety/crop → product NULL (portal renders
  "—"); 0 of them belong to the test pair.
- "Fully invoiced" on multi-customer loads is approximated by FreshTrack state seq ≥ 10 (no
  per-line coverage measure exists); today every load has exactly 1 invoiced customer (12,940/12,940).
- The 2 invoiced pair loads outside the load view = all-pallets-archived loads (view excludes them
  by design; the sale view still shows them).

# Handoff (2026-07-16b): grower-register posture (0052) — drift cleanup closed

Status: **✅ done; `rls:posture` fully green (100/100 relations conform, 0 problems) for the first
time since the register drift landed.** Migration `0052` applied. Closes the drift task chip.

## What landed
- **Migration `0052_grower_register_posture`** — the six register relations classified + gated:
  - `raw.atcm_crop_blocks_fnq` / `raw.qscf_lots_banana_belt` / `core.crop_block_parcel` →
    **internal-only** reads (spatial reference + derived overlap; no grower-facing view joins
    them — the 0034 dim_customer criterion) + cube read-all.
  - `core.block_grower_tag` / `core.parcel_grower_tag` (grower attribution — sensitive) →
    **internal-only reads + INTERNAL-GATED WRITES**: the hub's FIRST registered interactive-write
    surface. mm-hub's `gr_block_tags`/`gr_grower_tags` are security_invoker auto-updatable views,
    so staff tag edits write through as the logged-in user; INSERT/UPDATE/DELETE policies are
    exactly `is_internal_claim()`-gated.
  - `semantic.grower_crop_area` → **security_invoker** (was owner-rights — the 0051 anon-REST
    incident surface); base internal-only RLS now applies to the caller.
- **Registry contract evolution (`scripts/rls_posture.ts`):** `writes:'internal'` on a registry
  entry is now the ONLY way a non-SELECT policy is legal (A4 validates the exact gate + role;
  new A4b fails if a declared write surface is missing any of its three policies). Default stays
  writes-via-service_role-only. All six relations registered with provenance.

## Evidence
- Dry-run in a rolled-back txn: grower + Auth0 INSERT → **42501** (RLS write gate); internal
  INSERT passes the gate (fails only 23503 FK — no block data loaded yet); all read postures per
  class. Live after apply: `rls:posture` **100/100 · 0 problems** · `auth0:rls` 81/81 ·
  `rls:multifarm` 45/45 · tests 139/139 · typecheck clean.
- NB for mm-hub: staff tag-writing requires the user's `app_metadata.is_internal=true` (1 of 2
  auth users carries it today) — stamp it for any new staff account or register edits 42501.

> **⚠ FLAG from the mm-hub hardening session (2026-07-16, after the handoff below):**
> mm-hub's public P0/P1 hardening is DONE, the tenant Action now pins `role=authenticated`,
> **third-party auth is ENABLED and `semantic` is REST-EXPOSED** (auth0:rls 81/81 and
> rls:multifarm 45/45 re-run green post-enablement) — so the "⛔ NOT enabled" status below is
> stale. Consequence for the drift cleanup: **`semantic.grower_crop_area` (anon SELECT grant)
> is now anon-reachable over REST** — live probe returns `HTTP 200 []`, empty only because the
> register base tables have no prod rows yet. Before any register data loads:
> `revoke select on semantic.grower_crop_area from anon;` (+ the rest of the six-relation
> drift cleanup: anon grants/policies on the raw/core register tables, anon USAGE on semantic).
> Keep `authenticated` intact — mm-hub's `gr_*` views are now security_invoker over your grants/RLS.
>
> **✅ RESOLVED (same day, migration `0051_revoke_anon_grower_register_drift`):** every anon
> foothold stripped from raw/core/semantic — all six drift relations' anon grants, the two anon
> ALL policies, and anon USAGE on core+semantic (raw included idempotently). Verified live:
> the anon REST probe went 200 → **401 permission-denied for schema semantic**; anon
> grants/policies in hub schemas now **0**. Re-proven post-fix: `auth0:rls` 81/81 ·
> `rls:multifarm` 45/45 · posture anomalies 24 → 16 (remainder = registry classification +
> dead-grant/cube posture on the six relations — the drift task chip). `authenticated` untouched.

# Handoff (2026-07-16): Auth0 third-party auth (grower-portal) — grower RLS second identity path

Status: **✅ hub-side DB work built, applied to prod, proven. ⛔ third-party auth NOT enabled —
BLOCKED on an mm-hub public-schema audit (details below); enabling is Tim's go/no-go.**
Migration `0050` applied via MCP apply_migration. Push manual.

## What landed
- **`docs/mm-hub-auth0-integration.md`** — verbatim copy of the grower-portal brief (issuer
  `https://grower-portal.au.auth0.com/`, verified live incl. trailing slash + JWKS; consignor claim
  `https://grower-portal.mackays.com.au/consignor_ids`, a string array on both token types).
- **Migration `0050_auth0_grower_rls`** (ADDITIVE): `semantic.auth0_consignor_ids()` — issuer-pinned
  (exact match), array-only, per-element uuid-validated, de-duplicated, fail-closed; EXECUTE revoked
  from PUBLIC, granted to authenticated only. Six additive `auth0_grower_own_*` policies on exactly
  the 0026 grower-scoped set; the mm-hub `grower_own_*` policies untouched; NO internal branch.
  **Trust partition:** `current_consignor_ids()` / `is_internal_claim()` now REFUSE app_metadata on
  an Auth0-issued token (verbatim 0026/0010 bodies + one deny guard — adversarial review caught and
  removed an accidental exception-block divergence in is_internal_claim). ⚠ FUTURE-ISSUER
  INVARIANT: any additional third-party issuer requires extending the deny guards (CLAUDE.md).
- **`scripts/auth0_rls_proof.ts`** (`npm run auth0:rls`) — self-deriving (fixtures = busiest
  consignors present in dispatch+GP+NS; per-table non-triviality for BOTH growers). Run with
  loaders quiescent.
- **`scripts/rls_posture.ts`**: grower-scoped class now ALSO requires the additive auth0 policy;
  A6 requires the new helper. Apply 0050 before running the suite (ordering coupling, documented).

## Evidence
- Pre-apply: 15-agent adversarial review workflow (5 lenses × verify) — 10 confirmed findings all
  fixed or documented, 0 refuted-but-shipped; dry-run of the full DDL in a rolled-back txn green.
- `auth0:rls` **81/81** (report `reports/auth0_rls_proof_2026-07-16.txt`): identity parity on all
  5 grower views (Auth0 == mm-hub, 42,632 rows), wrong-iss/supabase-iss forgery 0-row, hostile
  hybrid (Auth0 token + forged app_metadata.{consignor_ids,is_internal}) sees own rows only,
  internal-only/etl-only/ungranted stay closed, legacy scalar token exact.
- mm-hub path untouched: `rls:multifarm` **45/45** · `ft:dispatch:rls` 7/7 · `ns:rls` 7/7 ·
  `ft:gp:rls` 14/14 · typecheck clean · tests 139/139.
- `rls:posture`: all six grower-scoped relations PASS the new dual-policy assertion. Sweep overall
  is 94/100 — the 6 FAILs are **pre-existing grower-register drift, NOT this change** (see below).

## ⛔ Why third-party auth is NOT yet enabled (Tim's decision)
Enabling it is PROJECT-level: every grower-portal Auth0 token (role=authenticated) becomes a valid
authenticated session for mm-hub's `public` schema + storage too. Read-only audit findings:
- **`public` has 7 RLS-OFF tables with FULL grants to authenticated AND anon** (`growers`,
  `gr_banana_blocks`, `gr_block_parcel`, `gr_block_tags`, `gr_grower_crop_area`, `gr_grower_tags`,
  `gr_parcels`) — already readable/WRITABLE with the anon key today, Auth0 or not. Fix in mm-hub.
- ~~mm-hub's `private.portal_*` helpers likely honor app_metadata~~ **VERIFIED SAFE (2026-07-16):**
  they key on `auth.uid()` → `hub_users`/`module_access` lookups, which fail CLOSED for Auth0
  tokens (non-uuid sub). Remaining mm-hub work = the RLS-OFF tables + reviewing `using(true)` /
  insert-true policies. Full list: `docs/mm-hub-public-hardening-checklist.md`.
- The tenant Action must pin `role=authenticated` (role claim maps to the Postgres role;
  service_role would bypass all RLS).
**To enable** (after mm-hub hardens): Dashboard → Authentication → Sign In/Providers → Third Party
Auth → add Auth0, tenant `grower-portal`, region AU (or Management API
`POST /v1/projects/uqzfkhsdyeokwnkpcxui/config/auth/third-party-auth`
`{"oidc_issuer_url":"https://grower-portal.au.auth0.com/"}`). No management token on this machine.
**Also**: add `semantic` to the API's exposed schemas (Settings → API) or grower-portal's REST
reads of the grower views can't route; grants/RLS are already correct for that exposure.

## Grower-readable surface (decision c)
Auth0 growers read EXACTLY what mm-hub growers read (proven parity): the 5 semantic grower views
(`grower_dispatch_detail`/`_shipped`, `grower_settlement`, `grower_gp_settlement`/`_load`) over the
6 RLS-anchored relations, + shared-reference lookups. Internal-only/etl-only/ungranted fail closed.
Recommend grower-portal consume the semantic views only.

## Surfaced (pre-existing, out of scope, task chip spawned)
Six unregistered relations in raw/core/semantic from the grower-register migrations (2026-07-13/14,
applied outside this repo): `raw.atcm_crop_blocks_fnq`, `raw.qscf_lots_banana_belt`,
`core.block_grower_tag`, `core.crop_block_parcel`, `core.parcel_grower_tag`,
`semantic.grower_crop_area` (owner-rights view) — anon grants + anon ALL policies inside hub
schemas (A4/A5 violations). Posture sweep stays red until classified + hardened.

# Handoff (2026-07-13): WOW scan ingest — Q.Checkout Woolworths sell-through

Status: **✅ pipeline built + proven end-to-end on the synthetic source; awaiting the real 303k
export for full-scale AC numbers.** Migration `0049` applied then demo rows cleaned (tables empty).
Commit `95add78`. Per `MODULE-WOW-SCAN-SPEC.md` (committed as the sprint doc `4121d6f`).

## What landed
- **`scripts/parse_wow_scan.py`** (Tim's, committed): fail-loud on the 8 dimension columns or a
  missing metric prefix; keeps ONLY the finest grain (drops Total-grain — the 8× multiply trap);
  '-'/blank → null; splits `{article}-{UOM} - {desc}`; row-accounting balances or exits 1.
- **`raw.wow_scan_loads`** (sidecar ledger) + **`raw.wow_scan_export`** (verbatim clean CSV, etl-only)
  → **`core.wow_scan_weekly`** (typed finest grain; PK = week×article×state×VCU×channel×promotion;
  UPSERT so Quantium restatements win; internal-only) → semantic **`v_wow_scan_national`** (derived
  totals), **`v_wow_scan_promo`** (promo share), **`v_scan_cross_retailer`** (WOW ∪ Coles national
  weekly — BOTH scans end **Tuesday**, so alignment is exact-date, correcting the spec draft's offset
  note). `npm run wow:load <export.csv>` (runs the parser) or `-- --clean <csv> --meta <json>`.
- **Evidence (synthetic source, the honest end-to-end proof):** parse 30 in = 9 out + 9 blank + 12
  total (0 unparsed) → load → core 9 (re-load idempotent, **0 dup groups**) → views. `wow:verify`
  **9/9** (accounting, PK, national reconciliation view==core, promo split, cross-retailer, RLS
  internal-only ×4). AC6: renamed column exits non-zero printing expected-vs-got. Parser tests drive
  the real Python via spawnSync — **139/139**; **rls:posture 94/94**; typecheck clean.
- **Wiki:** `docs/wiki/wow-scan.md` (Tuesday weeks, '-' nulls, 8× total trap, VCU clusters, 4-week
  restatement overlap, article churn, unreliable wizard state filter).

## Full-scale ACs pending the real export (one `wow:load` away)
AC1 (rows_in 303,264 / out 35,335), AC3 (SUM sales $497,463,530 / volume 111,445,503 vs the source
Australia/Total slice), AC5 (week 2026-07-07 article 0133211) — the 303k CSV was NOT in the drop
(only the 100KB clean-CSV excerpt + sidecar). When Tim provides it: `npm run wow:load <file>` then
`npm run wow:verify`; the sidecar's own accounting already shows 303,264 = 35,335 + 188,690 + 79,239.

## Deferred (spec Out-of-Scope)
- Q.Checkout export automation; store-level data (subscription tier); the Coles↔WOW article-mapping
  table (v_scan_cross_retailer ships the week+retailer+line spine; the mapping seed is its own sprint).

# Handoff (2026-07-12c): Insight layer + NL foundation

Status: **✅ built + proven (author dry-ran everything in a rolled-back txn pre-handoff; 21/21 live).**
Migrations `0045`–`0048` applied; commit `048f739`. **Push manual.** The schema-value review's
conclusions, implemented: the hub's domains are now JOINED, not just landed.

## What landed
- **Crosswalks:** customer→retailer×state (100% retail volume), product→scan segment (98.76% of
  banana pallets; bins/value-added OUT_OF_SCOPE surfaced).
- **`core.fact_market_week`** (2,605 cells; 55 Tuesday-ending weeks): Coles till demand vs our
  supply vs farm-gate $/kg. National share 0.001..0.541 — Mackays supplies up to ~54% of Coles's
  banana sell-through in peak weeks. Woolworths/ALDI supply-only cells ready for their scan.
- **Semantic:** `market_week` (price ladder: avg farm 3.43 / wholesale 3.43 [≈ by agency] /
  till 5.42 $/kg — the wholesale→till spread is the story), `customer_margin` (pre-freight,
  DR=positive verified), `grower_scorecard` (achieved vs pool $/kg, paid lag; internal-gated),
  `retail_supplier_share`.
- **NL foundation:** business_term/nl_phrase seeded with 1,436 hub-derived terms; the vocabulary
  engagement (8 sections / 699 entities / top-20-questions prompt) generated + browser-verified
  (autosave, export round-trip) and DELIVERED to Tim; `nl:load` ready for his JSON (source='tim'
  rows never touched by re-seeds).
- **Evidence:** insight:reconcile **21/21** (parity exact on all three sides; share bounds
  H1/H2/H3; ladder 109/110; RLS behavioral ×7) · posture **88/88** · tests **131/131**. Deviations
  from the sprint brief, all live-verified + documented in migration headers: farm-gate anchor
  coalesce(pack_date, pickup); DR invoices positive; three-tier share bounds (flat 1.05 fails on
  real stock-timing).

## Next
- Tim returns the vocabulary JSON → `npm run nl:load` → wire the glossary into the Hub MCP catalog
  (the NL translation engine's query side — its own sprint).
- Freight/SOH/harvest land → join into market_week/customer_margin (designed-for).

# Handoff (2026-07-12b): Retail scan — Coles weekly sell-through (Circana)

Status: **✅ built + proven from the 3 real exports; adversarial verify in flight at handoff.**
Migrations `0042`–`0044` applied; commit `02672dd` (+ sprint doc `1c6b22a`). **Push manual.**
The demand signal beside shelf prices: what actually sells at Coles, weekly.

## What landed
- **Parser** (pure, 20 unit tests; header signature pinned — drift throws): 19 measures × 5 variants
  → 57 landed (`SCAN_MEASURE_COLUMNS` = the shared contract). Channel checksum (in_store + online ==
  TOTAL) enforced pre-write; null legs surfaced as incomplete, never asserted or coalesced.
- **Data:** 3 exports found in Downloads — June **manufacturer-split** (market share by supplier:
  FRESHMAX, PERFECTION FRESH, ROCK RIDGE, PRIVATE LABEL, OTHER MFRS…), June + July own-brand.
  `raw.retail_scan` 13,228 rows (19,089 parsed; overlap upserted, newest-by-mtime wins);
  `core.fact_retail_scan` **12,224 weekly rows: 55 weeks (2025-06-24→2026-07-07) × 7 geographies ×
  5 segments × 11 suppliers × 3 channels**; `semantic.retail_scan` with pack_week_code + promo
  share + YoY. Product hierarchy `<child>-<parent>` conformed to segment × supplier.
- **Evidence:** scan:reconcile **8/8** (drift-guard 57/57; parity 12,224==12,224; channel checksum
  **0 mismatches over 4,679 groups**; 0 unmapped; dim_date joins all 55 weeks; NULLs preserved
  404/7,732; RLS internal-only fail-closed incl. user_metadata forgery); rls:posture **78/78**;
  tests **124/124**; idempotent re-run 0 net-new. Ops note: a timed-out client left a zombie
  ClientRead session holding the upsert — terminated via pg_terminate_backend (the 0031 lesson).
- **Deferred:** Woolworths scan (needs export sample), auto-ingest channel, SKU/EAN grain (absent
  from source), Cube exposure.

# Handoff (2026-07-12): Accounts receivable — invoices, cash mirror, Coles remittance reconciliation

Status: **✅ DONE — full AR domain built + adversarially verified.** Migrations `0037`–`0041`
applied. Commits `b5365b7` (build) + `3075d34` (review hardening). **Push manual** (mackaysmarketing
PAT). The receivable mirror of grower settlement — now the hub models both money directions.

## What landed
- **Landing (0037/0038/0039):** `raw.ft_invoice` (14,086) + `raw.ft_dispatch_load_invoice` (14,054,
  1 load/invoice) · six `raw.ns_customer*` tables (80,744 rows: 13,215 CustInvc, 51,261 lines, 2,172
  CustPymt, 578 CustCred, 13,391 apply-links, 127 customers) · Coles `raw.remittance` (2) +
  `raw.remittance_line` (74). Loaders `ft:invoice:load` / `ns:ar:load` / `remit:load`. All etl-only.
- **Core (0040):** `core.fact_customer_invoice` (13,275; paid_status **11,279 paid / 418 credited /
  620 unpaid / 12 part / 946 no_ns_match**) — paid status from NetSuite via the deterministic
  `CustInvc.externalid = ft_invoice.invoice_no` crosswalk + apply-links. `core.fact_remittance_line`
  (74: **71 matched / 2 claim / 1 unmatched**). `ar:core`.
- **Coles remittance parser** — pure, unit-tested (9 tests), checksum (Σ line payment = header total),
  per-retailer pluggable. **Woolworths/ALDI + auto-ingestion deferred** (need samples / channel).
- **Semantic (0041, internal-only, security_invoker):** `ar_customer_invoice`, `ar_debtor_open`
  (aged open receivables), `ar_remittance_reconciliation` (the discrepancy report).

## Evidence (2026-07-12, all re-runnable)
- **ar:reconcile 6/6** — landing parity (13,275=13,275); NS↔FT crosswalk (12,329 matched, unique, no
  fan-out; 946 no-NS + 885 non-FT surfaced); **independent cash tie** apply-link detail
  $184,221,410.41 == CustPymt headers $184,221,410.42 ($0.01), partitioning to in-scope $176.27M +
  out-of-scope $7.95M; lineage 13,114/13,275.
- **remit:reconcile 4/4** — checksum exact both advices; 71 matched (variance 0); Coles settlement
  discount exactly 2.5%; report committed. The real $1.9M Coles payment reconciled line-by-line.
- **ar:rls 30/30** — internal-only fail-closed on 2 facts + 3 views (grower / no-claim / forged
  top-level / forged user_metadata all 0; internal full).
- **rls:posture 75/75** (15 new AR relations registered, 0 anomalies). Battery unregressed: tests
  104/104, bridge 6/6, multifarm 45/45, dims 7/7, typecheck clean.

## Adversarial review (4 skeptics, independent SQL) — outcome
Security **CONFIRMED** (behavioral RLS held on every relation; raw etl-only permission-denied;
posture complete). Remittance **CONFIRMED** (byte-identical re-extraction; 72-line large advice ties
on all 3 money columns to the printed grand total). Three findings **fixed** (commit 3075d34):
split paid/open anchor (6 invoices 'paid' with open>0 → both anchor on ns_amount); 418 credit-settled
invoices mislabeled 'paid' → new `credited` status; circular cash-tie proof → independent
detail-vs-header tie. Known limitations documented: the remittance checksum is a sum-check not a
completeness check (a hypothetical $0.00 dropped line could pass — no real invoice line is $0.00);
`is_claim` is evaluated before match, so an LJ line carrying a real FT number would bucket as claim
(none today). One data note: NS `FT009228` references an FT number with no landed ft_invoice.

## Follow-ups / deferred
- **Woolworths + ALDI remittance parsers** — need their sample files/formats (per-retailer pluggable).
- **Auto-ingestion channel** (email/SFTP/portal) — loader consumes a file/dir for now.
- **Cube exposure of AR metrics** — after sign-off. **Revenue-class wiring** — still awaiting Tim's CSV.

# Handoff (2026-07-11): Warehouse closeout — dims, cross-source tie, governance, MCP, freshness

Status: **✅ ALL SEVEN CHUNKS DONE — full proof battery green on fresh data.** Migrations
`0033`–`0036` applied. Commits `948e06a` (C1) · `280b5cd` (C2) · `47e9f4f` (C3+C4) · `0be690b`
(C5) · `14c798e` (C6) + docs. **Push manual** (mackaysmarketing PAT per CLAUDE.md).

## What landed
- **C1 (0033/0034):** `raw.ft_consignee/ft_product/ft_crop/ft_variety/ft_pack_type` (replica
  full-sync, `ft:ref:load`) → `core.dim_customer` (INTERNAL-ONLY; names via the entity BACKLINK —
  which also fixed the 0031 bridge bug that left 0/23,544 rows named; now **100%**),
  `core.dim_product` (159/159 hub products, SHARED REFERENCE), `core.dim_date` (**pack-week =
  ISO week of `scheduled_pickup_on`, 98.91% verified; pack_date only ~47%**).
- **C2 (0035):** `semantic.recon_settlement_source` (grower × month, FULL OUTER, match_status
  buckets, strict internal gate) + `settle:tie`.
- **C3+C4 (0036):** `retail:reconcile` + `rls:posture` (60-relation posture registry + anomaly
  scans). Real findings fixed: dim_gp_charge/dim_ns_charge internal-only policies were DEAD (no
  grant — staff got permission denied; grant added, growers still 0 rows); dim_shed documented as
  a shared-reference VIEW with a load-bearing grant.
- **C5:** MCP multi-farm (`consignor_ids[]`, single-farm payloads byte-identical),
  `list_grower_sales` LIVE, `mcp/cube.ts` sends `renewQuery` (Cube result cache served pre-ingest
  counts ~45 min after load), `mcp_proof` fully self-deriving.
- **C6:** incremental loads everywhere — dispatch **+687 loads** (22,450→23,137), pallets →210,436,
  GP **+78 schedules** (→1,332) / details →25,119 settled, NetSuite **+70 bills** (→1,167, incl. a
  **40th grower vendor**), orders →21,590, entities →320. Core rebuilt; bridge **25,119 rows** with
  all guards intact. `rls_multi_farm_proof` converted to in-run derived baselines (the July-1
  snapshot failed 15/45 on pure drift).

## Evidence (all re-runnable, run 2026-07-11 post-load)
dims:verify **7/7** · settle:tie **7/7** (cash tie **0.43%**, deductions 0.37%, unexplained
**$0.00**) · retail:reconcile **10/10** · rls:posture **60/60, 0 anomalies** · ft:bridge:verify
**6/6** (25,119=25,119; 0 mismatched groups/loads; 0 over-allocated; product_exact 99.02%;
median variance $0.00) · ft:bridge:rls **30/30** · rls:multifarm **45/45** · mcp:proof **58/58**
· ft:gp:reconcile PASS (1225/1277 cash within 1%) · ft:gp:rls 14/14 · ft:gp:parity 5/5 ·
ns:reconcile PASS (0 unmapped) · ns:rls 7/7 · ns:parity **5/5** (1,167=1,167, Δ$0.0000) ·
ft:order:reconcile 500/500×4 · ft:order:rls 18/18 · ft:dispatch:reconcile PASS · tests **94/94**
· typecheck clean. Reports committed: settle_tie / retail_reconcile / mcp_proof (2026-07-11).

## Adversarial review + hardening (2026-07-12)
Four skeptic agents re-derived every chunk's claims with independent SQL. One **broken** finding
fixed, plus two robustness gaps and the misleading comments they surfaced:
- **`mcp/runSelect.ts` quoted-schema bypass (FIXED):** `"raw".ft_pallet` slipped past the
  `\b<schema>\.` scan (RLS still failed closed, but the `semantic.*`-only contract was not
  enforced). Now blanks string literals, rejects quoted identifiers + dollar-quotes, scans the
  de-quoted code. Regression tests added (95/95).
- **`rls:posture` sequence blind spot (FIXED):** relkind 'S' was outside the sweep — added A6
  scan asserting no sequence is granted to `authenticated` (0 found).
- **`mcp/identity.ts` dedupe (FIXED):** now lowercases UUIDs before the set dedupe (case-only
  duplicates collapse; real lowercase inputs unchanged → single-farm payload still byte-identical).
- **0034 comments corrected:** "1 unnamed" (now 0 after the entity load) and the pack-week
  residual direction (dominant bucket is +1 ISO week, not −1). Re-applied (comment-only, idempotent).
- Everything else **held**: bucket partition sound (no double-count; WADDA duplicate-code offsets
  to $0.01), RLS isolation proven behaviorally on real growers, dim_shed exposes only shed_id+name,
  retail dedupe hash-identical, customer names 12/12 vs replica, product coverage over a wider
  universe than the proof checks. Doc-staleness caveats only (98.91%→~98.8% as data grows).

## Notes / follow-ups
- **⚠ revenue_class persistence:** `ft:gp:core` rebuilds dim_gp_charge and RESETS revenue_class.
  The post-checkpoint wiring must persist Tim's marking through rebuilds (seed + loader re-apply).
- **Woolworths retail scraper has landed ZERO rows** — surfaced by retail:reconcile; a
  price-reporter (separate repo) gap, not a hub bug.
- Order-reconcile report filename carries an embedded stale date (cosmetic).
- Still deferred (blocking reasons in SPRINT.md): revenue-class wiring (Tim's CSV), Cube bridge
  exposure (sign-off gate), remote grower connector (infra/auth), knowledge graph (cross-repo
  interface), AR/remittance (own sprint — dim_customer prerequisite now built).

# Handoff (2026-07-09): Settlement bridge — order book ↔ grower settlement

Status: **✅ Bridge built + proven; ⏸ STOPPED at the revenue-class checkpoint (by design).**
Migrations `0031` (core) + `0032` (semantic) applied to the hub. **Awaiting Tim's marking of
`reports/revenue_class_checkpoint_2026-07-09.md`** — revenue_class is NOT wired (never guessed);
`mackays_revenue` is NULL and `core.fact_revenue_charge` / `semantic.mackays_revenue_fresh` are
empty until the marking lands. Commits **not yet pushed** (mackaysmarketing PAT per CLAUDE.md).

## What landed
- **`core.fact_settlement_bridge`** (0031) — raw.ft_gp_detail grain (23,544 rows = 100% of settled
  details; ALL gp_detail rows are settled). Keys incl. order_id (via `raw.ft_dispatch_load.order_id`
  — the real bridge; fact_order_item.dispatch_load_id is 99.3% null), order_item_id (only when
  exactly one authoritative line matches), schedule + detail consignors, consignee (+ denormalised
  names — raw.ft_entity has no authenticated grant). Measures: tiered `sell_value`
  (rate = Σ priced-line $ ÷ Σ priced-line boxes; per-(order,product) over-allocation cap),
  `grower_gross` (unrounded box×price), `variance`, settlement deductions/GST/net **allocated
  group-exact** from fact_gp_settlement_load (|gross|-share + residual-on-largest-row → every
  (schedule, load) group sums exactly), `mackays_revenue` (NULL until checkpoint).
- **`core.fact_revenue_charge`** (0031) — charge-application grain for revenue reporting; built
  from `dim_gp_charge.revenue_class` ∈ {commission, ripening, other_service}; empty pre-checkpoint.
- **`core.dim_gp_charge.revenue_class`** added (text, nullable, UNWIRED — Tim's checkpoint marking
  first; sequenced to not collide with the separate dim-RLS remediation).
- **Semantic (0032, all INTERNAL-ONLY, security_invoker):** `settlement_bridge_by_grower` /
  `_by_product` / `_by_customer` + `mackays_revenue_fresh` (month × class × charge × grower ×
  customer; product-level revenue lives on _by_product — charges are load-grain).
- **Loader `npm run ft:bridge:core`** (src/loaders/ft_bridge_core.ts; run after ft:gp:core +
  ft:order:core) with coverage + no-double-count self-checks. **Proofs:** `npm run ft:bridge:verify`
  (6/6) · `npm run ft:bridge:rls` (30/30). Checkpoint artifact: `scripts/revenue_class_checkpoint.ts`.

## Evidence (2026-07-09, all re-runnable)
- **AC1 parity:** settled gp_detail = 23,544; bridge = 23,544. ✅
- **AC2 no double-count:** 17,938 (schedule, load) groups, **0 mismatched** (gross + all 6 deduction
  classes + GST, tolerance $0.005); per-LOAD across schedules: 14,243 loads, **0 mismatched**. The 37
  charge-only groups (35 loads, +$547.37 ded / −$179.78 GST) have no detail rows — excluded by grain,
  surfaced. ✅
- **AC3 no over-allocation:** 11,879 orders with sell, **0** with Σ sell_value > derived_price_value
  + $1 (13 orders raw ~$40k → group cap). ✅
- **AC4 tiers:** product_exact 19,667 rows / $175.01M gross (**99.09%**, AC ≥ 80); box_allocated
  3,622 / $0.98M (0.56%); unmatched 255 / $0.62M (0.35%). ✅
- **AC5 variance (product_exact, n=16,850):** median **$0.00**, p95(|v|) **$0.00**, **99.58%**
  within ±1%; Σ variance −$54,818 on $175M (0.03%). Top-10 |variance| pasted in the session report
  (leads: 5003006 +$14.9k; SERRA 5003329 −$5.9k; MACBO cluster). ✅
- **AC7 RLS:** 30/30 — internal sees rows (23,544 / 36 / 89 / 66); real settled grower, no-claim,
  forged top-level → **0 rows** on the fact + revenue fact + all 4 views. Multi-farm suite **45/45**.
  Typecheck clean; tests **91/91**. ⚠ `mcp:proof` = 19/25: the 6 fails are STALE June-21 absolute
  count baselines (data grew: 43,975 vs 38,322 pallets); every relative identity invariant passes
  (A == internal-filtered-to-A, A→B = 0, forged/no-claim = 0). Pre-existing drift, not this sprint —
  fix chip spawned.
- **AC6 checkpoint (⏸ waiting):** `reports/revenue_class_checkpoint_2026-07-09.md` — 96 settled
  charges (only ct_scope 'WH - Ripening' pre-proposed) + 66 account-code-only groups (4,968 rows,
  $1.59M, no charge_id → cannot carry revenue_class; needs an account-code rule if any are revenue).
  Ripening tie anchor: **$6,379,588.03** / 9,663 rows.

## Next step (after Tim's marking)
1. Wire the marked list into `src/lib/ft_gp_charges.ts` + the dim build (ft_gp_core), re-run
   `ft:gp:core` → `ft:bridge:core`; mackays_revenue + fact_revenue_charge populate.
2. Paste proof 6 (mackays_revenue by class + by grower; ripening tied to $6,379,588.03) and re-run
   `ft:bridge:rls` (the revenue surfaces then assert internal > 0).
3. Perf note: the refresh stages temp tables + ANALYZE (CTEs got a 25-row estimate vs 23,544 real →
   nested-loop blowup past a 9-min timeout; now 1.6s).

> **Addendum (2026-07-03):** Migration `0027_raw_retail_prices.sql` applied to the hub (ledger
> entry `0027_raw_retail_prices`) — retail shelf-price landing for the **price-reporter** scraper
> (separate repo; its `scripts/load-to-warehouse.ts` writes via pg using `DATABASE_URL`). raw-only,
> RLS ON, cube_readonly-only read (0012 pattern), natural key `run_id+retailer+state+product_id`.
>
> **Addendum 2 (2026-07-03, retail metric layer — SPRINT-retail-metrics.md):** `0028`
> (core.dim_retail_product, seeded) + `0029` (semantic.retail_prices day-grain view, NO
> authenticated grant — fail closed, proven) applied with ledger entries. Cube: `retail_prices`
> base cube (public:false) + `retail` view + **INTERNAL_ONLY_VIEWS gate in cube.js queryRewrite**
> (non-internal → NIL → 0 rows; additive). Proven pre-deploy: semantic proof
> (sql/retail_semantic_proof.sql — 37=37 grain, 7/30 watchlist split), compile 0 errors,
> typecheck clean, tests 91/91. **Cube DEPLOYED (Tim, 2026-07-03) and live-proven:**
> `scripts/cube_retail_check.ts` → **7/7** (internal parity 37/30/8.5228 exact; real grower
> MMPRO 0 rows incl. group_by; no-claim 0; forged 0). Commits **not yet pushed**
> (mackaysmarketing PAT per CLAUDE.md).

# Handoff (2026-07-01): Grower RLS — single consignor_id → consignor SET (multi-farm)

Status: **✅ DONE — A0–B3 proven with pasted evidence.** Migration `0026` applied to the hub;
Cube change is code-only (**awaiting manual Cube deploy** — no deploy token in session).
**Portal sprint deferred as instructed:** no group reference table, grants, grower-admin role,
delegated user creation, subset check, grant resolver, or JWT stamping — mm-hub still stamps
`app_metadata`.

## What changed
One grower login can now carry **multiple farms**. RLS anchor widened from a single `consignor_id`
to a **SET**, in both Postgres policies and the Cube filter, backward-compatible, `app_metadata`-only,
fail-closed.

- **Migration `0026_grower_rls_consignor_set.sql`** (raw/core/semantic only — grep-proven, no
  public/auth/storage):
  - New `semantic.current_consignor_ids() → uuid[]`: union of `app_metadata.consignor_ids[]`
    (multi-farm) + legacy scalar `app_metadata.consignor_id`, de-duplicated, valid-only, fail-closed
    (empty on missing/malformed; never raises).
  - `semantic.current_consignor_id()` is now a **first-element shim** over the set — kept only for
    non-policy callers; **no grower policy references it**.
  - All **6** `grower_own_*` policies rewritten to `consignor_id = ANY(semantic.current_consignor_ids())
    OR is_internal_claim()` (the `raw.ft_pallet` load subquery too).
- **`cube/cube.js`**: `readClaims` returns the consignor SET; `queryRewrite` appends an
  `equals`/multi-value (IN) filter = set membership; internal unscoped; empty/invalid → NIL (0 rows).
  `contextToAppId`/`contextToOrchestratorId` now key on the **whole sorted set** so `[A]` and `[A,B]`
  never share a cache bucket.

## Test set (real multi-farm grower)
**L & R Collins** — A=`LRCLA` (Lakeland) `019439a6-…517087`, B=`LRCTU` (Tully) `019439a8-…dba6c`;
unrelated third C=`ZONTA` `019439d4-…7ed6a`. Snapshot: `reports/rls_multi_farm_a0_snapshot_2026-07-01.md`.

## Proofs (runnable)
- `npm run rls:multifarm` — A2–A7, **45/45 pass** (`reports/rls_multi_farm_proof_2026-07-01.txt`):
  legacy token == A0 baseline (backward compat); `[A,B]` → A+B only, unrelated C = 0; A sees 0 of B;
  no-claim/empty-set/forged top-level → 0; internal → full; functions never error on malformed.
- `npm run cube:compile` — whole schema, **0 errors** (B1).
- `npm test` — **91/91** incl. new `tests/cube_rls_multifarm.test.ts` (set membership + multi-farm
  isolation) and unchanged `cube_rls_public_guard` (B2/B3).

---

# Handoff (2026-07-01): Order-Domain Ingest — order / order_version / order_item

Status: **✅ DONE — all acceptance criteria proven with pasted evidence.** Last step: **awaiting manual
Cube deploy** (no deploy token in session, per B4). Source: FreshTrack read-replica, internal-only.

## What landed
`raw → core → semantic → Cube` for the commercial **order** layer (the sell side — ordered
quantities, unit prices, line dollars). Migrations `0023`–`0025`.

- **raw** (`0023`): `raw.ft_order` (20,920), `raw.ft_order_version` (35,482), `raw.ft_order_item`
  (72,601). UUID PKs; `_raw jsonb` on order+order_version, NOT order_item; enums as text; RLS
  internal-only + cube read-all.
- **core** (`0024`): `core.fact_order_item` (35,572 authoritative-version lines) + `core.dim_order`
  (20,920, one per order). Header dollar total DERIVED from current-version lines; `latest_version_no
  = max(version_no)`. Refresh fns idempotent. RLS internal-only + cube read-all.
- **semantic** (`0025`): `semantic.order_headers` / `order_detail` / `order_sales` (S-only), all
  `security_invoker`, internal-only, join keys exposed.
- **Cube**: `order_items` (base cube, `public:false`) + `sales_orders` (view, `public:false`),
  internal-only, additive. Reads `semantic.order_sales`.
- Loader `src/loaders/ft_order.ts` (full/incremental/slice, keyset paged, `assertHubTarget`,
  test-entity exclusion, `sync_window` resume) + core builder `src/loaders/ft_order_core.ts`.
- Oracle `src/lib/ft_order.ts` + specs `src/lib/ft_order_specs.ts`; proofs
  `scripts/ft_order_{profile,reconcile,verify}.ts`, `scripts/order_{rls_proof,idempotency}.ts`,
  `cube/compile_check.ts`, `scripts/apply_migration.ts`.

## A0 findings (build gate — SPRINT.md updated before any loader)
The replica has **no `order.total_price_value`** and **no `order.latest_version_no`** — the header
carries no dollar total and no version pointer. So the header total is **derived** from the
current-version lines; the authoritative version is `max(order_version.version_no)`. The source holds
**only `type='S'`** (21,192 S, 0 B) — `type` still lands as text (both admissible). `price_currency`
100% AUD; `price_per` ∈ {BOX, WEIGHT_UNIT}. Snapshot: `reconciliation/replica_order_schema_2026-07-01.md`.

## Evidence (all commands re-runnable)
| # | Criterion | Result |
|---|---|---|
| A0 | Replica schema snapshot + depended-on columns | `npm run ft:order:profile` → snapshot committed; two absent columns documented, design derived |
| A1 | Migrations touch only raw/core/semantic | grep over `0023`–`0025`: 0 public/auth/storage refs |
| A2 | Three raw tables, UUID PK, `_raw` shape | order/order_version have `_raw`, order_item does not; counts 20,920 / 35,482 / 72,601 |
| A3 | Enums text; 0 new enum types | enum types in raw/core/semantic = **0** (only auth/realtime/storage platform enums exist) |
| A4 | Idempotent, resumable | fixed-set re-upsert ×2: 72,602 → 72,602 → 72,602 (0 net new); `sync_window` carries all 3 streams |
| A5 | Test-entity exclusion | `raw.ft_order` joined to `raw.ft_entity.is_test` = **0** test-linked orders (272 excluded at pull) |
| A6 | Current-version integrity | `core.fact_order_item` non-latest-version rows = **0** / 35,572 |
| A7 | Header ↔ line ↔ source reconciliation | 500 priced orders: **500/500** on all four checks; `reconciliation/order_reconciliation_2026-07-01.md` |
| A8 | DQ invariants | AUD asserted (non-AUD=0); join keys present; raw type=S; `order_sales`=S only; 11,328 unpriced orders keep NULL total (never coalesced) |
| A9/A10 | Semantic internal; raw RLS | views `security_invoker`, no grower grant; raw RLS enabled + policies pasted |
| A11 | Typecheck clean | `npm run typecheck` exit 0 |
| B1 | Cube compiles whole schema | `npm run cube:compile` → **0 errors**, 8 cubes + 6 views incl. order_items + sales_orders |
| B2 | RLS internal-only | `npm run ft:order:rls` → **18/18**: internal sees rows; grower / no-claim / forged / seller-consignor-match all → **0** |
| B3 | Public-guard + suite green | guard passes (no VIEW_GROWER_KEYS anchor needed, view is public:false); **81 pass / 0 fail** (74 baseline + 7 new) |
| B4 | Manual deploy | No Cube token in session. **Awaiting manual Cube deploy** by Tim. |

## Run order (reproduce)
```
npm run ft:order:profile           # A0 snapshot + profile
node --experimental-strip-types scripts/apply_migration.ts supabase/migrations/0023_raw_ft_order.sql supabase/migrations/0024_core_order.sql supabase/migrations/0025_semantic_order.sql
npm run ft:order:load              # full backfill (or -- --since=YYYY-MM-DD / -- --orders=N)
npm run ft:order:core              # build fact + dim
npm run ft:order:reconcile         # A7 report
npm run ft:order:rls               # B2 RLS proof
node --experimental-strip-types scripts/order_idempotency.ts   # A4 zero-drift
node --experimental-strip-types scripts/ft_order_verify.ts     # A2/A3/A5/A6/A8/A10 evidence
npm run cube:compile               # B1 gate
npm test && npm run typecheck      # B3 / A11
```

## Manual next step (B4) — Cube deploy
Deploy is performed by Tim (token intentionally absent from this session):
`cd cube && npx cubejs-cli deploy --token <…>`. After deploy, `sales_orders`/`order_items` are
`public:false` (staged, internal-only) — a follow-on sprint adds an internal-only rewrite rule if the
order view is ever exposed to a consumer.

## Notes / not in scope (unchanged)
- Origin-grower / Sales-by-farm bridge, `primary_origin_consignor_id`, variance view, charges,
  invoices — **not built** (join keys `dispatch_load_id`/`po_no`/`order_id`/`latest_version_no`
  exposed for the follow-on).
- Fixed in passing: 4 pre-existing `noUncheckedIndexedAccess` type errors in
  `tests/cube_rls_public_guard.test.ts` (type-only null guards; behavior identical; test still passes).
- `dispatch_load_id` is present on only ~261/35,572 current sales lines today (the order→dispatch link
  is sparse on live/open orders) — surfaced, not hidden; the bridge sprint handles attribution.
- Git: committed locally on branch `feat/order-domain-ingest` (not pushed — no push requested; push via
  the `mackaysmarketing` PAT flow in CLAUDE.md when ready).
