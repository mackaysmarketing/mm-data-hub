-- 0034_core_dims — conformed dimensions: dim_customer, dim_product, dim_date (Sprint: closeout C1,
-- audit §8.10), plus the refresh_fact_settlement_bridge consignee-name fix.
--
-- Sources are the 0033 raw reference tables (raw.ft_consignee/ft_product/ft_crop/ft_variety/
-- ft_pack_type, loaded by ft:ref:load) + the raw.ft_entity BACKLINK for customer names
-- (entity.consignee_id → consignee.id — verified live 2026-07-11: 134/135 consignees carry a
-- backlink, every backlink has a non-blank org_name; exactly ONE hub-referenced consignee
-- (1 dispatch load) has no backlink → its name stays NULL, surfaced, never dropped).
--
-- Postures (two, chosen by consumer surface — the 0030 rationale):
--   • dim_customer = INTERNAL-ONLY. The customer LIST is commercially sensitive (who Mackays
--     sells to); no grower-facing view joins it today. Fail-closed to is_internal_claim() +
--     cube_readonly read-all — the exact 0031 fact posture. Additive later if a grower surface
--     ever needs it (then document the change).
--   • dim_product / dim_date = SHARED REFERENCE. Harmless non-grower lookups (a product master
--     row and a calendar row carry no consignor data), and a grower-facing security_invoker view
--     may join them later — read-all cannot widen, drop, or re-scope any grower's rows (same
--     rationale as dim_dispatch_state in 0030). `authenticated_read_reference … using (true)` +
--     cube_readonly read-all.

-- ═══════════════════════════════════════════════════════════════════════════
-- core.dim_customer — consignee grain (the CUSTOMER dimension)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.dim_customer (
  consignee_id  uuid primary key,
  name          text,          -- entity backlink org_name; NULL = no backlink (surfaced, 1 known)
  entity_code   text,          -- entity backlink code
  vendor_no     text,          -- raw.ft_consignee ('' at source when unset, landed faithfully)
  b2b_code      text,
  is_active     boolean,       -- raw.ft_consignee.is_active
  _built_at     timestamptz not null default now()
);
comment on table core.dim_customer is
  'Customer dimension at consignee grain. name/entity_code via the raw.ft_entity backlink (entity.consignee_id); NULL name = consignee with no entity backlink (surfaced, never dropped). Universe = raw.ft_consignee ∪ every consignee_id referenced by loads/GP/orders/pallets. INTERNAL-ONLY (the customer list is commercially sensitive).';
comment on column core.dim_customer.name is 'Business name from the entity backlink (raw.ft_entity.org_name). NULL when no entity backlinks this consignee — surfaced, never dropped or faked.';

-- Rebuild. Idempotent. Universe is the union of the reference table and every referenced
-- consignee_id, so coverage of the fact surfaces can never regress even if the reference
-- sync lags a new consignee.
create or replace function core.refresh_dim_customer() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.dim_customer;
  insert into core.dim_customer (consignee_id, name, entity_code, vendor_no, b2b_code, is_active, _built_at)
  select u.consignee_id, e.org_name, e.code, c.vendor_no, c.b2b_code, c.is_active, now()
  from (
    select id as consignee_id from raw.ft_consignee
    union
    select consignee_id from raw.ft_dispatch_load where consignee_id is not null
    union
    select consignee_id from raw.ft_gp_detail where consignee_id is not null
    union
    select consignee_id from raw.ft_gp_schedule where consignee_id is not null
    union
    select consignee_id from raw.ft_order where consignee_id is not null
    union
    select consignee_id from raw.ft_pallet where consignee_id is not null
  ) u
  left join raw.ft_consignee c on c.id = u.consignee_id
  -- name via the entity BACKLINK (entity.consignee_id → consignee.id — NOT entity.id).
  -- Deterministic if a consignee ever gains multiple backlinks (0 today): active first, then code.
  left join lateral (
    select e.org_name, e.code
    from raw.ft_entity e
    where e.consignee_id = u.consignee_id
    order by e.is_active desc nulls last, e.code
    limit 1
  ) e on true;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_dim_customer() is
  'Idempotent rebuild of core.dim_customer (consignee grain). Names via the raw.ft_entity backlink (entity.consignee_id); universe = raw.ft_consignee ∪ referenced consignee_ids. Run after ft:ref:load + the entity load.';

-- INTERNAL-ONLY + cube read-all (the exact 0031 fact posture)
alter table core.dim_customer enable row level security;
grant select on core.dim_customer to authenticated;
drop policy if exists internal_only_dim_customer on core.dim_customer;
create policy internal_only_dim_customer on core.dim_customer
  for select to authenticated using (semantic.is_internal_claim());
