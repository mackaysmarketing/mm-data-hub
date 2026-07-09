# Sprint: Settlement Bridge — order book ↔ grower settlement, revenue classification
Date: 2026-07-09
Repo: mm-data-hub

## Scope
Build the join between the sell side (core.fact_order_item, internal-only selling prices) and the grower-payment side (core.fact_gp_settlement_load / raw.ft_gp_detail), plus revenue classification of settlement charges. Deliverables: (1) per-load/product VARIANCE proving grower gross ties to what the fruit sold for, (2) a revenue_class on dim_gp_charge separating Mackays revenue (commission, ripening, other services) from cost recoveries and pass-throughs, (3) customer/order context on every settlement row, (4) semantic.mackays_revenue_fresh covering revenue streams 1 and 2a. NOT in scope: third-party ripening (2b), value-added sales (3), retail margin, Cube wiring, NetSuite cross-check, remittance/receivables, harvest, raw-layer changes.

## Business definitions (Tim's, 2026-07-09 — do not reinterpret)
Mackays Marketing revenue has three streams:
1. Commission on grower loads of fresh produce sold as their marketer.
2. Ripening services via Mackays ripening facilities — (a) on fresh produce loads with Mackays as marketer, (b) as a service to third-party marketers or other businesses.
3. Sales revenue from value-added lines (currently frozen banana only).
Grower return = gross sale minus all deductions = net_settlement (already built).
Retail margin = retailer shelf price minus retailer purchase cost (our sell price) — separate sprint.
Under agency semantics, grower gross_sales should ≈ the sell price invoiced to the customer for the same fruit; the bridge's headline measure is that variance, expected ≈ 0. Non-zero = claims, rejections, adjustments, timing, or leakage.

