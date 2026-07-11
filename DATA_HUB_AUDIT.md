# Mackays Data Hub — State of the Warehouse

**A briefing on what has been ingested, what the schema looks like, and what to add next.**
Audit date: 2026-07-08 · Target project: Supabase `data_hub` (`uqzfkhsdyeokwnkpcxui`, ap-southeast-2)
Scope of audit: the committed `mm-data-hub` repo (ingestion + modelling). Figures below are drawn from the repo's own committed reconciliation/proof reports.

---

## 1. Executive summary

The Data Hub is a single Supabase warehouse that lands source data and shapes it through a
**`raw → core → semantic`** medallion, then serves it through a governed **Cube** metric layer and a
read-only **Hub MCP** server for agents. Everything above the hub reads *from* the hub, never from
each other or from the source systems directly.

**Five sources are landed today.** Four are fully evidenced (loader + reconciliation + RLS proof
committed); the fifth (retail) is landed and deployed but lighter on committed proof.

| # | Source | What it gives us | Transport | Volume (latest) | Grower-facing? | Status |
|---|--------|------------------|-----------|-----------------|----------------|--------|
| 1 | **FreshTrack — Dispatch** | Packhouse → dispatch: loads, pallets, boxes, net weight | GraphQL windowed + read-replica | 22,450 loads · 205,246 pallets | ✅ Yes | Live, reconciled 0.01–0.02% |
| 2 | **NetSuite — Settlement (RCTIs)** | Grower settlement: gross, every deduction, net, **paid date** | SuiteQL REST / OAuth 1.0a | 1,097 RCTIs · **$139.7M** net paid | ✅ Yes | Live, `recon_diff = 0` on every bill |
| 3 | **FreshTrack — GP Settlement** | Second view of settlement **with load-grain lineage** | Postgres read-replica | 1,254 schedules · 17,975 load-grain rows · **$176.6M** gross → **$140.5M** paid | ✅ Yes | Live, ties to NetSuite within 0.59% |
| 4 | **FreshTrack — Orders** | The **sell side**: ordered qty, unit prices, line dollars | Postgres read-replica | 21,192 orders · 73,212 lines | 🔒 Internal-only | Live, 500/500 sample reconciled |
| 5 | **Retail shelf prices** | Competitor pricing (Woolworths / Coles / ALDI) | `price-reporter` scraper → pg | Woolworths/Coles/ALDI watchlist | 🔒 Internal-only | Landed + Cube-deployed (7/7 per handoff) |

