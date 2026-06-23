# Sprint 6: FreshTrack grower-pool (GP) settlement — load-grain settlement + cross-source reconcile
Date: 2026-06-23
Repo: mackaysmarketing/mm-data-hub

This onboards FreshTrack's **grower-pool (GP) settlement** as a source, landed via FreshTrack's
**direct Postgres read-replica** (the first non-GraphQL FreshTrack ingress; blocked across Sprints 1–5,
now unblocked). It is the **second view of grower settlement** — NetSuite RCTIs (Sprint 5) are the
accounting mirror of these FreshTrack GP schedules. Its unique value over NetSuite is **load-grain
lineage**: every settlement line carries `dispatch_load_id`, so settlement can finally be joined back
to dispatch (NetSuite is product-grain and cannot). It conforms to `core.dim_grower` via `consignor_id`,
is exposed as RLS-scoped settlement semantic views + additive Cube metrics, and is **reconciled to the
NetSuite RCTI net** to prove the two sources agree.

## Orient first (read before assuming anything)
- Read `SPEC.md` (medallion + semantic + metrics + §7 access + §9 data-quality), all of `CLAUDE.md`
  (schema boundary, the `app_metadata` RLS claim contract, the Cube + Hub MCP + NetSuite sections),
  `HANDOFF.md` (the Sprint-5 NetSuite settlement: `core.fact_settlement_bill`, `semantic.grower_settlement`,
  the FR/WH/MD/LA/MI charge taxonomy, the RLS proof), and the memory `freshtrack-readreplica-unblocked`.
- Study the existing settlement layer and **mirror it**: migrations `0014`–`0016`, `cube/model/cubes/settlement_bill.yml`,
  `cube/model/views/settlement.yml`, `src/lib/ns_charges.ts` (the charge classifier). GP settlement
  metrics are **ADDED, never redefining** a dispatch or NetSuite-settlement metric.
- **READ-ONLY out of the FreshTrack replica — never write.** It is a replica of FreshTrack prod.
  DB objects touch ONLY `raw`/`core`/`semantic` — never `public`/`auth`/`storage`.

## Already done — the Phase-2 probe (build FROM here, do not redo)
- Read-replica access proven (`FRESHTRACK_DATABASE_URL`, role `cloud_mackaysmarketing_readonly`).
  Probe scripts committed: `ft:db:smoke`, `ft:db:explore`, `ft:db:gp-profile`.
- Migration `0017_raw_ft_gp.sql` **applied** to the hub: `raw.ft_gp_schedule`, `raw.ft_gp_detail`,
  `raw.ft_gp_payment` (faithful native-column mirror; temporal cols read via `::text`).
- Slice loader `src/loaders/ft_gp.ts` (`npm run ft:gp:load`) + `ft:gp:verify` ran a 50-schedule test
  batch: idempotent (0 net-new on re-run), 0 unmapped consignors, 100% load lineage, dates exact.
- **Remaining for this sprint:** land the charge tables, build core/semantic/Cube/RLS, add the
  incremental loader, and the two reconciliations.

## Discovery — CONFIRMED LIVE against the replica (build to this; do not re-derive)
- **Source:** `cloud_mackaysmarketing` (Postgres 17, a Django app), schema `public`. The GP set:
  `gp_schedule` (~1,254 settlement headers), `gp_detail` (~23,544 lines, **one per dispatch load**),
  `gp_payment` (~1,257). Payable range 2025-06 → 2026-06. 35 settled growers.
- **Grain & keys:**
  - `gp_schedule` — header. `schedule_no`, `week_no`, `payable_on`, `invoiced_amount_value`,
    `paid_amount_value`, `gp_status_id`, **`consignor_id` = the grower being settled (RLS anchor)**.
  - `gp_detail` — one line **per `dispatch_load_id`** (100% populated; also `original_dispatch_load_id`
    on reconsignment, `harvest_load_id` mostly null). Prices progress `price_quoted → invoiced → paid
    → remitted`. **Gross sale = `box_quantity × price_invoiced_value`** (see the Power BI ref below).
  - `gp_payment` — `paid_on` (first-class paid date), `amount_value`, `gp_status`, `gp_schedule_id`.
