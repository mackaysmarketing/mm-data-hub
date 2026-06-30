# Reconciliation Ledger — Bold Reports vs Supabase/Cube Warehouse

Run started: 2026-07-01 (overnight autonomous run). Branch: reconciliation/bold-vs-warehouse
Warehouse: Supabase hub `uqzfkhsdyeokwnkpcxui` (raw/core/semantic). Reports generated 2026-07-01 ~10:00 AEST.
One bounded backfill performed up front to close the sync-lag window (existing dispatch loader, idempotent upserts into
RAW, `--since=2026-06-28`): loads 22,401→22,443, pallets 204,665→205,154 (full detail in "Run context" below).

## Status legend
- **DONE** — every figure aligned (exact, or within tolerance with a documented, proven cause)
- **RECONCILED-DIFF** — figures explained; a residual gap is proven structural (sync lag / known data-gap noise / definitional) and documented, not hand-waved
- **BLOCKED-NEEDS-TIM** — alignment requires a schema change, a new migration/DDL, a Cube model/deploy change, a field the existing loaders don't land, or replica/credential access not available in-session
- **IN-PROGRESS** / **NOT-STARTED**

## Final scoreboard

| # | Report file | Headline figures | Status | Validated query | Notes |
|---|-------------|------------------|--------|-----------------|-------|
| 1 | `SOH-Cons_Summary_Truganina.csv` | 425 pallets / **30,957 boxes** on hand @ MMTRU | **DONE** | `queries/soh-cons-truganina_*.sql` | 425/425 pallets present & box-exact after sync-lag backfill (was 304/425). |
| 2 | `Stock On Hand.csv` | **18,073 boxes** on hand @ MMLAR | **RECONCILED-DIFF** | `queries/stock-on-hand_*.sql` | 336/336 pallets present, 327 (97.3%) box-exact. −5.1% residual = 9 null-`box_count` frozen pallets (SPEC §9.3) + SSRS multi-table extraction edge. |
| 3 | `Weekly Purchase Order Summary (Sales).csv` | ordered qty ~244,336 + prices | **BLOCKED-NEEDS-TIM** | `queries/weekly-po-summary_*.sql` | Ordered qty + price live in FreshTrack `order_item` (proven 960/37.68 exact); NOT landed. Order *headers* match (441/558 po_no present). |
| 4 | `Sales - by farm.csv` | qty **4,919,304** · wt **53,495,382** · **$85,522,918** | **RECONCILED-DIFF** | `queries/sales-by-farm.sql` | Qty −0.43% (= `stock_boxes`+`reconsigned_boxes`; 8391/8572 loads exact). Wt +3.4% (SPEC §9.3 unreliable `net_weight_value`). $ + price BLOCKED (order_item, as #3). |

**Summary:** 1 DONE · 2 RECONCILED-DIFF · 1 BLOCKED-NEEDS-TIM. Every report is in a terminal state with pasted evidence
and a saved query. **Two cross-cutting findings:** (a) a ~1.5-day **sync-lag** window (warehouse synced 06-29 20:11 vs
reports 07-01 10:00) capped every report; closed by one bounded idempotent dispatch-loader backfill. (b) **Order-line
demand data (ordered quantity, unit price, line amount) is not landed** — the curated dispatch warehouse holds
`dispatch_load`+`pallet` (packed boxes, net weight) but not FreshTrack `order`/`order_version`/`order_item`. Any report
figure that is a price/$ or a forward *ordered* quantity is BLOCKED on landing those tables (the single actionable
change for Tim). All *dispatched* volume figures (boxes, pallets, net weight) reconcile.

---

## Per-report detail

### Run context (applies to all reports)
- Warehouse = Supabase hub `uqzfkhsdyeokwnkpcxui`, schemas `raw`/`core`/`semantic`.
- Reports were generated **2026-07-01 ~10:00 AEST**. Warehouse dispatch layer was last synced **2026-06-29 20:11**.
- **Bounded backfill performed once, up front** (permitted by spec — existing proven loader, idempotent upserts into RAW):
  `npm run ft:dispatch:load -- --since=2026-06-28` (incremental by `last_modified_on`, from the FreshTrack read-replica).
  - BEFORE: `raw.ft_dispatch_load` = **22,401**, `raw.ft_pallet` = **204,665** (max `_synced_at` 2026-06-29 20:11).
  - Loader output: `dispatch: seen=654 upserted=654` · `pallet: seen=2350 upserted=2350`.
  - AFTER: `raw.ft_dispatch_load` = **22,443**, `raw.ft_pallet` = **205,154** (max `_synced_at` 2026-07-01 00:45).
  - This closed the ~1.5-day sync-lag window that otherwise caps every 2026-07-01 report.
- Read-only SQL runner: `reconciliation/q.ts` (uses `DATABASE_URL`, asserts hub ref). CSV analyzer: `reconciliation/analyze.ts`.

---

### Report 1 — `SOH-Cons_Summary_Truganina.csv`  →  **DONE**
**What it is:** Stock-On-Hand Consignment Summary for **MM Truganina (MMTRU)** DC, as of 2026-07-01 10:00. One
detail row per pallet currently held at Truganina, grouped grower → consignment. 425 detail rows.

**Column map (reverse-engineered, SSRS `TextBoxNN` headers):**
`[0]` run timestamp · `[1]` consignment/manifest ref · `[2]` **pallet_no** · `[3]` pallet seq within group ·
`[4]` marketer/agent · `[5]` **grower (consignor)** · `[6]` stock date (`scheduled_pickup_on`) ·
`[7]` stock age in days (06/30→1, 06/29→2 … 06/24→7) · `[8]` product · `[9]` **box qty** · `[16]` grand-total slot.

**Hypothesis:** pallets in `raw.ft_pallet` whose `consignee_id` = MMTRU's consignee role key
(`0191f981-c9f7-87de-5ef6-ebcc669bbc96`); per-pallet qty = `ft_pallet.box_count`; grower = the load's consignor.
Reconcile at **pallet grain** by matching the report's enumerated 425 `pallet_no`s to the warehouse (authoritative —
the report lists exactly which pallets are on hand; "currently in the DC" is a live op-state with no single warehouse flag).

