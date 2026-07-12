-- 0047_semantic_insights — the four cross-domain insight surfaces (Sprint: Insight layer
-- 2026-07-12, Part 1 chunk 3). ALL INTERNAL-ONLY: market shares, customer margins, grower pool
-- comparisons and supplier competitive shares are Mackays-grade commercial data, never
-- grower-facing.
--
--   semantic.market_week          — the mart + null-safe share/ladder/transmission derivations.
--   semantic.customer_margin      — customer × month: AR revenue vs grower cost (pre-freight).
--   semantic.grower_scorecard     — grower × month vs the pool. EXPLICIT is_internal_claim() gate
--                                   (0035 rationale — see the view header).
--   semantic.retail_supplier_share— the Circana manufacturer split as shares of segment.
--
-- security_invoker on all four. Three of them are gated by their base tables' internal-only RLS
-- (fact_market_week / fact_customer_invoice + fact_settlement_bridge / fact_retail_scan → a grower
-- JWT sees ZERO rows). grower_scorecard additionally carries the explicit WHERE gate because one
-- of its bases (core.fact_gp_settlement) is GROWER-scoped — see its header.
-- House rules throughout: derivations null-safe, sums skip NULLs, nothing coalesced to 0.

-- ═══════════════════════════════════════════════════════════════════════════
-- semantic.market_week — demand vs supply vs farm gate, with the price ladder
-- ═══════════════════════════════════════════════════════════════════════════
-- The price ladder: farmgate_price_kg (what the grower got) → wholesale_price_kg (what we invoiced
-- the retailer) → scan_till_price_kg (what the shopper paid). NB under agency semantics the bridge
-- allocates sell ≈ grower gross (variance ≈ 0), so farm→wholesale spreads run near zero by
-- construction — Mackays' take lives in the deductions, not the price spread. Documented, not a bug.
create or replace view semantic.market_week
  with (security_invoker = true) as
select
  m.*,
  -- our share of the till (kg): shipments into the DC that week vs till sales that week.
  -- Weekly state-level values can breach 1.0 on stock timing (DC receipts precede till sales),
  -- and PRE_PACK pooled state shares run ~1.01–1.06 where Mackays is the sole supplier (carton kg
  -- vs Circana pack-kg wedge); insight:reconcile bounds national cells and pooled state groups
  -- hard and surfaces weekly outliers. Decision-grade share reads are the AU (national) cells.
  case when m.our_kg is not null and m.scan_volume_kg is not null and m.scan_volume_kg <> 0
       then round(m.our_kg / m.scan_volume_kg, 4) end                          as our_share_kg,
  l.farmgate_price_kg,
  l.wholesale_price_kg,
  -- transmission spreads (null when either rung is missing)
  case when l.wholesale_price_kg is not null and l.farmgate_price_kg is not null
       then round(l.wholesale_price_kg - l.farmgate_price_kg, 4) end           as spread_farm_to_wholesale,
  case when m.scan_till_price_kg is not null and l.wholesale_price_kg is not null
       then round(m.scan_till_price_kg - l.wholesale_price_kg, 4) end          as spread_wholesale_to_till,
  case when m.scan_till_price_kg is not null and l.farmgate_price_kg is not null
       then round(m.scan_till_price_kg - l.farmgate_price_kg, 4) end           as spread_farm_to_till,
  -- promo intensity: incremental share of scan dollars
  case when m.scan_dollars is not null and m.scan_dollars <> 0 and m.scan_incr_dollars is not null
       then round(m.scan_incr_dollars / m.scan_dollars, 4) end                 as promo_intensity,
  d.pack_week_code,
  d.iso_year,
  d.iso_week
