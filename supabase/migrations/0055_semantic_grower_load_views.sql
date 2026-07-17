-- 0055_semantic_grower_load_views — FIX 2 + FIX 4 + FIX 5 + FIX 6 of the grower-portal fix pack
-- (2026-07-18): clean product labels, the load-grain dispatch view with Tim's four consignment
-- statuses, and the grower-readable retailer/sales view over core.fact_load_sale (0054).
--
-- FIX 2 — product labels: raw.ft_pallet.product_description carries FreshTrack display format
--   codes (SPEC §9.7 — "parse, don't display raw"): '^{b}^{c blue}[30]^{cl} Banana… - WOW'.
--   131k of 210k pallet rows carry codes; 79k are empty strings. Cleaned IN THE SEMANTIC VIEWS
--   (raw lands faithfully — the invariant): strip ^{...} runs, strip the leading [N] token,
--   empty → fall back to variety, then crop. 484 in-scope pallets have NO product/variety/crop
--   at all → product stays NULL (surfaced, never invented; 0 of them belong to the portal test
--   pair). Trailing retailer hints ("- WOW") are KEPT until a structured retailer field fully
--   replaces them (fact_load_sale covers invoiced loads only). The verbatim string is APPENDED
--   as product_raw. semantic.clean_product_label() is the single shared expression.
--
-- FIX 4 — load grain: the portal was downloading ~3,700 pallet rows to render ~238 loads.
--   semantic.grower_dispatch_load = one row per load over grower_dispatch_shipped (same shipped
--   gate, same RLS chain — security_invoker all the way down), non-archived pallets only.
--
-- FIX 6 — consignment_status, Tim's grower-facing lifecycle (replaces the five dispatch states
--   and the PD/PA codes on the portal):
--     'Not Consigned' — dispatched from the farm (Shipped+), no connote number yet
--     'Consigned'     — connote present, not yet invoiced
--     'Sold'          — customer invoiced
--     'Paid'          — the grower is paid for the ENTIRE consignment
--   Connote = raw.ft_dispatch_load.manifest_no — FreshTrack has NO connote column anywhere (the
--   replica was searched); manifest_no carries the carrier consignment numbers and is 100%
--   populated on the test pair's shipped loads. Sold = FreshTrack says invoicing is complete
--   (state seq >= 10 — the closest computable signal for "fully invoiced" on multi-customer
--   loads) OR a landed invoice exists OR the load is in a settlement schedule. Paid = every
--   settlement schedule covering the load is PD (the cash evidence wins); loads with NO landed
--   settlement lineage (GP data starts 2025-06) fall back to lifecycle state Paid/Closed
--   (seq >= 13). All signals are exposed as columns so every status count is explainable.
--
-- FIX 5/7.2 — semantic.grower_load_sale: one row per (load, customer) with retailer_group and
--   that customer's share of gross — joins grower_gp_settlement_load on dispatch_load_id for
--   the settlement drill-down. consignee identity is NOT exposed (retailer group only).

-- ── The shared product-cleaning expression (FIX 2) ─────────────────────────────────────────────
create or replace function semantic.clean_product_label(product text, variety text, crop text)
returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    nullif(btrim(regexp_replace(regexp_replace(coalesce(product, ''),
      '\^\{[^}]*\}', '', 'g'),      -- ^{...} display control codes
      '^\s*\[\d+\]\s*', '')), ''),  -- leading [N] token left behind by the codes
    nullif(btrim(variety), ''),
    nullif(btrim(crop), '')
  )
$$;
comment on function semantic.clean_product_label(text, text, text) is
  'FreshTrack display-format cleanup (SPEC §9.7): strips ^{...} codes + the leading [N] token; empty → variety → crop → null. Pure; used by grower_dispatch_detail/shipped (0055). Trailing "- WOW"-style retailer hints kept deliberately.';

-- ── grower_dispatch_detail (LIVE 0008+0022 shape, incl. origin shed): product cleaned in place;
--    product_raw appended after origin_shed_name (the live column tail) ──────────────────────────
create or replace view semantic.grower_dispatch_detail
  with (security_invoker = true) as
select
  d.consignor_id              as grower_key,          -- = consignor_id; NOT harvest_load_id
  d.actual_pickup_on::date    as dispatched_on,
  d.actual_pickup_on          as dispatched_at,
  d.pack_date,
  d.extra_text_2              as pack_week,            -- Y{YY}W{WW}
  d.load_no,
  p.id                        as pallet_id,
  p.pallet_no,
  p.crop_description          as crop,
  p.variety_description       as variety,
  semantic.clean_product_label(p.product_description, p.variety_description, p.crop_description)
                              as product,             -- cleaned (0055); verbatim in product_raw
  p.box_count                 as boxes,
  p.net_weight_value          as net_weight,          -- nullable, NOT coalesced
  p.net_weight_unit           as net_weight_unit,
  p.is_field,
  p.is_archived,
  p.shed_id                   as origin_shed_id,      -- 0022
  sh.shed_name                as origin_shed_name,    -- 0022
  p.product_description       as product_raw          -- verbatim source string (may carry ^{...})