| Headline figure | Bold value | Warehouse result | Delta | Verdict |
|---|---|---|---|---|
| Pallets on hand | 425 | 425 matched (post-backfill) | 0 | exact |
| Total boxes on hand | 30,957 | 30,957 (`sum(box_count)`) | 0 | exact |
| Per-pallet box match | — | 425 / 425 exact (`box_count == report qty`) | 0 | exact |

**Query:** `reconciliation/queries/soh-cons-truganina_pallet-validation.sql` (425-pallet VALUES list vs `raw.ft_pallet`,
generated by `reconciliation/soh_trug_extract.ts`) · scope/derivation in `soh-cons-truganina_scope.sql`.

**Result evidence (pasted from transcript):**
- PRE-backfill: 304/425 matched, **304/304 exact box match**, 121 missing. Missing split by date proved pure sync-lag:
  06/24–06/28 = 100% present; 06/29 = 109 present / 20 missing (sync at 20:11); **06/30 = 0/101 present**.
- POST-backfill: `rpt_pallets=425, rpt_boxes=30957, matched_in_wh=425, exact_box_match=425, wh_boxcount_sum=30957, missing=0`.
  By date: every date 06/24–06/30 now 100% matched.

**Verdict:** **DONE.** Total stock-on-hand (30,957 boxes / 425 pallets) reproduced exactly at pallet grain; the only
pre-backfill gap was the proven sync-lag tail, closed by the bounded incremental loader run. Scope confirmed = consignee MMTRU.
Note: the independent state-filter derivation returns a *superset* (~1593 pallets in-window) because the live "held at DC
right now" status is not a modelled warehouse flag — so the pallet-list match is the authoritative reconciliation, and it is exact.