from core.fact_market_week m
cross join lateral (
  select
    case when m.farmgate_dollars is not null and m.farmgate_kg is not null and m.farmgate_kg <> 0
         then round(m.farmgate_dollars / m.farmgate_kg, 4) end as farmgate_price_kg,
    case when m.our_sell_dollars is not null and m.our_kg is not null and m.our_kg <> 0
         then round(m.our_sell_dollars / m.our_kg, 4) end      as wholesale_price_kg
) l
left join core.dim_date d on d.date = m.week_ending;
grant select on semantic.market_week to authenticated, cube_readonly;
comment on view semantic.market_week is
  'core.fact_market_week + null-safe derivations: our_share_kg (our kg / scan kg), the price ladder (farmgate_price_kg → wholesale_price_kg → scan_till_price_kg), transmission spreads, promo_intensity, pack-week code. Farm→wholesale runs ≈0 by agency construction (bridge sell ≈ grower gross). INTERNAL-ONLY; security_invoker → grower JWT sees 0 rows.';

-- ═══════════════════════════════════════════════════════════════════════════
-- semantic.customer_margin — customer × month: AR revenue vs grower cost
-- ═══════════════════════════════════════════════════════════════════════════
-- Revenue: core.fact_customer_invoice by invoice_date month, SIGN-AWARE (verified live 2026-07-12:
-- every invoice_type stores amount_value POSITIVE): PI/SI = sales, DR = debit notes — additional
-- charges to sales customers (66 live rows, all tied to loads/orders on retail customers in the
-- cutover window) → revenue-positive; CN = credit notes → subtracted.
-- Cost: the settlement bridge's grower_gross by consignee × month of coalesce(pack_date, pickup
-- UTC date) (pack_date 98% null live — the 0046 anchor). deductions_retained = −Σ total_deductions
-- (what was withheld from the grower against that fruit, which offsets our cost).
-- gross_margin = ar_revenue − grower_gross_cost + deductions_retained — PRE-FREIGHT: our own
-- freight/cost-to-serve is not landed yet (SPRINT deferred), and part of deductions_retained
-- passes through to third parties. A directional margin, not a P&L.
-- Timing caveat: AR anchors on invoice month, cost on pack/pickup month — month-boundary weeks
-- can split a load's revenue and cost across adjacent months. FULL OUTER: one-sided rows surface.
create or replace view semantic.customer_margin
  with (security_invoker = true) as
with ar as (
  select
    consignee_id,
    max(consignee_name)                          as consignee_name,
    (date_trunc('month', invoice_date))::date    as month,   -- null invoice_date → null month (surfaced)
    count(*)                                     as invoice_count,
    round(sum(case when invoice_type in ('PI', 'SI', 'DR') then amount_value
                   when invoice_type = 'CN' then -amount_value end), 2) as ar_revenue
  from core.fact_customer_invoice
  group by consignee_id, (date_trunc('month', invoice_date))::date
),
cost as (
  select
    b.consignee_id,
    max(b.consignee_name)                        as consignee_name,
    (date_trunc('month', coalesce(b.pack_date, (dl.scheduled_pickup_on at time zone 'UTC')::date)))::date as month,
    sum(b.box_quantity)                          as settled_boxes,
    round(sum(b.grower_gross), 2)                as grower_gross_cost,
    round(-sum(b.total_deductions), 2)           as deductions_retained   -- bridge deductions are signed ≤0
  from core.fact_settlement_bridge b
  left join raw.ft_dispatch_load dl on dl.id = b.dispatch_load_id
  group by b.consignee_id,
           (date_trunc('month', coalesce(b.pack_date, (dl.scheduled_pickup_on at time zone 'UTC')::date)))::date
)
select
  coalesce(ar.consignee_id, cost.consignee_id)     as consignee_id,
  coalesce(ar.consignee_name, cost.consignee_name) as consignee_name,
  coalesce(ar.month, cost.month)                   as month,
  ar.invoice_count,
  ar.ar_revenue,
  cost.settled_boxes,
  cost.grower_gross_cost,
  cost.deductions_retained,
  case when ar.ar_revenue is not null and cost.grower_gross_cost is not null
       then round(ar.ar_revenue - cost.grower_gross_cost + coalesce(cost.deductions_retained, 0), 2)
  end                                              as gross_margin,       -- PRE-FREIGHT (see header)
  case when ar.ar_revenue is not null and ar.ar_revenue <> 0
        and cost.grower_gross_cost is not null
       then round((ar.ar_revenue - cost.grower_gross_cost + coalesce(cost.deductions_retained, 0))
                  / ar.ar_revenue, 4)
  end                                              as gross_margin_pct
