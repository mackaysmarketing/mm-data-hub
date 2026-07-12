-- 0043_core_retail_scan — the conformed weekly sell-through fact.
--
-- Grain: retailer × week_ending × geography_code × segment × causal — WEEKLY rows only
-- (time_label 'W/E DD-MM-YY'; the 'Latest N' snapshot aggregates stay in raw — they are pure
-- derivations of the weekly rows). One row per raw weekly row; the unique index on the logical
-- grain guards against a mapping collision ever collapsing two raw rows.
--
-- Conformances (all documented, all surfaced-not-dropped):
--   week_ending    'W/E DD-MM-YY' → date (DD-MM-YY, 20yy). Joins core.dim_date → pack_week_code,
--                  tying scan weeks to the hub's pack weeks / dispatch calendar.
--   geography_code 'All Geography by Coles Supermarkets' → AU · 'NSW + ACT' → NSW+ACT ·
--                  'SA + NT' → SA+NT · QLD/TAS/VIC/WA verbatim. Unknown → verbatim (surfaced).
--   product        Circana's Product is a HIERARCHY PATH '<child>-<parent>' (split on the FIRST
--                  '-'; bare 'BANANAS' = the category root). Two export shapes observed:
--                    own-brand export:  child = segment,      parent = 'BANANAS'
--                    mfr-split export:  child = MANUFACTURER, parent = segment
--                  Conformed to (segment, supplier):
--                    'BANANAS'                → segment ALL,  supplier NULL (is_category_total)
--                    parent = 'BANANAS'       → segment map(child),  supplier NULL
--                    parent = a segment name  → segment map(parent), supplier = child
--                      (e.g. 'FRESHMAX HOLDINGS-LADY FINGER' → LADY_FINGER × FRESHMAX HOLDINGS;
--                       'PRIVATE LABEL-REGULAR' → REGULAR × PRIVATE LABEL; 'OTHER MFRS-…' likewise)
--                    anything else            → segment = verbatim product (surfaced, never dropped)
--                  Segment map: REGULAR BANANAS|REGULAR → REGULAR · PRE PACK BANANAS → PRE_PACK ·
--                  LADY FINGER → LADY_FINGER · OTHER BANANAS|OTHER → OTHER.
--   causal         TOTAL → total · 'In store' → in_store · Online → online.
--   category       'bananas' (the hierarchy root, lowercased); future category exports conform
--                  without a migration.
--
-- INTERNAL-ONLY (retailer sell-through is commercially sensitive; never grower-facing) — the exact
-- 0040 posture: RLS fail-closed to is_internal_claim() + cube_readonly read-all.

create table if not exists core.fact_retail_scan (
  id                 text primary key,   -- = raw.retail_scan.id
  retailer           text not null,
  week_ending        date not null,
  geography_code     text not null,
  category           text,
  segment            text not null,
  supplier           text,               -- manufacturer on the mfr-split export (NULL = no split)
  is_category_total  boolean not null,
  causal             text not null,      -- total / in_store / online
  units              numeric,            -- Unit Sales (current)
  units_ya           numeric,
  dollars            numeric,            -- Dollar Sales (current)
  dollars_ya         numeric,
  volume_kg          numeric,            -- Volume Sales (kg; NULL preserved)
  volume_kg_ya       numeric,
  price_per_unit     numeric,
  price_per_volume   numeric,            -- $/kg
  acv_distribution   numeric,
  pct_stores         numeric,
  base_dollars       numeric,            -- promo split: base vs incremental
  incr_dollars       numeric,
  base_units         numeric,
  incr_units         numeric,
  base_volume_kg     numeric,
  incr_volume_kg     numeric,
  _built_at          timestamptz not null default now()
);
alter table core.fact_retail_scan add column if not exists supplier text;  -- additive (re-apply safe)
drop index if exists core.ux_fact_retail_scan_grain;
create unique index if not exists ux_fact_retail_scan_grain
  on core.fact_retail_scan (retailer, week_ending, geography_code, segment, supplier, causal)
  nulls not distinct;
create index if not exists ix_fact_retail_scan_week on core.fact_retail_scan (week_ending);
comment on table core.fact_retail_scan is
  'Weekly retailer sell-through (Coles/Circana): units, dollars, volume-kg + YA counterparts, price, distribution, base/incremental promo split — by week × geography × banana segment × channel. Weekly grain only (Latest-N aggregates stay in raw). INTERNAL-ONLY.';