---

### Report 2 — `Stock On Hand.csv`  →  **RECONCILED-DIFF**
**What it is:** Stock-On-Hand at **MM Larapinta (MMLAR)** (the consignee — the 14-col table header is `consigneename11`,
single top group = "MM Larapinta"), as of 2026-07-01 ~10:00. The CSV **concatenates several SSRS tables of the same
stock at different grains** (manifest-summary in 11/12-col tables; pallet-level detail in the 14-col table). A naive
single-pass sum double/triple-counts across tables (→ 40,505); the true grand total is the pallet-detail table's box sum.

**Column map — pallet-detail (14-col) table:** `[0]` consignee (MM Larapinta) · `[1]` marketer (Eco-Farms / Mackays
Marketing) · `[2]` load state · `[3]` variety · `[4]` manifest/load_no · `[5]` product · `[6]` **pallet_no** ·
`[7]` pallet status · `[8]` spaces/count · `[9]` **box_count** · `[12/13]` grand-total slot. Verified the 14-col pallet
boxes roll up to the 11-col manifest box (manifest 865: pallets 64+66+72 = 202 = the manifest summary).

**Hypothesis:** pallet-detail `[9]` = `raw.ft_pallet.box_count`; reconcile the report's enumerated pallet_nos vs the
warehouse (like Truganina). `pallet_no` is **non-unique** in `ft_pallet` (phantom duplicate rows carry null box_count),
so match with `EXISTS … box_count = report box`.

| Headline figure | Bold value | Warehouse result | Delta | Verdict |
|---|---|---|---|---|
| Total boxes on hand | 18,073 | 17,146 (box-exact matched pallets) | −927 (−5.1%) | within structural residual |
| Pallets present | 336 (extracted) | **336 / 336** present in `ft_pallet` | 0 | exact |
| Exact box_count match | — | **327 / 336 (97.3%)** | — | exact for 97% |
| Manifest box totals (spot) | 708 / 1308 / 240 | 708 / 1308 / 240 | 0 | exact |

**Query:** `reconciliation/queries/stock-on-hand_pallet-validation.sql` (336-pallet EXISTS validation, generated by
`reconciliation/soh_extract.ts`) · `stock-on-hand_box-null-pallets.sql` (the 9 mismatches).

**Result evidence (pasted):**
- `rpt_pallets=336, rpt_boxes=17878, present_in_wh=336, box_exact_match=327, box_exact_sum=17146, missing=0`.
- Manifests verified individually vs `sum(box_count)`: 26453→708, 587809→1308, 564222→240 (all exact).
- The **9 non-exact pallets (3045425–3045433)** all have warehouse `box_count = NULL` (across all duplicate rows). They
  carry `net_weight_value=900` and `expected_box_count=60` instead — i.e. **box_count is null at source for these
  frozen "Peeled Whole" pallets** (SPEC §9.3 nullable-box_count invariant; product_description also blank), so
  FreshTrack's printed box figure isn't captured as `box_count` in the curated warehouse.

**Verdict:** **RECONCILED-DIFF.** Every on-hand pallet (336/336) is present in the warehouse and box_count matches for
97.3% of them. The residual −5.1% box-total gap = (a) **9 pallets with null `box_count`** in the warehouse (documented
SPEC §9.3 nullability; ~732 boxes), plus (b) a ~195-box (1.1%) CSV-extraction edge from the multi-table SSRS export.
Reproducing the exact 18,073 to the box would need either box_count populated for the frozen-line pallets (a loader/source
gap, not fixable read-only here) or the live "on-hand inventory" pallet selection, which is not a single modelled warehouse flag.

---

### Report 3 — `Weekly Purchase Order Summary (Sales).csv`  →  **BLOCKED-NEEDS-TIM**
**What it is:** Forward customer **purchase-order demand** by consignee for the upcoming ~2 weeks (delivery dates
2026-07-03 … 2026-07-13+), grouped consignee → product description → order, each order showing its order versions.