from raw.ft_pallet p
join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
join core.dim_grower g      on g.consignor_id = d.consignor_id
left join core.dim_shed sh  on sh.shed_id = p.shed_id
where d.actual_pickup_on is not null
  and coalesce(g.is_test, false) = false;

comment on view semantic.grower_dispatch_detail is
  'Grower-scoped dispatch detail at pallet grain. RLS via JWT claim consignor_id. grower_key = load consignor (not harvest_load_id). net_weight nullable, never coalesced. 0055: product cleaned (clean_product_label); verbatim kept in product_raw.';

-- ── grower_dispatch_shipped (0021 shape): product cleaned in place; product_raw appended ───────
create or replace view semantic.grower_dispatch_shipped
  with (security_invoker = true) as
select
  d.consignor_id                                            as grower_key,        -- = consignor_id (RLS anchor)
  d.id                                                      as load_id,           -- for exact distinct-load counts
  coalesce(d.actual_pickup_on, d.scheduled_pickup_on)::date as dispatched_on,      -- effective date: actual, else scheduled
  coalesce(d.actual_pickup_on, d.scheduled_pickup_on)       as dispatched_at,
  d.actual_pickup_on,                                                              -- raw actual kept (nullable) for transparency
  d.scheduled_pickup_on,                                                           -- raw scheduled kept for transparency
  st.code                                                   as dispatch_state,     -- lifecycle state (SH/IT/DE/…)
  st.name                                                   as dispatch_state_name,
  st.sequence                                               as dispatch_state_seq,
  d.pack_date,
  d.extra_text_2                                            as pack_week,           -- Y{YY}W{WW}
  d.load_no,
  p.id                                                      as pallet_id,
  p.pallet_no,
  p.crop_description                                        as crop,
  p.variety_description                                     as variety,
  semantic.clean_product_label(p.product_description, p.variety_description, p.crop_description)
                                                            as product,            -- cleaned (0055); verbatim in product_raw
  (coalesce(p.stock_boxes, 0) + coalesce(p.reconsigned_boxes, 0)) as boxes,        -- corrected: "Boxes Packed" (stock + reconsigned)
  p.box_count                                              as boxes_own_stock,     -- old definition kept for transparency (= stock_boxes)
  p.net_weight_value                                       as net_weight,          -- nullable, NEVER coalesced (SPEC §9.3)
  p.net_weight_unit,
  p.shed_id                                                as origin_shed_id,      -- pallet's OWN packing shed (farm origin), as in 0022
  sh.shed_name                                             as origin_shed_name,
  p.is_field,
  p.is_archived,
  p.product_description                                    as product_raw          -- verbatim source string (may carry ^{...})
from raw.ft_pallet p
join raw.ft_dispatch_load d     on d.id = p.dispatch_load_id
join core.dim_dispatch_state st on st.state_id = d.state_id
join core.dim_grower g          on g.consignor_id = d.consignor_id
left join core.dim_shed sh      on sh.shed_id = p.shed_id
where st.sequence >= 5                 -- ◀── SHIPPED GATE: Shipped-or-later. SINGLE ops-tunable line (raise to 7=Delivered, 10=Invoiced, …).
  and d.order_type = 'S'               -- Sell loads only (baked-in; mirrors the governed dispatch contract)
  and coalesce(g.is_test, false) = false;

comment on view semantic.grower_dispatch_shipped is
  'ADDITIVE shipped-state dispatch detail (pallet grain). dispatched = dim_dispatch_state.sequence >= 5 (Shipped+, single tunable gate); dispatched_on = coalesce(actual,scheduled) pickup; boxes = stock_boxes + reconsigned_boxes (portal "Boxes Packed"). Sell loads only, non-test. grower_key = load consignor (RLS anchor). RLS = same security_invoker + app_metadata-only fail-closed contract as grower_dispatch_detail (0008/0010). 0055: product cleaned (clean_product_label); verbatim kept in product_raw.';

-- ── FIX 4 + FIX 6: the load-grain dispatch view with consignment_status ────────────────────────
-- security_invoker over grower-readable relations ONLY: grower_dispatch_shipped (RLS chain 0008/
-- 0010/0026/0050), raw.ft_dispatch_load (grower-scoped), core.dim_dispatch_state (shared
-- reference), core.fact_gp_settlement[_load] (grower-scoped), core.fact_load_sale (grower-scoped,
-- 0054). No internal-only relation is touched — the retailer projection was denormalised in 0054.
create or replace view semantic.grower_dispatch_load
  with (security_invoker = true) as
