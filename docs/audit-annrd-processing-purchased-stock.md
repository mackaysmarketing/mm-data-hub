# Ann Rd / processing / purchased-stock probe (2026-07-22)

Multi-agent probe. 10 agents, 0 errors. Two adversarial verifiers per track.

# Ann Rd, processing, and purchased stock — what the hub actually shows

**Short answer:** the processing/freezing business *is* identifiable, and it is already completely outside grower settlement — nothing to fix there. But Ann Rd itself is **not** a freezing site in the landed data; it is a ripening/cross-dock node, and excluding it would delete $12.0m of genuine grower settlement. The real "purchased stock in the portal" exposure is a different population: **$4.04m** sitting on Buy-origin loads, plus **$519k** of deduction-free NetSuite bills. And the one thing you actually asked about — the *agreed rate* — is nowhere in the hub.

---

## 1. Is Ann Rd / the processing stream identifiable? Yes — by entity and by product, not by any "processing" flag

**Ann Rd exists as four FreshTrack entities** (all reproduced exactly by both verifiers):

| code | name | tags | role |
|---|---|---|---|
| MMANN | MM Ann Road | `3PL` | consignee `0193f60d-2727-6328-ff18-73f9dde47f89` |
| MMANR | Mackays Marketing - Ann Road | `Customer` | 1 inbound load, 7 pallets |
| MMPRO | Mackays Processing | `3PL` | 1 load in, **255 loads out** |
| ANNRTEST | Ann Road Test | — | `is_test=true`, inactive, 24 loads as consignee |

MMANN's parent is MACKM "Mackays Marketing"; its consignee record carries `vendor_no='WAREHOUSE'`; all four are already classified `retailer_group='internal'`.

**MMANN inbound = 1,460 loads, and zero of them carry processed or processing-input product.** Product mix is ripe/semi-ripe Cavendish cartons, Coles bands, WOW collars, Lady Finger, papaya and avocado trays. The only frozen charge in the entire GP rate card is `WH - Handling - Larapinta - Frozen Banana 10kg` — and it has been **applied 0 times**. There is no frozen charge for Ann Rd at all.

> **⚠ This contradicts your framing.** In landed data, Ann Rd = **ripening and handling** ($674,792.57 of `WH - Ripening - Ann Rd - Banana 15kg` across 2,368 charge lines / 6 consignors; ~$962k of Ann Rd charges in total). The **freezing/processing** entities are **MMPRO (Mackays Processing)** and **MMLAR (MM Larapinta)**. The hub has no site/address table, so it **cannot** tell us whether MMPRO physically sits at Ann Rd. That's a business fact only you have.

**The processing stream is identified by a 7-product set** in `core.dim_product`:

- Inputs (bulk): `PBIN` Processing Bin · `910115` Red Harvest Bin · `910126` Organic Octabin
- Outputs (crop = "Processed Banana", pack = "10kg Carton - Value Added"): `950101` Frozen Folded · `950102` Frozen Sealed · `950104` Chilled Folded · `950105` Chilled Sealed

Volume: **607 dispatch loads** carrying those products (**397** if you gate out archived pallets — the two verifiers disagree on which gate to use; the conclusion is identical either way). Pallets: 950102 3,334 · 950101 2,050 · 950104 1,939 · PBIN 1,861 · 910126 102 · 950105 9.

**Consignors of all 607 loads: MMLAR 261, MMPRO 255, ECOFA 48, DOEML 33, BLEND 7, WICFL/CHEFB/DOEAR 1 each. Every one is `is_grower=false`.** Consignees are food manufacturers plus MM Larapinta itself: Country Chef Bells Creek, Simped/New Cold, Blenners Darra, Doehler, Aryzta, Allied Pinnacle Melbourne & Sydney (Frozen).

**The decisive number:**
```sql
with proc_loads as (select distinct pa.dispatch_load_id lid from raw.ft_pallet pa
  join core.dim_product p on p.product_id=pa.product_id
  where p.crop_name='Processed Banana' or p.code in ('PBIN','910115','910126'))
select count(distinct pl.lid) proc_loads, count(distinct f.dispatch_load_id) in_gp_settlement
from proc_loads pl left join core.fact_gp_settlement_load f on f.dispatch_load_id = pl.lid;
-- 607 | 0
```
**607 processing loads → 0 GP settlement lines → $0.** Verified as zero across all three lineage keys (`dispatch_load_id`, `original_dispatch_load_id`, `origin_dispatch_load_id`). The processed stream has never been in grower settlement and needs no exclusion.