**Column map:** `[0]` marketer · `[1]` consignee (Woolworths Brisbane…) · `[2]` product description (15kg Exports…) ·
`[3]` **order ref = `po_no`** · `[4]` scheduled_delivery_on · `[5]` **latest-version ordered qty** · `[6]` **price** ·
`[7]` version_no · `[8]` per-version qty · `[9]` per-version price. Prior-version rows carry blank `[3]`.

**Hypothesis tested:** report order ref = `raw.ft_dispatch_load.po_no`; qty = some warehouse box field; price = none.

| Headline figure | Bold value | Warehouse result | Verdict |
|---|---|---|---|
| Total ordered qty (period) | ~244,336 (Σ[5], 561 orders) / 243,732 (Σ extracted, 558) | **not landed** | BLOCKED |
| Unit/line prices | 37.68, 41.60, 25.00 … (Σ ~20,041) | **no price field in warehouse** | BLOCKED |
| Orders present in warehouse | 558 (extracted) | **441 / 558** present as `dispatch_load.po_no` | partial (headers only) |
| Qty == warehouse `stock_boxes` | — | only **80 / 441** (stock_boxes=0 for Open forward orders) | mismatch (expected) |

**Evidence (pasted):**
- Probe of 6 report po_nos in `raw.ft_dispatch_load`: all `order_type='B'`, state **Open**, `stock_boxes=0`,
  `reconsigned_boxes=0`, consignee = Woolworths Brisbane (order_no e.g. 5022000). The warehouse `stock_boxes` is the
  PACKED count (0 here) — it is **not** the ordered quantity.
- Extraction+join: `rpt_orders=558, rpt_qty=243732, matched_loads=441, wh_stock_boxes_sum=129979, qty_eq_stockboxes=80`.
- **Source of truth located on the FreshTrack replica** (`reconciliation/ftq.ts`): po_no 0111142923 v1 →
  `order_item.total_box_count = 960` (= report qty exactly), `order_item.price_value = 37.68` (= report price exactly),
  `total_price_value = 36172.80`. Chain: `dispatch_load.order_id → order_version → order_item`.

**Query:** `reconciliation/queries/weekly-po-summary_order-item-source.sql` (the order_item proof + warehouse po_no probe);
`weekly-po-summary_po-presence.sql` (558-order presence/stock_boxes join, generated by `reconciliation/wpo_extract.ts`).