from ar
full join cost
  on cost.consignee_id = ar.consignee_id and cost.month = ar.month;
grant select on semantic.customer_margin to authenticated, cube_readonly;
comment on view semantic.customer_margin is
  'Customer × month: AR revenue (fact_customer_invoice, sign-aware — PI/SI/DR positive, CN negative; amounts stored positive, verified live) vs grower cost (bridge grower_gross by pack/pickup month) + deductions retained. gross_margin is PRE-FREIGHT and directional (freight/cost-to-serve not landed; timing anchors differ by design). FULL OUTER — one-sided customer-months surface. INTERNAL-ONLY; security_invoker → grower sees 0.';

-- ═══════════════════════════════════════════════════════════════════════════
-- semantic.grower_scorecard — grower × month vs the pool
-- ═══════════════════════════════════════════════════════════════════════════
-- ── STRICT INTERNAL-ONLY (the explicit WHERE gate — 0035 rationale) ──────────
-- core.fact_gp_settlement is GROWER-scoped (0020): through a plain security_invoker view a grower
-- would see their own rows — and pool_avg_price_kg would then be computed over THEIR OWN rows only,
-- silently presenting their own price as "the pool". Pool comparisons must never be computed over
-- an own-rows-only view, so the whole query carries WHERE semantic.is_internal_claim(): internal →
-- all growers, true pool; grower / no claim / forged top-level claim → ZERO rows. The gate NARROWS
-- the underlying RLS, never widens it.
-- Month anchors: bridge side = pack/pickup month (dispatch reality); settlement side =
-- payable_on month (settlement business date, the 0035 anchor). FULL OUTER on grower × month.
-- achieved_price_kg pairs gross with kg over lines where BOTH exist (a true $/kg, house rule);
-- pool_avg_price_kg = the same ratio window-summed over ALL growers that month.
create or replace view semantic.grower_scorecard
  with (security_invoker = true) as
with b as (
  select
    b.consignor_id,
    max(b.grower_code) as grower_code,
    max(b.grower_name) as grower_name,
    (date_trunc('month', coalesce(b.pack_date, (dl.scheduled_pickup_on at time zone 'UTC')::date)))::date as month,
    sum(b.box_quantity) as dispatched_boxes,
    sum(b.box_quantity * ps.kg_per_box) as dispatched_kg,   -- null kg_per_box skipped, never coalesced
    round(sum(b.grower_gross), 2) as bridge_gross,
    -- $/kg pairing: only lines where BOTH gross and kg exist enter the rate
    sum(b.grower_gross)             filter (where b.grower_gross is not null and ps.kg_per_box is not null) as priced_gross,
    sum(b.box_quantity * ps.kg_per_box) filter (where b.grower_gross is not null and ps.kg_per_box is not null) as priced_kg,
    round(sum(b.variance), 2) as variance_total
  from core.fact_settlement_bridge b
  left join raw.ft_dispatch_load dl on dl.id = b.dispatch_load_id
  left join core.crosswalk_product_segment ps on ps.product_id = b.product_id
  group by b.consignor_id,
           (date_trunc('month', coalesce(b.pack_date, (dl.scheduled_pickup_on at time zone 'UTC')::date)))::date
),
s as (
  select
    consignor_id,
    max(grower_code) as grower_code,
    max(grower_name) as grower_name,
    (date_trunc('month', payable_on))::date as month,
    count(*) as schedule_count,
    round(sum(gross_sales), 2)    as gp_gross,
    round(sum(net_settlement), 2) as gp_net,
    round(avg(paid_date - payable_on), 1) as paid_lag_days   -- unpaid rows (null paid_date) skipped
  from core.fact_gp_settlement
  group by consignor_id, (date_trunc('month', payable_on))::date
)
select
  coalesce(b.consignor_id, s.consignor_id) as consignor_id,
  coalesce(b.grower_code, s.grower_code)   as grower_code,
  coalesce(b.grower_name, s.grower_name)   as grower_name,
  coalesce(b.month, s.month)               as month,
  b.dispatched_boxes,
  b.dispatched_kg,
  b.bridge_gross,
  case when b.priced_kg is not null and b.priced_kg <> 0
       then round(b.priced_gross / b.priced_kg, 4) end as achieved_price_kg,
  -- the pool that month: all growers' priced gross / priced kg (window over the gated set = ALL
  -- rows for internal — the gate guarantees this is never an own-rows pool)
  case when sum(b.priced_kg) over w is not null and sum(b.priced_kg) over w <> 0
       then round(sum(b.priced_gross) over w / sum(b.priced_kg) over w, 4) end as pool_avg_price_kg,
  b.variance_total,
  s.schedule_count,
  s.gp_gross,
  s.gp_net,
  s.paid_lag_days