- **THE DEDUCTION MODEL = `charge_applied`** (~117,640 rows) — the normalized charge ledger, NOT the
  `gp_detail.extra_*` slots (those are secondary/legacy; populated unevenly). Each row links to
  `gp_schedule_id` + `gp_detail_id` + `dispatch_load_id` + `charge_id`, and carries `total_amount_value`,
  `account_code`, **`is_deductible`**, `vat_info` (GST), `text_1` (human label, e.g.
  "FR - Blenners - Road - Tully to Townsville…", "Ripening", "Admin Fee").
  - Dimensions: `charge` (rate card: `name`, `charge_type_id`, `account_code`, **`netsuite_id`**) and
    `charge_type` (`code`, `name`, **`scope`** e.g. "Freight" / "WH - Handling" / "MD- Levy", `is_deductible`,
    **`netsuite_id`**). `gp_status` = `PA` Payable / `PD` Paid / `DR` Draft.
  - **Taxonomy = the SAME FR/WH/MD/LA/MI scheme as NetSuite**, derivable from `charge_type.scope` /
    `charge.name` prefix / `account_code` first digit (`1` FR, `2` WH, `3` MD, `4` MI, Larapinta its own,
    credits negative). **Reuse the Sprint-5 classifier idea (`src/lib/ns_charges.ts`)** — do not invent a
    second taxonomy.
- **Settlement math — reference implementation is FreshTrack's own `public.v_power_bi_charge_split`
  view (read its def; cite it, do not naively sum):** net = gross sales (`Σ box_quantity ×
  price_invoiced_value`) − deductions (`charge_applied` where `is_deductible`, sign-flipped) ± GST
  (`vat_info`: `EX` → +10%, `INC` → 1/11 inclusive, `FREE` → 0). The view also apportions **original-load**
  charges by quantity (reconsignment splits) — replicate that or anchor on the header totals and reconcile.
- **Reconciliation anchors (both CONFIRMED to ~0.1%):**
  - Internal: charge_applied `is_deductible` total ≈ **$32.5M** vs the Sprint-5 NetSuite deductions
    **$32,498,332**. FreshTrack `gp_payment` paid total ≈ **$140.5M** vs NetSuite `net_paid` **$139.7M**.
  - The explicit join key is **`charge.netsuite_id` / `charge_type.netsuite_id`** (FreshTrack → NetSuite).
- **Consignor model (the 45-vs-35 gap):** `gp_detail.consignor_id` may be the **original** grower on a
  reconsigned load, while `gp_schedule.consignor_id` is **who is settled**. 45 distinct detail consignors
  vs 35 schedule consignors → 10 original-only. **RLS scopes on the SCHEDULE consignor_id** (the settled
  party). Surface the 10, do not drop. All 35 schedule consignors map to `core.dim_grower` (35/35),
  **deterministically on `consignor_id`** (no code-matching needed, unlike the NetSuite `entityid` crosswalk).
- **Archived:** `is_archived` is a soft flag; archived schedules/loads (and their detail) stay fully
  visible (most settled schedules are archived). Filter at semantic, never drop at raw. Incremental by
  `last_modified_on` (an archive/lock/pay event bumps it).
- **Date gotcha (already handled in the specs):** read `date`/`timestamptz` as `::text` — a JS `Date`
  round-trip shifts a `date` back a day across +10.

## Scope
Extend the raw GP landing with the charge ledger + dims, conform in `core` (a parsed charge dimension
reusing the FR/WH/MD/LA/MI taxonomy; settlement facts at **schedule grain** and **load grain**), expose
RLS-scoped `semantic` views (schedule-grain settlement + the load-grain lineage view that joins
settlement to dispatch), add **additive** Cube settlement metrics, and prove two reconciliations
(internal header rollup + cross-source to the NetSuite RCTI net). Incremental, idempotent loader by
`last_modified_on`. **Not** in scope: see Out of Scope.

## Acceptance Criteria
- [ ] **Raw landing extended** (migration `0018`): `raw.ft_charge_applied`, `raw.ft_charge`,
      `raw.ft_charge_type`, `raw.ft_gp_status` — faithful native-column mirrors (PK = `id`, text not enum,
      temporal via `::text`, `_raw` on the small dims only). `raw.ft_gp_*` from `0017` already applied.
- [ ] **Loader** (`src/loaders/ft_gp.ts` generalized): read-only, **incremental by `last_modified_on`**
      (`-- --since=YYYY-MM-DD`) and idempotent (upsert on `id`); resumable via `raw.sync_window`. Full
      backfill lands all GP schedules/detail/payments + their `charge_applied` + the charge dims. No writes
      to FreshTrack. Counts reported.