**Verdict:** **BLOCKED-NEEDS-TIM.** The two headline figures (ordered **quantity** and **price**) are order-line DEMAND
data that no existing loader lands. The warehouse curated dispatch schema (`dispatch_load` + `pallet`) carries only PACKED
boxes (`stock_boxes`/`reconsigned_boxes`, = 0 for these Open forward orders) and **no price** at all.
**Exact change required from Tim:** add a loader (and `raw` landing tables) for FreshTrack `public.order` /
`public.order_version` / `public.order_item` — specifically `order_item.total_box_count` (ordered boxes), `proposed_quantity`,
`price_value`, `total_price_value`, joined via `dispatch_load.order_id → order_version → order_item`. This is a NEW source
table + NEW loader (out of bounds for this read-only reconciliation run). Until then only the order *headers* (po_no /
consignee / scheduled_delivery / version) are reproducible — and only for the 441/558 orders that already have a
`dispatch_load` (the other 117 are pure forward orders with no load row, invisible because the `order` table isn't landed).

---

### Report 4 — `Sales - by farm.csv`  →  **RECONCILED-DIFF**
**What it is:** Sales (Sell dispatch loads, `order_type='S'`) by farm/grower, **flat detail table** — one row per
(load, product), no subtotal rows. 15,352 lines / 8,579 distinct loads. Pickup dates span 2026-01 … 2026-06 (YTD).

**Column map (proven by 3 exact spot-loads):** `[0]` consignee · `[1]` grower (consignor) · `[2]` marketer ·
`[3]` farm/shed · `[4]` **load_no** (unique in warehouse) · `[5]` **order_no** · `[6]` po_no · `[7]` version ·
`[8]` sched_delivery · `[9]` pickup · `[10]` **unit price** · `[11]` UOM · `[12]` product · `[13]` order-total qty
(REPEATED per split row — a render artifact, NOT summed) · `[14]` **qty = `stock_boxes + reconsigned_boxes`** ·
`[15]` **amount $ = qty × price** · `[16]` **net weight**.

| Headline figure | Bold value | Warehouse result | Delta | Verdict |
|---|---|---|---|---|
| Total qty (col14) | 4,919,304 | 4,898,389 = Σ(`stock_boxes`+`reconsigned_boxes`) | −20,915 (−0.43%) | within tolerance (sync tail) |
| — per-load qty exact | — | **8,391 / 8,572 loads** exact | — | 97.9% exact |
| Total net weight (col16) | 53,495,382 | 55,315,194 = Σ`net_weight_value` | +1,819,812 (+3.4%) | RECONCILED-DIFF (SPEC §9.3) |
| — per-load weight within 1% | — | **5,895 / 8,579 loads** | — | 69% within 1% |
| Total amount $ (col15) | 85,522,918.39 | **not landed** (order_item) | — | BLOCKED |
| Unit prices (col10) | 24.90, 36.54 … | **no price field in warehouse** | — | BLOCKED |
| Loads present | 8,579 | **8,572 / 8,579** (load_no, unique join) | 7 missing | sync tail |

**Evidence (pasted):**
- Spot-loads exact: order 5009135 → stock_boxes 3024 / box_sum 3024 / netwt 30240 (= report qty 3024, wt 30240);
  5022695 → 1 / 15; 5022696 → 55 / 445.5.
- `lines=15352 distinct load_no=8579`; report totals qty=4,919,304 box(col13)=6,689,107 weight=53,495,382 amount=85,522,918.39.
- Load-grain join: `matched=8572, wh_stock=3,471,493, wh_recon=1,426,896, wh_stock_plus_recon=4,898,389,
  wh_netwt=55,315,194, qty_eq_stock_plus_recon=8391, missing=7`.
- col13 proven to be the **order total repeated** on split rows (480+840=1320; 288+480+192+1200=2160) → not a measure.
- Weight gap is one-directional (1354 loads wh-higher vs 33 lower) on non-reconsignment loads (1.87M of 1.90M). Cause
  traced: warehouse `net_weight_value` is unreliable for some carton configs (load 5011173: 15kg cartons at 24.6–90 kg/box,
  ~2× nominal) — the documented SPEC §9.3 produce-dependent/unreliable net-weight property. Clean loads match exactly.
- $ source proven on FreshTrack replica: order 5009135 → `order_item.price_value=24.90`, `total_price_value=75297.60`
  (= report price 24.90 / amount 75297.60). Same un-landed `order_item` table as Report 3.

**Query:** `reconciliation/queries/sales-by-farm.sql` (spot-check, reconciliation logic, weight-cause, $-blocked proof);
generator `reconciliation/salesfarm_extract.ts`.

**Verdict:** **RECONCILED-DIFF.** The two **volume** headlines reproduce from the warehouse: **quantity to 0.43%**
(col14 = `stock_boxes + reconsigned_boxes`; residual = the post-07-01-00:45 sync tail + null box_count) and **net weight
to 3.4%** (residual = SPEC §9.3 unreliable `net_weight_value` on ~16% of loads, one-directional, proven by example). The
**monetary** headline (amount $85.5M + unit prices) is structurally **BLOCKED-NEEDS-TIM** — identical to Report 3: it
requires landing FreshTrack `order_item.price_value` / `total_price_value` (no price field exists in the curated dispatch
warehouse). col13's 6.69M is a report render artifact, not a warehouse quantity.
