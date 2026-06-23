# Proposal — correcting the `dispatched` + `boxes` definitions (Sprint 7 finding)

Date: 2026-06-23 · Status: **DRAFT for decision** (not yet implemented)
Evidence (all read-only, load-safe): `scripts/ft_dispatch_status_probe.ts`, `ft_dispatch_box_probe.ts`, `ft_dispatch_definition_evidence.ts`, `ft_dispatch_order_lookup.ts`. Ground-truth case: load **G5021160 - 126** (LMBCO), cross-checked against the FreshTrack portal.

## TL;DR
The Sprint-7 backfill brings the warehouse current, but **two governed definitions don't match how FreshTrack records dispatch**, so active growers like LMB stay invisible and box totals undercount for everyone:

| | Current definition | Reality | Proposed |
|---|---|---|---|
| **Dispatched?** | `actual_pickup_on IS NOT NULL` | `actual_pickup_on` is barely captured — null on 85% of **Paid** loads, 98% of **In Transit**, 100% of LMB's 2026 loads | load has reached a **Shipped-or-later** state (`dispatch_load_state.sequence >= 5`) |
| **Dispatch date** | `actual_pickup_on` | mostly null | `coalesce(actual_pickup_on, scheduled_pickup_on)` (optionally `, pack_date`) |
| **Boxes** | `pallet.box_count` | `box_count` = own-stock only (= `stock_boxes`, 100% of the time); reconsigned cartons sit in `reconsigned_boxes` | `stock_boxes + reconsigned_boxes` ("Boxes Packed") |

The backfill is **in scope and unaffected** — it lands every field these definitions need (`state_id`, `stock_boxes`, `reconsigned_boxes` are already columns). Changing the definitions is a **separate, governed-metric decision** (this doc) and must not be done silently (additive-only contract).

## The FreshTrack dispatch lifecycle (source of truth)
`dispatch_load.state_id → dispatch_load_state` (14 states, ordered by `sequence`):

`1 Open · 2 Work in Progress · 3 Filled* · 4 Ready to Collect · `**`5 Shipped`**` · 6 In Transit · 7 Delivered · 8 Partially Delivered · 9 Ready to Invoice · 10 Invoiced · 11 Charges Applied · 12 Ready for Payment · 13 Paid · 14 Closed` (*inactive).

**"Has it shipped?" = `sequence >= 5`.** G5021160 is "Ready for Payment" (seq 12) — definitively shipped, `actual_pickup_on` null. All 250 of LMB's 2026 loads sit in Shipped-or-later states (Paid/In Transit/Ready for Payment/Delivered).

`actual_pickup_on` is unreliable across the **whole business**, not just LMB — % populated by state (2026): Paid 15%, Invoiced 61%, Charges Applied 33%, In Transit 2%, Delivered 18%. It is not a dependable dispatch signal.

## Proposed definitions (exact before/after)

**`semantic.grower_dispatch_detail`** (the view the dashboard reads — holds BOTH definitions):
```sql
-- BEFORE
   d.actual_pickup_on::date  AS dispatched_on,
   p.box_count               AS boxes,
   ...
 WHERE d.actual_pickup_on IS NOT NULL
   AND coalesce(g.is_test,false) = false
-- AFTER
   coalesce(d.actual_pickup_on, d.scheduled_pickup_on)::date          AS dispatched_on,
   (coalesce(p.stock_boxes,0) + coalesce(p.reconsigned_boxes,0))      AS boxes,
   ...
   JOIN core.dim_dispatch_state st ON st.state_id = d.state_id
 WHERE st.sequence >= 5            -- Shipped or later
   AND coalesce(g.is_test,false) = false
```

**Cube** (`dispatch_loads.yml`, `dispatch_pallets.yml`) — both bake `actual_pickup_on IS NOT NULL` and define `dispatched_on = actual_pickup_on`; both would change identically (state-gate + coalesce date). The Cube has **no boxes measure today** (it surfaces `net_weight_dispatched`), so "boxes" is a **view-only** change unless we additively add a `boxes_packed` measure.

**New (additive) dim required:** `raw.ft_dispatch_load_state` + `core.dim_dispatch_state` (id, code, name, sequence) — small, mirrors `gp_status`. `state_id` itself already lands in `raw.ft_dispatch_load`.

## Blast radius (2026, Sell loads)