## What the warehouse can report per stream (verified live, 2026-07-09)
- Stream 1 (commission): computable once charges are classified. Commission is not currently isolated in dim_gp_charge — it sits inside the MD/other classes. Chunk-1 checkpoint resolves it.
- Stream 2a (ripening on marketed loads): computable now. ~30 named ripening charges exist across Truganina / Ann Rd / Larapinta / QPI / Epping / DBM; 10,000+ applications in raw.ft_charge_applied and 100% of them carry gp_schedule_id — all inside grower settlements. ct_scope = 'WH - Ripening' isolates most mechanically; edge cases (LA-scoped ripening adjustments, 'WH - Labelling' semi-ripe lines) need Tim's call at the checkpoint.
- Stream 2b (third-party ripening): ABSENT from the warehouse. Zero ft_charge_applied rows outside GP context. Lives on the receivables side — depends on the customer-invoicing ingest (audit gap #2). Out of scope; documented dependency.
- Stream 3 (frozen banana): ABSENT from the current ingest. No product matching 'frozen' in the synced product reference. Likely invoiced via NetSuite — Tim to confirm where these sales live before that follow-on is scoped. Out of scope.

## Ground truth on the join (verified live, 2026-07-09 — re-verify, don't re-derive)
- `core.fact_order_item.dispatch_load_id` is NULL on 35,311 of 35,572 rows (99.3%). Only 128 loads join through it. It is NOT the bridge.
- The real path is `raw.ft_dispatch_load.order_id`: 20,111 of 22,450 loads (89.6%) carry one; of 14,244 settled loads, 13,998 (98.3%) resolve to an order, covering 11,880 orders.
- Load → order is many-to-one. 1,164 orders span multiple loads. Clean direction.
- 2,458 settled loads span MULTIPLE schedules in fact_gp_settlement_load — settlement must be summed per load or it double-counts.
- Product-grain match: 19,667 of 23,289 raw.ft_gp_detail rows on ordered loads (84.4%) match an order line on (order_id, product_id).
- On the 128-load direct-FK overlap: sell $3.88M vs grower gross $3.50M. Under agency semantics that should be near zero — first thing the variance measure investigates at full coverage.

## Design (build this, not something else)
New table `core.fact_settlement_bridge`, grain = raw.ft_gp_detail row (schedule × load × product), settled loads only.
Keys: gp_detail_id, schedule_id, dispatch_load_id, order_id, order_item_id (nullable), product_id, consignor_id, consignee_id, crop_id, pack_date.
Measures: sell_value (allocated per tiers below), grower_gross (detail share of gross_sales), variance = sell_value − grower_gross, deductions by class carried through, gst, grower_net, mackays_revenue (sum of charge amounts whose revenue_class ∈ {commission, ripening, other_service}), match_tier.

Match tiers, in order:
1. `product_exact` — order line on (ft_dispatch_load.order_id, gp_detail.product_id) against fact_order_item (authoritative version only). sell_value = line unit economics × gp box_quantity; consistent with src/lib/ft_order.derivedLineValue; inspect price_per values (per-box vs per-kg) before coding.
2. `box_allocated` — order resolved, no product match: order derived line dollars allocated by box share (detail boxes ÷ order's total settled boxes).
3. `unmatched` — load has no order_id: sell measures NULL, row kept and flagged.

Revenue classification (chunk 1, CHECKPOINT — do not proceed past it without Tim):
Add `revenue_class text` to core.dim_gp_charge: one of {commission, ripening, other_service, cost_recovery, pass_through, na}. The build session must NOT guess. Chunk 1 outputs every charge (name, ct_scope, ct_code, account_code, existing category, total dollars applied) pre-tagged with a PROPOSED class (ct_scope 'WH - Ripening' → ripening; the rest unproposed); Tim confirms/corrects the full list; only then wire into the classifier (src/lib/ft_gp_charges.ts) and the bridge. Mackays revenue = classes {commission, ripening, other_service}.

Semantic layer (all INTERNAL-ONLY; never the grower_ prefix; selling prices and revenue must not enter grower surfaces or the grower MCP):
- `semantic.settlement_bridge_by_grower`, `_by_product`, `_by_customer` — sell_value, grower_gross, variance, mackays_revenue, grower_net.
- `semantic.mackays_revenue_fresh` — streams 1 + 2a by grower / product / customer / facility-ish charge name / month. Named _fresh deliberately: 2b and value-added join later as separate sources.

## Acceptance Criteria
- [ ] `core.fact_settlement_bridge` exists; row count equals raw.ft_gp_detail rows whose dispatch_load_id appears in core.fact_gp_settlement_load — paste both counts, matching or explained.
- [ ] No settlement double-count: per load, bridge totals equal fact_gp_settlement_load summed across schedules — paste the check returning 0 mismatched loads.
- [ ] No revenue over-allocation: per order, SUM(sell_value) ≤ dim_order.derived_price_value + $1 — paste the check returning 0 violating orders.
- [ ] Tier breakdown pasted (rows and grower_gross share per tier); product_exact ≥ 80% of gross, consistent with the verified 84.4%.
- [ ] Variance distribution pasted: median, p95, share of product_exact rows within ±1%, top 10 absolute variances with load/order identifiers.
- [ ] Revenue-class checkpoint completed: full charge list with proposals produced, Tim's marking applied, revenue_class wired through classifier and bridge; mackays_revenue by class and by grower pasted, and ripening total sanity-checked against ct_scope 'WH - Ripening' raw sum.
- [ ] RLS fail-closed proof: bridge fact and all semantic views (including mackays_revenue_fresh) return ZERO rows to a grower-scoped JWT and full rows to the internal claim — paste both. Tests added to the RLS proof suite.
- [ ] Existing suites still green (45/45 multi-farm RLS, 25/25 MCP identity) — paste the run output.

## Definition of Done
- [ ] All acceptance criteria checked, each with pasted evidence
- [ ] Tests written and passing per rubric below
- [ ] No TypeScript errors in touched build code
- [ ] HANDOFF.md updated
- [ ] Committed to git

## Quality Rubric (Mackays / mm-data-hub)
- SQL against the layers is the oracle; counts reconcile across every boundary; no key field dropped in any transform.
- FreshTrack patterns: established schema usage, defensive on nulls (order_id, product_id, price fields).
- No destructive SQL; raw layer untouched.
- RLS: new tables ship with policies matching the house patterns (grower-scoped / internal-only / cube_readonly); enforcement proven, not asserted; nothing weakens an existing policy.
- Universal: no secrets, no empty catch blocks, no TODO in the critical path, clean tree at handoff.
- Hard blockers: RLS fail-closed proof, the two double-count guards, and the revenue-class checkpoint (no guessing).

## Goal Condition
/goal The settlement bridge is built in mm-data-hub: core.fact_settlement_bridge exists at ft_gp_detail grain for settled loads, with match_tier, sell_value, grower_gross, variance, and mackays_revenue populated per SPRINT.md. Prove it by pasting real query results: (1) fact row count vs settled gp_detail count, matching or explained; (2) per-load settlement totals equal fact_gp_settlement_load summed across schedules, 0 mismatches; (3) per-order SUM(sell_value) exceeds dim_order.derived_price_value (+$1) for 0 orders; (4) tier breakdown with product_exact ≥ 80% of gross; (5) variance distribution with median, p95, top-10 absolute variances; (6) mackays_revenue by class with ripening tied to the ct_scope raw sum; (7) all new semantic views return 0 rows under a grower JWT and real rows under the internal claim. STOP at the revenue-class checkpoint and wait for Tim's marking before wiring revenue_class. Do not touch the raw layer, grower_ semantic views, the grower MCP, or Cube config. Stop after 30 turns.

## Out of Scope
- Stream 2b (third-party ripening) — depends on the customer-invoicing / receivables ingest (audit gap #2)
- Stream 3 (frozen banana / value-added) — not in the current ingest; Tim to confirm invoicing home (NetSuite?) before scoping
- Retail margin (fact_order_item ↔ retail_prices) — the follow-on that actually carries the word margin
- Cube metric-layer exposure (after variance + revenue definitions are signed off)
- NetSuite fact_settlement_bill cross-check; remittance reconciliation; harvest & yield; conformed dims
- Backfilling the 2,339 loads with no order_id, or the null dispatch_load_id column on fact_order_item
- Any change to raw.*
- The RLS remediation on dim_ns_charge / dim_gp_charge / dim_dispatch_state — separate migration, do NOT fold into this sprint

## Notes for the build session
- The repo's current working-tree SPRINT.md is an mm-hub companion sprint — replace it with this file and commit before starting.
- revenue_class lands on dim_gp_charge, which is also getting RLS enabled in the separate remediation migration — sequence them so they don't collide (remediation first is cleanest).
- Run the evaluator (dispatched Agent View session, standard skeptical-QA prompt) after the goal loop reports done; it must re-run the SQL itself.
