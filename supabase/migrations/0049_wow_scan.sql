-- 0049_wow_scan — Woolworths Q.Checkout scan ingest (MODULE-WOW-SCAN-SPEC.md, 2026-07-13).
--
-- The Woolworths counterpart to the Coles Circana scan (0042-0044). Manual CSV download →
-- scripts/parse_wow_scan.py (finest-grain clean CSV + JSON sidecar) → these tables via
-- `npm run wow:load`. INTERNAL-ONLY throughout (Mackays category data — NOT grower-scoped; no
-- consignor policy) — the 0040/0043 posture: RLS fail-closed to is_internal_claim() + cube_readonly.
--
-- SOURCE QUIRKS ENCODED (spec §"Known source risks"):
--   • `week_ending` is a Woolworths Wed→Tue promo week ending TUESDAY — same basis as the Coles
--     scan, so cross-retailer alignment is EXACT-DATE on week_ending (documented on the union view).
--   • Only the FINEST grain lands (State×VCU×Channel×Promotion); Total-grain rows are dropped by the
--     parser (the 8× multiply trap) and totals are DERIVED in the semantic views.
--   • Quantium RESTATES recent weeks → the load UPSERTS on the PK so a trailing-overlap re-export
--     corrects prior rows. Article list churns → never hard-code SKUs.

-- ── raw: the load ledger (one row per parsed export) ─────────────────────────
create table if not exists raw.wow_scan_loads (
  load_id           uuid primary key,
  source_filename   text,
  export_parameters jsonb,     -- the sidecar's export_parameters (wizard settings)
  stats             jsonb,     -- rows_in / rows_out / blank / total-grain / unparsed
  coverage          jsonb,     -- weeks / week_min / week_max / articles / states
  loaded_at         timestamptz not null default now()
);
comment on table raw.wow_scan_loads is
  'One row per parse_wow_scan.py load — the JSON sidecar (export params + accounting stats + coverage). Provenance for every core.wow_scan_weekly row via load_id.';

-- ── raw: verbatim clean-CSV landing (all text + load provenance) ─────────────
create table if not exists raw.wow_scan_export (
  load_id              uuid not null references raw.wow_scan_loads(load_id),
  source_filename      text,
  week_ending          text,
  article_number       text,
  uom                  text,
  article_description  text,
  sub_category         text,
  segment              text,
  state                text,
  vcu                  text,
  channel              text,
  promotion            text,
  volume               text,
  sales                text,
  units                text,
  avg_price_per_volume text,
  avg_unit_price       text,
  loaded_at            timestamptz not null default now()
);
create index if not exists ix_wow_scan_export_load on raw.wow_scan_export (load_id);
comment on table raw.wow_scan_export is
  'Verbatim landing of the parser''s clean CSV (all columns text) + load_id/source_filename. core.wow_scan_weekly types + dedupes this into the finest-grain fact.';

-- ── core: the finest-grain typed fact (spec DDL) ─────────────────────────────
create table if not exists core.wow_scan_weekly (
  week_ending          date        not null,   -- Tuesday
  article_number       text        not null,   -- zero-padded, e.g. '0133211'
  uom                  text        not null,   -- 'KG' | 'EA'
  article_description  text        not null,
  sub_category         text        not null,   -- BANANA | TROPICAL FRUIT
  segment              text        not null,
  state                text        not null,   -- 7 AU states, no 'Australia'
  vcu                  text        not null,   -- CORE | UP | VALUE, no 'Total'
  channel              text        not null,   -- INSTORE | ONLINE, no 'Total'
  promotion            text        not null,   -- ON_PROMOTION | OFF_PROMOTION, no 'Total'
  volume               numeric,                -- never coalesced to 0 (SPEC §9.3)
  sales                numeric,
  units                numeric,
  avg_price_per_volume numeric,
  avg_unit_price       numeric,
  load_id              uuid        not null references raw.wow_scan_loads(load_id),
  _built_at            timestamptz not null default now(),
  primary key (week_ending, article_number, state, vcu, channel, promotion)
);
create index if not exists ix_wow_scan_weekly_week on core.wow_scan_weekly (week_ending);
create index if not exists ix_wow_scan_weekly_article on core.wow_scan_weekly (article_number);
comment on table core.wow_scan_weekly is
  'Woolworths Q.Checkout sell-through, FINEST grain (week × article × state × VCU × channel × promotion). Totals derived in semantic views (the source''s Total rows are dropped — the 8× multiply trap). Upsert on PK (Quantium restates recent weeks). INTERNAL-ONLY.';

-- Build the typed fact from the raw landing of a given load (idempotent upsert on the PK).
create or replace function core.upsert_wow_scan_weekly(p_load_id uuid) returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  insert into core.wow_scan_weekly (
    week_ending, article_number, uom, article_description, sub_category, segment,
    state, vcu, channel, promotion, volume, sales, units, avg_price_per_volume, avg_unit_price,
    load_id, _built_at
  )
  select
    e.week_ending::date, e.article_number, e.uom, e.article_description, e.sub_category, e.segment,
    e.state, e.vcu, e.channel, e.promotion,
    nullif(e.volume,'')::numeric, nullif(e.sales,'')::numeric, nullif(e.units,'')::numeric,
    nullif(e.avg_price_per_volume,'')::numeric, nullif(e.avg_unit_price,'')::numeric,
    e.load_id, now()
  from raw.wow_scan_export e
  where e.load_id = p_load_id
  on conflict (week_ending, article_number, state, vcu, channel, promotion) do update set
    uom = excluded.uom, article_description = excluded.article_description,
    sub_category = excluded.sub_category, segment = excluded.segment,
    volume = excluded.volume, sales = excluded.sales, units = excluded.units,
    avg_price_per_volume = excluded.avg_price_per_volume, avg_unit_price = excluded.avg_unit_price,
    load_id = excluded.load_id, _built_at = now();
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.upsert_wow_scan_weekly(uuid) is
  'Types + upserts one load''s raw.wow_scan_export rows into core.wow_scan_weekly (PK = finest grain; Quantium restatements win). Nullable metrics never coalesced.';

