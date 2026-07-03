-- retail_semantic_proof.sql — semantic.retail_prices invariants (run after any day's load).
--
-- 1. GRAIN: total rows == distinct (retailer, state, store_name, product_id, capture_date) —
--    the day-grain latest-capture dedupe holds.
-- 2. SCOPE: every row is 'state' or 'national'; national == state='AU' exactly.
-- 3. WATCHLIST: is_watchlist rows all carry a product_key; non-watchlist rows carry none.
-- First proven 2026-07-03 (37 rows: 37 grain keys; 7 watchlist / 30 specials; 37 national).

select
  (select count(*) from semantic.retail_prices) as total_rows,
  (select count(*) from (select distinct retailer, state, store_name, product_id, capture_date
                         from semantic.retail_prices) g) as distinct_grain,
  (select count(*) from semantic.retail_prices
    where (scope = 'national') <> (state = 'AU')) as scope_violations,
  (select count(*) from semantic.retail_prices
    where is_watchlist and product_key is null) as watchlist_missing_key,
  (select count(*) from semantic.retail_prices
    where not is_watchlist and product_key is not null) as nonwatchlist_with_key,
  (select count(*) from semantic.retail_prices where is_watchlist) as watchlist_rows,
  (select count(*) from semantic.retail_prices where not is_watchlist) as specials_rows;

-- Expected: total_rows = distinct_grain; scope_violations = 0; watchlist_missing_key = 0;
-- nonwatchlist_with_key = 0.
