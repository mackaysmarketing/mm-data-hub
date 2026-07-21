-- 0061_grower_archived_loads_and_origin — the archived-pallet load fix + settlement origin lineage
-- (2026-07-21). Answers the grower-portal ask "why are those dispatch loads missing from the view —
-- archived, filtered, or a genuine gap?" and its follow-on "expose origin_load_no directly".
--
-- NB numbering: 0060 is RESERVED (CLAUDE.md) for dropping the retired grower-portal Auth0 issuer /
-- namespace from the five claim helpers after the tenant cutover. This lands as 0061 so the two
-- changes stay independent of each other's ordering.
--
-- ═══ FINDING 1 — the loads are NOT missing; a pallet filter is deleting them ═══════════════════
-- semantic.grower_dispatch_load (0055) rolls pallets up to load grain over grower_dispatch_shipped
-- with `where not is_archived`. That filter was written to drop pallets REMOVED from a live load.
-- Measured live 2026-07-21, it does almost nothing at pallet grain and everything at LOAD grain:
--
--   shipped Sell loads with pallets      19,205
--     all pallets live                   14,577   ← currently visible
--     ALL pallets archived                4,628   ← the whole load vanishes from the view
--     MIXED (some archived, some live)        3   ← what the filter was actually written for
--
-- is_archived is effectively a LOAD-level flag (3 mixed loads in 19,205), so grouping after the
-- filter silently deletes the load. Every one of the 19,042 settlement lines' origin loads DOES
-- exist in raw.ft_dispatch_load — 0 absent. The portal's "Not linked to a load" bucket
-- (1,577 lines / $11.5m) is this filter, not a landing gap.
--
-- These loads are real, not voided duplicates:
--   · 3,326 of them carry customer invoices totalling  $58,698,021  (29% of all invoiced sales)
--   ·   752 of them carry grower settlement totalling   $8,952,319
--   · all 4,628 have a load_no unique to them — none collides with a live load
--   · only 4.2% are reconsignment ORIGINS (vs 26.1% of live loads) and 2,917 RECEIVED reconsigned
--     boxes — they sit at the END of the reconsignment chain, so counting their boxes cannot
--     double-count against a live load.
--   (pallet_no was NOT used as evidence either way: it is reused across loads — 48,338 pallet_nos
--    appear on more than one load among LIVE pallets alone — so it is not a stable identity.)
--
-- FIX: keep the archived-pallet exclusion for MEASURES (correct on the 3 mixed loads), but stop it
-- deleting the row. Measures come from live pallets; when a load has NO live pallet the load is
-- archived wholesale and its own pallets are the only truth, so the measures fall back to them.
-- `is_archived` is exposed so the portal can badge or filter — the hub does not decide that.
-- Every currently-visible load keeps byte-identical measures (live_* wins whenever live > 0).
--
-- ═══ FINDING 2 — origin lineage, and where it is genuinely ambiguous ═══════════════════════════
-- core.fact_gp_settlement_load is SALE-load grain; 63% of its load_no values are loads the grower
-- never dispatched. The origin is coalesce(original_dispatch_load_id, dispatch_load_id) PER DETAIL
-- ROW. Denormalised here at build time (the 0020/0054 pattern — a grower invoker view must not
-- depend on an RLS'd join that can silently drop rows).
--
-- ⚠ The existing grain cannot always carry ONE origin: of 19,005 (schedule × sale-load) groups,
--   1,158 (6.1%) draw from MORE THAN ONE origin load. origin_load_count states this outright;
--   origin_dispatch_load_id / origin_load_no are NULL when it is > 1 rather than picking a winner.
--   (fact_gp_settlement_load.original_dispatch_load_id has always been a max() over the group —
--   an arbitrary pick. It is left untouched for compatibility; prefer the origin_* columns.)
--   Exact per-origin money needs a sibling fact at origin grain — raw.ft_charge_applied carries
--   original_dispatch_load_id too, so deductions split exactly and nothing needs apportioning.
--   That is a separate, additive change (new relation ⇒ three RLS policies + the pinned sets).

-- ── core: origin lineage denormalised onto the load-grain settlement fact ──────────────────────
alter table core.fact_gp_settlement_load
  add column if not exists origin_dispatch_load_id uuid,
  add column if not exists origin_load_no          text,
  add column if not exists origin_load_count       integer;

comment on column core.fact_gp_settlement_load.origin_dispatch_load_id is
  'The load the GROWER dispatched = coalesce(original_dispatch_load_id, dispatch_load_id) per detail row. NULL when the group draws from >1 origin (see origin_load_count) — never an arbitrary pick.';
comment on column core.fact_gp_settlement_load.origin_load_no is
  'raw.ft_dispatch_load.load_no of origin_dispatch_load_id. NULL when ambiguous. The number the grower actually recognises — dispatch_load_id/load_no are the SALE load, which means nothing to them.';
comment on column core.fact_gp_settlement_load.origin_load_count is
  'Distinct origin loads feeding this (schedule × sale-load) row. 1 = origin_* is exact; >1 = the existing grain cannot carry a single origin (1,158 of 19,005 groups live 2026-07-21).';

create index if not exists ix_fact_gp_settlement_load_origin
  on core.fact_gp_settlement_load (origin_dispatch_load_id);

-- Rebuild, now populating the origin columns. Body otherwise unchanged from 0019.
create or replace function core.refresh_fact_gp_settlement_load() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_gp_settlement_load;
  insert into core.fact_gp_settlement_load (
    schedule_id, dispatch_load_id, consignor_id, detail_consignor_id, original_dispatch_load_id,
    load_no, crop_id, gross_sales, deduction_freight, deduction_warehouse, deduction_market,
    deduction_larapinta, deduction_misc, deduction_other, total_deductions, gst_total,
    net_settlement, detail_line_count, charge_line_count,
    origin_dispatch_load_id, origin_load_no, origin_load_count, _built_at
  )
  with gross as (
    select gp_schedule_id, dispatch_load_id,
           sum(box_quantity * price_invoiced_value) as gross_sales,
           count(*) as detail_line_count,
           max(original_dispatch_load_id::text)::uuid as original_dispatch_load_id,
           max(consignor_id::text)::uuid as detail_consignor_id,
           max(crop_id::text)::uuid as crop_id,
           -- origin per DETAIL ROW, then collapsed only when it is unambiguous
           count(distinct coalesce(original_dispatch_load_id, dispatch_load_id)) as origin_load_count,
           min(coalesce(original_dispatch_load_id, dispatch_load_id)::text)::uuid as origin_any
    from raw.ft_gp_detail
    where dispatch_load_id is not null
    group by gp_schedule_id, dispatch_load_id
  ),
  -- Origins come from the DETAIL lines (the produce the grower actually sent). A deduction line's
  -- origin is only consulted for the 37 rows live that carry deductions and no detail — a freight
  -- charge spanning the whole sale load must not be allowed to blur an origin the produce pins down.
  chg_origin as (
    select gp_schedule_id, dispatch_load_id,
           count(distinct coalesce(original_dispatch_load_id, dispatch_load_id)) as origin_load_count,
           min(coalesce(original_dispatch_load_id, dispatch_load_id)::text)::uuid as origin_any
    from raw.ft_charge_applied
    where gp_schedule_id is not null and dispatch_load_id is not null and is_deductible
    group by gp_schedule_id, dispatch_load_id
  ),
  chg as (
    select
      ca.gp_schedule_id, ca.dispatch_load_id,
      case left(btrim(ca.account_code),1)
        when '1' then 'FR' when '2' then 'WH' when '3' then 'MD'
        when '4' then 'MI' when '5' then 'LA'
        else coalesce(dgc.category, 'OTHER') end as category,
      ca.total_amount_value as amt,
      case upper(btrim(ca.vat_info))
        when 'EX'  then ca.total_amount_value * 0.1
        when 'INC' then ca.total_amount_value / 11.0
        else 0 end as gst
    from raw.ft_charge_applied ca
    left join core.dim_gp_charge dgc on dgc.charge_id = ca.charge_id
    where ca.gp_schedule_id is not null and ca.dispatch_load_id is not null and ca.is_deductible
  ),
  ded as (
    select gp_schedule_id, dispatch_load_id,
      sum(amt) filter (where category='FR') as fr,
      sum(amt) filter (where category='WH') as wh,
      sum(amt) filter (where category='MD') as md,
      sum(amt) filter (where category='LA') as la,
      sum(amt) filter (where category='MI') as mi,
      sum(amt) filter (where category not in ('FR','WH','MD','LA','MI')) as other,
      sum(amt) as total, sum(gst) as gst, count(*) as charge_line_count
    from chg group by gp_schedule_id, dispatch_load_id
  ),
  keys as (
    select gp_schedule_id, dispatch_load_id from gross
    union
    select gp_schedule_id, dispatch_load_id from ded
  ),
  resolved as (
    -- detail origins win; deduction origins only fill in where there is no detail line at all
    select k.gp_schedule_id, k.dispatch_load_id,
           coalesce(gr.origin_load_count, co.origin_load_count) as origin_load_count,
           case when coalesce(gr.origin_load_count, co.origin_load_count) = 1
                then coalesce(gr.origin_any, co.origin_any) end as origin_dispatch_load_id
    from keys k
    left join gross gr on gr.gp_schedule_id = k.gp_schedule_id and gr.dispatch_load_id = k.dispatch_load_id
    left join chg_origin co on co.gp_schedule_id = k.gp_schedule_id and co.dispatch_load_id = k.dispatch_load_id
  )
  select
    k.gp_schedule_id, k.dispatch_load_id, s.consignor_id, gr.detail_consignor_id, gr.original_dispatch_load_id,
    dl.load_no, gr.crop_id,
    round(coalesce(gr.gross_sales,0),2),
    round(-coalesce(d.fr,0),2), round(-coalesce(d.wh,0),2), round(-coalesce(d.md,0),2),
    round(-coalesce(d.la,0),2), round(-coalesce(d.mi,0),2), round(-coalesce(d.other,0),2),
    round(-coalesce(d.total,0),2), round(-coalesce(d.gst,0),2),
    round(coalesce(gr.gross_sales,0) - coalesce(d.total,0) - coalesce(d.gst,0),2) as net_settlement,
    coalesce(gr.detail_line_count,0), coalesce(d.charge_line_count,0),
    r.origin_dispatch_load_id, odl.load_no, r.origin_load_count, now()
  from keys k
  join raw.ft_gp_schedule s on s.id = k.gp_schedule_id
  join resolved r on r.gp_schedule_id = k.gp_schedule_id and r.dispatch_load_id = k.dispatch_load_id
  left join gross gr on gr.gp_schedule_id = k.gp_schedule_id and gr.dispatch_load_id = k.dispatch_load_id
  left join ded d on d.gp_schedule_id = k.gp_schedule_id and d.dispatch_load_id = k.dispatch_load_id
  left join raw.ft_dispatch_load dl  on dl.id  = k.dispatch_load_id
  left join raw.ft_dispatch_load odl on odl.id = r.origin_dispatch_load_id;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_gp_settlement_load() is
  'Idempotent rebuild of core.fact_gp_settlement_load (schedule × dispatch_load). consignor_id = SCHEDULE consignor (RLS anchor). The load-grain lineage NetSuite cannot provide. 0061: origin_dispatch_load_id / origin_load_no / origin_load_count denormalised — the load the GROWER dispatched, NULL when the group draws from >1 origin.';

-- ── semantic: the origin columns on the grower-readable settlement-load view ───────────────────
create or replace view semantic.grower_gp_settlement_load
  with (security_invoker = true) as
select
  consignor_id as grower_key,
  schedule_id,
  dispatch_load_id,
  load_no,
  original_dispatch_load_id,
  crop_id,
  gross_sales,
  deduction_freight,
  deduction_warehouse,
  deduction_market,
  deduction_larapinta,
  deduction_misc,
  deduction_other,
  total_deductions,
  gst_total,
  net_settlement,
  detail_line_count,
  charge_line_count,
  origin_dispatch_load_id,   -- 0061: the load the GROWER dispatched
  origin_load_no,            --       …and the number they recognise (NULL when >1 origin)
  origin_load_count          --       1 = exact; >1 = pool it, the grain cannot split it
from core.fact_gp_settlement_load;

grant select on semantic.grower_gp_settlement_load to authenticated;
grant select on semantic.grower_gp_settlement_load to cube_readonly;

comment on view semantic.grower_gp_settlement_load is
  'GP settlement at LOAD grain, grower-scoped (security_invoker over core.fact_gp_settlement_load; RLS anchors on the SCHEDULE consignor). dispatch_load_id/load_no are the SALE load — 63% of them are loads the grower never dispatched. Use origin_* (0061) for the load the grower recognises: origin_load_count = 1 means origin_load_no is exact, > 1 means this row draws from several origin loads and must be pooled.';

-- ── semantic: the archived-pallet load fix (see FINDING 1) ─────────────────────────────────────
create or replace view semantic.grower_dispatch_load
  with (security_invoker = true) as
with pal as (
  select
    grower_key,
    load_id,
    load_no,
    max(dispatched_on)  as dispatched_on,
    max(pack_week)      as pack_week,
    -- live-pallet measures (what every currently-visible load resolves to — unchanged)
    count(*) filter (where not is_archived)        as live_pallet_count,
    sum(boxes) filter (where not is_archived)      as live_boxes,
    sum(net_weight) filter (where not is_archived) as live_net_weight_kg,  -- SUM skips nulls; NEVER coalesced (SPEC §9.3)
    array_agg(distinct product) filter (where product is not null and not is_archived) as live_products,
    -- all-pallet measures (the fallback for a wholly archived load — its pallets are its only truth)
    count(*)            as all_pallet_count,
    sum(boxes)          as all_boxes,
    sum(net_weight)     as all_net_weight_kg,
    array_agg(distinct product) filter (where product is not null) as all_products
  from semantic.grower_dispatch_shipped
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
  case when pal.live_pallet_count > 0 then pal.live_pallet_count  else pal.all_pallet_count  end as pallet_count,
  case when pal.live_pallet_count > 0 then pal.live_boxes         else pal.all_boxes         end as boxes,
  case when pal.live_pallet_count > 0 then pal.live_net_weight_kg else pal.all_net_weight_kg end as net_weight_kg,
  case when pal.live_pallet_count > 0 then pal.live_products      else pal.all_products      end as products,
  st.code                                        as dispatch_state,
  st.name                                        as dispatch_state_name,
  st.sequence                                    as dispatch_state_seq,
  nullif(btrim(coalesce(d.manifest_no, '')), '') as connote_no,        -- the "connote" (0055 header)
  (sale.dispatch_load_id is not null)            as has_invoice,       -- landed invoice records exist
  sale.invoice_count,
  sale.sale_gross,
  sale.retailer_groups,
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
  end                                            as consignment_status, -- Tim's four-state grower lifecycle (0055 FIX 6)
  (pal.live_pallet_count = 0)                    as is_archived         -- 0061: load archived wholesale (appended at the tail — create-or-replace cannot reorder columns)
from pal
join raw.ft_dispatch_load d     on d.id = pal.load_id
join core.dim_dispatch_state st on st.state_id = d.state_id
left join settle on settle.dispatch_load_id = pal.load_id
left join sale   on sale.dispatch_load_id   = pal.load_id;

grant select on semantic.grower_dispatch_load to authenticated, cube_readonly;

comment on view semantic.grower_dispatch_load is
  'Load-grain dispatch surface (one row per shipped Sell load) over grower_dispatch_shipped — same shipped gate + RLS chain. 0061: a load whose pallets are ALL archived is NO LONGER deleted by the pallet filter (4,628 such loads, carrying $58.7m of customer invoices and $8.95m of settlement, were invisible); measures come from live pallets, falling back to the load''s own pallets when none are live, and is_archived flags it. consignment_status = Tim''s grower lifecycle: Not Consigned (no connote = manifest_no) / Consigned / Sold (state>=Invoiced OR landed invoice OR in a settlement schedule) / Paid (ALL settlement schedules PD; state>=Paid fallback where GP lineage predates the landing). Every signal exposed as a column.';
