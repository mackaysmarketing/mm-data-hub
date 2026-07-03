-- 0029_semantic_retail_prices — the retail-price day-grain semantic surface.
--
-- One row per (retailer, state, store_name, product_id) per LOCAL capture date
-- (Australia/Brisbane — the scraper's "day"); when a day has multiple runs, the LATEST
-- capture wins. This is the layer Cube (and any internal SQL) reads — never raw directly.
--
-- scope: 'national' for state='AU' rows (Coles baseline, ALDI), 'state' for per-state rows
-- (Woolworths; Coles store rows when the store leg is unblocked). AU must never be charted
-- as a ninth state — consumers filter or facet by scope before cross-state comparisons.
--
-- is_watchlist: true when the row's product_id matches core.dim_retail_product for its
-- retailer — separates the 5 Mackays lines from ALDI Super Savers catalogue noise.
--
-- price/was_price pass through untouched and may be NULL — never coalesced (house invariant).
--
-- INTERNAL-ONLY: security_invoker + NO grant to authenticated (a grower/staff JWT gets
-- permission denied — fail closed); cube_readonly reads via 0011's default privileges +
-- the 0027/0028 policies. The Cube door adds its own internal-only queryRewrite gate.

create or replace view semantic.retail_prices
with (security_invoker = true) as
with day_rows as (
  select
    r.*,
    (r.captured_at at time zone 'Australia/Brisbane')::date as capture_date,
    row_number() over (
      partition by
        r.retailer, r.state, r.store_name, r.product_id,
        (r.captured_at at time zone 'Australia/Brisbane')::date
      order by r.captured_at desc
    ) as rn
  from raw.retail_prices r
)
select
  d.retailer,
  d.state,
  case when d.state = 'AU' then 'national' else 'state' end as scope,
  d.store_name,
  d.product_label,
  d.product_id,
  (p.product_key is not null) as is_watchlist,
  p.product_key,
  d.price,
  d.unit_price,
  d.was_price,
  d.promo_flag,
  d.promo_label,
  d.capture_date,
  d.captured_at,
  d.run_id,
  d.source_url
from day_rows d
left join core.dim_retail_product p
  on (d.retailer = 'woolworths' and d.product_id = p.ww_product_id)
  or (d.retailer = 'coles'      and d.product_id = p.coles_product_id)
  or (d.retailer = 'aldi'       and d.product_id = p.aldi_product_id)
where d.rn = 1;

comment on view semantic.retail_prices is 'Retail shelf prices, day grain (latest capture per retailer/state/store/product per Australia/Brisbane date). scope separates national (AU) from state rows; is_watchlist separates Mackays lines from catalogue specials. INTERNAL-ONLY: no authenticated grant; consume via Cube.';
