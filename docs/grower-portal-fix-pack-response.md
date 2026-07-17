# mm-data-hub → grower-portal: fix-pack response (2026-07-17)

Response to "mm-data-hub: fix instructions (from grower-portal)" (written 2026-07-18 portal-side).
All hub-side work is **live on prod** (`data_hub`, migrations `0053`/`0054`/`0055`) and proven by
`npm run portal:verify` (24/24; report `reports/grower_portal_fixes_2026-07-17.txt`). Everything
below is re-runnable by the portal with a grower token — no counts here are hand-entered
expectations; they are what the proof measured.

Shared test pair throughout: LRCLA + LRCTU (resolved by grower code, not uuid).

## FIX 1 — grower_gp_settlement.date_from/date_to ✅ (with one caveat)
Root cause: the FreshTrack SOURCE (`gp_schedule.date_from/date_to`) is null on 1,329/1,332
schedules; the 3 populated rows are TEST schedules whose dates contradict their own week_no.
Fix: derived from `week_no` against the ISO-week calendar (the same one `pack_week` uses):
`date_from` = Monday of that ISO week (year picked as the latest week-start ≤ payable_on, falling
back to created_on), `date_to = date_from + 6`. A new `dates_derived boolean` column flags it.
- Acceptance: **test pair = 104 schedules, 0 null dates**; all derived rows align to week_no.
- Caveat: **5 schedules hub-wide keep null dates** (AGDBM ×2, AGRRF ×3 — the source has neither
  week_no nor dates; nothing to derive from, surfaced not invented). Your global
  `count(*) where date_from is null` therefore returns 5, not 0; scoped to any grower token
  outside those two AG* entities it returns 0.

## FIX 2 — product labels ✅
Cleaned in the semantic views (raw lands faithfully): `^{...}` codes stripped, leading `[N]`
stripped, empty → variety → crop. Verbatim string kept as a new `product_raw` column on both
`grower_dispatch_shipped` and `grower_dispatch_detail`. "- WOW"-style suffixes kept, per the doc.
- Acceptance: `product like '%^{%' or btrim(product) = ''` → **0** on both views; pair-scoped
  empty/coded count → **0**.
- Caveat: 484 pallets hub-wide (0 in the test pair) have no product, variety, OR crop in
  FreshTrack — their `product` is now **NULL** (not empty string). Render as "—"; we surface,
  never invent.

## FIX 3 — public schema REST exposure ✅ audited; decision handed to mm-hub
This repo cannot change `public` (mm-hub owns it). Audit of all 38 public tables:
- **anon: zero policies anywhere** → RLS fail-closed on every table (the broad default anon
  GRANTs are dead; recommend mm-hub revoke them for hygiene — the hub schemas did this in 0051).
- **Auth0 grower tokens: identity-scoped tables error closed.** mm-hub's `private.portal_*`
  helpers key on `auth.uid()`, and an Auth0 `sub` (`auth0|…`) fails the uuid cast → 22P02, query
  aborts, zero rows. Verified behaviorally with a simulated Auth0-shaped token.
- **Residual (the real finding): five `using (true)` authenticated-read tables** any grower token
  (mm-hub or Auth0) can read: `retailers` (3 rows), `distribution_centres` (15 rows),
  `products`, `ft_products`, `product_retailer_mappings` (all 0 rows today). Reference-grade data,
  but it is mm-hub's call to accept or gate to `portal_is_internal()`.
- `pm_price_snapshots` / `pm_run_log`: RLS on, no policies → fail-closed.

## FIX 4 — load-grain dispatch view ✅
**`semantic.grower_dispatch_load`** is live: one row per shipped load (non-archived pallets),
same shipped gate + RLS chain as `grower_dispatch_shipped`. Columns: grower_key, load_id,
load_no, dispatched_on, pack_week, pallet_count, boxes, net_weight_kg, products (text[], cleaned),
dispatch_state/name/seq, connote_no, has_invoice, invoice_count, sale_gross, retailer_groups,
settlement_schedule_count, settlement_all_paid, settlement_paid_date, consignment_status.
- Acceptance: **test pair = 238 rows** (your number); Σboxes and Σnet_weight tie the pallet grain
  exactly; grower token sees only its rows; no-claim → 0.
- Note: 2 pair loads with landed invoices have ALL pallets archived → excluded here (by your
  `not is_archived` spec) but still visible in `grower_load_sale`.

## FIX 5 — retailer identity ✅
`core.crosswalk_customer_retail` (already existing, insight layer) is projected into a new
grower-scoped fact `core.fact_load_sale` (load × customer) at BUILD time — grower tokens never
touch the internal customer book. Grower surface: **`semantic.grower_load_sale`** — one row per
(load, customer) with `retailer_group` (woolworths/coles/aldi/other/internal), `state_code`,
`invoice_count`, `gross_amount` (CN invoices subtract), `share_of_load_gross`, first/last invoice
dates. Customer identity (consignee id/name) is deliberately NOT exposed.
- Acceptance: pair distribution = **woolworths on 240/240 sold loads** — matches the "- WOW" hints.
- `retailer_groups text[]` also appears on the FIX 4 load view for one-call rendering.

## FIX 6 — the four consignment statuses ✅
`consignment_status` on `grower_dispatch_load`:
- **Connote = `manifest_no`.** FreshTrack has NO connote column anywhere (we searched the full
  replica schema); `manifest_no` carries the carrier consignment-note numbers and is 100%
  populated on the pair's shipped loads. Exposed as `connote_no`.
- **Sold** = FreshTrack lifecycle ≥ Invoiced (seq 10 — the closest computable signal for your
  "fully invoiced" edge; no per-line coverage measure exists) OR a landed invoice OR membership in
  a settlement schedule. Today every invoiced load has exactly one customer, so the multi-customer
  edge is theoretical for now.
- **Paid** = every settlement schedule covering the load is PD ("paid for the ENTIRE
  consignment" — the cash evidence wins over the lifecycle state); lifecycle ≥ Paid is the
  fallback only for loads whose settlement predates the GP landing (June 2025).
- Every signal is a column, so each status count is explainable against records.
- Pair distribution: Paid=218 / Sold=13 / Consigned=7. Hub-wide: Paid=10,807 / Sold=3,337 /
  Consigned=402 / Not Consigned=31.

## FIX 7 — settlement drill-down ✅ (hub side)
Deductions per category were already on `grower_gp_settlement_load`; the customer link is
`grower_load_sale` joined on `dispatch_load_id`.
- Acceptance: schedule **1329** via a pair grower token → its 2 loads (G5021851-416, G5021853-439),
  each showing retailer (woolworths) + per-category deductions + gross.
- PDF stays portal-side, as your doc records.

## Sequencing note
Everything shipped in one pack; the load view + statuses + retailer projection are live now, so
Phase B is unblocked end-to-end. REST: all new surfaces live in `semantic` (already exposed).
Re-run your acceptance probes at will; `npm run portal:verify` re-derives them on our side.