-- ── semantic: internal-only rollups (security_invoker over the internal fact) ─
-- v_wow_scan_national — week × article totals, DERIVED (matches the export's Australia/Total slice).
create or replace view semantic.v_wow_scan_national
  with (security_invoker = true) as
select
  week_ending, article_number, uom, max(article_description) as article_description,
  max(sub_category) as sub_category, max(segment) as segment,
  sum(volume) as volume, sum(sales) as sales, sum(units) as units,
  case when sum(volume) > 0 then round(sum(sales) / sum(volume), 6) end as avg_price_per_volume,
  case when sum(units)  > 0 then round(sum(sales) / sum(units),  6) end as avg_unit_price
from core.wow_scan_weekly
group by week_ending, article_number, uom;
grant select on semantic.v_wow_scan_national to authenticated, cube_readonly;
comment on view semantic.v_wow_scan_national is
  'Woolworths national week×article totals, summed from the finest grain (reconciles to the source Australia/Total slice, AC3/AC5). INTERNAL-ONLY; security_invoker → grower JWT sees 0.';

-- v_wow_scan_promo — promo vs off-promo split + promo share of sales (week × article × state).
create or replace view semantic.v_wow_scan_promo
  with (security_invoker = true) as
select
  week_ending, article_number, state,
  sum(sales) filter (where promotion = 'ON_PROMOTION')  as promo_sales,
  sum(sales) filter (where promotion = 'OFF_PROMOTION') as base_sales,
  sum(sales) as total_sales,
  sum(units) filter (where promotion = 'ON_PROMOTION')  as promo_units,
  case when sum(sales) > 0
       then round(sum(sales) filter (where promotion = 'ON_PROMOTION') / sum(sales), 4) end
    as promo_sales_share
from core.wow_scan_weekly
group by week_ending, article_number, state;
grant select on semantic.v_wow_scan_promo to authenticated, cube_readonly;
comment on view semantic.v_wow_scan_promo is
  'Woolworths promo vs off-promo split + promo share of sales, week × article × state. INTERNAL-ONLY; security_invoker.';

-- v_scan_cross_retailer — Woolworths ∪ Coles national weekly, aligned on week_ending (BOTH end
-- Tuesday). Coles side reuses the finest-grain Coles fact (own-brand rows, causal=total) rolled to
-- national. Article/segment mapping across retailers is a SEPARATE sprint — this ships the retailer
-- + week + segment/label spine so cross-retailer weekly comparison works today for the banana total.
create or replace view semantic.v_scan_cross_retailer
  with (security_invoker = true) as
select 'woolworths'::text as retailer, week_ending,
       article_number as line_key, article_description as line_label,
       sum(sales) as sales, sum(volume) as volume_kg, sum(units) as units
from core.wow_scan_weekly
group by week_ending, article_number, article_description
union all
select 'coles'::text as retailer, week_ending,
       segment as line_key, segment as line_label,
       sum(dollars) as sales, sum(volume_kg) as volume_kg, sum(units) as units
from core.fact_retail_scan
where geography_code = 'AU' and causal = 'total' and supplier is null and not is_category_total
group by week_ending, segment;
grant select on semantic.v_scan_cross_retailer to authenticated, cube_readonly;
comment on view semantic.v_scan_cross_retailer is
  'Cross-retailer weekly scan spine (Woolworths article-grain ∪ Coles segment-grain), aligned on week_ending — BOTH retailers'' scan weeks end Tuesday, so same-date = same week. Article↔segment mapping is a later sprint; join on week + the mapping table when it lands. INTERNAL-ONLY.';

-- ── Posture ─────────────────────────────────────────────────────────────────
-- raw = etl-only (the 0042 raw.retail_scan pattern): NO authenticated grant, no RLS; cube_readonly
-- grant belt-and-braces. core.wow_scan_weekly = INTERNAL-ONLY (0040): RLS fail-closed to
-- is_internal_claim() + cube read-all. Semantic views (above) are security_invoker over the internal
-- fact — a grower JWT sees 0. This is Mackays category data (not grower-scoped), internal throughout.
grant select on raw.wow_scan_loads, raw.wow_scan_export to cube_readonly;

alter table core.wow_scan_weekly enable row level security;
grant select on core.wow_scan_weekly to authenticated, cube_readonly;
drop policy if exists internal_only_wow_scan_weekly on core.wow_scan_weekly;
create policy internal_only_wow_scan_weekly on core.wow_scan_weekly
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists cube_readonly_read_all on core.wow_scan_weekly;
create policy cube_readonly_read_all on core.wow_scan_weekly for select to cube_readonly using (true);
