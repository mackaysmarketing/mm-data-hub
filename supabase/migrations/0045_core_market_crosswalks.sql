-- 0045_core_market_crosswalks — the two conformance crosswalks the insight mart stands on
-- (Sprint: Insight layer 2026-07-12, Part 1 chunk 1).
--
--   core.crosswalk_customer_retail  — consignee → retailer_group + state_code. Which retailer (and
--     which DC state) a dispatch/settlement consignee belongs to, so supply can be laid beside the
--     Circana scan demand cells.
--   core.crosswalk_product_segment  — product → banana scan segment (+ kg_per_box). Which scan
--     segment a hub product sells through as, so boxes convert to comparable kg.
--
-- Both are RULE-DRIVEN over the conformed dims (core.dim_customer / core.dim_product, 0034) and
-- rebuilt by refresh functions (idempotent DELETE + INSERT). Every rule was VERIFIED against the
-- live distinct names 2026-07-12 (probe evidence in the sprint worklog): the DC-city → state
-- lookup covers 100% of the live Coles/Woolworths/ALDI consignees that carry dispatch loads;
-- the segment ladder maps 98.8% of banana pallets into an in-scope segment. `method` records
-- WHICH rule fired on every row; nothing is ever dropped — a name/product no rule recognises
-- lands with method 'unmapped' (customers → retailer_group 'other') and is surfaced by
-- npm run insight:reconcile.
--
-- INTERNAL-ONLY (the exact 0040 posture): the customer↔retailer map inherits dim_customer's
-- commercial sensitivity, and the segment map exists to serve internal-only scan surfaces.
-- RLS fail-closed to semantic.is_internal_claim() + cube_readonly read-all.

-- ═══════════════════════════════════════════════════════════════════════════
-- core.crosswalk_customer_retail — consignee grain
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.crosswalk_customer_retail (
  consignee_id   uuid primary key,      -- = core.dim_customer.consignee_id
  retailer_group text not null,         -- coles / woolworths / aldi / internal / other (text, never enum)
  state_code     text,                  -- VIC / QLD / NSW / SA / WA / TAS / NT; null = no DC-city rule fired
  method         text not null,         -- '<group rule>+state:<token|none>' — which rules fired
  name           text,                  -- denormalised dim_customer.name (the rule input, for audit)
  _built_at      timestamptz not null default now()
);
comment on table core.crosswalk_customer_retail is
  'Consignee → retailer_group (coles/woolworths/aldi/internal/other) + DC state via name rules over core.dim_customer (rules verified live 2026-07-12). method records which rule fired; unmapped names land as retailer_group=other, method=unmapped — surfaced, never dropped. internal = Mackays sheds/transfers/test consignees, EXCLUDED from retail supply measures. INTERNAL-ONLY.';
comment on column core.crosswalk_customer_retail.state_code is
  'Raw AU state of the consignee DC/city (VIC/QLD/NSW/SA/WA/TAS/NT). The MART maps this to scan geography (NSW→NSW+ACT, SA/NT→SA+NT) — this column keeps the unconflated state.';