from b
full join s on s.consignor_id = b.consignor_id and s.month = b.month
where semantic.is_internal_claim()
window w as (partition by coalesce(b.month, s.month));
grant select on semantic.grower_scorecard to authenticated, cube_readonly;
comment on view semantic.grower_scorecard is
  'Grower × month scorecard: dispatched boxes/kg + achieved $/kg vs the POOL average that month (bridge, pack/pickup month) beside GP gross/net + payment lag (fact_gp_settlement, payable month). STRICT INTERNAL-ONLY via explicit WHERE semantic.is_internal_claim() — fact_gp_settlement is grower-scoped and a pool comparison must never be computed over a grower''s own-rows-only view (0035 rationale).';

-- ═══════════════════════════════════════════════════════════════════════════
-- semantic.retail_supplier_share — the Circana manufacturer split as shares
-- ═══════════════════════════════════════════════════════════════════════════
-- Supplier rows (fact_retail_scan.supplier NOT NULL — the mfr-split export) against the matching
-- own-brand segment row (supplier IS NULL, same retailer × week × geography × segment × causal;
-- the 0043 unique grain guarantees at most one). Shares null-safe; a supplier row with no segment
-- total surfaces with null shares, never dropped.
create or replace view semantic.retail_supplier_share
  with (security_invoker = true) as
select
  s.retailer,
  s.week_ending,
  d.pack_week_code,
  s.geography_code,
  s.segment,
  s.causal,
  s.supplier,
  s.units,
  s.dollars,
  s.volume_kg,
  t.units     as segment_units,
  t.dollars   as segment_dollars,
  t.volume_kg as segment_volume_kg,
  case when s.volume_kg is not null and t.volume_kg is not null and t.volume_kg <> 0
       then round(s.volume_kg / t.volume_kg, 4) end as share_volume_kg,
  case when s.dollars is not null and t.dollars is not null and t.dollars <> 0
       then round(s.dollars / t.dollars, 4) end     as share_dollars,
  case when s.units is not null and t.units is not null and t.units <> 0
       then round(s.units / t.units, 4) end         as share_units
from core.fact_retail_scan s
left join core.fact_retail_scan t
  on t.retailer = s.retailer
 and t.week_ending = s.week_ending
 and t.geography_code = s.geography_code
 and t.segment = s.segment
 and t.causal = s.causal
 and t.supplier is null
left join core.dim_date d on d.date = s.week_ending
where s.supplier is not null;
grant select on semantic.retail_supplier_share to authenticated, cube_readonly;
comment on view semantic.retail_supplier_share is
  'Coles manufacturer split as market shares: supplier × segment × week × geography × channel kg/$/unit shares vs the own-brand segment total row (FRESHMAX, PERFECTION FRESH, ROCK RIDGE, PRIVATE LABEL, OTHER MFRS…). Null-safe; suppliers without a segment total surface with null shares. INTERNAL-ONLY; security_invoker → grower sees 0.';
