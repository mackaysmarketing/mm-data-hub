-- 0031_core_settlement_bridge — the sell-side ↔ grower-settlement bridge (Sprint: Settlement Bridge).
--
-- Joins the order book (core.fact_order_item / core.dim_order — INTERNAL selling prices) to grower
-- settlement (raw.ft_gp_detail / core.fact_gp_settlement_load) at ft_gp_detail grain, settled loads
-- only. Headline measure: variance = sell_value − grower_gross, expected ≈ 0 under agency semantics.
--
-- THE JOIN (verified live 2026-07-09, SPRINT "ground truth"): fact_order_item.dispatch_load_id is
-- 99.3% null — NOT the bridge. The real path is raw.ft_dispatch_load.order_id (many loads → one
-- order). Product-grain match on (order_id, product_id) against the authoritative order lines.
--
-- MATCH TIERS (in order):
--   product_exact — an authoritative order line group exists on (load.order_id, detail.product_id).
--       sell_value = rate × detail box_quantity, where rate = Σ line derived_price_value ÷ Σ line
--       total_box_count over the group's PRICED lines only (18,742 of 35,572 lines carry no dollars;
--       unpriced lines must not deflate the rate). price_per is BOX on 35,556 of 35,572 lines; the
--       16 WEIGHT_UNIT lines flow through the same $-per-box rate (derived ÷ boxes), so per-kg
--       pricing needs no special case. derived_price_value mirrors src/lib/ft_order.derivedLineValue.
--       OVER-ALLOCATION CAP: when settled boxes exceed ordered boxes, rate × Σ settled boxes can
--       exceed the group's line dollars (13 orders, ~$40k raw). sell is scaled per (order, product)
--       group by cap_factor = line_dollars ÷ (rate × Σ settled boxes) when that ratio < 1 — so no
--       group, and therefore no order, allocates more than its order-book dollars (AC3 guard).
--       A matched group whose lines are ALL unpriced has no rate → sell_value NULL (surfaced, never 0).
--   box_allocated — load resolves to an order but no line matches the product. Pool = Σ derived
--       dollars of the order's UNMATCHED line groups (disjoint from tier-1 dollars — allocating the
--       whole order would double-count), allocated by box share among the order's tier-2 details.
--       No pool / no tier-2 boxes → sell_value NULL (nothing allocable; under-allocation is
--       surfaced by variance, never faked to 0).
--   unmatched — the load carries no order_id (255 details). Sell measures NULL, row kept + flagged.
--
-- SETTLEMENT ALLOCATION (the no-double-count guard, AC2): deductions/GST live at (schedule, load)
-- grain in fact_gp_settlement_load. Each measure is allocated across the group's detail rows by
-- |gross| share (equal split when the group's gross is all zero/null), rounded to 2dp with the
-- residual placed on the group's largest row — so every (schedule, load) group sums EXACTLY to
-- fact_gp_settlement_load, and per-load totals reconcile with 0 mismatches. The 37 charge-only
-- (schedule, load) groups (detail_line_count = 0; +$547.37 deductions, −$179.78 GST) have no detail
-- rows to carry them — excluded by grain, surfaced in the reconciliation proof.
--
-- REVENUE (checkpoint-gated): revenue_class lands on core.dim_gp_charge but is NOT populated here —
-- SPRINT chunk 1 forbids guessing; Tim marks the full charge list first. mackays_revenue is computed
-- FROM dim_gp_charge.revenue_class at refresh time, so it is NULL until the marking lands and the
-- refresh re-runs. core.fact_revenue_charge (charge-application grain, for semantic.mackays_revenue_fresh)
-- is likewise empty until then. The 4,968 settled charge rows with NO charge_id ($1.59M) cannot carry
-- a revenue_class (it lives on the charge dim) — surfaced at the checkpoint, not silently dropped.
--
-- PERFORMANCE: the refresh stages its working sets through TEMP TABLES with ANALYZE between steps.
-- CTEs carry no statistics — the planner estimated the 23,544-row detail set at 25 rows and chose
-- nested-loop joins with re-executed inner subplans, blowing a 9-minute statement timeout. With
-- analyzed temp tables the same build hash-joins in seconds.
--
-- INTERNAL-ONLY: sell_value/variance/mackays_revenue are Mackays selling-price data. RLS is
-- fail-closed to internal (is_internal_claim) + cube_readonly read-all — the exact 0024 pattern.
-- Names (grower, consignee) are DENORMALISED at refresh time because raw.ft_entity and
-- core.dim_gp_charge carry no authenticated grant — security_invoker views must not join them.

-- ── revenue_class on the charge dimension (additive; UNWIRED until Tim's checkpoint marking) ──
alter table core.dim_gp_charge add column if not exists revenue_class text;
comment on column core.dim_gp_charge.revenue_class is
  'Mackays revenue classification: commission / ripening / other_service / cost_recovery / pass_through / na. NULL = awaiting Tim''s checkpoint marking (SPRINT 2026-07-09 chunk 1 — never guessed). Text, never an enum.';

-- ── The bridge fact (grain = raw.ft_gp_detail row; settled loads only) ────────
create table if not exists core.fact_settlement_bridge (
  gp_detail_id         uuid primary key,
  schedule_id          uuid not null,
  dispatch_load_id     uuid not null,
  order_id             uuid,           -- raw.ft_dispatch_load.order_id; null = unmatched tier
  order_item_id        uuid,           -- set ONLY when exactly one authoritative line matches (order, product)
  product_id           uuid,
  consignor_id         uuid,           -- SCHEDULE consignor (settlement attribution anchor, as fact_gp_settlement_load)
  grower_code          text,
  grower_name          text,
  detail_consignor_id  uuid,           -- the line's own consignor (original grower on reconsignment)
  consignee_id         uuid,           -- buyer on the settlement detail
  consignee_name       text,           -- denormalised (raw.ft_entity has no authenticated grant)
  crop_id              uuid,           -- 0 populated in source today; carried for lineage
  pack_date            date,
  load_no              text,
  match_tier           text not null,  -- product_exact / box_allocated / unmatched (text, never enum)
  box_quantity         numeric,
  sell_rate            numeric,        -- tier-1 $-per-box rate (Σ priced line $ ÷ Σ priced line boxes)
  sell_cap_factor      numeric,        -- ≤ 1; group over-allocation cap (see header)
  sell_value           numeric,        -- allocated sell $; NULL = nothing allocable (never coalesced to 0)
  grower_gross         numeric,        -- box_quantity × price_invoiced_value (UNROUNDED; null when price null)
  variance             numeric,        -- sell_value − grower_gross; null unless both present
  deduction_freight    numeric,        -- allocated share of fact_gp_settlement_load (signed; group-exact)
  deduction_warehouse  numeric,
  deduction_market     numeric,
  deduction_larapinta  numeric,        -- LA = Load Adjustment (FreshTrack), not Larapinta
  deduction_misc       numeric,
  deduction_other      numeric,
  total_deductions     numeric,
  gst_total            numeric,
  grower_net           numeric,        -- coalesce(gross,0) + total_deductions + gst_total (per row)
  mackays_revenue      numeric,        -- allocated Σ revenue-classed charge $; NULL until checkpoint wiring
  _built_at            timestamptz not null default now()
);
create index if not exists ix_fact_settlement_bridge_load     on core.fact_settlement_bridge (dispatch_load_id);
create index if not exists ix_fact_settlement_bridge_schedule on core.fact_settlement_bridge (schedule_id);
create index if not exists ix_fact_settlement_bridge_order    on core.fact_settlement_bridge (order_id);
create index if not exists ix_fact_settlement_bridge_grower   on core.fact_settlement_bridge (consignor_id);
create index if not exists ix_fact_settlement_bridge_tier     on core.fact_settlement_bridge (match_tier);
comment on table core.fact_settlement_bridge is
  'Order book ↔ grower settlement bridge at raw.ft_gp_detail grain (settled loads only). variance = sell_value − grower_gross (agency ≈ 0). Settlement measures allocated group-exact from fact_gp_settlement_load. INTERNAL-ONLY (selling prices). mackays_revenue NULL until the revenue-class checkpoint.';

-- ── Revenue-charge fact (charge-application grain; feeds semantic.mackays_revenue_fresh) ──
-- EMPTY until dim_gp_charge.revenue_class is marked (checkpoint) — built from the marked dim, never
-- from a guess. Carries the charge name ("facility-ish") + grower + customer + month anchors.
create table if not exists core.fact_revenue_charge (
  charge_applied_id  uuid primary key,  -- raw.ft_charge_applied.id
  schedule_id        uuid not null,
  dispatch_load_id   uuid,              -- null = schedule-level charge with no load linkage (surfaced)
  consignor_id       uuid,              -- SCHEDULE consignor
  grower_code        text,
  grower_name        text,
  charge_id          uuid,
  charge_name        text,              -- dim_gp_charge.name (rate card)
  applied_label      text,              -- charge_applied.text_1 (human label on the applied row)
  revenue_class      text,              -- commission / ripening / other_service (from the marked dim)
  category           text,              -- FR/WH/MD/MI/LA/OTHER
  subcategory        text,
  account_code       text,
  order_id           uuid,              -- via the load; customer context
  consignee_id       uuid,              -- dim_order.consignee_id (the BUYER = customer)
  consignee_name     text,              -- denormalised
  load_no            text,
  payable_on         date,              -- settlement business date (month anchor)
  amount             numeric,           -- charge $ as applied (positive = revenue to Mackays)
  gst                numeric,           -- per vat_info (EX ×0.10 / INC ×1/11 / FREE 0)
  _built_at          timestamptz not null default now()
);
create index if not exists ix_fact_revenue_charge_class   on core.fact_revenue_charge (revenue_class);
create index if not exists ix_fact_revenue_charge_grower  on core.fact_revenue_charge (consignor_id);
create index if not exists ix_fact_revenue_charge_month   on core.fact_revenue_charge (payable_on);
comment on table core.fact_revenue_charge is
  'Mackays revenue at charge-application grain (settled + deductible + revenue-classed only). EMPTY until core.dim_gp_charge.revenue_class is marked at the checkpoint — never guessed. INTERNAL-ONLY.';

-- ── Rebuild the bridge fact. Idempotent. ─────────────────────────────────────
create or replace function core.refresh_fact_settlement_bridge() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  -- Working sets as ANALYZEd temp tables (CTEs carry no stats → catastrophic nested-loop plans).
  drop table if exists pg_temp._bridge_d0, pg_temp._bridge_rates, pg_temp._bridge_t1,
                       pg_temp._bridge_t2pool, pg_temp._bridge_t2box, pg_temp._bridge_rev;

  -- settled detail rows: the (schedule, load) pair must exist in fact_gp_settlement_load
  create temp table _bridge_d0 as
  select d.id as gp_detail_id, d.gp_schedule_id as schedule_id, d.dispatch_load_id,
         d.product_id, d.consignor_id as detail_consignor_id, d.consignee_id, d.crop_id,
         d.pack_date, d.box_quantity,
         d.box_quantity * d.price_invoiced_value as gross,   -- UNROUNDED; null when price null
         dl.order_id, dl.load_no,
         s.consignor_id, g.code as grower_code, g.org_name as grower_name,
         e.org_name as consignee_name
  from raw.ft_gp_detail d
  join raw.ft_gp_schedule s on s.id = d.gp_schedule_id
  left join core.dim_grower g on g.consignor_id = s.consignor_id
  left join raw.ft_dispatch_load dl on dl.id = d.dispatch_load_id
  left join raw.ft_entity e on e.id = d.consignee_id
  where exists (select 1 from core.fact_gp_settlement_load f
                where f.schedule_id = d.gp_schedule_id
                  and f.dispatch_load_id = d.dispatch_load_id);
  analyze pg_temp._bridge_d0;

  -- authoritative order lines rolled to (order, product): rate over PRICED lines only
  create temp table _bridge_rates as
  select order_id, product_id,
         sum(derived_price_value) as line_dollars,
         sum(total_box_count) filter (where derived_price_value is not null) as priced_boxes,
         count(*) as line_count,
         min(order_item_id::text)::uuid as sole_order_item_id  -- only meaningful when line_count = 1
  from core.fact_order_item
  group by order_id, product_id;
  analyze pg_temp._bridge_rates;

  -- tier-1 per-detail rate + the group over-allocation cap (no (order, product) group may exceed
  -- its line dollars)
  create temp table _bridge_t1 as
  with t1 as (
    select d0.gp_detail_id, r.line_dollars, r.line_count, r.sole_order_item_id,
           case when coalesce(r.priced_boxes, 0) > 0 then r.line_dollars / r.priced_boxes end as rate,
           sum(d0.box_quantity) over (partition by d0.order_id, d0.product_id) as grp_boxes
    from pg_temp._bridge_d0 d0
    join pg_temp._bridge_rates r on r.order_id = d0.order_id and r.product_id = d0.product_id
  )
  select gp_detail_id, rate, line_count, sole_order_item_id,
         case when rate is null then null
              when rate * grp_boxes > line_dollars and rate * grp_boxes > 0
                then line_dollars / (rate * grp_boxes)
              else 1 end as cap_factor
  from t1;
  analyze pg_temp._bridge_t1;

  -- per order: derived dollars of line groups NO settled detail matched (disjoint from tier-1).
  -- Plain-equality anti-join (hashable): settled product_ids are never null, so a null-product
  -- line correctly never matches → stays in the pool.
  create temp table _bridge_t2pool as
  with settled_groups as (
    select distinct order_id, product_id from pg_temp._bridge_d0 where order_id is not null
  )
  select oi.order_id, sum(oi.derived_price_value) as pool_dollars
  from core.fact_order_item oi
  join (select distinct order_id from settled_groups) so on so.order_id = oi.order_id
  left join settled_groups sg
    on sg.order_id = oi.order_id and sg.product_id = oi.product_id
  where sg.order_id is null
  group by oi.order_id;
  analyze pg_temp._bridge_t2pool;

  -- per order: total boxes across its tier-2 details (the box-share denominator)
  create temp table _bridge_t2box as
  select d0.order_id, sum(d0.box_quantity) as t2_boxes
  from pg_temp._bridge_d0 d0
  left join pg_temp._bridge_rates r on r.order_id = d0.order_id and r.product_id = d0.product_id
  where d0.order_id is not null and r.order_id is null
  group by d0.order_id;
  analyze pg_temp._bridge_t2box;

  -- Mackays revenue per (schedule, load) from the MARKED dim — empty until the checkpoint lands
  create temp table _bridge_rev as
  select ca.gp_schedule_id, ca.dispatch_load_id,
         sum(ca.total_amount_value) as revenue_amt
  from raw.ft_charge_applied ca
  join core.dim_gp_charge c on c.charge_id = ca.charge_id
  where ca.gp_schedule_id is not null and ca.dispatch_load_id is not null
    and ca.is_deductible
    and c.revenue_class in ('commission', 'ripening', 'other_service')
  group by 1, 2;
  analyze pg_temp._bridge_rev;

  delete from core.fact_settlement_bridge;
  insert into core.fact_settlement_bridge (
    gp_detail_id, schedule_id, dispatch_load_id, order_id, order_item_id, product_id,
    consignor_id, grower_code, grower_name, detail_consignor_id, consignee_id, consignee_name,
    crop_id, pack_date, load_no, match_tier, box_quantity, sell_rate, sell_cap_factor, sell_value,
    grower_gross, variance, deduction_freight, deduction_warehouse, deduction_market,
    deduction_larapinta, deduction_misc, deduction_other, total_deductions, gst_total,
    grower_net, mackays_revenue, _built_at
  )
  with base as (
    select d0.*,
           t1c.rate, t1c.cap_factor, t1c.line_count, t1c.sole_order_item_id,
           (t1c.gp_detail_id is not null) as is_t1,
           p.pool_dollars, tb.t2_boxes,
           f.deduction_freight as m_fr, f.deduction_warehouse as m_wh, f.deduction_market as m_md,
           f.deduction_larapinta as m_la, f.deduction_misc as m_mi, f.deduction_other as m_oth,
           f.total_deductions as m_ded, f.gst_total as m_gst,
           r.revenue_amt as m_rev
    from pg_temp._bridge_d0 d0
    left join pg_temp._bridge_t1 t1c on t1c.gp_detail_id = d0.gp_detail_id
    left join pg_temp._bridge_t2pool p on p.order_id = d0.order_id
    left join pg_temp._bridge_t2box tb on tb.order_id = d0.order_id
    join core.fact_gp_settlement_load f
      on f.schedule_id = d0.schedule_id and f.dispatch_load_id = d0.dispatch_load_id
    left join pg_temp._bridge_rev r
      on r.gp_schedule_id = d0.schedule_id and r.dispatch_load_id = d0.dispatch_load_id
  ),
  a1 as (
    select base.*,
           case when base.order_id is null then 'unmatched'
                when base.is_t1 then 'product_exact'
                else 'box_allocated' end as match_tier,
           case when base.is_t1
                  then round(base.rate * base.box_quantity * base.cap_factor, 2)  -- null if no rate
                when base.order_id is not null and base.pool_dollars is not null
                     and coalesce(base.t2_boxes, 0) > 0
                  then round(base.pool_dollars * base.box_quantity / base.t2_boxes, 2)
           end as sell_value,
           -- settlement allocation weight within the (schedule, load) group
           case when sum(abs(coalesce(base.gross, 0))) over w > 0
                then abs(coalesce(base.gross, 0)) / sum(abs(coalesce(base.gross, 0))) over w
                else 1.0 / count(*) over w end as frac,
           row_number() over (partition by base.schedule_id, base.dispatch_load_id
                              order by abs(coalesce(base.gross, 0)) desc, base.gp_detail_id) as rn
    from base
    window w as (partition by base.schedule_id, base.dispatch_load_id)
  ),
  a2 as (
    select a1.*,
           round(m_fr  * frac, 2) as afr,  round(m_wh  * frac, 2) as awh,
           round(m_md  * frac, 2) as amd,  round(m_la  * frac, 2) as ala,
           round(m_mi  * frac, 2) as ami,  round(m_oth * frac, 2) as aoth,
           round(m_ded * frac, 2) as aded, round(m_gst * frac, 2) as agst,
           round(m_rev * frac, 2) as arev
    from a1
  ),
  a3 as (
    -- residual on the group's largest row → every (schedule, load) sums EXACTLY to the load fact
    select a2.*,
           afr  + case when rn = 1 then m_fr  - sum(afr)  over w2 else 0 end as xfr,
           awh  + case when rn = 1 then m_wh  - sum(awh)  over w2 else 0 end as xwh,
           amd  + case when rn = 1 then m_md  - sum(amd)  over w2 else 0 end as xmd,
           ala  + case when rn = 1 then m_la  - sum(ala)  over w2 else 0 end as xla,
           ami  + case when rn = 1 then m_mi  - sum(ami)  over w2 else 0 end as xmi,
           aoth + case when rn = 1 then m_oth - sum(aoth) over w2 else 0 end as xoth,
           aded + case when rn = 1 then m_ded - sum(aded) over w2 else 0 end as xded,
           agst + case when rn = 1 then m_gst - sum(agst) over w2 else 0 end as xgst,
           arev + case when rn = 1 then m_rev - sum(arev) over w2 else 0 end as xrev
    from a2
    window w2 as (partition by schedule_id, dispatch_load_id)
  )
  select
    gp_detail_id, schedule_id, dispatch_load_id, order_id,
    case when is_t1 and line_count = 1 then sole_order_item_id end as order_item_id,
    product_id, consignor_id, grower_code, grower_name, detail_consignor_id,
    consignee_id, consignee_name, crop_id, pack_date, load_no,
    match_tier, box_quantity, rate, cap_factor, sell_value,
    gross as grower_gross,
    case when sell_value is not null and gross is not null
         then round(sell_value - gross, 2) end as variance,
    xfr, xwh, xmd, xla, xmi, xoth, xded, xgst,
    round(coalesce(gross, 0) + xded + xgst, 2) as grower_net,
    xrev as mackays_revenue,
    now()
  from a3;
  get diagnostics n = row_count;

  drop table if exists pg_temp._bridge_d0, pg_temp._bridge_rates, pg_temp._bridge_t1,
                       pg_temp._bridge_t2pool, pg_temp._bridge_t2box, pg_temp._bridge_rev;
  return n;
end $func$;
comment on function core.refresh_fact_settlement_bridge() is
  'Idempotent rebuild of core.fact_settlement_bridge. Tiered sell allocation (product_exact rate×boxes with group cap / box_allocated disjoint pool / unmatched NULL); settlement measures allocated group-exact from fact_gp_settlement_load. mackays_revenue from dim_gp_charge.revenue_class (NULL until checkpoint). Run AFTER refresh_fact_gp_settlement_load() and refresh_fact_order_item().';

-- ── Rebuild the revenue-charge fact. Idempotent. Empty until revenue_class marked. ──
create or replace function core.refresh_fact_revenue_charge() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_revenue_charge;
  insert into core.fact_revenue_charge (
    charge_applied_id, schedule_id, dispatch_load_id, consignor_id, grower_code, grower_name,
    charge_id, charge_name, applied_label, revenue_class, category, subcategory, account_code,
    order_id, consignee_id, consignee_name, load_no, payable_on, amount, gst, _built_at
  )
  select
    ca.id, ca.gp_schedule_id, ca.dispatch_load_id, s.consignor_id, g.code, g.org_name,
    ca.charge_id, c.name, ca.text_1, c.revenue_class, c.category, c.subcategory, ca.account_code,
    dl.order_id, o.consignee_id, e.org_name, dl.load_no, s.payable_on,
    ca.total_amount_value,
    case upper(btrim(ca.vat_info))
      when 'EX'  then round(ca.total_amount_value * 0.1, 2)
      when 'INC' then round(ca.total_amount_value / 11.0, 2)
      else 0 end as gst,
    now()
  from raw.ft_charge_applied ca
  join core.dim_gp_charge c
    on c.charge_id = ca.charge_id
   and c.revenue_class in ('commission', 'ripening', 'other_service')
  join raw.ft_gp_schedule s on s.id = ca.gp_schedule_id
  left join core.dim_grower g on g.consignor_id = s.consignor_id
  left join raw.ft_dispatch_load dl on dl.id = ca.dispatch_load_id
  left join core.dim_order o on o.order_id = dl.order_id
  left join raw.ft_entity e on e.id = o.consignee_id
  where ca.gp_schedule_id is not null and ca.is_deductible;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_revenue_charge() is
  'Idempotent rebuild of core.fact_revenue_charge (settled + deductible + revenue-classed charge applications). Returns 0 rows until core.dim_gp_charge.revenue_class is marked (checkpoint — never guessed).';

-- ── RLS: INTERNAL-ONLY (fail-closed) + cube read-all — the exact 0024 pattern ──
alter table core.fact_settlement_bridge enable row level security;
alter table core.fact_revenue_charge    enable row level security;
grant select on core.fact_settlement_bridge, core.fact_revenue_charge to authenticated;

drop policy if exists internal_only_fact_settlement_bridge on core.fact_settlement_bridge;
create policy internal_only_fact_settlement_bridge on core.fact_settlement_bridge
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_fact_revenue_charge on core.fact_revenue_charge;
create policy internal_only_fact_revenue_charge on core.fact_revenue_charge
  for select to authenticated using (semantic.is_internal_claim());

grant select on core.fact_settlement_bridge, core.fact_revenue_charge to cube_readonly;
drop policy if exists cube_readonly_read_all on core.fact_settlement_bridge;
create policy cube_readonly_read_all on core.fact_settlement_bridge for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on core.fact_revenue_charge;
create policy cube_readonly_read_all on core.fact_revenue_charge for select to cube_readonly using (true);
