-- 0048_core_business_terms — the NL glossary foundation (SPRINT 2026-07-12 Part 2).
--
-- A translation layer from MACKAYS business vocabulary to hub entities/metrics, so agents and BI
-- can answer questions asked in business language ("cavs to Coles Melbourne", "week 31",
-- "lady fingers"). Two tables + one semantic catalog view + an idempotent seed:
--
--   core.business_term — alias → entity mapping at (entity_type × entity_key × lower(alias)) grain.
--     entity_type (text, documented values — never an enum):
--       product / customer / grower / shed / segment / geography / charge_category / metric / period
--     entity_key namespaces (documented, additive):
--       product   → core.dim_product.product_id (uuid text)
--       customer  → core.dim_customer.consignee_id (uuid text)
--       grower    → core.dim_grower.consignor_id (uuid text)
--       shed      → core.dim_shed.shed_id (uuid text)
--       segment   → core.fact_retail_scan.segment (ALL/REGULAR/PRE_PACK/LADY_FINGER/OTHER)
--       geography → core.fact_retail_scan.geography_code (AU/NSW+ACT/QLD/SA+NT/TAS/VIC/WA)
--       charge_category → 'gp:<CAT>' / 'ns:<CAT>' for the FR/WH/MD/MI/LA taxonomy (the gp:/ns:
--                          prefix carries the documented LA divergence: GP LA = Load Adjustment,
--                          NS LA = Larapinta); 'gp_charge:<charge_id>' / 'ns_item:<itemid>' for
--                          specific charges aliased through the engagement tool
--       metric    → '<cube view>.<measure>' (e.g. dispatch.load_count) or
--                    '<mart view>.<column>' (e.g. market_week.our_share_kg)
--       period    → au_fiscal_year codes (FY26) — pack-week codes stay a PATTERN (see nl_phrase)
--     source: 'seed' (canonical names + curated static values) / 'derived' (mechanically derived
--       variants — suffix strips, underscore/plural forms) / 'tim' (the engagement tool, loaded by
--       npm run nl:load — NEVER deleted or overwritten by the seed).
--
--   core.nl_phrase — free-form phrase → meaning/mapping for metrics, time expressions, units,
--     roles, questions (category text: units/time/roles/questions/general — documented, not
--     enforced). mapping = hub object/expression when known; Tim rows land with mapping NULL
--     (wired in the follow-on sprint once his vocabulary returns).
--
--   semantic.business_glossary — security_invoker union catalog shaped for an agent:
--     (entity_type, entity_key, canonical_name, alias, source, notes). Phrases surface as
--     entity_type 'phrase:<category>'.
--
--   core.seed_business_terms() — idempotent: DELETE where source in ('seed','derived') then
--     re-insert FROM THE HUB ITSELF (dim_product, dim_customer, dim_grower, dim_shed, the scan
--     segments/geographies, the GP+NS charge taxonomy, the governed Cube metric contracts, the
--     0047 mart measures via information_schema — guarded, so seeding works before/after Part 1
--     integrates). ON CONFLICT DO NOTHING everywhere → a Tim row with the same id is never
--     touched. Derived aliases are MECHANICAL only (suffix strips, underscore/space/plural
--     variants) — business slang is Tim's job, harvested by scripts/nl_glossary_tool.ts.
--     Called once at the end of this migration; re-run any time with
--     `select core.seed_business_terms();` (e.g. after a dim refresh).
--
-- Posture: INTERNAL-ONLY (the 0040 pattern — the glossary names customers and metrics; the
-- customer list is commercially sensitive). RLS fail-closed to semantic.is_internal_claim() +
-- cube_readonly read-all. Registered in scripts/rls_posture.ts.