-- Rebuild. Idempotent. RULE ORDER (documented contract — first match wins):
--   0. name NULL/blank                                → other / unmapped   (surfaced, never dropped)
--   1. internal:  'MM %' · '%test%' (Truganina Test, Ann Road Test, Larapinta Test — no live false
--      positive contains "test") · exact 'QPI' · 'Mackays%' · exact core.dim_shed.shed_name match
--      (catches Blenners Storage - Darra). Internal checks run BEFORE the retailer prefixes so a
--      hypothetical 'Woolworths Test' consignee stays out of retail supply (the sprint exclusion).
--   2. retailer first-token: 'Coles%' · 'Woolworths%'/'WOW %' · 'ALDI%'
--   3. everything else                                → other / other_default
-- STATE: DC-city/state token lookup (VALUES, verified against every live retail consignee name
-- 2026-07-12; longest token wins ties deterministically — 'Woolworths Melbourne Fresh (Truganina)'
-- matches Melbourne+Truganina, both VIC). Computed for EVERY row (harmless + useful on internal
-- sheds); retail rows without a token (head offices, 0 loads live) get state null, ':none' in method.
create or replace function core.refresh_crosswalk_customer_retail() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.crosswalk_customer_retail;
  insert into core.crosswalk_customer_retail (consignee_id, retailer_group, state_code, method, name, _built_at)
  select
    dc.consignee_id,
    split_part(g.rule, '|', 1),
    st.state,
    split_part(g.rule, '|', 2) || '+state:' || coalesce(st.token, 'none'),
    dc.name,
    now()
  from core.dim_customer dc
  -- one CASE ladder producing 'group|method' (a single ladder cannot diverge between two columns)
  cross join lateral (
    select case
      when dc.name is null or btrim(dc.name) = ''                       then 'other|unmapped'
      when dc.name ilike 'MM %'                                         then 'internal|internal_mm'
      when dc.name ~* 'test'                                            then 'internal|internal_test'
      when btrim(dc.name) = 'QPI'                                       then 'internal|internal_qpi'
      when dc.name ilike 'Mackays%'                                     then 'internal|internal_mackays'
      when exists (select 1 from core.dim_shed sh where sh.shed_name = dc.name)
                                                                        then 'internal|internal_shed'
      when dc.name ilike 'Coles%'                                       then 'coles|prefix_coles'
      when dc.name ilike 'Woolworths%' or dc.name ilike 'WOW %'         then 'woolworths|prefix_woolworths'
      when dc.name ilike 'ALDI%'                                        then 'aldi|prefix_aldi'
      else 'other|other_default'
    end as rule
  ) g
  -- DC-city → state lookup, verified live (every retail consignee with loads resolves):
  --   VIC Melbourne/Truganina/Derrimut/Wodonga/Epping · QLD Brisbane/Parkinson/Brendale/Stapylton/
  --   Townsville/Rochedale/Cairns/Tully/Darra/Larapinta · NSW Minchinbury/Eastern Creek/Sydney/
  --   Wyong/NSW · WA Jandakot/Perth · SA 'South Australia'/Adelaide/Regency Park · TAS Tasmania/
  --   Hobart · NT Darwin (defensive; 0 live)
  left join lateral (
    select s.token, s.state
    from (values
      ('Melbourne','VIC'), ('Truganina','VIC'), ('Derrimut','VIC'), ('Wodonga','VIC'), ('Epping','VIC'),
      ('Brisbane','QLD'), ('Parkinson','QLD'), ('Brendale','QLD'), ('Stapylton','QLD'),
      ('Townsville','QLD'), ('Rochedale','QLD'), ('Cairns','QLD'), ('Tully','QLD'),
      ('Darra','QLD'), ('Larapinta','QLD'),
      ('Minchinbury','NSW'), ('Eastern Creek','NSW'), ('Sydney','NSW'), ('Wyong','NSW'), ('NSW','NSW'),
      ('Jandakot','WA'), ('Perth','WA'),
      ('South Australia','SA'), ('Adelaide','SA'), ('Regency Park','SA'),
      ('Tasmania','TAS'), ('Hobart','TAS'),
      ('Darwin','NT')
    ) as s(token, state)
    where dc.name is not null and dc.name ilike '%' || s.token || '%'
    order by length(s.token) desc, s.token
    limit 1
  ) st on true;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_crosswalk_customer_retail() is
  'Idempotent rebuild of core.crosswalk_customer_retail from core.dim_customer name rules (order: unmapped → internal [MM %/%test%/QPI/Mackays%/shed-name] → Coles/Woolworths|WOW/ALDI prefixes → other) + the verified DC-city→state token lookup. Run after refresh_dim_customer().';

-- ═══════════════════════════════════════════════════════════════════════════
-- core.crosswalk_product_segment — product grain
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.crosswalk_product_segment (
  product_id  uuid primary key,          -- = core.dim_product.product_id
  segment     text not null,             -- REGULAR / PRE_PACK / LADY_FINGER / OTHER / OUT_OF_SCOPE (text, never enum)
  method      text not null,             -- which rule fired
  kg_per_box  numeric,                   -- dim_product.net_weight_value — nullable, NEVER coalesced (SPEC §9.3)
  _built_at   timestamptz not null default now()
);
comment on table core.crosswalk_product_segment is
  'Product → Circana banana scan segment via variety/pack_type/name rules over core.dim_product (verified live 2026-07-12: 98.8% of banana pallets map in-scope; the residual is processing bins, correctly OUT_OF_SCOPE). kg_per_box = net_weight_value (nullable, never coalesced). method records which rule fired. INTERNAL-ONLY.';
comment on column core.crosswalk_product_segment.segment is
  'REGULAR/PRE_PACK/LADY_FINGER/OTHER match the conformed scan segments (0043). OUT_OF_SCOPE = never on a retail shelf as loose fruit: non-banana crops, value-added (Processed Banana), and bulk bins.';

