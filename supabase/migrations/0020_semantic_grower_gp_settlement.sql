-- 0020_semantic_grower_gp_settlement — grower-scoped GP settlement views (schedule + load grain) + RLS.
--
-- RLS is the SAME app_metadata-only, fail-closed contract as 0008/0010/0016: it REUSES
-- semantic.current_consignor_id() / semantic.is_internal_claim() (read ONLY from app_metadata, so a
-- forged top-level claim is ignored). The anchor is the SCHEDULE consignor
-- (core.fact_gp_settlement.consignor_id / fact_gp_settlement_load.consignor_id) — NOT the gp_detail
-- consignor, which can be the ORIGINAL grower on a reconsigned load (would leak across growers).
-- service_role bypasses RLS (the refresh runs as table owner). Cube reads via cube_readonly (read-all)
-- and re-applies tenant scope in queryRewrite — identical to dispatch (0012) + NetSuite settlement (0016).
--
-- The load-grain view reads ONLY the core fact (load_no/dispatch_load_id were denormalised at build
-- time by service_role); it does NOT runtime-join raw.ft_dispatch_load, so the dispatch RLS (keyed on
-- the LOAD's consignor, 0008) can never hide or leak a reconsigned load's settlement row.

-- ── Schedule-grain fact RLS ──────────────────────────────────────────────────
alter table core.fact_gp_settlement enable row level security;
grant select on core.fact_gp_settlement to authenticated;

drop policy if exists grower_own_gp_settlement on core.fact_gp_settlement;
create policy grower_own_gp_settlement on core.fact_gp_settlement
  for select to authenticated
  using (consignor_id = semantic.current_consignor_id() or semantic.is_internal_claim());

drop policy if exists cube_readonly_read_all on core.fact_gp_settlement;
create policy cube_readonly_read_all on core.fact_gp_settlement
  for select to cube_readonly using (true);
grant select on core.fact_gp_settlement to cube_readonly;

-- ── Load-grain fact RLS (anchor = SCHEDULE consignor, carried into the fact) ──
alter table core.fact_gp_settlement_load enable row level security;
grant select on core.fact_gp_settlement_load to authenticated;

drop policy if exists grower_own_gp_settlement_load on core.fact_gp_settlement_load;
create policy grower_own_gp_settlement_load on core.fact_gp_settlement_load
  for select to authenticated
  using (consignor_id = semantic.current_consignor_id() or semantic.is_internal_claim());

drop policy if exists cube_readonly_read_all on core.fact_gp_settlement_load;
create policy cube_readonly_read_all on core.fact_gp_settlement_load
  for select to cube_readonly using (true);
grant select on core.fact_gp_settlement_load to cube_readonly;

-- ── Schedule-grain settlement view (security_invoker → caller's RLS applies) ──
create or replace view semantic.grower_gp_settlement
  with (security_invoker = true) as
select
  consignor_id          as grower_key,        -- = the SETTLED grower's consignor_id; the RLS anchor
  grower_code,
  grower_name,
  schedule_id,
  schedule_no,
  week_no,
  date_from,
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
  is_archived
from core.fact_gp_settlement;

grant select on semantic.grower_gp_settlement to authenticated;
grant select on semantic.grower_gp_settlement to cube_readonly;

comment on view semantic.grower_gp_settlement is
  'Grower-scoped GP settlement at SCHEDULE grain. RLS via app_metadata.consignor_id (0008/0010 contract), anchored on the SETTLED grower (not gp_detail consignor). gross/deductions(by FR/WH/MD/LA/MI)/GST/net + paid_date (first-class). Deduction columns signed.';

-- ── Load-grain settlement view (the lineage NetSuite cannot provide) ─────────
create or replace view semantic.grower_gp_settlement_load
  with (security_invoker = true) as
select
  consignor_id              as grower_key,     -- = SCHEDULE consignor; the RLS anchor (NOT detail consignor)
  schedule_id,
  dispatch_load_id,                            -- the join key back to dispatch (raw.ft_dispatch_load.id)
  load_no,
  original_dispatch_load_id,                   -- reconsignment lineage
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
  charge_line_count
from core.fact_gp_settlement_load;

grant select on semantic.grower_gp_settlement_load to authenticated;
grant select on semantic.grower_gp_settlement_load to cube_readonly;

comment on view semantic.grower_gp_settlement_load is
  'Grower-scoped GP settlement at LOAD grain (the load↔settlement lineage NetSuite cannot provide). dispatch_load_id joins back to dispatch. RLS anchored on the SCHEDULE consignor (never the gp_detail/original-load consignor). security_invoker.';
