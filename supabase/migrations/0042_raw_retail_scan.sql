-- 0042_raw_retail_scan — Coles weekly sell-through scan landing (Circana supplier export).
--
-- Source: the "Weekly Sales (Scan)_SUP" CSV Tim downloads from Coles (Circana/IRI supplier report).
-- Multi-section (one per geography: national + 6 states), banana category + 4 segments ×
-- TOTAL/In store/Online, 52-week rolling window (`W/E DD-MM-YY`) + Latest-52/4/1 aggregate rows.
-- Parsed by the PURE src/lib/retail_scan_coles.ts (header-drift fails loudly; '' → NULL; scientific
-- notation supported); loaded by src/loaders/retail_scan.ts (`npm run scan:load`).
--
-- MEASURES: the export carries 19 measures × 5 variants. We land 3 variants per measure —
-- Current (base name), Year Ago (_ya), % Change vs 2 YA (_pct_2ya; embeds the 2-years-ago value,
-- which is NOT otherwise present) = 57 numeric columns. The two vs-YA delta variants are PURE
-- derivations (change = current − ya; pct = change/ya) and are parsed-then-discarded, never landed.
-- Share/ACV/pct measures are RATIOS as provided (% values 0-100, pct-change values as fractions) —
-- landed verbatim, never scaled. NULLs preserved (never coalesced — SPEC §9.3).
--
-- GRAIN / KEY: (retailer, geography, product, time_label, causal) — synthesized text PK. Weekly
-- re-drops of the rolling window UPSERT (retailer revisions win; the natural key is stable).
-- time_label lands VERBATIM ('W/E 07-07-26', 'Latest 52 W/E 07-07-26') — week parsing happens in
-- core (0043), raw stays faithful.
--
-- POSTURE (matches 0027/0037/0039 raw): NO authenticated grant, RLS NOT enabled — etl-only;
-- cube_readonly grant is belt-and-braces over 0011 default privileges. Commercially sensitive
-- (retailer sell-through) — internal-only exposure happens at core/semantic (0043/0044).

create table if not exists raw.retail_scan (
  id                text primary key,   -- retailer|geography|product|time_label|causal
  retailer          text not null,      -- 'coles'
  geography         text,               -- section Geography, verbatim
  manufacturer      text,
  brand             text,
  subbrand          text,
  product           text,               -- BANANAS / REGULAR BANANAS-BANANAS / ...
  time_label        text,               -- verbatim: 'W/E DD-MM-YY' or 'Latest N W/E DD-MM-YY'
  causal            text,               -- TOTAL / In store / Online

  unit_sales                    numeric,
  unit_sales_ya                 numeric,
  unit_sales_pct_2ya            numeric,
  price_per_unit                numeric,
  price_per_unit_ya             numeric,
  price_per_unit_pct_2ya        numeric,
  volume_sales                  numeric,
  volume_sales_ya               numeric,
  volume_sales_pct_2ya          numeric,
  price_per_volume              numeric,
  price_per_volume_ya           numeric,
  price_per_volume_pct_2ya      numeric,
  dollar_sales                  numeric,
  dollar_sales_ya               numeric,
  dollar_sales_pct_2ya          numeric,
  acv_distribution              numeric,
  acv_distribution_ya           numeric,
  acv_distribution_pct_2ya      numeric,
  pct_stores                    numeric,
  pct_stores_ya                 numeric,
  pct_stores_pct_2ya            numeric,
  avg_wk_dollars_per_store          numeric,
  avg_wk_dollars_per_store_ya       numeric,
  avg_wk_dollars_per_store_pct_2ya  numeric,
  avg_wk_units_per_store            numeric,
  avg_wk_units_per_store_ya         numeric,
  avg_wk_units_per_store_pct_2ya    numeric,
  avg_wk_volume_per_store           numeric,
  avg_wk_volume_per_store_ya        numeric,
  avg_wk_volume_per_store_pct_2ya   numeric,
  dollar_share_parent           numeric,
  dollar_share_parent_ya        numeric,
  dollar_share_parent_pct_2ya   numeric,
  unit_share_parent             numeric,
  unit_share_parent_ya          numeric,
  unit_share_parent_pct_2ya     numeric,
  volume_share_parent           numeric,
  volume_share_parent_ya        numeric,
  volume_share_parent_pct_2ya   numeric,
  base_dollar_sales             numeric,
  base_dollar_sales_ya          numeric,
  base_dollar_sales_pct_2ya     numeric,
  incr_dollar_sales             numeric,
  incr_dollar_sales_ya          numeric,
  incr_dollar_sales_pct_2ya     numeric,
  base_unit_sales               numeric,
  base_unit_sales_ya            numeric,
  base_unit_sales_pct_2ya       numeric,
  incr_unit_sales               numeric,
  incr_unit_sales_ya            numeric,
  incr_unit_sales_pct_2ya       numeric,
  base_volume_sales             numeric,
  base_volume_sales_ya          numeric,
  base_volume_sales_pct_2ya     numeric,
  incr_volume_sales             numeric,
  incr_volume_sales_ya          numeric,
  incr_volume_sales_pct_2ya     numeric,

  source_file       text,
  _synced_at        timestamptz not null default now()
);
create index if not exists ix_retail_scan_time on raw.retail_scan (time_label);
create index if not exists ix_retail_scan_geo on raw.retail_scan (geography);
comment on table raw.retail_scan is
  'Coles weekly sell-through scan (Circana supplier export), landed verbatim at (retailer, geography, product, time_label, causal) grain. 19 measures × {current, _ya, _pct_2ya} — vs-YA deltas derivable, never landed. Weekly re-drops upsert. etl-only; exposure via core/semantic (internal-only).';
comment on column raw.retail_scan.time_label is
  'Verbatim Circana time label: weekly rows ''W/E DD-MM-YY'' + snapshot aggregates ''Latest 52|4|1 W/E DD-MM-YY''. Parsed to week_ending/period_type in core (0043), never here.';
comment on column raw.retail_scan.volume_sales is
  'Circana Volume Sales (kg for bananas). NULL preserved, never coalesced (SPEC §9.3).';

-- Grants (belt-and-braces over 0011 default privileges; NO authenticated grant, no RLS)
grant select on raw.retail_scan to cube_readonly;