- [ ] **Charge dimension** `core.dim_gp_charge` (+ classifier, unit-tested): every `charge`/`charge_type`
      classified into **FR/WH/MD/LA/MI + subcategory** from `charge_type.scope`/`account_code`/`name`,
      reusing the Sprint-5 taxonomy. Unknown → OTHER (surfaced, counted). Products (the Sales rows) tagged
      by produce/crop.
- [ ] **Grower crosswalk:** every `gp_schedule.consignor_id` resolves to `core.dim_grower.consignor_id`
      (35/35), deterministically. The 10 detail-only (original-load) consignors are surfaced and explained,
      never silently dropped. Unmapped settled growers → 0.
- [ ] **Settlement facts:**
      - `core.fact_gp_settlement` (**schedule grain**): gross, deductions by category (signed), GST, net,
        `paid_date`, `paid_status` (PA/PD/DR), reconciliation diff column.
      - `core.fact_gp_settlement_load` (**load grain**, via `gp_detail.dispatch_load_id`): per-load gross +
        itemized deductions — the lineage NetSuite cannot provide.
- [ ] **Line/charge reconciliation (internal):** per schedule, gross − deductions ± GST reconciles to
      `gp_schedule.invoiced_amount_value` / `paid_amount_value` within a stated tolerance (mirror the
      Sprint-5 `recon_diff = 0` proof); original-load splits handled per the Power BI reference; variance
      logged, not hidden.
- [ ] **Cross-source reconciliation (FreshTrack ↔ NetSuite):** Σ GP net paid per grower per period ties to
      the NetSuite RCTI `net_paid` for the same grower/period (the $140.5M ≈ $139.7M anchor); deductions tie
      (~$32.5M). Spot-check one grower line-by-line via `charge.netsuite_id`. Differences explained.
- [ ] **`semantic.grower_gp_settlement`** (schedule grain) **+ `semantic.grower_gp_settlement_load`**
      (load grain) — `security_invoker`; RLS by **schedule `consignor_id`** using the **same
      `app_metadata`-only, fail-closed** helpers as `0008`/`0010`/`0016`; `cube_readonly` read-all policy
      (mirror `0012`). **Paid date first-class.**
- [ ] **RLS proof** on the new views: ≥2 distinct grower contexts (each sees only its own settlements) +
      1 internal (all) + no-claim → 0 + forged top-level claim → 0; no arg/dimension widens scope. Runnable
      script, captured output.
- [ ] **Cube:** additive `gp_settlement` cube + view (`gp_gross_sales`, `gp_total_deductions`, FR/WH/MD/LA/MI
      deductions, `gp_net_paid`, `gp_paid_rcti`/unpaid, schedule + **dispatch_load** dimensions), governed,
      **never redefining** an existing dispatch or NetSuite-settlement metric. `cube.js` `queryRewrite`
      extended to scope the new view with the identical contract (existing dispatch + settlement RLS preserved).
- [ ] Schema boundary respected (raw/core/semantic only); no Postgres enums; amounts never coalesced in a
      way that hides nulls (SPEC §9.3).

## Definition of Done (with evidence)
- [ ] Runnable incremental loader + docs (how to run, the `last_modified_on` window, the read-only replica
      access it needs).
- [ ] Internal-reconciliation + cross-source-parity + RLS-proof committed as runnable scripts, passing
      (`ft:gp:reconcile`, `ft:gp:parity`, `ft:gp:rls`).
- [ ] `npm run typecheck` clean; `npm test` green (new unit tests: charge classification incl. LA/credits,
      GST `vat_info` math, crosswalk incl. original-load-consignor case, fail-closed RLS).
- [ ] **No regression:** `cube:rls`, `cube:reconcile`, `cube:settlement`, `ns:reconcile`, `ns:rls`,
      `ns:parity`, `mcp:proof` all still pass.
- [ ] `CLAUDE.md` + `HANDOFF.md` updated (FreshTrack GP as a source; the read-replica ingress; the charge
      model; the FreshTrack↔NetSuite reconciliation).
- [ ] Committed and pushed to `mackaysmarketing/mm-data-hub` via the **PAT-in-remote-URL** method (never
      `gh`). Scrub the token after.

