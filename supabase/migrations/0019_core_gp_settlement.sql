-- 0019_core_gp_settlement — conform FreshTrack GP into the grower settlement model (core layer).
--
-- The SECOND view of grower settlement (NetSuite RCTIs, 0015, is the first). Its unique value is
-- LOAD-GRAIN LINEAGE: every line carries dispatch_load_id, so settlement joins back to dispatch
-- (NetSuite is product-grain and cannot). Mirrors 0015's structure: a classified charge dimension,
-- a deterministic grower crosswalk, and sign-explicit settlement facts whose net reconciles.
--
-- NET FORMULA (validated live, see HANDOFF Sprint-6): net = gross − deductions − GST, where
--   gross      = Σ gp_detail.box_quantity × price_invoiced_value   (the "Sales" rows)
--   deductions = Σ charge_applied.total_amount_value WHERE is_deductible, by category
--   GST        = Σ per vat_info (EX ×0.10 / INC ×1/11 / FREE 0)     — mirrors v_power_bi_charge_split
-- Anchored on gp_payment (the actual cash); the original-load split apportionment is NOT replicated
-- (its residual is surfaced as recon variance). Deduction/GST columns are SIGNED (≤ 0 normally; a
-- category with net credits, e.g. LA load-adjustments, can be > 0). net = gross + deductions + gst.
--
-- The sign + category + GST rules mirror EXACTLY the unit-tested TS oracle src/lib/ft_gp_settlement.ts
-- (rollupSchedule) — the reconciliation proof checks the two against each other (drift guard).

