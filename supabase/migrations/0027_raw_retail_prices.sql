-- 0027_raw_retail_prices — retail shelf-price & specials landing (price-reporter).
--
-- Fourth source: the price-reporter scraper (repo `price-reporter`), capturing daily shelf
-- prices + specials for Mackays' retail lines: Woolworths (5 products × 8 per-state pickup
-- stores), Coles (national online baseline as state 'AU', plus per-store rows whenever the
-- store-context browser leg passes Imperva), and ALDI (national 'AU', watched products plus
-- Super Savers catalogue promos). Landed from the day's unified output file — Option A
-- two-stage: output/prices-YYYY-MM-DD.json → this table, loaded by
-- price-reporter/scripts/load-to-warehouse.ts (pg over the session pooler, never PostgREST).
--
-- Source-faithful: prices land as captured (bare numeric; unit_price is the DISPLAY string).
-- retailer/state are text, no enums (SPEC §2). Rows are immutable observations — re-loading
-- the same file must add nothing: natural key (run_id, retailer, state, product_id). NB the
-- key collapses duplicate observations of the same product within one run (e.g. an ALDI
-- watchlist product that also appears in the Super Savers listing) — first write wins.
--
-- INTERNAL-ONLY: competitor pricing is never grower-visible. RLS is ON with a read policy
-- for cube_readonly only (0012 pattern); no authenticated policy = growers fail closed.
-- The loader writes as the postgres owner, to which RLS does not bind.

create table if not exists raw.retail_prices (
  id            bigint generated always as identity primary key,
  retailer      text not null,             -- 'woolworths' | 'coles' | 'aldi' (text, no enum)
  state         text not null,             -- 'QLD'..'ACT', or 'AU' for national rows
  store_name    text not null default '',  -- '' where the leg has no store concept
  product_label text not null,             -- watchlist label, or specials item name (ALDI Super Savers)
  product_id    text not null,             -- retailer's id (WW stockcode / Coles id / ALDI code)
  price         numeric,                   -- dollars as captured; null = listed but unpriced
  unit_price    text,                      -- as displayed (e.g. '$4.90 / 1KG') — source-faithful
  was_price     numeric,                   -- dollars, when a was/strike price was shown
  promo_flag    boolean not null default false,
  promo_label   text,                      -- badge text ('Special', 'Super Savers', 'Add 2 | $4', 'was $x')
  source_url    text not null,
  captured_at   timestamptz not null,      -- capture moment (UTC)
  run_id        text not null,             -- scraper run id: YYYY-MM-DD-xxxxxx (local capture date)
  ingested_at   timestamptz not null default now(),
  source_file   text not null,             -- basename of the loaded output file
  constraint retail_prices_natural_key unique (run_id, retailer, state, product_id)
);
comment on table raw.retail_prices is 'Daily retail shelf prices & specials for Mackays lines (price-reporter: Woolworths per-state stores, Coles AU baseline + store rows, ALDI national + Super Savers). Natural key run_id+retailer+state+product_id — re-loading a day''s file adds nothing. INTERNAL-ONLY (no grower access).';

create index if not exists retail_prices_captured_at_idx
  on raw.retail_prices (captured_at);
create index if not exists retail_prices_product_idx
  on raw.retail_prices (retailer, product_id, captured_at);

alter table raw.retail_prices enable row level security;

-- Cube reads all rows (0012 pattern); everyone else fails closed — this table is
-- internal competitive data with no grower dimension at all.
drop policy if exists cube_readonly_read_all on raw.retail_prices;
create policy cube_readonly_read_all on raw.retail_prices
  for select to cube_readonly using (true);