## Quality Rubric (mm-data-hub — FreshTrack GP settlement)
| Criterion | What to check |
|-----------|--------------|
| **Schema-ownership boundary** | Every migration touches only `raw`/`core`/`semantic`. Zero DDL/reads against `public.*` IN THE HUB. (The FreshTrack replica `public` is read-only SOURCE, never written.) **Hard blocker.** |
| **Read-only / secrets** | FreshTrack replica access is SELECT-only (session pinned read-only); no writes. Creds in env, never committed. |
| **Grower mapping** | 100% of settled (`gp_schedule`) consignors map to `dim_grower` on `consignor_id`; the 10 original-load detail consignors surfaced + explained; unmapped → 0. |
| **Charge classification** | Every deduction lands in FR/WH/MD/LA/MI + subcategory from `charge_type`/`account_code`/`name`; GST (`vat_info`) handled; OTHER surfaced. Matches FreshTrack's own `v_power_bi_charge_split`. |
| **Reconciliation (internal)** | Per-schedule gross − deductions ± GST ties to the header total within tolerance; original-load splits handled; variance logged. |
| **Reconciliation (cross-source)** | GP net/deductions tie to the NetSuite RCTI net/deductions per grower/period (≈$139.7M / ≈$32.5M anchors); one grower spot-checked via `charge.netsuite_id`. |
| **RLS propagation** | Grower context returns only its own settlements (scoped on SCHEDULE consignor_id); ≥2 grower + 1 internal proven; no arg/dimension widens scope; forged/no-claim → 0. **Hard blocker.** |
| **Load-grain lineage** | `fact_gp_settlement_load` / the load-grain view correctly join settlement to `raw.ft_dispatch_load` via `dispatch_load_id`; this is the value NetSuite cannot provide. |
| **Settlement-date integrity** | `paid_date` from `gp_payment`, first-class, never fabricated; unpaid/Draft flagged, never zero-dated. Dates not shifted (`::text` read path). |
| **Schema evolution safety** | No Postgres enums; stable column names; UUID PKs; `_raw` on small dims only; Cube metrics additive-only. |
| **TypeScript** | `npm run typecheck` clean; no `any` without a comment; no secrets in code. |

**Threshold:** Schema-ownership boundary and RLS propagation are non-negotiable hard blockers.
Grower mapping, both reconciliations, and charge classification are the settlement core. Pass 9/11.

## Out of Scope (defer/stub, don't fake)
- **Decoding the `gp_detail.extra_*` slots** beyond noting they exist — the authoritative deduction model
  is `charge_applied`. Only revisit if a reconciliation gap forces it.
- **Replicating the full original-load split apportionment** if anchoring on header totals reconciles
  within tolerance — state which approach was taken.
- **Merging the FreshTrack-GP and NetSuite-RCTI settlement views into one** — keep them as two reconciled
  sources this sprint; unification (single canonical settlement) is a later decision.
- **Hub MCP / Steep surfacing** of GP metrics — later phase (the Cube metrics are the substrate).
- **Other FreshTrack-replica domains** (orders, invoices, EDI, harvest) — not this sprint.
- **Write-back to FreshTrack** — never.

## Prerequisite (satisfied)
Read-replica access (`FRESHTRACK_DATABASE_URL`) is provisioned and proven. No external blocker remains.
Keep the connection read-only; the role is `_readonly` and the session pins `default_transaction_read_only`.

## First step
Read the orient docs + the live `public.v_power_bi_charge_split` / `v_power_bi_charges` defs and
`charge_type` rows; lock the FR/WH/MD/LA/MI mapping from `charge_type.scope`/`account_code`; **state** the
net-computation approach (replicate splits vs anchor-on-header-and-reconcile) and the incremental key
(`last_modified_on`); then write migration `0018` (charge raw tables) and extend the loader, acknowledging
scope + acceptance criteria before the core/semantic build.

## Evaluator session (Phase 3 — fresh session, adversarial)
Open a second fresh session with the skeptical-senior-engineer opener (agent-harness skill, Phase 3).
Point it at this `SPRINT.md` + `HANDOFF.md`; have it run `ft:gp:reconcile`, `ft:gp:parity`, `ft:gp:rls`
and the no-regression suite, and score each Quality Rubric row honestly — especially: does a grower
context leak another's settlement under ANY claim permutation; does the internal rollup actually tie to
the header (not just claim to); is the FreshTrack↔NetSuite parity real (per-grower, not just grand-total);
are the 10 original-load consignors handled; are unpaid/Draft schedules flagged not zero-dated.
