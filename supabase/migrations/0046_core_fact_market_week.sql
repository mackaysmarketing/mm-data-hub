-- 0046_core_fact_market_week — the demand-vs-supply market mart (Sprint: Insight layer 2026-07-12,
-- Part 1 chunk 2). The first table in the hub where all three money layers of the banana trade sit
-- in ONE row: Coles till demand (Circana scan) · our shipments into that retailer's DCs (dispatch/
-- bridge) · what the grower was paid for that fruit (GP farm gate).
--
-- GRAIN: week_ending × retailer_group × state_code × segment (composite PK, all NOT NULL).
--   week_ending    = the Circana scan week end — a TUESDAY. Supply/farm-gate dates are aligned by
--                    DATE-RANGE MEMBERSHIP into [week_ending−6 .. week_ending] — NEVER by ISO-week
--                    equality (the sprint's alignment finding; ISO weeks end Sunday).
--                    Week universe = the scan calendar (distinct fact_retail_scan weeks): supply
--                    outside the scan span is out of the mart by design.
--   retailer_group = coles / woolworths / aldi. Scan exists only for coles today; woolworths/aldi
--                    rows land SUPPLY-ONLY (scan columns null) so the mart is ready the day their
--                    scan arrives. internal/other consignees are EXCLUDED from supply (transfers,
--                    test consignees, non-retail customers — the sprint exclusion).
--   state_code     = the SCAN geography: VIC/QLD/NSW+ACT/SA+NT/WA/TAS state rows AND an 'AU'
--                    national row (never a NULL state). Supply states map crosswalk → scan geo:
--                    NSW→NSW+ACT, SA→SA+NT, NT→SA+NT, VIC/QLD/WA/TAS verbatim. The AU row is the
--                    sum of EVERYTHING for that retailer incl. supply whose consignee has no state
--                    (head offices) — so national supply never undercounts.
--   segment        = REGULAR / PRE_PACK / LADY_FINGER / OTHER state of the 0043 conformance, plus
--                    an 'ALL' rollup row. Scan carries ALL natively (the BANANAS category root);
--                    supply/farm-gate ALL rows are summed across the four in-scope segments.
--                    OUT_OF_SCOPE products (bins/value-added/non-banana) never enter.
--
-- SCAN SIDE (from core.fact_retail_scan): causal='total', supplier IS NULL rows only (the own-brand
-- weekly cells — channel splits and the manufacturer share belong to their own surfaces). 1:1
-- projection — scan grain == mart grain, so parity is exact (proof: npm run insight:reconcile).
--
-- SUPPLY SIDE (core.fact_settlement_bridge × the 0045 crosswalks): our shipments into that
-- retailer's DCs. Date anchor = raw.ft_dispatch_load.scheduled_pickup_on (UTC date — the hub's
-- verified week anchor, 0034 pack-week lore). our_kg = box_quantity × kg_per_box (kg_per_box
-- nullable → those boxes contribute NULL kg, never coalesced; all in-scope banana cartons carry
-- weights live). our_sell_dollars = Σ sell_value (the bridge's order-book allocation; NULL rows
-- skipped by SUM, never faked to 0).
--
-- FARM-GATE SIDE (raw.ft_gp_detail × the crosswalks): what growers were paid for fruit that went
-- to that retailer cell. PRICED LINES ONLY (price_invoiced_value IS NOT NULL — 6,378/25,119 lines
-- are unpriced live and carry no farm-gate price signal; volume lives in our_kg, so farm-gate kg
-- deliberately covers exactly the dollars' denominator and farmgate_dollars/farmgate_kg is a true
-- $/kg). Date anchor = coalesce(pack_date, scheduled_pickup_on UTC date): the sprint designed for
-- pack_date, but pack_date is NULL on 24,595/25,119 live gp_detail rows (verified 2026-07-12) —
-- the pickup fallback is the same anchor FreshTrack itself stamps pack-week codes from (0034,
-- 98.91%). pack_date wins where present.
--
-- Refresh = the 0031 TEMP TABLE + ANALYZE pattern (CTEs carry no stats). INTERNAL-ONLY (0040
-- posture): scan sell-through + selling prices + grower prices are all internal-grade.