-- Rebuild. Idempotent. RULE ORDER (documented contract — first match wins; verified against the
-- full live banana product list 2026-07-12):
--   0. crop_name NULL                      → OUT_OF_SCOPE / unmapped        (defensive; 0 live)
--   1. crop_name <> 'Banana'               → OUT_OF_SCOPE / out_of_scope_crop
--        (Processed Banana = value-added, out of scan scope per the sprint findings; plus
--         Avocado/Mango/Papaya/Passionfruit/Watermelon)
--   2. pack_type ~* 'bin'                  → OUT_OF_SCOPE / out_of_scope_bulk
--        (Megabin/Octabin/Red Harvest Bin — processing bulk, never a retail shelf; runs BEFORE the
--         name rules so 'Class 2MIXOctabin…Red Tip' is bulk, not OTHER)
--   3. variety = 'Lady Finger'             → LADY_FINGER / variety_lady_finger
--        (BEFORE the organic rule: the scan LADY FINGER segment is a variety split, so the organic
--         8kg Lady Finger carton is LADY_FINGER, not OTHER)
--   4. pack_type ~* 'band|collar|prepack|pre pack|kids' → PRE_PACK / pack_type_pre_pack
--        (Coles Bands / WOW Collars / PrePack Crate live; Kids defensive)
--   5. is_organic OR name ~* 'organic|red tip|singles|mix' → OTHER / name_other
--        (is_organic is belt-and-braces: every live organic product also carries 'Organic' in the
--         name; Red Tip / Singles / Class-2 MIX cartons are the scan OTHER BANANAS segment)
--   6. remaining crop_name = 'Banana'      → REGULAR / regular_default      (the loose-cavendish cartons)
create or replace function core.refresh_crosswalk_product_segment() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.crosswalk_product_segment;
  insert into core.crosswalk_product_segment (product_id, segment, method, kg_per_box, _built_at)
  select
    dp.product_id,
    split_part(r.rule, '|', 1),
    split_part(r.rule, '|', 2),
    dp.net_weight_value,                 -- nullable; never coalesced
    now()
  from core.dim_product dp
  cross join lateral (
    select case
      when dp.crop_name is null                                    then 'OUT_OF_SCOPE|unmapped'
      when dp.crop_name <> 'Banana'                                then 'OUT_OF_SCOPE|out_of_scope_crop'
      when dp.pack_type_name ~* 'bin'                              then 'OUT_OF_SCOPE|out_of_scope_bulk'
      when dp.variety_name = 'Lady Finger'                         then 'LADY_FINGER|variety_lady_finger'
      when dp.pack_type_name ~* 'band|collar|prepack|pre pack|kids' then 'PRE_PACK|pack_type_pre_pack'
      when coalesce(dp.is_organic, false)
        or dp.name ~* 'organic|red tip|singles|mix'                then 'OTHER|name_other'
      else 'REGULAR|regular_default'
    end as rule
  ) r;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_crosswalk_product_segment() is
  'Idempotent rebuild of core.crosswalk_product_segment from core.dim_product (rule order: null crop → non-banana → bulk bins → Lady Finger → pre-pack pack types → organic/red tip/singles/mix → REGULAR). kg_per_box = net_weight_value, never coalesced. Run after refresh_dim_product().';

-- ── RLS: INTERNAL-ONLY (fail-closed) + cube read-all — the exact 0040 pattern ──
alter table core.crosswalk_customer_retail enable row level security;
alter table core.crosswalk_product_segment enable row level security;
grant select on core.crosswalk_customer_retail, core.crosswalk_product_segment to authenticated;

drop policy if exists internal_only_crosswalk_customer_retail on core.crosswalk_customer_retail;
create policy internal_only_crosswalk_customer_retail on core.crosswalk_customer_retail
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_crosswalk_product_segment on core.crosswalk_product_segment;
create policy internal_only_crosswalk_product_segment on core.crosswalk_product_segment
  for select to authenticated using (semantic.is_internal_claim());

grant select on core.crosswalk_customer_retail, core.crosswalk_product_segment to cube_readonly;
drop policy if exists cube_readonly_read_all on core.crosswalk_customer_retail;
create policy cube_readonly_read_all on core.crosswalk_customer_retail for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on core.crosswalk_product_segment;
create policy cube_readonly_read_all on core.crosswalk_product_segment for select to cube_readonly using (true);