-- ═══════════════════════════════════════════════════════════════════════════
-- core.business_term
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.business_term (
  id             text primary key,        -- = entity_type||'|'||entity_key||'|'||lower(alias)
  entity_type    text not null,           -- product/customer/grower/shed/segment/geography/charge_category/metric/period (documented, never an enum)
  entity_key     text not null,           -- see the namespace table above; no '|' allowed
  canonical_name text,                    -- the hub's own name for the entity
  alias          text not null,           -- what the business CALLS it (grain: lower(alias))
  source         text not null,           -- seed / derived / tim (documented, never an enum)
  notes          text,
  _synced_at     timestamptz not null default now(),
  constraint business_term_id_convention
    check (id = entity_type || '|' || entity_key || '|' || lower(alias)),
  constraint business_term_no_pipe_keys
    check (position('|' in entity_type) = 0 and position('|' in entity_key) = 0)
);
create index if not exists ix_business_term_alias on core.business_term (lower(alias));
create index if not exists ix_business_term_entity on core.business_term (entity_type, entity_key);
comment on table core.business_term is
  'NL glossary: business alias → hub entity, grain (entity_type × entity_key × lower(alias)). source seed/derived = re-derivable from the hub (core.seed_business_terms()); source tim = harvested vocabulary (nl:load), never touched by the seed. INTERNAL-ONLY.';
comment on column core.business_term.entity_key is
  'Namespaced key: uuids for product/customer/grower/shed; segment/geography codes; gp:/ns:/gp_charge:/ns_item: for charges; <view>.<measure> for metrics; FY codes for periods.';

-- ═══════════════════════════════════════════════════════════════════════════
-- core.nl_phrase
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.nl_phrase (
  id         text primary key,            -- = category||'|'||lower(phrase)
  category   text not null,               -- units/time/roles/questions/general (documented, never an enum)
  phrase     text not null,               -- the business-language phrase, verbatim
  meaning    text,                        -- what it means in plain English
  mapping    text,                        -- hub object/expression it maps to (null until wired)
  source     text not null,               -- seed / derived / tim
  notes      text,
  _synced_at timestamptz not null default now(),
  constraint nl_phrase_id_convention check (id = category || '|' || lower(phrase)),
  constraint nl_phrase_no_pipe_category check (position('|' in category) = 0)
);
comment on table core.nl_phrase is
  'NL glossary: free-form phrase → meaning/mapping (units, time expressions, roles, plain-English questions, general jargon). source tim = the engagement tool''s harvest (nl:load); mapping is wired in the follow-on sprint. INTERNAL-ONLY.';

-- ── RLS: INTERNAL-ONLY (fail-closed) + cube read-all — the 0040 pattern ──────
alter table core.business_term enable row level security;
alter table core.nl_phrase     enable row level security;
grant select on core.business_term, core.nl_phrase to authenticated;

drop policy if exists internal_only_business_term on core.business_term;
create policy internal_only_business_term on core.business_term
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_nl_phrase on core.nl_phrase;
create policy internal_only_nl_phrase on core.nl_phrase
  for select to authenticated using (semantic.is_internal_claim());

grant select on core.business_term, core.nl_phrase to cube_readonly;
drop policy if exists cube_readonly_read_all on core.business_term;
create policy cube_readonly_read_all on core.business_term for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on core.nl_phrase;
create policy cube_readonly_read_all on core.nl_phrase for select to cube_readonly using (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- semantic.business_glossary — the agent catalog (union of both tables)
-- ═══════════════════════════════════════════════════════════════════════════
-- security_invoker → the caller's own RLS on business_term/nl_phrase gates it (internal-only,
-- fail-closed): an internal claim sees the whole glossary, a grower JWT sees ZERO rows.
create or replace view semantic.business_glossary
  with (security_invoker = true) as
select entity_type, entity_key, canonical_name, alias, source, notes
from core.business_term
union all
select 'phrase:' || category as entity_type,
       id                    as entity_key,
       coalesce(mapping, meaning) as canonical_name,
       phrase                as alias,
       source,
       notes
from core.nl_phrase;
grant select on semantic.business_glossary to authenticated, cube_readonly;
comment on view semantic.business_glossary is
  'The NL glossary catalog for agents: alias → (entity_type, entity_key, canonical_name). Entities from core.business_term; phrases surface as entity_type ''phrase:<category>''. INTERNAL-ONLY via security_invoker (grower JWT sees 0 rows).';

