-- 0015_core_settlement — conform NetSuite RCTIs into the grower settlement model (core layer).
--
-- Bridges NetSuite ids → the FreshTrack/uuid world via the grower crosswalk, classifies charges,
-- and rolls lines up to the bill grain. The sign-based gross/deduction split + category breakdown
-- mirror EXACTLY the unit-tested TS oracle in src/lib/ns_lines.ts (rollupBill) — the reconciliation
-- proof checks the two against each other (drift guard).

-- ── Grower crosswalk: ns_vendor.entityid = dim_grower.code → consignor_id ─────
-- WADDA-style duplicate codes resolve to the ACTIVE dim_grower row (then lowest consignor_id).
-- Unmapped active growers surface as consignor_id IS NULL (never silently dropped).
create or replace view core.crosswalk_ns_grower as
select distinct on (v.id)
  v.id          as vendor_id,
  v.entityid    as code,
  v.companyname as ns_name,
  v.isinactive  as vendor_inactive,
  g.consignor_id,
  g.org_name    as grower_name,
  g.is_active   as grower_is_active
from raw.ns_vendor v
left join core.dim_grower g on g.code = v.entityid
order by v.id, g.is_active desc nulls last, g.consignor_id;

comment on view core.crosswalk_ns_grower is
  'ns_vendor → consignor_id via entityid=dim_grower.code. WADDA resolved to the active row. consignor_id null = unmapped (surface, never drop). NEVER use externalid (rotten).';

-- ── Charge dimension (item taxonomy) — populated by the TS classifier ────────
create table if not exists core.dim_ns_charge (
  item_id        bigint primary key,
  itemid         text,
  displayname    text,
  category       text,          -- PRODUCT / FR / WH / MD / LA / MI / OTHER
  category_label text,
  subcategory    text,
  detail         text,
  produce        text,          -- banana/papaya/avocado/passionfruit for 9xxxxx
  is_product     boolean,
  _built_at      timestamptz not null default now()
);
comment on table core.dim_ns_charge is
  'NetSuite item → charge classification. Built by the unit-tested TS classifier (src/lib/ns_charges.ts) from raw.ns_item.';

-- ── Bill-grain settlement fact (consignor_id anchor; RLS target in 0016) ──────
create table if not exists core.fact_settlement_bill (
  bill_id              bigint primary key,
  tranid               text,
  consignor_id         uuid,          -- RLS anchor (null = unmapped grower, internal-only)
  grower_code          text,
  grower_name          text,
  settlement_date      date,          -- trandate
  gross_sales          numeric,       -- Σ positive non-tax non-main lines (money to grower)
  deduction_freight    numeric,       -- Σ negative FR lines  (signed, ≤ 0)
  deduction_warehouse  numeric,       -- Σ negative WH lines
  deduction_market     numeric,       -- Σ negative MD lines
  deduction_larapinta  numeric,       -- Σ negative LA lines
  deduction_misc       numeric,       -- Σ negative MI lines
  deduction_other      numeric,       -- Σ negative lines not in FR/WH/MD/LA/MI
  total_deductions     numeric,       -- Σ all negative non-tax non-main lines
  tax_total            numeric,       -- Σ tax lines (GST/RCTI)
  net_paid             numeric,       -- gross + total_deductions + tax (what the grower receives, positive)
  bill_total           numeric,       -- foreigntotal (signed; negative payable)
  recon_diff           numeric,       -- net_paid - (-bill_total); ~0 proves line integrity
  paid_date            date,          -- max(payment date); null = unpaid (flagged, never zero-dated)
  paid_amount          numeric,       -- Σ linked payment amounts
  paid_status          text,          -- paid | partial | unpaid
  line_count           integer,
  _built_at            timestamptz not null default now()
);
comment on table core.fact_settlement_bill is
  'Per-RCTI grower settlement (bill grain). consignor_id = RLS anchor. net_paid reconciles to -bill_total via recon_diff. paid_date from VendPymt (null=unpaid).';