create table if not exists core.fact_market_week (
  week_ending        date not null,      -- scan week end (Tuesday)
  retailer_group     text not null,      -- coles / woolworths / aldi
  state_code         text not null,      -- AU / VIC / QLD / NSW+ACT / SA+NT / WA / TAS (scan geography)
  segment            text not null,      -- ALL / REGULAR / PRE_PACK / LADY_FINGER / OTHER
  -- scan demand (coles only today; null on supply-only rows)
  scan_units         numeric,
  scan_dollars       numeric,
  scan_volume_kg     numeric,
  scan_till_price_kg numeric,            -- price_per_volume ($/kg realised at the till)
  scan_base_dollars  numeric,            -- promo split
  scan_incr_dollars  numeric,
  scan_volume_kg_ya  numeric,            -- year-ago counterparts
  scan_dollars_ya    numeric,
  -- our supply into the cell (bridge × crosswalks, pickup-week aligned)
  our_boxes          numeric,
  our_kg             numeric,
  our_sell_dollars   numeric,
  -- farm gate (GP priced lines × crosswalks, pack/pickup-week aligned)
  farmgate_dollars   numeric,
  farmgate_kg        numeric,
  _built_at          timestamptz not null default now(),
  primary key (week_ending, retailer_group, state_code, segment)
);
create index if not exists ix_fact_market_week_cell on core.fact_market_week (retailer_group, state_code, segment);
comment on table core.fact_market_week is
  'Demand vs supply vs farm gate at scan-week × retailer_group × scan-geography × banana segment. Scan side = Coles/Circana weekly cells (causal total, own-brand); supply = settlement-bridge boxes/kg/sell$ into that retailer''s DCs (pickup-date range-aligned into the Tuesday-ending scan week); farm gate = GP priced lines $ and kg (pack_date, pickup fallback — pack_date 98% null live). AU national + ALL segment rollup rows included. INTERNAL-ONLY.';
comment on column core.fact_market_week.farmgate_kg is
  'Kg of the PRICED GP lines only — the exact denominator of farmgate_dollars, so dollars/kg is a true farm-gate $/kg. Volume analysis belongs to our_kg.';