create or replace function core.refresh_fact_retail_scan() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_retail_scan;
  insert into core.fact_retail_scan (
    id, retailer, week_ending, geography_code, category, segment, supplier, is_category_total, causal,
    units, units_ya, dollars, dollars_ya, volume_kg, volume_kg_ya,
    price_per_unit, price_per_volume, acv_distribution, pct_stores,
    base_dollars, incr_dollars, base_units, incr_units, base_volume_kg, incr_volume_kg, _built_at
  )
  with seg as (
    -- the segment-name map, applied to EITHER hierarchy level (see the table-comment contract)
    select * from (values
      ('REGULAR BANANAS', 'REGULAR'), ('REGULAR', 'REGULAR'),
      ('PRE PACK BANANAS', 'PRE_PACK'),
      ('LADY FINGER', 'LADY_FINGER'),
      ('OTHER BANANAS', 'OTHER'), ('OTHER', 'OTHER')
    ) as m(source_name, segment)
  ),
  split as (
    select r.*,
           case when position('-' in r.product) > 0
                then btrim(left(r.product, position('-' in r.product) - 1)) end as child,
           case when position('-' in r.product) > 0
                then btrim(substr(r.product, position('-' in r.product) + 1)) end as parent
    from raw.retail_scan r
    where r.time_label like 'W/E %'   -- weekly grain only; Latest-N snapshots stay in raw
  )
  select
    s.id, s.retailer,
    make_date(2000 + split_part(replace(s.time_label, 'W/E ', ''), '-', 3)::int,
              split_part(replace(s.time_label, 'W/E ', ''), '-', 2)::int,
              split_part(replace(s.time_label, 'W/E ', ''), '-', 1)::int),
    case s.geography
      when 'All Geography by Coles Supermarkets' then 'AU'
      when 'NSW + ACT' then 'NSW+ACT'
      when 'SA + NT'  then 'SA+NT'
      else s.geography end,
    'bananas',
    case
      when s.product = 'BANANAS'          then 'ALL'
      when s.parent = 'BANANAS'           then coalesce(mc.segment, s.product)  -- own-brand: child = segment
      when mp.segment is not null         then mp.segment                        -- mfr split: parent = segment
      else s.product                                                             -- unknown → verbatim, surfaced
    end,
    case when s.parent is not null and s.parent <> 'BANANAS' and mp.segment is not null
         then s.child end,                                                       -- supplier on the mfr split
    (s.product = 'BANANAS'),
    case s.causal when 'TOTAL' then 'total' when 'In store' then 'in_store'
                  when 'Online' then 'online' else lower(s.causal) end,
    s.unit_sales, s.unit_sales_ya, s.dollar_sales, s.dollar_sales_ya,
    s.volume_sales, s.volume_sales_ya,
    s.price_per_unit, s.price_per_volume, s.acv_distribution, s.pct_stores,
    s.base_dollar_sales, s.incr_dollar_sales, s.base_unit_sales, s.incr_unit_sales,
    s.base_volume_sales, s.incr_volume_sales,
    now()
  from split s
  left join seg mc on mc.source_name = s.child
  left join seg mp on mp.source_name = s.parent;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_retail_scan() is
  'Idempotent rebuild of core.fact_retail_scan (weekly rows only). Run after scan:load. Week parsed DD-MM-YY (20yy); geography/segment/causal conformed per the table comment; unknowns land verbatim, never dropped.';

-- ── RLS: INTERNAL-ONLY (fail-closed) + cube read-all — the 0040 pattern ──────
alter table core.fact_retail_scan enable row level security;
grant select on core.fact_retail_scan to authenticated;
drop policy if exists internal_only_fact_retail_scan on core.fact_retail_scan;
create policy internal_only_fact_retail_scan on core.fact_retail_scan
  for select to authenticated using (semantic.is_internal_claim());
grant select on core.fact_retail_scan to cube_readonly;
drop policy if exists cube_readonly_read_all on core.fact_retail_scan;
create policy cube_readonly_read_all on core.fact_retail_scan for select to cube_readonly using (true);
