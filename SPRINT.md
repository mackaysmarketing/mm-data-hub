# Sprint 5: NetSuite RCTI / grower settlement ingestion
Date: 2026-06-21
Repo: mackaysmarketing/mm-data-hub

This onboards **NetSuite as a second source system** into the medallion, landing grower
**settlement (RCTIs)** — what each grower was paid, the deductions, the net, and the **paid date**
(which FreshTrack cannot provide). It conforms to the existing grower dimension and is surfaced as
a settlement semantic view + Cube metrics, RLS-scoped by `consignor_id`, exactly like the FreshTrack
dispatch layer.

## Orient first (read before assuming anything)
- Read `SPEC.md` (medallion + semantic + metrics + §7 access model + §9 data-quality), all of
  `CLAUDE.md` (schema boundary, the `app_metadata` RLS claim contract, the Cube + Hub MCP sections),
  `HANDOFF.md` (what's LIVE), and the `/cube` model + `cube/CONTRACTS.md` so settlement metrics are
  **added, never redefined**.
- This is **read-only out of NetSuite**. Never write back to NetSuite. DB objects touch ONLY
  `raw`/`core`/`semantic` — never `public`/`auth`/`storage`.

## Discovery — CONFIRMED LIVE against NetSuite (build to this; do not re-derive)
- **Subsidiary**: Mackays Marketing (internal id **2**) is the settlement entity. Filter to it.
- **RCTIs** = `transaction WHERE type='VendBill' AND entity IN (SELECT id FROM vendor WHERE category=110)`.
  Category 110 = **Growers** = **39 vendors**. (VendBill spans all vendor types ~9,789; grower RCTIs
  are the category-110 subset.) VendBill data runs 2023 → end-FY26.
- **Lines**: `transactionline`. ⚠️ The line table carries summary/AP and duplicate rows — filter on
  the line-type flags (`mainline`/`taxline`, posting flags) to get clean per-product and per-deduction
  lines. **Reconcile sum(lines) to the bill total per RCTI** to prove no double-count.
- **Paid date / status**: `transaction WHERE type='VendPymt'` (links to the bill). Paid date is the
  whole point — FreshTrack stops at invoiced/remitted.
- **Grower crosswalk — DETERMINISTIC**: NetSuite `vendor.entityid` = `core.dim_grower.code`. **39/39**
  active grower vendors match. Use `entityid`, **not** `externalid` (it has 2 nulls + 1 mismatch:
  `LRCDR`≠`LRCTU`). `code` is not strictly 1:1 to `consignor_id` (e.g. `WADDA` → active + inactive
  records) — resolve on `is_active`.
- **Line taxonomy** — the `item.itemid` IS the code; prefix = category, `displayname` =
  `Category - Subcategory - Detail`:
  - `9xxxxx` **products** (gross sale): `910` banana, `920` papaya, `930` avocado, `960` passionfruit.
  - `1xxxxx` **FR — Freight** (by carrier/route).
  - `2xxxxx` **WH — Warehouse** (ripening / handling / labelling / packing / storage / quarantine, by site).
  - `3xxxxx` **MD — Market Deductions** (commission / levy / retail rebate / packaging / promotion / inspection).
  - `591xxx` **LA — Larapinta-specific** charge set (the closing site; mirrors FR/WH/MD).
  - `4xxxxx` **MI — Misc**.

## Scope
Build a read-only SuiteQL extractor that lands grower RCTI **headers**, **full line detail**
(products + every deduction), and **payments** into `raw.ns_*`, conforms them in `core` (grower via
the crosswalk, products, and a parsed charge dimension), and exposes
`semantic.grower_settlement` (RLS by `consignor_id`) consumed by Cube as additive settlement metrics.

## Acceptance Criteria
- [ ] SuiteQL extractor: read-only, **paginated** (pageSize 1000), idempotent/incremental (by
      `lastmodified`/`trandate` window), scoped to subsidiary 2 + category-110 vendors. No writes to NetSuite.
- [ ] `raw.ns_vendor_bill` (RCTI headers), `raw.ns_vendor_bill_line` (lines), `raw.ns_vendor_payment`
      landed with real NetSuite field names (confirm via `ns_getSuiteQLMetadata` for
      transaction/transactionline/vendor — don't invent).
- [ ] **Line integrity**: clean per-product + per-deduction lines via the line-type flags;
      `sum(lines) = bill total` per RCTI within tolerance — variance logged, not hidden.
- [ ] **Grower crosswalk**: every grower RCTI resolves to a `dim_grower.consignor_id` via
      `vendor.entityid = code` (WADDA-style codes resolved on `is_active`). Unmapped active growers → 0;
      any unmapped row is surfaced, not silently dropped.
- [ ] **Charge dimension**: each deduction classified into FR / WH / MD / LA / MI + subcategory,
      parsed from `itemid` prefix + `displayname`. Products tagged by produce type (910/920/930/960).
- [ ] `semantic.grower_settlement`: per-grower settlement — **gross, deductions by category, net, and
      paid date** — `security_invoker`, RLS by `consignor_id` using the **same `app_metadata`-only,
      fail-closed contract** as migrations 0008/0010. **Paid date is a first-class column.**
- [ ] **RLS proof** on the new view: ≥2 distinct grower contexts (each sees only its own settlements)
      + 1 internal (sees all) + no-claim → 0 + forged top-level claim → 0. Runnable script, captured output.
- [ ] **Cube**: additive settlement metrics (`gross_sales`, `total_deductions`, deductions by category,
      `net_paid`) over the new view — consumed/governed, **never redefining** an existing dispatch metric.
- [ ] **Parity**: net paid reconciles to NetSuite — sum of grower RCTI nets for a period = the NetSuite
      figure; spot-check one grower's RCTI line-by-line against NetSuite.
- [ ] Schema boundary respected (raw/core/semantic only); no Postgres enums; amounts never coalesced
      in a way that hides nulls.

## Definition of Done (with evidence)
- [ ] Runnable extractor + docs (how to run, incremental window, the NetSuite auth it needs).
- [ ] Line-reconciliation + net-parity + RLS-proof committed as runnable scripts, passing.
- [ ] `npm run typecheck` clean; `npm test` green (unit tests: charge classification, crosswalk
      resolution incl. WADDA case, line-type filtering, fail-closed RLS).
- [ ] **No regression** to the FreshTrack sprints: `npm run cube:rls` and `npm run cube:reconcile`
      still pass; Hub MCP `mcp:proof` still passes.
- [ ] `CLAUDE.md` + `HANDOFF.md` updated (NetSuite as a source; the crosswalk; the charge taxonomy).
- [ ] Committed and pushed to `mackaysmarketing/mm-data-hub` via the **PAT-in-remote-URL** method
      (never `gh`). Fresh fine-grained or classic PAT, mm-data-hub only, scrubbed after.

## Quality Rubric (mm-data-hub — NetSuite settlement)
| Criterion | What to check |
|-----------|--------------|
| **Grower mapping** | 100% of active grower RCTIs map via `entityid=code`; unmapped surfaced; WADDA resolved on `is_active`. |
| **Line reconciliation** | `sum(lines) = bill total` per RCTI; no double-count from summary/AP/tax lines. |
| **RLS propagation** | Grower context returns only its settlements; ≥2 grower + 1 internal proven; no arg/dimension widens scope; forged/no-claim → 0. |
| **Charge classification** | Every deduction lands in FR/WH/MD/LA/MI + subcategory; parsing matches `displayname`. |
| **Settlement-date integrity** | Paid date sourced from VendPymt, first-class, never fabricated; unpaid RCTIs flagged not zero-dated. |
| **Schema boundary** | raw/core/semantic only; never public/auth/storage; no enums. |
| **Read-only / secrets** | NetSuite access read-only (no writes); creds in env, never committed. |

**Threshold:** Grower mapping, line reconciliation, and RLS propagation are hard blockers. Pass 6/7.

## Out of Scope (defer/stub, don't fake)
- **Retailer sales / AR** (CustInvc, 12,529) — the next NetSuite sprint.
- **Finance / GL** (journals, P&L) — later.
- **Tying settlement lines to specific dispatch loads** — NetSuite is product-grain, not load-grain.
  The load-level lineage is FreshTrack `gpDetails`, still blocked on read-replica. Settlement and
  dispatch join at the **grower** level now; line-to-load lineage waits for FreshTrack.
- **Write-back to NetSuite** — never.

## Prerequisite to flag (not buildable without it)
The interactive NetSuite MCP used for discovery is **not** a pipeline. The loader needs its own
NetSuite API access — **Token-Based Auth** (account id + consumer key/secret + token key/secret) for
the SuiteQL REST endpoint. Confirm these are provisioned (or provision an integration role scoped to
read transactions/vendors/items) before the extractor can run on a schedule. Store as gitignored env.

## First step
Read the docs above; run `ns_getSuiteQLMetadata` for `transaction`, `transactionline`, `vendor`,
`item` to lock real field names + the line-type flags; decide and **state** the incremental
extraction key (trandate vs lastmodifieddate) and the NetSuite-auth approach; then acknowledge scope
+ acceptance criteria before writing code.