| Metric | Current | Proposed | Δ | Defined in |
|---|---:|---:|---:|---|
| Dispatched loads (global) | 2,953 | 7,681 | **×2.6** | view + dispatch_loads + dispatch_pallets |
| Dispatched loads (LMB) | 0 | 248 | **0 → 248** | (same) |
| Boxes total (global) | 3,053,700 | 4,403,927 | **+44%** | view only |
| Boxes total (LMB) | 17,840 | 296,824 | **×16.6** | view only |
| LMB most-recent completed week | 0 loads / null | ~10 loads / ~12,000 boxes | — | view |

Every dispatch **volume** metric (load_count, pallet_count, net_weight_dispatched, line_count) roughly **2.6×** for every grower and every consumer (dashboard, Steep, MCP). This is a **re-baseline**, not a tweak.

## Cross-grower validation (is the methodology sound across the board?)
Evidence: `scripts/ft_dispatch_cross_grower_validation.ts` (2026 Sell, 49 non-test growers). **Yes — it generalises, and it corrects a systemic flaw, not an LMB special case:**

1. **`actual_pickup_on` under-population is systemic.** Only **4 of 49** growers populate it on ≥75% of loads; **23 growers sit at 0%** (like LMB); 45/49 are under 75%. The current metric is broadly broken.
2. **The state signal agrees with `actual_pickup_on` wherever it exists.** Of loads that *have* an actual pickup, **99.4%** are also `seq ≥ 5` — only **17 contradictions** (0.6%, loads picked-up but bounced to an earlier state). So `seq ≥ 5` doesn't conflict with the existing ground truth; it *adds* the 4,745 shipped loads that lack an actual-pickup stamp.
3. **`seq ≥ 5` is clean — it does not sweep in non-shipped loads.** Of 7,681 shipped loads, only **6** have no pallets and **16** have zero boxes (0.2%).
4. **The scheduled-date fallback is a sound proxy.** Where both dates exist, scheduled pickup is a median **0.41 days** from actual; **95.7%** within 2 days.
5. **Boxes change is well-targeted — stock-only growers are UNCHANGED.** Of 49 growers, **15 (stock-only) see boxes unchanged** (≈1.0×, e.g. MMTRU 1.56M→1.56M, MMANN 155,005→155,007); the **34 reconsignment growers** are corrected upward (LMBCO 15.8×, LMBEP 21.6×, SERAV 4.4×). The biggest grower (MMTRU, recon 0%) is unaffected on boxes.

**Punchline: 22 of 49 active growers are invisible on today's dashboard** (0 current loads, >0 shipped) — LMB is just one. Totals: dispatched loads 2,953 → 7,681 (×2.6); boxes 3,053,700 → 4,403,927 (+44%). The revised methodology is consistent, conservative, and applicable across the board.

## The decision (yours)

- **A — Backfill only (in scope).** Ship the loader; LMB stays at its 2025-07-15 row; report the LMB AC as evidenced source truth. No metric change. The dashboard keeps undercounting dispatch business-wide (status quo).
- **B — Redefine in place.** Correct `dispatched`/`boxes` everywhere (view + Cube). One correct source of truth, but **breaks the additive-only contract** (CLAUDE.md: "NEVER redefine an existing metric's … baked-in filter set — it silently breaks every consumer") — every existing dispatch number re-baselines ×2.6. Requires coordinated Cube redeploy + sign-off + consumer comms.
- **C — Additive (recommended).** Leave the `actual_pickup_on` metric untouched; add a NEW contract-compliant surface: `core.dim_dispatch_state`, a `semantic.grower_dispatch_shipped` view (or `*_detail_v2`), and new Cube measures (`shipped_load_count`, `boxes_packed`) + dims (`dispatch_state`, `effective_dispatched_on`). LMB shows via the new path; existing consumers are unaffected and opt in. Honors additive-only; more surface area.

**Recommendation:** do the **backfill now** regardless (Sprint 7 as scoped — it lands all the data). For LMB visibility, take **C** — either folded into this sprint as an additive extension, or as a fast follow-up sprint. Reserve **B** only as a deliberate, signed-off correction with a re-baseline plan.

## Confirm-before-ship (if B or C chosen)
1. **Ops sign-off on the dispatch threshold:** is "Shipped+ (seq ≥ 5)" the right "has left the dock" line, or should it be a different state (e.g. require Delivered, or include Ready to Collect)?
2. **Validate "boxes packed" against a normal STOCK load's portal screen** (we confirmed the reconsigned case via G5021160; `box_count == stock_boxes` always, so the formula is sound — one stock-load check closes it).
3. **Date fallback:** `coalesce(actual, scheduled)` — decide whether to add `, pack_date` for the rare shipped load with neither pickup date.
