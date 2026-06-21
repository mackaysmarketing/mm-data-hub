-- 0016_semantic_grower_settlement — the grower-scoped settlement view (bill grain) + RLS.
--
-- RLS is the SAME app_metadata-only, fail-closed contract as migrations 0008/0010: it REUSES
-- semantic.current_consignor_id() / semantic.is_internal_claim() (read ONLY from app_metadata, so a
-- forged top-level claim is ignored). The RLS anchor is core.fact_settlement_bill.consignor_id.
-- service_role bypasses RLS (the refresh runs as the table owner). Cube reads via cube_readonly
-- (read-all policy) and re-applies tenant scope itself — identical to the dispatch layer (0012).

-- ── RLS on the fact the view reads ───────────────────────────────────────────
alter table core.fact_settlement_bill enable row level security;
grant select on core.fact_settlement_bill to authenticated;

-- A grower sees only their own settlements; internal claims see all. Unmapped (consignor_id null)
-- rows match no grower and are visible only to internal — surfaced for fixing, never leaked.
drop policy if exists grower_own_settlement on core.fact_settlement_bill;
create policy grower_own_settlement on core.fact_settlement_bill
  for select to authenticated
  using (consignor_id = semantic.current_consignor_id() or semantic.is_internal_claim());

-- cube_readonly reads ALL rows (Cube narrows per query in queryRewrite) — mirror 0012.
drop policy if exists cube_readonly_read_all on core.fact_settlement_bill;
create policy cube_readonly_read_all on core.fact_settlement_bill
  for select to cube_readonly using (true);
grant select on core.fact_settlement_bill to cube_readonly;

-- ── The bill-grain settlement view (security_invoker → caller's RLS applies) ──
create or replace view semantic.grower_settlement
  with (security_invoker = true) as
select
  consignor_id          as grower_key,        -- = consignor_id; the RLS anchor
  grower_code,
  grower_name,
  bill_id,
  tranid,
  settlement_date,
  gross_sales,                                 -- money to the grower (positive)
  deduction_freight,                           -- signed (≤ 0)
  deduction_warehouse,
  deduction_market,
  deduction_larapinta,
  deduction_misc,
  deduction_other,
  total_deductions,
  tax_total,
  net_paid,                                    -- gross + deductions + tax (what the grower receives)
  bill_total,                                  -- foreigntotal (signed; negative payable)
  paid_date,                                   -- first-class; null = unpaid (never zero-dated)
  paid_amount,
  paid_status,
  line_count
from core.fact_settlement_bill;

grant select on semantic.grower_settlement to authenticated;
grant select on semantic.grower_settlement to cube_readonly;

comment on view semantic.grower_settlement is
  'Grower-scoped settlement at RCTI (bill) grain. RLS via app_metadata.consignor_id (0008/0010 contract). Exposes gross, deductions by category (FR/WH/MD/LA/MI), net_paid, and paid_date (first-class). Deduction columns are signed (≤ 0).';
