-- 0028_core_dim_retail_product — the Mackays retail watchlist, conformed across retailers.
--
-- The price-reporter scraper (raw.retail_prices, 0027) records each retailer's own product id
-- (Woolworths stockcode / Coles id / ALDI code). This dim is the cross-retailer join key that
-- turns "banana price gap, Coles vs Woolworths vs ALDI" into a join instead of string-matching
-- in every query. label = the conformed key (identical to the scraper's product_label).
--
-- Seeded in-migration from the confirmed watchlist (price-reporter scripts/config.ts, matches
-- confirmed by Tim 3 Jul 2026). A retailer with no equivalent product is NULL — never force a
-- match (e.g. "Eat Later" is Woolworths-only). Small, slowly-changing, idempotent seed.
--
-- INTERNAL-ONLY posture, same as raw.retail_prices: RLS ON, cube_readonly read (0012 pattern),
-- no authenticated policy (growers fail closed). No enums (SPEC §2).

create table if not exists core.dim_retail_product (
  product_key      text primary key,       -- stable slug, e.g. 'hass-avocado'
  label            text not null unique,   -- conformed key = raw.retail_prices.product_label
  ww_product_id    text,                   -- Woolworths stockcode (null = no WW listing)
  coles_product_id text,                   -- Coles product id (null = confirmed no match)
  aldi_product_id  text,                   -- ALDI product code (null = confirmed no match)
  is_active        boolean not null default true,
  _loaded_at       timestamptz not null default now()
);
comment on table core.dim_retail_product is 'Mackays retail watchlist conformed across retailers (price-reporter source). label matches raw.retail_prices.product_label; per-retailer ids are the join keys; NULL = confirmed no match at that retailer. INTERNAL-ONLY.';

insert into core.dim_retail_product (product_key, label, ww_product_id, coles_product_id, aldi_product_id) values
  ('cavendish-bananas-each',      'Cavendish Bananas each',      '133211', '409499',  '000000000000380234'),
  ('eat-later-cavendish-bananas', 'Eat Later Cavendish Bananas', '157649', null,      null),
  ('bananas-kids-5-pack',         'Bananas Kids 5 pack',         '106218', '2511791', null),
  ('hass-avocado',                'Hass Avocado',                '120080', '5900530', '000000000000380092'),
  ('papaya-red-whole',            'Papaya Red Whole',            '172659', '6950578', '000000000000380298')
on conflict (product_key) do nothing;

alter table core.dim_retail_product enable row level security;

drop policy if exists cube_readonly_read_all on core.dim_retail_product;
create policy cube_readonly_read_all on core.dim_retail_product
  for select to cube_readonly using (true);