-- ── Idempotent rebuild: roll lines → bill, attach crosswalk + payment status ─
create or replace function core.refresh_fact_settlement() returns integer
language plpgsql as $$
declare n integer;
begin
  delete from core.fact_settlement_bill;
  insert into core.fact_settlement_bill (
    bill_id, tranid, consignor_id, grower_code, grower_name, settlement_date,
    gross_sales, deduction_freight, deduction_warehouse, deduction_market,
    deduction_larapinta, deduction_misc, deduction_other, total_deductions, tax_total,
    net_paid, bill_total, recon_diff, paid_date, paid_amount, paid_status, line_count, _built_at
  )
  with agg as (
    select
      l.transaction as bill_id,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount > 0 then l.foreignamount else 0 end) as gross_sales,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 and coalesce(c.category,'OTHER')='FR' then l.foreignamount else 0 end) as deduction_freight,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 and coalesce(c.category,'OTHER')='WH' then l.foreignamount else 0 end) as deduction_warehouse,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 and coalesce(c.category,'OTHER')='MD' then l.foreignamount else 0 end) as deduction_market,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 and coalesce(c.category,'OTHER')='LA' then l.foreignamount else 0 end) as deduction_larapinta,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 and coalesce(c.category,'OTHER')='MI' then l.foreignamount else 0 end) as deduction_misc,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 and coalesce(c.category,'OTHER') not in ('FR','WH','MD','LA','MI') then l.foreignamount else 0 end) as deduction_other,
      sum(case when not coalesce(l.taxline,false) and not coalesce(l.mainline,false) and l.foreignamount < 0 then l.foreignamount else 0 end) as total_deductions,
      sum(case when coalesce(l.taxline,false) and not coalesce(l.mainline,false) then l.foreignamount else 0 end) as tax_total,
      count(*) filter (where not coalesce(l.mainline,false)) as line_count
    from raw.ns_vendor_bill_line l
    left join core.dim_ns_charge c on c.item_id = l.item
    group by l.transaction
  ),
  pay as (
    select previousdoc as bill_id, sum(foreignamount) as paid_amount, max(nextdate) as paid_date
    from raw.ns_bill_payment_link
    where linktype = 'Payment' and previoustype = 'VendBill'
    group by previousdoc
  )
  select
    b.id, b.tranid, x.consignor_id, x.code, x.grower_name, b.trandate,
    round(coalesce(a.gross_sales,0),2),
    round(coalesce(a.deduction_freight,0),2), round(coalesce(a.deduction_warehouse,0),2),
    round(coalesce(a.deduction_market,0),2), round(coalesce(a.deduction_larapinta,0),2),
    round(coalesce(a.deduction_misc,0),2), round(coalesce(a.deduction_other,0),2),
    round(coalesce(a.total_deductions,0),2), round(coalesce(a.tax_total,0),2),
    round(coalesce(a.gross_sales,0) + coalesce(a.total_deductions,0) + coalesce(a.tax_total,0),2) as net_paid,
    b.foreigntotal as bill_total,
    round((coalesce(a.gross_sales,0) + coalesce(a.total_deductions,0) + coalesce(a.tax_total,0)) - (-b.foreigntotal),2) as recon_diff,
    p.paid_date,
    round(p.paid_amount,2) as paid_amount,
    case
      when p.paid_amount is null then 'unpaid'
      when abs(coalesce(p.paid_amount,0) - (-b.foreigntotal)) < 0.01 then 'paid'
      else 'partial'
    end as paid_status,
    coalesce(a.line_count,0),
    now()
  from raw.ns_vendor_bill b
  left join core.crosswalk_ns_grower x on x.vendor_id = b.entity
  left join agg a on a.bill_id = b.id
  left join pay p on p.bill_id = b.id
  where b.type = 'VendBill';
  get diagnostics n = row_count;
  return n;
end $$;

comment on function core.refresh_fact_settlement() is
  'Idempotent rebuild of core.fact_settlement_bill from raw.ns_* + crosswalk + dim_ns_charge. Sign-based gross/deduction split mirrors src/lib/ns_lines.ts.';