with pal as (
  select
    grower_key,
    load_id,
    load_no,
    max(dispatched_on)  as dispatched_on,
    max(pack_week)      as pack_week,
    count(*)            as pallet_count,
    sum(boxes)          as boxes,
    sum(net_weight)     as net_weight_kg,   -- SUM skips nulls; NEVER coalesced (SPEC §9.3)
    array_agg(distinct product) filter (where product is not null) as products
  from semantic.grower_dispatch_shipped
  where not is_archived
  group by grower_key, load_id, load_no
),
settle as (
  select
    sl.dispatch_load_id,
    count(distinct sl.schedule_id)   as settlement_schedule_count,
    bool_and(fs.paid_status = 'PD')  as settlement_all_paid,   -- Tim: "paid for the ENTIRE consignment"
    max(fs.paid_date)                as settlement_paid_date
  from core.fact_gp_settlement_load sl
  join core.fact_gp_settlement fs on fs.schedule_id = sl.schedule_id
  group by sl.dispatch_load_id
),
sale as (
  select
    dispatch_load_id,
    sum(invoice_count)               as invoice_count,
    round(sum(gross_amount), 2)      as sale_gross,
    array_agg(distinct retailer_group) filter (where retailer_group is not null) as retailer_groups
  from core.fact_load_sale
  group by dispatch_load_id
)
select
  pal.grower_key,
  pal.load_id,
  pal.load_no,
  pal.dispatched_on,
  pal.pack_week,
  pal.pallet_count,
  pal.boxes,
  pal.net_weight_kg,
  pal.products,
  st.code                                        as dispatch_state,
  st.name                                        as dispatch_state_name,
  st.sequence                                    as dispatch_state_seq,
  nullif(btrim(coalesce(d.manifest_no, '')), '') as connote_no,        -- the "connote" (see header)
  (sale.dispatch_load_id is not null)            as has_invoice,       -- landed invoice records exist
  sale.invoice_count,
  sale.sale_gross,
  sale.retailer_groups,                                                -- FIX 5: e.g. {woolworths}
  settle.settlement_schedule_count,
  settle.settlement_all_paid,
  settle.settlement_paid_date,
  case
    when coalesce(settle.settlement_all_paid, false)
      or (settle.dispatch_load_id is null and st.sequence >= 13)       then 'Paid'
    when st.sequence >= 10
      or sale.dispatch_load_id is not null
      or settle.dispatch_load_id is not null                           then 'Sold'
    when nullif(btrim(coalesce(d.manifest_no, '')), '') is not null    then 'Consigned'
    else                                                                    'Not Consigned'
  end                                            as consignment_status -- Tim's four-state grower lifecycle (FIX 6)
from pal
join raw.ft_dispatch_load d     on d.id = pal.load_id
join core.dim_dispatch_state st on st.state_id = d.state_id
left join settle on settle.dispatch_load_id = pal.load_id
left join sale   on sale.dispatch_load_id   = pal.load_id;

grant select on semantic.grower_dispatch_load to authenticated, cube_readonly;

comment on view semantic.grower_dispatch_load is
  'Load-grain dispatch surface (one row per shipped load, non-archived pallets) over grower_dispatch_shipped — same shipped gate + RLS chain. consignment_status = Tim''s grower lifecycle: Not Consigned (no connote = manifest_no) / Consigned / Sold (state>=Invoiced OR landed invoice OR in a settlement schedule) / Paid (ALL settlement schedules PD; state>=Paid fallback where GP lineage predates the landing). Every signal exposed as a column. FIX 4+6 of the grower-portal fix pack (0055).';

-- ── FIX 5 + FIX 7.2: the grower-readable retailer/sales view (load × customer grain) ──────────
-- consignee identity is NOT exposed — retailer_group only (Tim-approved surface). Joins
-- grower_gp_settlement_load on dispatch_load_id for the per-load settlement drill-down.
create or replace view semantic.grower_load_sale
  with (security_invoker = true) as
select
  f.consignor_id        as grower_key,       -- = load consignor (RLS anchor)
  f.dispatch_load_id,
  f.load_no,
  f.retailer_group,                          -- woolworths / coles / aldi / other / internal; null = unmapped (surfaced)
  f.state_code,
  f.invoice_count,
  f.gross_amount,                            -- signed: CN credits subtract
  f.share_of_load_gross,                     -- this customer's share of the load total (multi-customer loads)
  f.first_invoice_date,
  f.last_invoice_date
from core.fact_load_sale f
join core.dim_grower g on g.consignor_id = f.consignor_id
where coalesce(g.is_test, false) = false;

grant select on semantic.grower_load_sale to authenticated, cube_readonly;

comment on view semantic.grower_load_sale is
  'Invoiced sales per dispatch load × customer, grower-readable: retailer_group (never the customer identity) + gross + share of load. One row per (load, retailer/customer) — multi-customer loads split per the FIX 5 spec. security_invoker over core.fact_load_sale (grower-scoped, 0054). Join grower_gp_settlement_load on dispatch_load_id for deductions per category (FIX 7).';