grant select on core.dim_customer to cube_readonly;
drop policy if exists cube_readonly_read_all on core.dim_customer;
create policy cube_readonly_read_all on core.dim_customer
  for select to cube_readonly using (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- core.dim_product — product grain (the PRODUCT dimension)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.dim_product (
  product_id        uuid primary key,
  code              text,
  name              text,          -- display-code-stripped (SPEC §9.7); source is clean today, strip is belt-and-braces
  description       text,
  unit              text,
  count             integer,
  boxes_per_pallet  integer,
  net_weight_value  numeric,       -- produce-dependent, nullable — never coalesce (SPEC §9.3)
  net_weight_unit   text,
  is_organic        boolean,
  ean13             text,
  ean14             text,
  crop_id           uuid,
  crop_name         text,
  variety_id        uuid,
  variety_name      text,
  pack_type_id      uuid,
  pack_type_name    text,
  is_active         boolean,
  _built_at         timestamptz not null default now()
);
comment on table core.dim_product is
  'Product dimension from the raw.ft_product master (covers 159/159 hub product_ids, verified 2026-07-11), crop/variety/pack_type denormalised. Names stripped of SPEC §9.7 display codes (^{…}/[nn]) — the master is clean at source (0/251), the strip is belt-and-braces. SHARED REFERENCE (non-grower lookup).';

-- Rebuild. Idempotent. The strip removes ^{…} control tokens and [nn] box-count tokens, collapses
-- whitespace, and NULLs (never '') a value that was only codes — mirroring src/lib/parsers.ts
-- stripFormatCodes, extended to [nn] per the SPRINT C1 contract.
create or replace function core.refresh_dim_product() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.dim_product;
  insert into core.dim_product (
    product_id, code, name, description, unit, count, boxes_per_pallet,
    net_weight_value, net_weight_unit, is_organic, ean13, ean14,
    crop_id, crop_name, variety_id, variety_name, pack_type_id, pack_type_name,
    is_active, _built_at
  )
  select
    p.id, p.code,
    nullif(btrim(regexp_replace(regexp_replace(regexp_replace(
      p.name, '\^\{[^}]*\}', '', 'g'), '\[[0-9]+\]', '', 'g'), '\s+', ' ', 'g')), ''),
    nullif(btrim(regexp_replace(regexp_replace(regexp_replace(
      p.description, '\^\{[^}]*\}', '', 'g'), '\[[0-9]+\]', '', 'g'), '\s+', ' ', 'g')), ''),
    p.unit, p.count, p.boxes_per_pallet,
    p.net_weight_value, p.net_weight_unit, p.is_organic, p.ean13, p.ean14,
    p.crop_id, c.name, p.variety_id, v.name, p.pack_type_id, pt.name,
    p.is_active, now()
  from raw.ft_product p
  left join raw.ft_crop c on c.id = p.crop_id
  left join raw.ft_variety v on v.id = p.variety_id
  left join raw.ft_pack_type pt on pt.id = p.pack_type_id;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_dim_product() is
  'Idempotent rebuild of core.dim_product from raw.ft_product (+ crop/variety/pack_type lookups). Display codes stripped per SPEC §9.7. Run after ft:ref:load.';

-- SHARED REFERENCE + cube read-all (the 0030 dim_dispatch_state posture)
alter table core.dim_product enable row level security;
grant select on core.dim_product to authenticated, cube_readonly;
drop policy if exists cube_readonly_read_all on core.dim_product;
create policy cube_readonly_read_all on core.dim_product
  for select to cube_readonly using (true);
drop policy if exists authenticated_read_reference on core.dim_product;
create policy authenticated_read_reference on core.dim_product
  for select to authenticated using (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- core.dim_date — calendar grain, incl. the FreshTrack pack-week code
-- ═══════════════════════════════════════════════════════════════════════════
-- PACK-WEEK RULE (verified live 2026-07-11, read-only probe against raw.ft_dispatch_load):
--   pack_week_code = 'Y' || to_char(d,'IY') || 'W' || to_char(d,'IW')   — the ISO year-week code.
-- Which DATE carries a load's code: extra_text_2 equals the ISO week code of the load's
-- scheduled_pickup_on (UTC date) on 22,120 / 22,363 well-formed codes = 98.91%. Candidates
-- anchored on pack_date top out at 47.4% (ISO) / 48.0% (Sunday-start) — the code tracks the
-- SCHEDULED-PICKUP week, NOT the pack-date week (fruit is often packed days before pickup).
-- The 1.09% residual: offsets of ±1–2 weeks consistent with pickup reschedules after the code
-- was assigned (largest buckets −1wk×40, −2wk×7), plus 8 malformed codes — documented honestly,
-- not hidden. So: joining a load's extra_text_2 to dim_date.pack_week_code yields the load's
-- scheduled-pickup week; pack_date-based joins will legitimately disagree ~half the time.
create table if not exists core.dim_date (
  date            date primary key,
  iso_year        integer not null,
  iso_week        integer not null,
  pack_week_code  text not null,   -- Y{ISO-yy}W{ISO-ww}, e.g. Y25W31 (SPEC §9.5 format)
  year            integer not null,
  month           integer not null,
  month_name      text not null,
  quarter         integer not null,
  au_fiscal_year  text not null,   -- 'FY26' = Jul 2025 – Jun 2026 (named by ending year)
  day_of_week     integer not null, -- ISO: 1 = Monday … 7 = Sunday
  is_weekend      boolean not null,
  _built_at       timestamptz not null default now()
);
comment on table core.dim_date is
  'Calendar dimension 2024-01-01..2027-12-31. pack_week_code = ISO year-week as Y{yy}W{ww} — matches raw.ft_dispatch_load.extra_text_2 at 98.91% when anchored on the load''s scheduled_pickup_on UTC date (verified 2026-07-11; pack_date anchors only ~47%). au_fiscal_year named by ENDING year (FY26 = Jul 2025 – Jun 2026). SHARED REFERENCE.';
comment on column core.dim_date.pack_week_code is
  'FreshTrack pack-week code for this date: Y{ISO-yy}W{ISO-ww}. A load''s extra_text_2 is this code evaluated at the load''s scheduled_pickup_on (UTC date) — 98.91% verified; residual = pickup reschedules after code assignment.';

-- Rebuild. Idempotent. Fixed range 2024-01-01..2027-12-31 (1,461 days).
create or replace function core.refresh_dim_date() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.dim_date;
  insert into core.dim_date (
    date, iso_year, iso_week, pack_week_code, year, month, month_name, quarter,
    au_fiscal_year, day_of_week, is_weekend, _built_at
  )
  select
    d::date,
    to_char(d, 'IYYY')::integer,
    to_char(d, 'IW')::integer,
    'Y' || to_char(d, 'IY') || 'W' || to_char(d, 'IW'),
    extract(year from d)::integer,
    extract(month from d)::integer,
    to_char(d, 'FMMonth'),
    extract(quarter from d)::integer,
    'FY' || to_char(d + interval '6 months', 'YY'),
    extract(isodow from d)::integer,
    extract(isodow from d) in (6, 7),
    now()
  from generate_series('2024-01-01'::date, '2027-12-31'::date, interval '1 day') as d;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_dim_date() is
  'Idempotent rebuild of core.dim_date (2024-01-01..2027-12-31, 1,461 rows). pack_week_code = ISO year-week Y{yy}W{ww} (98.91% verified vs load extra_text_2 on scheduled_pickup_on).';

-- SHARED REFERENCE + cube read-all (the 0030 dim_dispatch_state posture)
alter table core.dim_date enable row level security;
grant select on core.dim_date to authenticated, cube_readonly;
drop policy if exists cube_readonly_read_all on core.dim_date;
create policy cube_readonly_read_all on core.dim_date
  for select to cube_readonly using (true);
drop policy if exists authenticated_read_reference on core.dim_date;
create policy authenticated_read_reference on core.dim_date
  for select to authenticated using (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: core.refresh_fact_settlement_bridge — consignee-name join key (0031 bug)
-- ═══════════════════════════════════════════════════════════════════════════
-- 0031 joined `raw.ft_entity e on e.id = d.consignee_id` — the WRONG key: d.consignee_id lives in
-- the consignee id space, and entities point at it via the BACKLINK column e.consignee_id (never
-- e.id). Every bridge row therefore carried a NULL consignee_name (0/23,544 named). Full function
-- body copied from 0031 verbatim; the ONLY change is that join + its comment. Re-run
-- core.refresh_fact_settlement_bridge() (npm run ft:bridge:core) after applying.
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
  -- consignee name via the entity BACKLINK (e.consignee_id, NOT e.id — fixed in 0034)
  left join raw.ft_entity e on e.consignee_id = d.consignee_id
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
  'Idempotent rebuild of core.fact_settlement_bridge. Tiered sell allocation (product_exact rate×boxes with group cap / box_allocated disjoint pool / unmatched NULL); settlement measures allocated group-exact from fact_gp_settlement_load. consignee_name via the raw.ft_entity BACKLINK (e.consignee_id — fixed in 0034). mackays_revenue from dim_gp_charge.revenue_class (NULL until checkpoint). Run AFTER refresh_fact_gp_settlement_load() and refresh_fact_order_item().';
