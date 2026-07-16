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