**Cross-source integrity is proven, not asserted.** GP settlement (FreshTrack's view) and NetSuite
settlement (the accounting view) independently reconstruct grower payments and agree: GP paid
**$140.5M** ≈ NetSuite net **$139.7M**; GP deductions **$32.53M** ≈ NetSuite **$32.50M**. The residual
is explained (GP's finer sub-entity granularity), not hand-waved.

**Governance is the spine, not an afterthought.** Every grower-scoped object is filtered by the
grower's own identity (`consignor_id`), read only from the server-controlled `app_metadata` JWT
namespace, and **fails closed** (no claim → zero rows). This is proven across all six grower-scoped
objects: 45/45 multi-farm RLS, 25/25 MCP identity-propagation, 12/12 Cube RLS.

---

## 2. Architecture at a glance

```
Sources                          Hub (Supabase Postgres 17)                 Access
─────────                        ──────────────────────────                 ──────
FreshTrack GraphQL  ┐            raw     per-source landing,                 Cube  ── Steep BI
FreshTrack replica  ┤──►  loaders  ►     source-faithful           ──►       │      (metrics)
NetSuite SuiteQL    ┤            core    conformed dims + facts,             Hub MCP ── agents
price-reporter      ┘            semantic the only layer read by consumers   SQL / PostgREST ── apps
                                          (RLS-scoped)
```

- **`raw`** — one table per source object, landed faithfully (UUID/native PKs, `_raw jsonb` safety net
  on small tables, enums stored as *text* never Postgres enums).
- **`core`** — conformed dimensions and facts: cleaned, cast, deduped, classified. Every fact is built
  by an **idempotent refresh function** that is mirrored by a unit-tested TypeScript "oracle" so drift
  is caught.
- **`semantic`** — `security_invoker` views; the *only* layer apps/BI/agents are meant to touch. RLS
  lives here.
- **Cube** (`/cube`) — metrics defined **once** in code; Steep and the Hub MCP consume them, they never
  redefine them. Metric contracts are **additive-only**.
- **Hub MCP** (`/mcp`) — a governed read server that holds **no standing elevated access**; caller
  identity enters once from a signed token and scopes every query.

---

## 3. What has been ingested — by domain

### 3.1 Dispatch (FreshTrack) — the packhouse-to-truck spine

The first and largest source. Answers *"what left the shed, for whom, when, how much."*

- **`raw.ft_dispatch_load`** (22,450) — one row per load: consignor (grower), consignee (customer),
  carrier, shed, order/PO refs, scheduled vs actual pickup/delivery, stock & reconsigned box counts,
  and `extra_text_2` (a 100%-populated pack-week code `Y25W31`).
- **`raw.ft_pallet`** (205,246) — one row per pallet: product/crop/variety, box counts, net weight
  (produce-dependent, nullable), packing shed, pack date.
- **`core.dim_grower`** (156) — the conformed grower dimension keyed on `consignor_id`, the RLS anchor.
- **`core.dim_dispatch_state`** / **`core.dim_shed`** — lifecycle states (Open→Shipped→Paid→Closed) and
  a shed-id→name lookup for farm-origin reporting.

**Reconciliation vs the FreshTrack replica (2% tolerance): all green.** Loads 0.00% Δ, pallets 0.02%,
net weight 0.01%, boxes 0.02%; per-grower load-count variance = 0 growers differ.

**Two governed dispatch surfaces exist** (deliberately kept distinct so definitions can't be confused):
- `dispatch` — the original: "dispatched" = `actual_pickup_on` is set. ~6,189 loads / 43,754 pallets.
- `dispatch_shipped` — a corrected, broader definition: "dispatched" = load reached **Shipped-or-later**,
  boxes = stock + reconsigned ("Boxes Packed"). **18,670 loads / 11.0M boxes / 174,711 pallets across
  69 growers** — this surface makes ~21 growers visible who were invisible on the narrow definition
  (because `actual_pickup_on` was barely captured upstream).

### 3.2 NetSuite settlement (RCTIs) — the accounting truth of grower payments

Read-only out of NetSuite (account 11176992, subsidiary 2). RCTIs = vendor bills where the vendor is a
Grower (category 110, 39 vendors).

- **`raw.ns_vendor` / `ns_item` / `ns_vendor_bill` / `ns_vendor_bill_line` / `ns_vendor_payment` /
  `ns_bill_payment_link`** — the full RCTI + payment graph.
- **`core.fact_settlement_bill`** (1,097 bills) — one row per RCTI: `gross_sales`, six signed deduction
  categories (freight / warehouse / market / larapinta / misc / other), `tax_total`, `net_paid`, and
  the **paid date** — the one thing FreshTrack cannot give.
- **`core.dim_ns_charge`** — every charge/product line classified by an itemid-prefix taxonomy.

**Line integrity is proven exactly**: `recon_diff = 0` for every bill; the sum of detail lines equals
the bill total for every bill; 0 unmapped growers.

### 3.3 GP settlement (FreshTrack) — the same money, with lineage

FreshTrack's own settlement schedules, landed via the direct Postgres read-replica. Its unique value
over NetSuite is **load-grain lineage**: every settlement line carries `dispatch_load_id`, so
settlement joins back to dispatch.

- **`core.fact_gp_settlement`** (1,254 schedules) — schedule grain: gross, deductions by category, GST,
  net, paid amount, paid date.
- **`core.fact_gp_settlement_load`** (17,975) — **load grain**, the lineage NetSuite structurally cannot
  provide. This is what lets you attribute a settlement dollar back to a specific dispatched load.

**Grand totals:** gross $176.6M → deductions −$32.53M → GST −$2.72M → net $141.4M → **paid $140.5M**
(anchored on the actual cash in `gp_payment`, not the unreliable invoiced-amount field). Cash
reconciles: 1,170/1,206 schedules within 1% of the payment record.

### 3.4 Orders (FreshTrack) — the sell side *(internal-only)*

The commercial layer: what was ordered, at what price. Internal-only because it exposes selling
prices/margins — a grower JWT sees **zero** rows.

- **`raw.ft_order` (21,192) / `ft_order_version` (35,900) / `ft_order_item` (73,212)**.
- **`core.fact_order_item`** — one row per **current-version** order line (superseded versions are never
  admitted); **`core.dim_order`** — one row per order with a **derived** dollar total (the replica header
  carries no dollar total, so it's computed from current-version lines).

**Reconciliation:** a 500 priced-order sample reconciled **500/500** on all four checks. Note ~47% of
lines are unpriced (quotes/pending) and correctly keep NULL — never coalesced to 0.

### 3.5 Retail shelf prices *(internal-only)*

Competitor pricing landed daily by the separate `price-reporter` scraper (Woolworths per-state stores,
Coles national baseline, ALDI national + Super Savers).

- **`raw.retail_prices`** — one immutable price observation per (run, retailer, state, product).
- **`core.dim_retail_product`** — the 5-line Mackays watchlist with per-retailer product-id crosswalk.
- **`semantic.retail_prices`** — a day-grain view (latest capture per product per local day) with a
  `scope` flag (national vs state) and an `is_watchlist` flag (Mackays lines vs ALDI catalogue noise).

Cube-deployed and live-proven 7/7 per the handoff. ⚠️ Unlike the other four domains, retail has **no
committed reconciliation report or npm proof script** in this repo yet — its evidence lives only in the
git/handoff notes.

---

## 4. Schema map — objects that exist today

### `raw` (per-source landing)
| Domain | Tables |
|---|---|
| Dispatch | `ft_dispatch_load`, `ft_pallet`, `ft_entity`, `ft_dispatch_load_state`, `sync_window` |
| NetSuite | `ns_vendor`, `ns_item`, `ns_vendor_bill`, `ns_vendor_bill_line`, `ns_vendor_payment`, `ns_bill_payment_link` |
| GP settlement | `ft_gp_schedule`, `ft_gp_detail`, `ft_gp_payment`, `ft_charge`, `ft_charge_type`, `ft_charge_applied`, `ft_gp_status` |
| Orders | `ft_order`, `ft_order_version`, `ft_order_item` |
| Retail | `retail_prices` |

### `core` (conformed dims + facts)
- **Dimensions:** `dim_grower`, `dim_dispatch_state`, `dim_shed`, `dim_ns_charge`, `dim_gp_charge`,
  `dim_order`, `dim_retail_product`
- **Facts:** `fact_settlement_bill`, `fact_gp_settlement`, `fact_gp_settlement_load`, `fact_order_item`
- **Crosswalks:** `crosswalk_ns_grower` (NetSuite vendor → grower), `crosswalk_gp_grower`
- **Reconciliation view:** `load_box_reconciliation`

### `semantic` (the consumer layer — all `security_invoker`)
| View | Grain | Audience |
|---|---|---|
| `grower_dispatch_detail` | pallet | Grower |
| `grower_dispatch_shipped` | pallet (Shipped+ definition) | Grower |
| `grower_settlement` | RCTI/bill | Grower |
| `grower_gp_settlement` | schedule | Grower |
| `grower_gp_settlement_load` | schedule × load (lineage) | Grower |
| `order_headers` / `order_detail` / `order_sales` | order / line | Internal |
| `retail_prices` | day × retailer × state × product | Internal |

### Cube metric layer (`/cube`) — what is actually queryable as governed metrics
- **`dispatch` view** — `load_count`, `pallet_count`, `net_weight_dispatched`, `line_count`,
  `pallets_with_net_weight`, `net_weight_capture_rate`. Slices: grower, pack-week, crop/variety/product,
  consignee, dispatch date.
- **`dispatch_shipped` view** — `shipped_load_count`, `boxes_packed`, `pallet_count_shipped`,
  `net_weight_shipped`. Slices: grower, dispatch state, effective dispatch date, origin shed.
- **`settlement` view** (NetSuite) + **`gp_settlement` / `gp_settlement_load` views** (FreshTrack) —
  gross, deductions by category, net, paid date, sliceable by grower / crop / week.
- **`sales_orders` view** (internal) — order dollars.
- **`retail` view** (internal) — `avg/min/max_price`, `observation_count`, `promo_observations`, sliced
  by retailer / state / scope / product / promo / capture date.

---

## 5. Access & governance (what makes this safe to expose)

- **Tenant isolation (RLS):** every grower query is filtered to the grower's own consignor set, read
  **only** from `app_metadata` (a namespace a grower cannot self-set). A forged top-level or
  `user_metadata` claim is ignored; a missing claim returns **zero rows** (fail closed). One grower login
  can now carry **multiple farms** (a consignor *set*, not a single id) — proven on L & R Collins across
  two farms.
- **Cube** re-applies the identical scope in `queryRewrite`; its DB role (`cube_readonly`) can read all
  rows but Cube narrows per query.
- **Hub MCP** holds no standing access — it either signs a short-lived per-caller Cube token (metric
  path) or assumes a least-privilege `hub_mcp` role and sets the caller's JWT claims so Postgres RLS
  scopes the row (detail path). Every read returns a self-describing envelope
  (`columns, rows, metric_definition, filters_applied, row_count, truncated`).
- **Internal-only domains** (orders, retail) invert the contract: only an internal claim sees rows;
  growers fail closed.

**Proof coverage:** 45/45 multi-farm RLS · 25/25 MCP identity-propagation · 12/12 Cube RLS · plus
per-domain line/cash/parity reconciliations.

---

## 6. Data-quality guardrails baked in (so they aren't re-discovered)

These are encoded in the schema and documented in `SPEC.md §9` / `CLAUDE.md`:
- **Grower attribution = the load's consignor**, never the pallet's harvest link (`harvest_load_id` is
  null on outbound).
- **Never coalesce nullable measures to 0** — `net_weight_value`, order `total_price_value`, retail
  `price` all preserve NULL (produce sold by count, unpriced quotes, unlisted lines).
- **Deductions/GST stored signed**; `net = gross + deductions + gst`.
- **Test consignors** (`TRUGTEST`, `LARATEST`, `ANNRTEST`) excluded at pull.
- **Enums are text**, never Postgres enum types (additive schema evolution).
- **Idempotent, resumable loaders** — re-running lands zero net new rows; interrupted backfills resume
  via `raw.sync_window`.

---

## 7. What we can report on **today**

Anyone with the right access can already answer, as governed queries (no hand-SQL):
- **Dispatch volume** — loads, pallets, boxes, net weight — by grower, crop/variety/product, customer,
  pack-week, shed, over time. Two definitions (actual-pickup vs shipped-state).
- **Grower settlement** — gross, every deduction category, net, and **when they were paid** — by grower,
  crop, week, from *both* the accounting (NetSuite) and operational (FreshTrack GP) views, cross-checked.
- **Settlement-to-dispatch lineage** — trace a settlement dollar back to the specific dispatched load
  (GP load-grain fact).
- **The sell side** (internal) — ordered quantities and line dollars per order/customer/product.
- **Competitor retail pricing** (internal) — price by retailer/state over time, promo frequency,
  cross-retailer gaps on the watchlist lines.

---

## 8. High-value data points **not yet there** — where to invest next

Ordered by likely business value. Several are explicitly flagged as "not built" in the repo's own
handoffs, which makes them the natural next moves.

### Tier 1 — completes the money story

1. **The margin / "sales-by-farm" bridge (order sell-price → dispatch → grower settlement).**
   This is the single highest-value gap and it is *called out as not-built* in the order-domain handoff.
   The sell-side dollars (orders) and the grower-payment dollars (settlement) both exist now, but they
   are **not joined**, so we cannot yet answer *"what did we sell this grower's fruit for vs what did we
   pay them — i.e. Mackays' margin per grower / product / customer."* The join keys
   (`dispatch_load_id`, `po_no`, `order_id`) are exposed and waiting. **Caveat:** the order→dispatch link
   is sparse on live/open orders (~261 of 35,572 current lines carry `dispatch_load_id` today), so this
   needs an attribution strategy (via `po_no` and origin-load), not a naive join. The two Bold reports
   that stayed BLOCKED/RECONCILED-DIFF (Weekly PO Summary, Sales-by-farm dollars) are blocked on exactly
   this bridge.

2. **Customer invoicing + automated AR remittance reconciliation (the accounts-receivable mirror).**
   *Requested 2026-07-08.* The hub models the *payable* side (what we pay growers) from two angles, but
   not the *receivable* side (what customers owe and pay us). Customer invoices **originate in FreshTrack**
   (EDI'd to the supermarket customers) and are **pushed to NetSuite for debtor management** — so, exactly
   like grower settlement, there are two landable views of the same money: FreshTrack as the invoice
   *origin* (carrying dispatch/order lineage) and NetSuite as the *debtor / cash* status (payments received
   and applied). Landing it reuses the existing NetSuite SuiteQL pipeline + medallion and is **internal-only**
   (AR is commercially sensitive, never grower-facing) — a near-mirror of the `raw.ns_vendor_bill*` →
   `core.fact_settlement_bill` work. The headline use case is **automating reconciliation of customer
   remittance advice files**: parse each remittance (**PDF** today, possibly CSV later) → match lines to
   invoices → flag **remittance-vs-invoice discrepancies** (short-pays, unexpected deductions,
   unmatched/duplicate invoices) → cross-check the cash NetSuite actually applied. The main effort is
   per-customer remittance parsing (each supermarket's format differs); the invoice + debtor landing is
   low-risk. *To be scoped as its own sprint — parsing formats and channel confirmed at design time.*

3. **A retail reconciliation/proof script + committed report.** Retail is the one live domain without the
   house-standard `npm run …:reconcile` + committed evidence. Adding it brings retail up to the same bar
   as the other four and de-risks the daily scrape.

### Tier 2 — the agentic access & intelligence layer

4. **A grower-facing MCP connector — growers plug their own AI agents into just their production & sales.**
   *Requested 2026-07-09.* The hard part is already built: the repo's Hub MCP (`/mcp`) is a governed,
   **identity-propagating, fail-closed** read server — caller identity enters once from a signed
   `app_metadata` token and Postgres/Cube RLS scopes every row, so no tool argument, filter, or `run_select`
   string can widen scope. What's missing to hand this to growers: (a) **wire the sales/settlement tools in**
   (`list_grower_sales` is still stubbed "Phase 2 — read-replica blocked"; the replica is now unblocked and
   settlement is landed — a wiring job, not a data gap; this **absorbs the previous standalone "wire
   settlement into the MCP" gap**); (b) **external grower auth** — issue each grower a scoped, short-lived,
   revocable token tied to their mm-hub grower login (the same `consignor_ids` / `is_internal` claim
   contract), so identity is delegated, never self-asserted; (c) **package it as a remote connector**
   (hosted HTTP/streamable transport, not just local stdio) so a grower points Claude / ChatGPT / their own
   agent at one URL. Scope is deliberately narrow — **only their own production (dispatch) + sales
   (settlement)**; internal/commercial surfaces (orders, retail, margins) are never exposed on this
   connector, and everything outside the caller's consignor set fails closed.

5. **A comprehensive, ever-evolving business knowledge graph — the context layer agents reason over.**
   *Requested 2026-07-09.* Today identity is a flat claim ("this login may see consignor set X"). The next
   step is a **knowledge graph of the whole Mackays Marketing business** — people and their **roles**
   (grower, account / field manager, packhouse, finance, sales…), plus growers, farms, customers, products
   and sites — and the **relationships** between them (who *manages* which growers, who *owns* which farms,
   which farm *grows* which product, which customer *buys* what). Agentic systems traverse it to **derive
   context from the user**: when *Jon* asks "what were my growers' farm dispatches last week," the graph
   resolves *Jon → his role → the grower portfolio he manages* (from **CRM records**) and scopes the answer —
   no hand-supplied grower list. Sources: the mm-hub CRM (`hub_users`, `farms`, grower groups,
   `module_access`), the hub's conformed dims (`dim_grower`, and the planned `dim_customer` / `dim_product`),
   and explicit org/role definitions; it must **evolve continuously** as the org and CRM change.
   **Governance note:** the graph informs *relevance / context* — it is **not** the security boundary. RLS
   still enforces scope fail-closed, so a graph edge can never widen what a caller may actually read. This is
   the connective tissue under every agent surface (the grower MCP above, the internal Hub MCP, and future
   assistants) that makes "context based on who's asking" possible.

### Tier 3 — new sources that unlock new questions

6. **Harvest / production / yield data (field → pack).** Today lineage stops at dispatch;
   `harvest_load_id` is null outbound and `productMovements` is empty upstream. Landing harvest loads +
   planting/block data would give **farm-block yield, pack-out %, and fruit age** — connecting what was
   grown to what was sold and settled. This is the biggest *new* analytical surface.

7. **Retail scan / consumer sell-through (IRI / Quantium).** Named in `SPEC.md §1` as a planned source,
   not yet landed. We have competitor *shelf price*; scan data adds actual *volume sold at retail* —
   turning "what's on the shelf at what price" into "what's actually selling," the demand signal behind
   the orders.

8. **Wholesale/market price benchmarks.** A reference price series (central-market or index pricing)
   would let us benchmark grower returns and Mackays margin against the market — high value for grower
   conversations and pricing strategy.

9. **Quality / QC / rejections / claims.** Packhouse grading, rejection reasons, and customer claims are
   not ingested. This is the quality dimension behind both grower returns and customer relationships.

### Tier 4 — conformance & depth (makes existing data easier and richer to report on)

10. **Complete the conformed dimension set.** `SPEC.md §3` envisages `dim_customer` (consignee),
   `dim_product` (product·crop·variety·pack), and `dim_date`, but only `dim_grower` (+ charge/shed/state/
   order/retail dims) are built. Customer, product, and date are currently *embedded in views* rather than
   standalone conformed dimensions — building them out gives clean, consistent slicing (e.g. one product
   hierarchy shared across dispatch, settlement, and orders) and a real time dimension for calendar/fiscal
   reporting. *(The `dim_customer` here is a prerequisite the customer-invoicing item above will also
   want — build once, share.)*

11. **Inventory / stock-on-hand as a first-class fact.** SOH is currently *derived* through ad-hoc
    reconciliation queries against pallets. Modelling a proper stock-on-hand / ageing fact would make
    "what's in the shed, how old, whose" a governed metric instead of a bespoke query.

12. **Freight & logistics cost detail.** Freight appears today only as a settlement *deduction category*.
    Landing carrier/lane/temperature-profile cost detail would support a real cost-to-serve and logistics
    analysis.

13. **Labour / payroll cost.** Not ingested. Pairing packhouse labour with pack volume would give a true
    cost-per-box and packhouse-efficiency view.

---

## 9. One caveat on repo state (for the colleague)

The file currently named `SPRINT.md` in the working tree is a **companion mm-hub sprint** ("Grower
Access Claims"), not a mm-data-hub sprint — it builds the claim-stamping path in the *app* repo that
feeds the `app_metadata` claims this warehouse reads. The most recent *this-repo* work is the retail
metric layer (deployed, per `HANDOFF.md`), and those commits were noted as **not yet pushed** to
`mackaysmarketing/mm-data-hub` at handoff time.

---

### The one-paragraph version

*The Data Hub already lands and reconciles five sources into a governed `raw→core→semantic` warehouse:
dispatch (22k loads / 205k pallets), grower settlement from two independent angles that agree to 0.6%
(NetSuite RCTIs $139.7M paid + FreshTrack GP $140.5M with load-grain lineage), the internal sell-side
order book (21k orders / 73k lines), and competitor retail shelf prices. It's served through a Cube
metric layer and an MCP for agents, with grower-level row security proven fail-closed throughout. The
biggest untapped value is joining the sell side to the settlement side to expose margin per grower/
product (the data is landed, the bridge isn't built), standing up the **accounts-receivable** side —
customer invoices plus automated remittance-advice reconciliation — to mirror the grower-payment
picture, and building out the **agentic access & intelligence layer**: a grower-facing MCP connector
(each grower's own AI agent, scoped to just their production + sales) and an ever-evolving **business
knowledge graph** so agents derive context from *who's asking* (Jon's "my growers" resolved from the
CRM) — all still enforced by fail-closed RLS. Then harvest/yield and retail-scan data to connect
field-to-shelf.*