create or replace function core.refresh_fact_market_week() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  -- Working sets as ANALYZEd temp tables (0031 pattern — CTEs carry no stats).
  drop table if exists pg_temp._mw_weeks, pg_temp._mw_scan, pg_temp._mw_supply_base,
                       pg_temp._mw_supply, pg_temp._mw_farm_base, pg_temp._mw_farm, pg_temp._mw_keys;

  -- the scan-week calendar (Tuesday endings) — the mart's week universe
  create temp table _mw_weeks as
  select distinct week_ending from core.fact_retail_scan;
  analyze pg_temp._mw_weeks;

  -- scan side: causal total, own-brand (supplier null) — grain == mart grain, 1:1
  create temp table _mw_scan as
  select f.week_ending, f.retailer as retailer_group, f.geography_code as state_code, f.segment,
         f.units, f.dollars, f.volume_kg, f.price_per_volume,
         f.base_dollars, f.incr_dollars, f.volume_kg_ya, f.dollars_ya
  from core.fact_retail_scan f
  where f.causal = 'total' and f.supplier is null;
  analyze pg_temp._mw_scan;

  -- supply detail: bridge rows into retail consignees, in-scope segments, pickup-week aligned
  create temp table _mw_supply_base as
  select w.week_ending, cw.retailer_group,
         case cw.state_code
           when 'NSW' then 'NSW+ACT'
           when 'SA'  then 'SA+NT'
           when 'NT'  then 'SA+NT'
           else cw.state_code               -- VIC/QLD/WA/TAS verbatim; null stays null (AU row only)
         end as state_code,
         ps.segment,
         b.box_quantity                as boxes,
         b.box_quantity * ps.kg_per_box as kg,   -- null kg_per_box → null kg (never coalesced)
         b.sell_value                  as sell
  from core.fact_settlement_bridge b
  join raw.ft_dispatch_load dl on dl.id = b.dispatch_load_id
  join core.crosswalk_customer_retail cw
    on cw.consignee_id = b.consignee_id
   and cw.retailer_group in ('coles', 'woolworths', 'aldi')   -- internal/other EXCLUDED from retail supply
  join core.crosswalk_product_segment ps
    on ps.product_id = b.product_id
   and ps.segment in ('REGULAR', 'PRE_PACK', 'LADY_FINGER', 'OTHER')
  join pg_temp._mw_weeks w
    on (dl.scheduled_pickup_on at time zone 'UTC')::date between w.week_ending - 6 and w.week_ending;
  analyze pg_temp._mw_supply_base;

  -- supply rollups: state × segment · state × ALL · AU × segment · AU × ALL
  -- (the AU rows aggregate EVERYTHING incl. null-state supply, so national never undercounts)
  create temp table _mw_supply as
  select week_ending, retailer_group, state_code, segment,
         sum(boxes) as our_boxes, sum(kg) as our_kg, sum(sell) as our_sell_dollars
  from pg_temp._mw_supply_base where state_code is not null group by 1, 2, 3, 4
  union all
  select week_ending, retailer_group, state_code, 'ALL', sum(boxes), sum(kg), sum(sell)
  from pg_temp._mw_supply_base where state_code is not null group by 1, 2, 3
  union all
  select week_ending, retailer_group, 'AU', segment, sum(boxes), sum(kg), sum(sell)
  from pg_temp._mw_supply_base group by 1, 2, 4
  union all
  select week_ending, retailer_group, 'AU', 'ALL', sum(boxes), sum(kg), sum(sell)
  from pg_temp._mw_supply_base group by 1, 2;
  analyze pg_temp._mw_supply;

  -- farm-gate detail: GP PRICED lines into retail consignees, pack/pickup-week aligned.
  -- LEFT join the load: a priced line with pack_date still lands if its load link dangles
  -- (24 dangling loads live); no date at all → no week bucket (excluded by the join, surfaced
  -- in insight:reconcile).
  create temp table _mw_farm_base as
  select w.week_ending, cw.retailer_group,
         case cw.state_code
           when 'NSW' then 'NSW+ACT'
           when 'SA'  then 'SA+NT'
           when 'NT'  then 'SA+NT'
           else cw.state_code
         end as state_code,
         ps.segment,
         d.box_quantity * d.price_invoiced_value as fg_dollars,
         d.box_quantity * ps.kg_per_box          as fg_kg
  from raw.ft_gp_detail d
  left join raw.ft_dispatch_load dl on dl.id = d.dispatch_load_id
  join core.crosswalk_customer_retail cw
    on cw.consignee_id = d.consignee_id
   and cw.retailer_group in ('coles', 'woolworths', 'aldi')
  join core.crosswalk_product_segment ps
    on ps.product_id = d.product_id
   and ps.segment in ('REGULAR', 'PRE_PACK', 'LADY_FINGER', 'OTHER')
  join pg_temp._mw_weeks w
    on coalesce(d.pack_date, (dl.scheduled_pickup_on at time zone 'UTC')::date)
       between w.week_ending - 6 and w.week_ending
  where d.price_invoiced_value is not null;      -- priced lines only (see header)
  analyze pg_temp._mw_farm_base;

  create temp table _mw_farm as
  select week_ending, retailer_group, state_code, segment,
         sum(fg_dollars) as farmgate_dollars, sum(fg_kg) as farmgate_kg
  from pg_temp._mw_farm_base where state_code is not null group by 1, 2, 3, 4
  union all
  select week_ending, retailer_group, state_code, 'ALL', sum(fg_dollars), sum(fg_kg)
  from pg_temp._mw_farm_base where state_code is not null group by 1, 2, 3
  union all
  select week_ending, retailer_group, 'AU', segment, sum(fg_dollars), sum(fg_kg)
  from pg_temp._mw_farm_base group by 1, 2, 4
  union all
  select week_ending, retailer_group, 'AU', 'ALL', sum(fg_dollars), sum(fg_kg)
  from pg_temp._mw_farm_base group by 1, 2;
  analyze pg_temp._mw_farm;

  -- the cell universe = union of the three sides' keys (scan-only, supply-only and
  -- farm-gate-only cells all land; missing sides stay NULL, never 0)
  create temp table _mw_keys as
  select week_ending, retailer_group, state_code, segment from pg_temp._mw_scan
  union
  select week_ending, retailer_group, state_code, segment from pg_temp._mw_supply
  union
  select week_ending, retailer_group, state_code, segment from pg_temp._mw_farm;
  analyze pg_temp._mw_keys;

  delete from core.fact_market_week;
  insert into core.fact_market_week (
    week_ending, retailer_group, state_code, segment,
    scan_units, scan_dollars, scan_volume_kg, scan_till_price_kg,
    scan_base_dollars, scan_incr_dollars, scan_volume_kg_ya, scan_dollars_ya,
    our_boxes, our_kg, our_sell_dollars, farmgate_dollars, farmgate_kg, _built_at
  )
  select
    k.week_ending, k.retailer_group, k.state_code, k.segment,
    sc.units, sc.dollars, sc.volume_kg, sc.price_per_volume,
    sc.base_dollars, sc.incr_dollars, sc.volume_kg_ya, sc.dollars_ya,
    su.our_boxes, su.our_kg, su.our_sell_dollars,
    fa.farmgate_dollars, fa.farmgate_kg,
    now()
  from pg_temp._mw_keys k
  left join pg_temp._mw_scan sc
    on sc.week_ending = k.week_ending and sc.retailer_group = k.retailer_group
   and sc.state_code = k.state_code and sc.segment = k.segment
  left join pg_temp._mw_supply su
    on su.week_ending = k.week_ending and su.retailer_group = k.retailer_group
   and su.state_code = k.state_code and su.segment = k.segment
  left join pg_temp._mw_farm fa
    on fa.week_ending = k.week_ending and fa.retailer_group = k.retailer_group
   and fa.state_code = k.state_code and fa.segment = k.segment;
  get diagnostics n = row_count;

  drop table if exists pg_temp._mw_weeks, pg_temp._mw_scan, pg_temp._mw_supply_base,
                       pg_temp._mw_supply, pg_temp._mw_farm_base, pg_temp._mw_farm, pg_temp._mw_keys;
  return n;
end $func$;
comment on function core.refresh_fact_market_week() is
  'Idempotent rebuild of core.fact_market_week (temp-table + ANALYZE pattern). Scan side 1:1 from fact_retail_scan (causal total, own-brand); supply from fact_settlement_bridge × the 0045 crosswalks, pickup-date range-aligned into Tuesday-ending scan weeks; farm gate from priced ft_gp_detail lines (pack_date, pickup fallback). Run AFTER refresh_crosswalk_customer_retail(), refresh_crosswalk_product_segment(), refresh_fact_retail_scan() and refresh_fact_settlement_bridge() — npm run insight:core does this in order.';

-- ── RLS: INTERNAL-ONLY (fail-closed) + cube read-all — the exact 0040 pattern ──
alter table core.fact_market_week enable row level security;
grant select on core.fact_market_week to authenticated;
drop policy if exists internal_only_fact_market_week on core.fact_market_week;
create policy internal_only_fact_market_week on core.fact_market_week
  for select to authenticated using (semantic.is_internal_claim());
grant select on core.fact_market_week to cube_readonly;
drop policy if exists cube_readonly_read_all on core.fact_market_week;
create policy cube_readonly_read_all on core.fact_market_week for select to cube_readonly using (true);
