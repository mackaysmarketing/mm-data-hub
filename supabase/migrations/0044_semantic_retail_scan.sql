-- 0044_semantic_retail_scan — the internal weekly sell-through surface.
--
-- INTERNAL-ONLY (retailer sell-through; never grower-facing): security_invoker over
-- core.fact_retail_scan whose RLS is fail-closed to internal (0043) — internal sees all, a grower
-- JWT sees ZERO. Joins core.dim_date (SHARED REFERENCE, authenticated-readable — 0034) so every
-- scan week carries the hub pack-week code: scan sell-through lines up against dispatch/pack weeks
-- without string surgery. Derived convenience measures (promo share, YoY growth) are computed here,
-- null-safe, never coalesced.

drop view if exists semantic.retail_scan;  -- column set changed (supplier inserted mid-view); no dependents
create view semantic.retail_scan
  with (security_invoker = true) as
select
  f.retailer,
  f.week_ending,
  d.pack_week_code,
  d.iso_year,
  d.iso_week,
  f.geography_code,
  f.category,
  f.segment,
  f.supplier,          -- manufacturer on the mfr-split export (market share); NULL = no split
  f.is_category_total,
  f.causal,
  f.units, f.units_ya,
  f.dollars, f.dollars_ya,
  f.volume_kg, f.volume_kg_ya,
  f.price_per_unit,
  f.price_per_volume,
  f.acv_distribution,
  f.pct_stores,
  f.base_dollars, f.incr_dollars,
  f.base_units,   f.incr_units,
  f.base_volume_kg, f.incr_volume_kg,
  -- derived, null-safe (never coalesced): promo intensity + YoY growth
  case when f.dollars is not null and f.dollars <> 0
       then round(f.incr_dollars / f.dollars, 4) end as promo_dollar_share,
  case when f.units_ya is not null and f.units_ya <> 0 and f.units is not null
       then round((f.units - f.units_ya) / f.units_ya, 4) end as units_yoy_pct,
  case when f.dollars_ya is not null and f.dollars_ya <> 0 and f.dollars is not null
       then round((f.dollars - f.dollars_ya) / f.dollars_ya, 4) end as dollars_yoy_pct
from core.fact_retail_scan f
left join core.dim_date d on d.date = f.week_ending;
grant select on semantic.retail_scan to authenticated, cube_readonly;
comment on view semantic.retail_scan is
  'Weekly Coles sell-through (units/dollars/kg + YA, price, distribution, base/incremental promo split, promo share, YoY) by week × geography × banana segment × channel, with the hub pack-week code. INTERNAL-ONLY; security_invoker → grower JWT sees 0 rows.';