-- ── Charge dimension (built by the TS classifier in src/loaders/ft_gp_core.ts) ─
create table if not exists core.dim_gp_charge (
  charge_id       uuid primary key,
  name            text,
  charge_type_id  uuid,
  ct_code         text,          -- charge_type.code
  ct_scope        text,          -- charge_type.scope (raw; classifier input)
  account_code    text,          -- the charge's account_code (classifier primary signal)
  category        text,          -- FR / WH / MD / MI / LA / OTHER
  category_label  text,          -- LA = 'Load Adjustment' in FreshTrack (≠ NetSuite Larapinta)
  subcategory     text,
  is_deductible   boolean,       -- charge_type default (the applied row's flag still governs the fact)
  vat_info        text,          -- the charge's default GST treatment
  netsuite_id     text,          -- ~0 populated — NOT a usable cross-source key (documented)
  _built_at       timestamptz not null default now()
);
comment on table core.dim_gp_charge is
  'FreshTrack charge → FR/WH/MD/LA/MI classification (src/lib/ft_gp_charges.ts) from account_code + charge_type.scope + charge.name. LA = Load Adjustment (FreshTrack), not Larapinta (NetSuite).';

-- ── Grower crosswalk (deterministic: gp_schedule.consignor_id = dim_grower.consignor_id) ──
-- Lists every consignor seen in GP (as a SETTLED schedule party and/or a DETAIL/original-load
-- party), with its dim_grower match. Detail-only consignors (is_schedule=false) are reconsignment
-- ORIGINALS — surfaced, never settled here (RLS/attribution anchor on the schedule consignor).
create or replace view core.crosswalk_gp_grower as
with sched as (select distinct consignor_id from raw.ft_gp_schedule where consignor_id is not null),
     det   as (select distinct consignor_id from raw.ft_gp_detail   where consignor_id is not null),
     allc  as (select consignor_id from sched union select consignor_id from det)
select
  a.consignor_id,
  (a.consignor_id in (select consignor_id from sched)) as is_schedule_consignor, -- settled party
  (a.consignor_id in (select consignor_id from det))   as is_detail_consignor,
  g.code      as grower_code,
  g.org_name  as grower_name,
  g.is_active as grower_is_active,
  (g.consignor_id is not null) as is_mapped
from allc a
left join core.dim_grower g on g.consignor_id = a.consignor_id;
comment on view core.crosswalk_gp_grower is
  'GP consignors → dim_grower (deterministic on consignor_id). is_schedule_consignor = settled party (RLS anchor); detail-only = reconsignment original (surfaced, not settled). is_mapped=false = unmapped (surface, never drop).';

-- ── Schedule-grain settlement fact (consignor_id anchor; RLS target in 0020) ──
create table if not exists core.fact_gp_settlement (
  schedule_id          uuid primary key,
  schedule_no          text,
  consignor_id         uuid,          -- the SETTLED grower (RLS anchor; null = unmapped, internal-only)
  grower_code          text,
  grower_name          text,
  week_no              smallint,
  date_from            date,
  date_to              date,
  payable_on           date,          -- the settlement business date
  gross_sales          numeric,       -- Σ box_quantity × price_invoiced_value (positive)
  deduction_freight    numeric,       -- signed (≤ 0 normally); −Σ FR
  deduction_warehouse  numeric,       -- −Σ WH
  deduction_market     numeric,       -- −Σ MD
  deduction_larapinta  numeric,       -- −Σ LA (Load Adjustment; can be > 0 = net credit)
  deduction_misc       numeric,       -- −Σ MI
  deduction_other      numeric,       -- −Σ OTHER (unclassified; surfaced)
  total_deductions     numeric,       -- −Σ all deductible (signed)
  gst_total            numeric,       -- −Σ GST on deductibles (signed ≤ 0)
  net_settlement       numeric,       -- gross_sales + total_deductions + gst_total (what the grower earns)
  paid_amount          numeric,       -- Σ gp_payment.amount_value (actual cash)
  paid_date            date,          -- max(gp_payment.paid_on); null = unpaid (flagged, never zero-dated)
  paid_status          text,          -- PA Payable / PD Paid / DR Draft (from gp_status)
  recon_diff           numeric,       -- net_settlement − paid_amount (≈ 0; reconsignment residual surfaced)
  is_archived          boolean,
  detail_line_count    integer,       -- gp_detail rows
  charge_line_count    integer,       -- deductible charge_applied rows
  _built_at            timestamptz not null default now()
);
comment on table core.fact_gp_settlement is
  'Per-GP-schedule grower settlement (schedule grain). consignor_id = RLS anchor (the SETTLED grower, not gp_detail consignor). net_settlement = gross − deductions − GST; reconciles to paid_amount (gp_payment) via recon_diff. paid_date from gp_payment (null = unpaid).';

-- ── Load-grain settlement fact (the lineage NetSuite cannot provide) ─────────
create table if not exists core.fact_gp_settlement_load (
  schedule_id               uuid not null,
  dispatch_load_id          uuid not null,
  consignor_id              uuid,        -- the SCHEDULE consignor (RLS anchor) — NOT gp_detail.consignor_id
  detail_consignor_id       uuid,        -- the line's own consignor (original grower on reconsignment)
  original_dispatch_load_id uuid,        -- reconsignment lineage
  load_no                   text,        -- raw.ft_dispatch_load.load_no
  crop_id                   uuid,        -- product/crop tag for the sales rows
  gross_sales               numeric,
  deduction_freight         numeric,
  deduction_warehouse       numeric,
  deduction_market          numeric,
  deduction_larapinta       numeric,
  deduction_misc            numeric,
  deduction_other           numeric,
  total_deductions          numeric,
  gst_total                 numeric,
  net_settlement            numeric,
  detail_line_count         integer,
  charge_line_count         integer,
  _built_at                 timestamptz not null default now(),
  primary key (schedule_id, dispatch_load_id)
);
create index if not exists ix_fact_gp_settlement_load_consignor on core.fact_gp_settlement_load (consignor_id);
create index if not exists ix_fact_gp_settlement_load_dl on core.fact_gp_settlement_load (dispatch_load_id);
comment on table core.fact_gp_settlement_load is
  'GP settlement at LOAD grain (schedule × dispatch_load). The load↔settlement lineage NetSuite (product-grain) cannot provide. consignor_id = SCHEDULE consignor (RLS anchor). Joins dispatch via dispatch_load_id.';

-- ── Shared category/GST expressions, applied per charge_applied line ─────────
-- Category = dim_gp_charge (the full classifier, by charge_id); null charge → OTHER.
-- GST mirrors src/lib/ft_gp_charges.gstForVatInfo (trivial formula; guarded by the recon drift check).

-- Rebuild the schedule-grain fact. Idempotent.
create or replace function core.refresh_fact_gp_settlement() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_gp_settlement;
  insert into core.fact_gp_settlement (
    schedule_id, schedule_no, consignor_id, grower_code, grower_name, week_no, date_from, date_to,
    payable_on, gross_sales, deduction_freight, deduction_warehouse, deduction_market,
    deduction_larapinta, deduction_misc, deduction_other, total_deductions, gst_total,
    net_settlement, paid_amount, paid_date, paid_status, recon_diff, is_archived,
    detail_line_count, charge_line_count, _built_at
  )
  with gross as (
    select gp_schedule_id,
           sum(box_quantity * price_invoiced_value) as gross_sales,
           count(*) as detail_line_count
    from raw.ft_gp_detail group by gp_schedule_id
  ),
  chg as (
    select
      ca.gp_schedule_id,
      -- LINE account_code first digit is the PRIMARY signal (proven: OTHER = $45.7k). dim_gp_charge
      -- (the full scope/name classifier) is the FALLBACK for GL-string / blank / null-charge lines.
      -- ~5k applied rows carry NO charge_id but DO carry account_code, so line-prefix beats dim-join.
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
    where ca.gp_schedule_id is not null and ca.is_deductible
  ),
  ded as (
    select gp_schedule_id,
      sum(amt) filter (where category='FR')    as fr,
      sum(amt) filter (where category='WH')    as wh,
      sum(amt) filter (where category='MD')    as md,
      sum(amt) filter (where category='LA')    as la,
      sum(amt) filter (where category='MI')    as mi,
      sum(amt) filter (where category not in ('FR','WH','MD','LA','MI')) as other,
      sum(amt) as total,
      sum(gst) as gst,
      count(*) as charge_line_count
    from chg group by gp_schedule_id
  ),
  pay as (
    select gp_schedule_id, sum(amount_value) as paid_amount, max(paid_on) as paid_date
    from raw.ft_gp_payment group by gp_schedule_id
  )
  select
    s.id, s.schedule_no, s.consignor_id, g.code, g.org_name, s.week_no, s.date_from, s.date_to,
    s.payable_on,
    round(coalesce(gr.gross_sales,0),2),
    round(-coalesce(d.fr,0),2), round(-coalesce(d.wh,0),2), round(-coalesce(d.md,0),2),
    round(-coalesce(d.la,0),2), round(-coalesce(d.mi,0),2), round(-coalesce(d.other,0),2),
    round(-coalesce(d.total,0),2), round(-coalesce(d.gst,0),2),
    round(coalesce(gr.gross_sales,0) - coalesce(d.total,0) - coalesce(d.gst,0),2) as net_settlement,
    round(p.paid_amount,2) as paid_amount,
    p.paid_date,
    st.code as paid_status,
    round((coalesce(gr.gross_sales,0) - coalesce(d.total,0) - coalesce(d.gst,0)) - coalesce(p.paid_amount,0),2) as recon_diff,
    s.is_archived,
    coalesce(gr.detail_line_count,0),
    coalesce(d.charge_line_count,0),
    now()
  from raw.ft_gp_schedule s
  left join core.dim_grower g on g.consignor_id = s.consignor_id
  left join raw.ft_gp_status st on st.id = s.gp_status_id
  left join gross gr on gr.gp_schedule_id = s.id
  left join ded d on d.gp_schedule_id = s.id
  left join pay p on p.gp_schedule_id = s.id;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_gp_settlement() is
  'Idempotent rebuild of core.fact_gp_settlement. net = gross − deductions − GST; mirrors src/lib/ft_gp_settlement.rollupSchedule. Anchored on gp_payment (recon_diff).';

-- Rebuild the load-grain fact. Idempotent.
create or replace function core.refresh_fact_gp_settlement_load() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_gp_settlement_load;
  insert into core.fact_gp_settlement_load (
    schedule_id, dispatch_load_id, consignor_id, detail_consignor_id, original_dispatch_load_id,
    load_no, crop_id, gross_sales, deduction_freight, deduction_warehouse, deduction_market,
    deduction_larapinta, deduction_misc, deduction_other, total_deductions, gst_total,
    net_settlement, detail_line_count, charge_line_count, _built_at
  )
  with gross as (
    select gp_schedule_id, dispatch_load_id,
           sum(box_quantity * price_invoiced_value) as gross_sales,
           count(*) as detail_line_count,
           max(original_dispatch_load_id::text)::uuid as original_dispatch_load_id,
           max(consignor_id::text)::uuid as detail_consignor_id,
           max(crop_id::text)::uuid as crop_id
    from raw.ft_gp_detail
    where dispatch_load_id is not null
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
  )
  select
    k.gp_schedule_id, k.dispatch_load_id, s.consignor_id, gr.detail_consignor_id, gr.original_dispatch_load_id,
    dl.load_no, gr.crop_id,
    round(coalesce(gr.gross_sales,0),2),
    round(-coalesce(d.fr,0),2), round(-coalesce(d.wh,0),2), round(-coalesce(d.md,0),2),
    round(-coalesce(d.la,0),2), round(-coalesce(d.mi,0),2), round(-coalesce(d.other,0),2),
    round(-coalesce(d.total,0),2), round(-coalesce(d.gst,0),2),
    round(coalesce(gr.gross_sales,0) - coalesce(d.total,0) - coalesce(d.gst,0),2) as net_settlement,
    coalesce(gr.detail_line_count,0), coalesce(d.charge_line_count,0), now()
  from keys k
  join raw.ft_gp_schedule s on s.id = k.gp_schedule_id
  left join gross gr on gr.gp_schedule_id = k.gp_schedule_id and gr.dispatch_load_id = k.dispatch_load_id
  left join ded d on d.gp_schedule_id = k.gp_schedule_id and d.dispatch_load_id = k.dispatch_load_id
  left join raw.ft_dispatch_load dl on dl.id = k.dispatch_load_id;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_gp_settlement_load() is
  'Idempotent rebuild of core.fact_gp_settlement_load (schedule × dispatch_load). consignor_id = SCHEDULE consignor (RLS anchor). The load-grain lineage NetSuite cannot provide.';