**The money on the processing book (NetSuite):**
- **Purchases in:** item `910128` "BananaCavendishProcessingMIXMac Farms - 1kg" — **82 lines / 82 bills / $519,142.40**, 2025-07-06 → 2026-07-05. MACBO $455,226.40 · MACSD $59,710.20 · MACGT $4,205.80.
- **Sales out:** **$3,624,932.36** across 206 customer-invoice lines — 950102 $1,455,497.00, 950104 $1,561,479.36, 950101 $604,123.60, 950105 $3,832.40, plus PBIN $105,545.04. Customers: Country Chef, Aryzta, Allied Pinnacle (Frozen), Edlyn, Priestlys, Madhouse Bakehouse.

> **Note the ~7:1 gap.** $3.6m of processed sales against $519k of processing-fruit purchases through the RCTI route. **Most of the input to processing does not arrive via item 910128.** Where the rest comes from is not answerable from landed data. (Two probe reports wrongly claimed the 950xxx items and the resale side weren't landed; both verifiers refuted that — all five 950 items including `950000 "Processed Banana"` exist, and the resale is fully landed.)

---

## 2. Can "purchased at an agreed rate" be told apart from commission consignment?

**Honest answer: not directly, anywhere. No landed field records a purchase price, a rate, a quantity, or a contract type.** Everything below is inference from *money shape*, not from a flag.

Ranked by measured separating power:

| # | Predicate | Separation | Numbers |
|---|---|---|---|
| **1** | **NetSuite bill has NO commission item (`itemid ~ '^31'`)** | **Perfect on the NetSuite surface — zero overlap** | 1,085 bills carry commission at **3.000–4.566%** of product gross (median 4.387%). **82 bills carry exactly zero.** Those 82 are the 910128 processing bills. Plus 4 commission-free adjustment bills ($5,843.90) that are legitimate. |
| **2** | **Bill structure: 1 product line + 1 GST line, zero deduction lines** | **82/82 vs 3/1,085** | Processing bills average **1.0** detail line and **0.00** deduction lines. Ordinary grower RCTIs average **41–44** lines carrying commission, levies, rebates, freight, warehouse. This is what a purchase invoice looks like; a commission RCTI carries the deduction stack. |
| 3 | `fact_settlement_bill.total_deductions = 0` | Near-perfect | 85 bills: 82 processing + 3 false positives (AVOLU levy refund $2,244, ALCOC $1,308, WADDA $0). |
| 4 | Item `910128` present | Exact but narrow | 82 bills, $519,142.40, 3 vendors. Any future processing item escapes silently. |
| 5 | **`order_type='B'` traced to the ORIGIN load** | **Real signal, but mixed population** | **1,043 settlement rows, gross $4,749,172.82, net $4,043,914.26**, 286 schedules, 23 consignors — see §3. Mixes agents and genuine growers. |
| 6 | `is_grower` flag | Separates agents, **zero** power on purchases | 7 AG* agents carry $1,966,588.56 GP gross. But all 82 processing bills are on `is_grower=true` Mackays farms. |
| 7 | GP commission charge on the schedule | Almost none | Present on **1,328 of 1,332** schedules. The 4 exceptions total $77,950.32 and are not purchases. |
| 8 | Price ladder (quoted/invoiced/paid/remitted) | **None** | `price_paid_value` populated on 378/25,119 (1.5%); `remitted` 367 (1.46%). Where both exist, quoted == invoiced on **18,712 of 18,739 (99.86%)**. Dead. |
| 9 | `raw.ft_gp_detail.processing_id` | **None** | Non-null on **25,119/25,119**, 7,586 distinct, joins to **nothing** landed (0 matches across 14 FreshTrack PKs), and all 361 Buy-load values also appear on Sell rows. It is not a processing flag. |
| 10 | Consignee = an MM facility | **None — actively misleading** | 1,068 of 1,460 MMANN loads are the origin of a downstream settled sale worth **$12,035,467.12**. |

**Two important honesty caveats on predicate #1**, both raised by verifiers:

- The word "purchase" is **not in the data**. A positive `foreignamount` product line on an RCTI is exactly what a *commission* gross line also looks like. What is established: 82 bills are commission-free, deduction-free, single-line and weekly. That *shape* is a purchase; the label is inference.
- **All three vendors are Mackays' own farms** (MACBO/MACSD/MACGT, under the MACKF Mac Farms parent) and every line is `accountinglinetype='INTERCOEXPENSE'` — related-party. So these are not arm's-length third-party agreed-rate purchases. Sibling item `910129` "Mackays Growers - 1kg" exists with **0 lines** — the capacity for third-party processing purchases is there and unused.
- Latent fragility: item `591` "LA - Commission - 3%" is a commission item that `^31` does not match. Today safe (0 bills carry 591-commission without 310-commission), but it's the same trap as LA meaning two things.

---

## 3. What this means for the grower portal

### The $4.04m figure you carried in is CORRECT — two probe reports wrongly told you it was bogus

Both adversarial verifiers independently reproduced it to the cent. The probes joined `order_type` on the *destination* load and found nothing; the figure is on the **origin** load:

```sql
select count(*) n_rows, sum(f.gross_sales) gross, sum(f.total_deductions) deds,
       sum(f.gst_total) gst, sum(f.net_settlement) net,
       count(distinct f.schedule_id) scheds, count(distinct f.consignor_id) consignors
from core.fact_gp_settlement_load f
join raw.ft_dispatch_load l on l.id = f.origin_dispatch_load_id
where l.order_type = 'B';
-- 1043 | 4,749,172.82 | -661,305.65 | -43,953.22 | 4,043,914.26 | 286 | 23
```

`fact_gp_settlement_load` carries three load keys giving B-totals of $0 / $4.99m / $4.04m net. Origin lineage is the business-relevant one — purchased stock enters on a Buy load and is reconsigned onward.

**Composition of the $4,043,914.26 net** *(single-source, from one verifier — worth a re-run before it drives a decision)*:
- Agents (`is_grower=false`): **$1,777,517.08** — AGDBM $1,387,345.97 dominates. **All AG\* entities are already `portal_enabled=false`**, so this slice does not currently reach the portal.
- Genuine growers: **~$2,070,543.15** — LMBEP $519,717.02, LMBCO $396,055.24, LMBBF $285,155.65, MACBO $140,361.31, SERRA $139,104.33. **These growers are `portal_enabled=true` — roughly $1.2m of it reaches the portal today.**
- No `dim_grower` match: 127 rows / $195,854.03.

### The options, with what each moves

| Option | What it does | Rows / money moved | Verdict |
|---|---|---|---|
| **A. Exclude Ann Rd consignee from the portal** | Removes `consignee_id = 0193f60d-2727…` | **1,018 loads, 12 portal-enabled growers, $12,035,467.12 of genuinely settled produce** | **DO NOT.** Both verifiers refuted the case for this. The apparent "$0 gross on Ann Rd loads" is a **grain artefact** — settlement keys on the *sale* load, and Ann Rd loads are reconsignment *origins*. Follow `original_dispatch_load_id` and the money reappears: 4,563 rows / 467 schedules / **$12,035,467.12 gross** on the same schedules. MACBO −$154,196.50 on the inbound leg has **+$5,808,891.68** on the origin side. No grower is economically net-negative on Ann Rd volume. Ann Rd is a 3PL cross-dock that reconsigns out to Coles Townsville ($7.54m), Woolworths Townsville ($3.25m), Simon George, etc. |
| **B. Gate NetSuite settlement bills with no commission item** | `semantic.grower_settlement` / `core.fact_settlement_bill` | **82 bills, $519,142.40**, 3 growers — **all `portal_enabled=true` today**, sitting in the fact with gross == net and $0.00 deductions, indistinguishable from commission settlement | **Do this.** It's the only zero-misclassification gate in the landed data, and it's a genuine live exposure. |
| **C. Gate GP settlement whose ORIGIN load is `order_type='B'`** | `semantic.grower_gp_settlement_load` — what grower-portal actually reads | **1,043 rows / $4,043,914.26 net / 286 schedules**; effective portal exposure ≈ **$1.2m** across LMBEP/LMBCO/LMBBF (agents already disabled) | **Your call.** Option B does *not* touch this surface at all — the portal reads FreshTrack GP, and commission is present on 1,328/1,332 GP schedules, so the commission predicate is useless there. If Buy-origin is the right proxy for purchased stock, this is the lever. If not, there is no other lever. |
| **D. Processing / frozen stream** | 607 loads | **$0 — zero settlement rows** | **No action needed.** Never in the portal. |

### Two hygiene issues found in passing
- `semantic.grower_dispatch_load` exposes non-growers as growers: MMANN itself, plus **Coles Townsville (COLTV), Woolworths Townsville (WOWTO), Simon George Cairns (SGCNS)** appear as *consignors* into Ann Rd — returns/rejections, not supply.
- The whole `internal`-consignee class in that view is **4,404 loads / 52 growers / 46.7m kg**, only 3.6% of which carry a customer invoice (vs 64–90% for retailers). Ann Rd is 23% of it; MM Truganina and MM Larapinta are bigger. Zero-invoice on an internal consignee is a cleaner, more generalizable signal than anything Ann-Rd-specific.

---

## 4. What is NOT landed and would have to be ingested

1. **The FreshTrack table `processing_id` points at.** 25,119 rows carry it; it resolves to nothing in the hub (0 joins across 14 FreshTrack PKs). Its target is where a real processing/batch flag would most plausibly live. **Landing it is the single highest-value next step** — but be warned, it is 100% populated including on ordinary Coles/Woolworths fresh settlement, so it may be a line-grouping key, not a processing marker. Confirm on the replica before committing.
2. **Any agreed-rate / purchase-price field.** Not in `ft_gp_detail` (all Buy-load prices are NULL — not zero — and box_quantity is 0 on all 486 lines), not in any landed FreshTrack table, not in NetSuite. The SuiteQL loader lands **no `quantity` and no `rate`** on `ns_vendor_bill_line`, and all 82 processing bill memos are NULL. Adding quantity/rate to the NetSuite bill-line loader would let us test rate-per-kg against commission-discovered price — the one test that could actually settle this.
3. **`item.parent` from NetSuite.** Without it, `950000 "Processed Banana"` cannot be *proven* to be the parent of 950101–950105 — only that all five exist and share a naming family.
4. **A NetSuite → FreshTrack transaction link.** No `dispatch_load_id` on RCTIs. We can say *which growers* were paid $519,142.40 for processing fruit, not *which loads*. The only bridge is that the four 950xxx SKU names match `core.dim_product` character-for-character.
5. **A frozen / chilled / fresh marker at load or pallet grain.** It only exists downstream in product names. 6,257 of 6,389 inbound Ann Rd pallets have a blank `product_description`.
6. **A site / address table.** Nothing links MMPRO or MMLAR to a physical location, so "is Mackays Processing at Ann Rd?" is unanswerable from the hub.
7. **Where the other ~6/7 of processing input comes from.** $3.6m of processed sales vs $519k of RCTI processing purchases. Not visible.

---

## 5. Questions only you can answer

1. **Is the freezing at Ann Rd, or is "Mackays Processing" (MMPRO) / "MM Larapinta" (MMLAR) a different site?** The hub says Ann Rd = ripening. If MMPRO *is* Ann Rd, the entity model is misleading and worth fixing at source.
2. **Is `order_type='B'` on the origin load your operational marker for "we bought this"?** It's the only lever that touches the GP settlement surface the portal reads. If it isn't, nothing in the hub currently distinguishes purchased from commission stock on that surface.
3. **Are the 82 MACKF bills ($519,142.40 to MACBO/MACSD/MACGT) genuinely purchases at an agreed rate, or just your processing-grade product line on a normal commission RCTI?** They're related-party (your own farms), commission-free and deduction-free — the shape says purchase, the data doesn't say it.
4. **Do you buy processing-grade fruit from third-party growers at an agreed rate?** Item `910129` "Mackays Growers - 1kg" exists with zero lines. If yes, those purchases aren't reaching NetSuite through this route.
5. **Should the ~$1.2m of Buy-origin GP settlement on LMBEP / LMBCO / LMBBF (all portal-enabled) be visible to those growers?**
6. **Should genuine grower loads that merely *pass through* Ann Rd / Truganina / Larapinta remain in the portal?** They should — they're $12.0m of real settled produce — but confirm, because 4,404 internal-consignee loads across 52 growers is a big surface.
7. **Should retailers appearing as consignors (Coles/Woolworths Townsville returns) be scrubbed from the grower dimension?**

---

## Flagged / unverified

- **Grower-level split of the $4.04m** (§3) comes from one verifier only and was not independently re-derived.
- **`semantic.grower_dispatch_load` load counts** shifted between probe and verification — migration **0061 landed the same day** and rewrote that view (archived-pallet handling). Any count off that view needs re-running.
- **607 vs 397 processing loads** — the archived-pallet gate was applied inconsistently across probes. Decide the gate before quoting either. The zero-settlement conclusion holds under both.
- **Corrections to the probe reports:** "1,672 of 1,673 rows have `price_invoiced_value = 0`" is wrong — they are **NULL** (the SPEC §9.3 null-vs-zero trap). "13 growers net-negative on Ann Rd" is 11 growers plus a null-consignor bucket (−$13,619.53). "`processing_id` is a payment-run batch key" is an invented meaning — the timestamp-prefix property is universal to every FreshTrack id, so it proves nothing specific. "FreshTrack ids are UUIDv7" is false.
- **No replica probes were run**, per instruction. Items 1, 2 and 7 in §4 would have to be established there.
