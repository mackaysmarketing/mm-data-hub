# Sprint: Insight layer — cross-domain marts + the business-language (NL) foundation
Date: 2026-07-12
Repo: mm-data-hub

## Part 1 — the schema-value review (the findings this sprint implements)
The hub now lands EIGHT domains that have never been JOINED analytically. Each domain is proven
internally; the untapped value is at the intersections. Review conclusions (verified feasible
against live data 2026-07-12):

**The insight gaps, ranked:**
1. **Demand vs supply (“our share of the till”)** — `fact_retail_scan` gives Coles’s TOTAL banana
   sell-through (kg/units/$ by week × state × segment); dispatch gives OUR shipments into Coles DCs.
   Nobody can currently answer “what share of what Coles sold did we supply, and are we over/under-
   shipping demand?” Feasible: consignee names map cleanly to retailer×state (Coles Melbourne → VIC…),
   products map to scan segments (variety/pack_type → REGULAR/PRE_PACK/LADY_FINGER/OTHER), kg from
   `dim_product.net_weight_value` × boxes.
2. **The price ladder (farm gate → wholesale → shelf → till)** — four price points exist in four
   domains and are never lined up: GP `price_invoiced_value`/kg (what the grower got), bridge/order
   sell $/kg (what we invoiced the retailer), `retail_prices` (shelf), scan `price_per_volume`
   (realised till $/kg). Price transmission + margin stack per week × segment: NOVEL, high value.
3. **Customer margin** — AR gives revenue per customer; the settlement bridge gives the grower cost
   of that fruit per consignee. Joined at customer × month = gross margin by customer (freight cost
   to layer in later when that domain lands).
4. **Grower scorecard** — per grower × month: volume, net return, price achieved vs pool average,
   bridge variance, payment lag. All landed; never assembled.
5. **Supplier share (competitive)** — the scan manufacturer-split already carries FRESHMAX,
   PERFECTION FRESH, ROCK RIDGE, PRIVATE LABEL… share within Coles by segment/week. Pure derivation.
6. *(Planned-data extensions, NOT this sprint: freight cost-to-serve joins #3 when landed; SOH ages
   against demand; harvest lineage extends the ladder to the block. Designed-for, not built.)*

**Alignment findings that shape the design:** scan weeks end TUESDAY (W/E 07-07-26); dispatch/GP
use dates → align by date-range membership into the scan week (week_ending−6 .. week_ending),
NEVER by ISO-week equality. Internal transfer + test consignees (MM Truganina, Truganina Test)
must be excluded from retail supply measures. Value-added (Processed Banana) is out of scan scope.

## Part 1 scope — build
1. **0045 crosswalks:** `core.crosswalk_customer_retail` (consignee → retailer_group + state_code,
   name-rule + DC-city lookup, method + unmapped surfaced) · `core.crosswalk_product_segment`
   (product → banana segment via variety/pack_type/organic rules; non-banana + value-added flagged
   out-of-scope). Both refresh-function built, both proven for coverage.
2. **0046 mart:** `core.fact_market_week` — grain week_ending (from scan) × retailer_group × state ×
   segment: scan demand (kg/units/$/till price/promo split) + our supply into that cell (boxes, kg,
   sell $ via bridge) + farm-gate $/kg (GP, pack_date-aligned) + our_share_kg. Refresh via the
   temp-table pattern.
3. **0047 semantic (all INTERNAL-ONLY):** `semantic.market_week` (+ ladder + share + transmission
   derivations, null-safe) · `semantic.customer_margin` (customer × month: AR revenue vs grower
   cost vs deductions retained) · `semantic.grower_scorecard` (grower × month, is_internal-gated —
   pool comparisons must not be computed over a grower’s own-rows-only view) ·
   `semantic.retail_supplier_share` (scan mfr split shares).
4. **Proofs `insight:reconcile`:** crosswalk coverage (≥95% of Coles/WOW/ALDI volume mapped;
   ≥95% banana pallets segment-mapped), mart parity BOTH sides derived in-run (scan side == fact_
   retail_scan; supply side == pallet sums in scope), share sanity (0 < our_share ≤ 1.05 on Coles
   cells), ladder ordering (farm ≤ wholesale ≤ till, informational), RLS behavioral. Posture
   registry additions; battery green.

## Part 2 — the natural-language (NL) foundation + engagement
Goal: agents and BI answering questions in MACKAYS language (“cavs to Coles Melbourne”, “week 31”,
“lady fingers”, “the majors”, “Jon’s growers”) — a translation layer from business vocabulary to
hub entities/metrics. This sprint builds the FOUNDATION + the engagement that harvests Tim’s
vocabulary; wiring into the MCP catalog follows once his input returns.
1. **0048 schema:** `core.business_term` (entity_type × entity_key × alias grain; canonical name,
   source [seed|tim|derived], notes) + `core.nl_phrase` (free-form phrase → meaning/mapping for
   metrics, time expressions, units, roles). Internal-only semantic view `semantic.business_glossary`.
   Seeded from the hub itself (canonical names + obvious derivations e.g. grower codes, segment
   names, geography codes) so the engine has a base layer even before Tim’s input.
2. **The engagement tool** (`nl:tool` → reports/nl_glossary_<date>.html, the revenue-marker UX):
   pre-populated with EVERY hub entity — products (with attributes), customers (with retailer/state),
   growers, sheds, segments, geographies, charge categories, metric definitions — each with alias +
   notes inputs; plus guided free-form sections (units of speech, time vocabulary, people/roles,
   “top questions you’d ask in plain English”). localStorage autosave; exports a JSON Tim sends back.
3. **`nl:load`** — lands the returned JSON into 0048 (idempotent, source='tim').

## Acceptance Criteria
- [ ] Crosswalk coverage pasted (retail volume ≥95% mapped; banana pallets ≥95% segment-mapped;
      unmapped listed, never dropped).
- [ ] fact_market_week built; parity pasted (scan side + supply side, both derived in-run);
      our_share sane on every Coles cell; ladder populated (farm/wholesale/till non-null on the
      majority of REGULAR × VIC/QLD cells).
- [ ] 4 semantic views live, internal-only proven behaviorally; posture registry green (expected 87).
- [ ] insight:reconcile green with pasted evidence; existing battery + tests + typecheck green.
- [ ] NL schema landed + seeded; the engagement HTML generated from live hub data, verified in a
      browser (chips/autosave/export), delivered to Tim with a clear ask.
- [ ] Docs (CLAUDE.md + HANDOFF) updated; committed.

## Deferred (with reason)
- MCP/Cube wiring of the marts + glossary — after Tim’s vocabulary returns and definitions settle.
- Freight/SOH/harvest joins into the mart — those domains aren’t landed yet (designed-for).
- Woolworths/ALDI scan + remittance parsers — awaiting samples.

## Goal Condition
/goal The insight layer + NL foundation is built per SPRINT.md 2026-07-12b: crosswalks proven at
≥95% coverage, fact_market_week + 4 internal-only semantic views live with insight:reconcile green
(both-sides-derived parity, share sanity, RLS behavioral), posture green, battery green, NL schema
(0048) seeded, and the pre-populated vocabulary engagement tool generated from live hub data,
browser-verified, and delivered to Tim. Docs updated, committed. Stop after 45 turns.
