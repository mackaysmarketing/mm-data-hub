-- 0053_core_gp_settlement_dates — FIX 1 of the grower-portal fix pack (2026-07-18):
-- semantic.grower_gp_settlement.date_from/date_to were NULL on ~100% of rows.
--
-- ROOT CAUSE (verified live): raw.ft_gp_schedule.date_from/date_to are null at the SOURCE —
-- 3 of 1,332 schedules carry them, and all 3 are TEST schedules whose dates don't even agree
-- with their own week_no (e.g. schedule "TEST 6": week_no=14, dates in ISO week 24). FreshTrack
-- simply doesn't capture the period; week_no is the trustworthy signal (1,327/1,332 populated).
--
-- FIX: derive the settlement period from week_no against the SAME ISO-week calendar the
-- pack-week code (Y{YY}W{WW}, core.dim_date.pack_week_code) comes from:
--   date_from = Monday of ISO week `week_no`, date_to = date_from + 6.
-- Year disambiguation: anchor = coalesce(payable_on, created_on::date); candidates are the
-- anchor's calendar year and the year before; pick the LATEST week start <= anchor (a schedule
-- is paid after — never before — the week it covers; handles the Dec/Jan wrap both ways).
-- Validated live pre-migration: 1,327/1,327 derivable schedules derive; every derived start is
-- a Monday whose ISO week equals week_no; 1,307/1,327 anchors fall within 45 days of the week.
--
-- Derivation WINS over source dates whenever week_no is present (the only populated source rows
-- are the self-inconsistent TEST trio); source dates are the fallback when week_no is null.
-- The 5 remaining null-week schedules (AGDBM x2, AGRRF x3) have neither week_no nor source
-- dates — they stay null, SURFACED via the new dates_derived flag, never invented.
--
-- Additive schema change only: fact + view gain `dates_derived boolean`; every existing column
-- keeps its name, type, and position. raw stays verbatim (faithful landing; conforming is core's job).

alter table core.fact_gp_settlement add column if not exists dates_derived boolean;
comment on column core.fact_gp_settlement.dates_derived is
  'true = date_from/date_to derived from week_no (ISO-week calendar, payable_on-anchored year pick; 0053). false/null = source passthrough (only the 5 null-week schedules; source dates are null there too).';

-- ── Rebuild fn: 0019 body + the week_no-derived period (dates_derived appended) ──────────────
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
    detail_line_count, charge_line_count, dates_derived, _built_at
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
    s.id, s.schedule_no, s.consignor_id, g.code, g.org_name, s.week_no,
    coalesce(wk.wk_start, s.date_from)     as date_from,
    coalesce(wk.wk_start + 6, s.date_to)   as date_to,
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
    (wk.wk_start is not null) as dates_derived,
    now()
  from raw.ft_gp_schedule s
  left join core.dim_grower g on g.consignor_id = s.consignor_id
  left join raw.ft_gp_status st on st.id = s.gp_status_id
  left join gross gr on gr.gp_schedule_id = s.id
  left join ded d on d.gp_schedule_id = s.id
  left join pay p on p.gp_schedule_id = s.id
  -- The derived settlement period: Monday of ISO week `week_no`, year picked so the week starts
  -- on or before the anchor (payable_on, else created_on). NULLs propagate through to_date, so
  -- a null week_no / null anchor simply yields wk_start = null (no ON-gate needed).
  left join lateral (
    select max(t.ws) as wk_start
    from (values
      (to_date(extract(year from coalesce(s.payable_on, s.created_on::date))::int::text
               || lpad(s.week_no::text, 2, '0'), 'IYYYIW')),
      (to_date((extract(year from coalesce(s.payable_on, s.created_on::date))::int - 1)::text
               || lpad(s.week_no::text, 2, '0'), 'IYYYIW'))
    ) t(ws)
    where t.ws <= coalesce(s.payable_on, s.created_on::date)
  ) wk on true;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_gp_settlement() is
  'Idempotent rebuild of core.fact_gp_settlement. net = gross − deductions − GST; mirrors src/lib/ft_gp_settlement.rollupSchedule. Anchored on gp_payment (recon_diff). 0053: date_from/date_to derived from week_no (ISO week, payable_on-anchored) — source period columns are null/garbage.';

select core.refresh_fact_gp_settlement();

-- ── View: identical columns + dates_derived APPENDED (additive; 0020 shape preserved) ─────────
create or replace view semantic.grower_gp_settlement
  with (security_invoker = true) as
select
  consignor_id          as grower_key,        -- = the SETTLED grower's consignor_id; the RLS anchor
  grower_code,
  grower_name,
  schedule_id,
  schedule_no,
  week_no,
  date_from,                                   -- 0053: derived from week_no (see dates_derived)
  date_to,
  payable_on,
  gross_sales,                                 -- Σ box_quantity × price_invoiced_value (positive)
  deduction_freight,                           -- signed (≤ 0 normally)
  deduction_warehouse,
  deduction_market,
  deduction_larapinta,                         -- Load Adjustment; can be > 0 (net credit)
  deduction_misc,
  deduction_other,
  total_deductions,
  gst_total,
  net_settlement,                              -- gross + deductions + gst (what the grower earns)
  paid_amount,
  paid_date,                                   -- first-class; null = unpaid (never zero-dated)
  paid_status,                                 -- PA / PD / DR
  recon_diff,
  is_archived,
  dates_derived                                -- true = period derived from week_no (0053)
from core.fact_gp_settlement;

comment on view semantic.grower_gp_settlement is
  'Grower-scoped GP settlement at SCHEDULE grain. RLS via app_metadata.consignor_id (0008/0010 contract), anchored on the SETTLED grower (not gp_detail consignor). gross/deductions(by FR/WH/MD/LA/MI)/GST/net + paid_date (first-class). Deduction columns signed. 0053: date_from/date_to derived from week_no (ISO-week calendar); dates_derived flags it.';