-- ═══════════════════════════════════════════════════════════════════════════
-- core.seed_business_terms() — idempotent hub-derived seed
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.seed_business_terms() returns integer
language plpgsql set search_path = '' as $func$
declare n integer := 0; rc integer;
begin
  -- Re-derivable rows only. Tim's vocabulary (source='tim') is NEVER deleted, and every insert
  -- below is ON CONFLICT DO NOTHING so an existing tim row with the same id is never overwritten.
  delete from core.business_term where source in ('seed', 'derived');
  delete from core.nl_phrase     where source in ('seed', 'derived');

  -- ── products: every dim_product row — name + code (seed) ──────────────────
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'product|' || p.product_id::text || '|' || lower(a.alias),
         'product', p.product_id::text, coalesce(p.name, p.code), a.alias, a.src,
         nullif(concat_ws(' · ',
           'code ' || p.code,
           'crop ' || p.crop_name,
           'variety ' || p.variety_name,
           'pack ' || p.pack_type_name,
           case when p.count is not null then p.count::text || ' count' end,
           case when p.net_weight_value is not null
                then trim(to_char(p.net_weight_value, 'FM999999990.###')) || ' ' || lower(coalesce(p.net_weight_unit, 'kg')) end,
           case when p.is_organic then 'organic' end,
           case when p.is_active = false then 'INACTIVE' end), '')
  from core.dim_product p
  cross join lateral (values (p.name, 'seed'), (p.code, 'seed')) a(alias, src)
  where nullif(btrim(a.alias), '') is not null
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── customers: name + entity_code (seed) + suffix-stripped short form (derived) ──
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'customer|' || c.consignee_id::text || '|' || lower(a.alias),
         'customer', c.consignee_id::text, c.name, a.alias, a.src,
         nullif(concat_ws(' · ',
           'code ' || nullif(btrim(c.entity_code), ''),
           'b2b ' || nullif(btrim(c.b2b_code), ''),
           case when c.is_active = false then 'INACTIVE' end), '')
  from core.dim_customer c
  cross join lateral (values
    (c.name, 'seed'),
    (c.entity_code, 'seed'),
    -- mechanically obvious short form: company suffix stripped (only when it differs)
    (nullif(btrim(regexp_replace(c.name,
       '\s+(pty\.?\s+ltd\.?|pty\s+limited|proprietary\s+limited|p/l|limited|ltd\.?)\s*$', '', 'i')),
     btrim(c.name)), 'derived')
  ) a(alias, src)
  where nullif(btrim(a.alias), '') is not null
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── growers: code + org_name (seed) + suffix strip (derived); test consignors excluded ──
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'grower|' || g.consignor_id::text || '|' || lower(a.alias),
         'grower', g.consignor_id::text, coalesce(g.org_name, g.code), a.alias, a.src,
         nullif(concat_ws(' · ',
           'code ' || g.code,
           case when g.is_active = false then 'INACTIVE' end), '')
  from core.dim_grower g
  cross join lateral (values
    (g.code, 'seed'),
    (g.org_name, 'seed'),
    (nullif(btrim(regexp_replace(g.org_name,
       '\s+(pty\.?\s+ltd\.?|pty\s+limited|proprietary\s+limited|p/l|limited|ltd\.?)\s*$', '', 'i')),
     btrim(g.org_name)), 'derived')
  ) a(alias, src)
  where coalesce(g.is_test, false) = false
    and nullif(btrim(a.alias), '') is not null
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── sheds: core.dim_shed rows (seed) ───────────────────────────────────────
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'shed|' || s.shed_id::text || '|' || lower(s.shed_name),
         'shed', s.shed_id::text, s.shed_name, s.shed_name, 'seed', null
  from core.dim_shed s
  where nullif(btrim(s.shed_name), '') is not null
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── scan segments: canonical (seed) + mechanical variants (derived) ────────
  -- Variants are MECHANICAL forms of the source names ('PRE PACK BANANAS', 'LADY FINGER', …):
  -- underscore/space/hyphen/concatenated + simple plural. No invented slang (that is Tim's job).
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'segment|' || v.key || '|' || lower(v.alias),
         'segment', v.key, v.canon, v.alias, v.src,
         'Coles scan banana segment (core.fact_retail_scan.segment).'
  from (values
    ('ALL',         'All bananas (category total)', 'ALL',              'seed'),
    ('ALL',         'All bananas (category total)', 'all bananas',      'derived'),
    ('ALL',         'All bananas (category total)', 'bananas',          'derived'),
    ('ALL',         'All bananas (category total)', 'total bananas',    'derived'),
    ('REGULAR',     'Regular bananas',              'REGULAR',          'seed'),
    ('REGULAR',     'Regular bananas',              'regular bananas',  'derived'),
    ('PRE_PACK',    'Pre-pack bananas',             'PRE_PACK',         'seed'),
    ('PRE_PACK',    'Pre-pack bananas',             'pre pack',         'derived'),
    ('PRE_PACK',    'Pre-pack bananas',             'pre-pack',         'derived'),
    ('PRE_PACK',    'Pre-pack bananas',             'prepack',          'derived'),
    ('PRE_PACK',    'Pre-pack bananas',             'pre pack bananas', 'derived'),
    ('LADY_FINGER', 'Lady finger bananas',          'LADY_FINGER',      'seed'),
    ('LADY_FINGER', 'Lady finger bananas',          'lady finger',      'derived'),
    ('LADY_FINGER', 'Lady finger bananas',          'lady fingers',     'derived'),
    ('LADY_FINGER', 'Lady finger bananas',          'lady-finger',      'derived'),
    ('LADY_FINGER', 'Lady finger bananas',          'ladyfinger',       'derived'),
    ('OTHER',       'Other bananas',                'OTHER',            'seed'),
    ('OTHER',       'Other bananas',                'other bananas',    'derived')
  ) v(key, canon, alias, src)
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── scan geographies: the 7 codes (seed) + standard AU state names (seed) ──
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'geography|' || v.key || '|' || lower(v.alias),
         'geography', v.key, v.canon, v.alias, 'seed',
         'Coles scan geography (core.fact_retail_scan.geography_code).'
  from (values
    ('AU',      'Australia (Coles national)', 'AU'), ('AU', 'Australia (Coles national)', 'australia'),
    ('AU',      'Australia (Coles national)', 'national'),
    ('NSW+ACT', 'NSW + ACT',                  'NSW+ACT'), ('NSW+ACT', 'NSW + ACT', 'nsw + act'),
    ('NSW+ACT', 'NSW + ACT',                  'nsw'), ('NSW+ACT', 'NSW + ACT', 'act'),
    ('NSW+ACT', 'NSW + ACT',                  'new south wales'),
    ('NSW+ACT', 'NSW + ACT',                  'australian capital territory'),
    ('QLD',     'Queensland',                 'QLD'), ('QLD', 'Queensland', 'queensland'),
    ('SA+NT',   'SA + NT',                    'SA+NT'), ('SA+NT', 'SA + NT', 'sa + nt'),
    ('SA+NT',   'SA + NT',                    'sa'), ('SA+NT', 'SA + NT', 'nt'),
    ('SA+NT',   'SA + NT',                    'south australia'), ('SA+NT', 'SA + NT', 'northern territory'),
    ('TAS',     'Tasmania',                   'TAS'), ('TAS', 'Tasmania', 'tasmania'),
    ('VIC',     'Victoria',                   'VIC'), ('VIC', 'Victoria', 'victoria'),
    ('WA',      'Western Australia',          'WA'), ('WA', 'Western Australia', 'western australia')
  ) v(key, canon, alias)
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── charge categories: GP + NS taxonomy (seed) — the LA divergence documented ──
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'charge_category|' || v.key || '|' || lower(v.alias),
         'charge_category', v.key, v.canon, v.alias, 'seed', v.note
  from (values
    ('gp:FR', 'Freight (GP)',            'FR',                'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:FR', 'Freight (GP)',            'freight',           'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:WH', 'Warehouse (GP)',          'WH',                'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:WH', 'Warehouse (GP)',          'warehouse',         'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:MD', 'Market Deductions (GP)',  'MD',                'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:MD', 'Market Deductions (GP)',  'market deductions', 'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:MI', 'Misc (GP)',               'MI',                'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:MI', 'Misc (GP)',               'misc',              'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:MI', 'Misc (GP)',               'miscellaneous',     'FreshTrack GP deduction category (core.dim_gp_charge).'),
    ('gp:LA', 'Load Adjustment (GP)',    'LA',                '⚠ GP LA = Load Adjustment (account 5xxxxx) — NOT NetSuite''s LA = Larapinta. Shared code, different meaning (documented in CLAUDE.md).'),
    ('gp:LA', 'Load Adjustment (GP)',    'load adjustment',   '⚠ GP LA = Load Adjustment — NOT NetSuite''s LA = Larapinta.'),
    ('gp:OTHER', 'Other (GP)',           'other',             'Unclassified GP charges — surfaced, never dropped.'),
    ('ns:FR', 'Freight (NetSuite)',            'FR',                'NetSuite RCTI charge category (core.dim_ns_charge, itemid 1xxxxx).'),
    ('ns:FR', 'Freight (NetSuite)',            'freight',           'NetSuite RCTI charge category (core.dim_ns_charge, itemid 1xxxxx).'),
    ('ns:WH', 'Warehouse (NetSuite)',          'WH',                'NetSuite RCTI charge category (itemid 2xxxxx).'),
    ('ns:WH', 'Warehouse (NetSuite)',          'warehouse',         'NetSuite RCTI charge category (itemid 2xxxxx).'),
    ('ns:MD', 'Market Deductions (NetSuite)',  'MD',                'NetSuite RCTI charge category (itemid 3xxxxx).'),
    ('ns:MD', 'Market Deductions (NetSuite)',  'market deductions', 'NetSuite RCTI charge category (itemid 3xxxxx).'),
    ('ns:MI', 'Misc (NetSuite)',               'MI',                'NetSuite RCTI charge category (itemid 4xxxxx).'),
    ('ns:MI', 'Misc (NetSuite)',               'misc',              'NetSuite RCTI charge category (itemid 4xxxxx).'),
    ('ns:LA', 'Larapinta (NetSuite)',          'LA',                '⚠ NetSuite LA = Larapinta (itemid 591xxx, a full parallel sales+charge set) — NOT FreshTrack GP''s LA = Load Adjustment.'),
    ('ns:LA', 'Larapinta (NetSuite)',          'larapinta',         '⚠ NetSuite LA = Larapinta — NOT FreshTrack GP''s LA = Load Adjustment.'),
    ('ns:PRODUCT', 'Product (NetSuite)',       'product',           'NetSuite gross-sale produce items (itemid 9xxxxx: 910 banana / 920 papaya / 930 avocado / 960 passionfruit).'),
    ('ns:OTHER', 'Other (NetSuite)',           'other',             'Unclassified NetSuite items — surfaced, never dropped.')
  ) v(key, canon, alias, note)
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── metrics: the governed Cube contracts (seed name + derived spaced variant) ──
  -- Names + plain definitions from cube/CONTRACTS.md + cube/model/views/*.yml. ADDITIVE-ONLY,
  -- like the contracts themselves. Must stay in sync with the METRICS list in
  -- scripts/nl_glossary_tool.ts (its fallback when this seed has not run).
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'metric|' || v.key || '|' || lower(a.alias),
         'metric', v.key, v.key, a.alias, a.src, v.def
  from (values
    ('dispatch.load_count',                    'How many loads we dispatched (Sell only, actual pickup recorded).'),
    ('dispatch.pallet_count',                  'How many pallets were on dispatched Sell loads.'),
    ('dispatch.net_weight_dispatched',         'Total kg dispatched (pallet net weights; missing weights left out, never counted as zero).'),
    ('dispatch.line_count',                    'How many load × product lines were dispatched.'),
    ('dispatch.pallets_with_net_weight',       'Pallets that carry a recorded net weight (capture-rate numerator).'),
    ('dispatch.net_weight_capture_rate',       'Share of pallets with a recorded net weight.'),
    ('dispatch_shipped.shipped_load_count',    'Loads that reached Shipped-or-later (the ops shipped definition), Sell only.'),
    ('dispatch_shipped.boxes_packed',          'Boxes packed = own-stock boxes + reconsigned boxes (the portal''s "Boxes Packed").'),
    ('dispatch_shipped.pallet_count_shipped',  'Pallets on Shipped-or-later Sell loads.'),
    ('dispatch_shipped.net_weight_shipped',    'Total kg on Shipped-or-later pallets (missing weights left out).'),
    ('settlement.rcti_count',                  'How many grower RCTIs (NetSuite settlement bills).'),
    ('settlement.gross_sales',                 'Grower gross sales on RCTIs (product lines — money to the grower).'),
    ('settlement.total_deductions',            'All deductions on RCTIs (signed negative).'),
    ('settlement.freight_deductions',          'Freight deductions on RCTIs (signed).'),
    ('settlement.warehouse_deductions',        'Warehouse deductions on RCTIs (signed).'),
    ('settlement.market_deductions',           'Market deductions on RCTIs (signed).'),
    ('settlement.larapinta_deductions',        'Larapinta deductions on RCTIs (signed; NetSuite LA = Larapinta).'),
    ('settlement.misc_deductions',             'Misc deductions on RCTIs (signed).'),
    ('settlement.tax_total',                   'GST on RCTIs.'),
    ('settlement.net_paid',                    'What the grower receives on RCTIs (gross + deductions + GST).'),
    ('settlement.paid_rcti_count',             'RCTIs with a payment applied.'),
    ('settlement.unpaid_rcti_count',           'RCTIs without a payment applied (null paid_date, never zero-dated).'),
    ('gp_settlement.gp_schedule_count',        'How many FreshTrack grower-pool settlement schedules.'),
    ('gp_settlement.gp_gross_sales',           'Grower gross on GP schedules (boxes × invoiced price).'),
    ('gp_settlement.gp_total_deductions',      'All GP deductions (signed).'),
    ('gp_settlement.gp_freight_deductions',    'GP Freight deductions (signed).'),
    ('gp_settlement.gp_warehouse_deductions',  'GP Warehouse deductions (signed).'),
    ('gp_settlement.gp_market_deductions',     'GP Market deductions (signed).'),
    ('gp_settlement.gp_larapinta_deductions',  'GP LA-bucket deductions (⚠ Load Adjustment in FreshTrack; the measure keeps the shared LA code for cross-source alignment).'),
    ('gp_settlement.gp_misc_deductions',       'GP Misc deductions (signed).'),
    ('gp_settlement.gp_other_deductions',      'GP unclassified deductions (signed; surfaced, never dropped).'),
    ('gp_settlement.gp_gst',                   'GST on GP deductions (from vat_info: EX ×0.10 / INC ×1/11 / FREE 0).'),
    ('gp_settlement.gp_net_paid',              'Grower net on GP schedules (gross − deductions − GST).'),
    ('gp_settlement.gp_paid_amount',           'Cash actually paid on GP schedules (gp_payment — the anchor).'),
    ('gp_settlement.gp_paid_schedule_count',   'GP schedules with a payment.'),
    ('gp_settlement.gp_unpaid_schedule_count', 'GP schedules without a payment (null paid_date, never zero-dated).'),
    ('gp_settlement_load.gp_load_count',       'Settled schedule × load rows — settlement at LOAD grain (the lineage NetSuite cannot provide).'),
    ('gp_settlement_load.gp_load_gross_sales', 'Grower gross at load grain.'),
    ('gp_settlement_load.gp_load_total_deductions', 'GP deductions at load grain (signed).'),
    ('gp_settlement_load.gp_load_net_paid',    'Grower net at load grain.'),
    ('retail.observation_count',               'Day-grain shelf-price observations (retail price reporter).'),
    ('retail.avg_price',                       'Average shelf price (AUD), missing prices left out.'),
    ('retail.min_price',                       'Lowest shelf price observed (AUD).'),
    ('retail.max_price',                       'Highest shelf price observed (AUD).'),
    ('retail.promo_observations',              'Shelf observations on promotion (badge, multibuy or was-price).')
  ) v(key, def)
  cross join lateral (values
    (split_part(v.key, '.', 2), 'seed'),
    (replace(split_part(v.key, '.', 2), '_', ' '), 'derived')
  ) a(alias, src)
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── metrics: the 0047 insight-mart measures, derived LIVE from information_schema ──
  -- Guarded by to_regclass so this seed works whether or not Part 1 has integrated yet; re-run
  -- `select core.seed_business_terms();` after 0047 lands to pick the mart measures up.
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'metric|' || v.relname || '.' || c.column_name || '|' || lower(a.alias),
         'metric', v.relname || '.' || c.column_name,
         v.relname || '.' || c.column_name, a.alias, 'derived',
         'Numeric measure on semantic.' || v.relname || ' (insight mart, migration 0047).'
  from (values ('market_week'), ('customer_margin'), ('grower_scorecard'), ('retail_supplier_share')) v(relname)
  join information_schema.columns c
    on c.table_schema = 'semantic' and c.table_name = v.relname
   and c.data_type in ('numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint')
  cross join lateral (values (c.column_name), (replace(c.column_name, '_', ' '))) a(alias)
  where to_regclass('semantic.' || v.relname) is not null
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── periods: AU fiscal years present in core.dim_date (derived) ────────────
  insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes)
  select 'period|' || f.fy || '|' || lower(a.alias),
         'period', f.fy,
         f.fy || ' (Jul ' || (f.yr - 1)::text || ' - Jun ' || f.yr::text || ')',
         a.alias, 'derived',
         'Australian financial year, named by ENDING year (core.dim_date.au_fiscal_year).'
  from (select distinct au_fiscal_year as fy, 2000 + right(au_fiscal_year, 2)::int as yr
        from core.dim_date) f
  cross join lateral (values
    (f.fy),
    ('fy ' || right(f.fy, 2)),
    ((f.yr - 1)::text || '/' || right(f.fy, 2)),
    ((f.yr - 1)::text || '-' || right(f.fy, 2))
  ) a(alias)
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  -- ── nl_phrase seeds: hub conventions an agent must know (all mechanical/hub-documented) ──
  insert into core.nl_phrase (id, category, phrase, meaning, mapping, source, notes)
  values
    ('time|pack week code', 'time', 'pack week code',
     'FreshTrack pack-week code Y{yy}W{ww} (e.g. Y25W31) = ISO year/week of the load''s SCHEDULED pickup date (98.9% verified) — not the pack date.',
     'core.dim_date.pack_week_code', 'seed', 'SPEC §9.5; verified 2026-07-11 (migration 0034).'),
    ('time|week ending (scan)', 'time', 'week ending (scan)',
     'Coles scan weeks end TUESDAY. Align dispatch/GP dates by date-range membership (week_ending−6 .. week_ending), never by ISO-week equality.',
     'core.fact_retail_scan.week_ending', 'seed', 'SPRINT 2026-07-12 alignment finding.'),
    ('time|financial year', 'time', 'financial year',
     'Australian financial year Jul–Jun, named by the ENDING year: FY26 = Jul 2025 – Jun 2026.',
     'core.dim_date.au_fiscal_year', 'seed', null),
    ('units|boxes packed', 'units', 'boxes packed',
     'Boxes packed = own-stock boxes + reconsigned boxes (the portal definition) — never pallet.box_count alone.',
     'dispatch_shipped.boxes_packed', 'seed', 'cube/CONTRACTS.md dispatch_shipped contract.')
  on conflict (id) do nothing;
  get diagnostics rc = row_count; n := n + rc;

  return n;
end $func$;
comment on function core.seed_business_terms() is
  'Idempotent NL glossary seed: deletes source seed/derived, re-derives canonical names + mechanical aliases from the hub itself (dims, scan values, charge taxonomy, Cube metric contracts, 0047 mart columns via information_schema — guarded). Never touches source=tim rows (nl:load). Re-run after dim refreshes or after 0047 integrates.';

-- Seed now (idempotent; the dims it reads are live). Re-run any time.
select core.seed_business_terms();
