-- 0035_recon_settlement_source — GP ↔ NetSuite settlement reconciliation surface (grower × month).
--
-- The governed cross-source tie (SPRINT 2026-07-11 chunk 2): FreshTrack GP settlement
-- (core.fact_gp_settlement, schedule grain) vs NetSuite RCTIs (core.fact_settlement_bill, bill
-- grain), both rolled to GROWER × MONTH and FULL OUTER joined so one-sided rows always surface.
-- No new facts — a reconciliation view over the two proven settlement facts. Proof runner:
-- npm run settle:tie (scripts/settle_tie.ts).
--
-- ── STRICT INTERNAL-ONLY (the explicit WHERE gate) ───────────────────────────
-- Both underlying facts carry GROWER-scoped RLS (0016 / 0020: a grower reads their own rows).
-- Through a plain security_invoker view that RLS would let a grower see THEIR OWN recon rows —
-- gross-vs-gross across the two sources, unmapped-entity buckets, cross-source deltas. Per SPRINT
-- this surface is internal-only, so the view adds an explicit
--     WHERE semantic.is_internal_claim()
-- gate (the same app_metadata-only, fail-closed helper as 0008/0010): internal claim → all rows;
-- grower claim / no claim / forged top-level claim → ZERO rows. This gate NARROWS the underlying
-- RLS — it never widens it (a grower blocked by 0016/0020 stays blocked here regardless).
-- NB cube_readonly: SELECT is granted (posture parity with the other semantic surfaces, and so a
-- future Cube exposure needs no re-grant), but a claims-less cube_readonly session reads 0 rows
-- THROUGH THIS VIEW because the gate fails closed. Cube settlement exposure is deferred (SPRINT
-- exclusions); when it lands it reads the core facts via its read-all policies (0016/0020) or this
-- gate gets an explicit, documented revisit. The grant is intentionally nominal today.
--
-- ── Month anchor: GP payable_on vs NS settlement_date (= trandate) ───────────
-- GP  side: payable_on        — "the settlement business date" (0019), when the schedule falls due.
-- NS  side: settlement_date   — trandate, the RCTI's settlement date (0015). This is the NS column
--   comparable to payable_on: both are the accrual/settlement business date. NOT paid_date on
--   either side — paid_date is the CASH date and is NULL for unpaid rows (flagged, never
--   zero-dated, per house contract), so anchoring on it would silently drop every unpaid
--   settlement from the recon. bill trandate ↔ schedule payable_on is the like-for-like pair.
-- The 2 GP schedules with NULL payable_on land with month NULL — visible, never dropped.
--
-- ── Grower join key: consignor_id ────────────────────────────────────────────
-- GP rows carry consignor_id natively (deterministic: gp_schedule.consignor_id, 0019). NS rows
-- carry the consignor_id resolved via core.crosswalk_ns_grower (vendor.entityid = dim_grower.code,
-- denormalised onto core.fact_settlement_bill at refresh, 0015). Rows that cannot join stay
-- visible under match_status:
--   matched            — both sources settled this grower this month
--   gp_only            — GP settled; no NS RCTI that grower × month (incl. AG* agent sub-entities
--                        and duplicate-code consignors NetSuite rolls into a vendor RCTI)
--   ns_only            — NS RCTI; no GP schedule that grower × month
--   gp_null_consignor  — GP schedule with NULL consignor (52 known; internal-only source quirk)
--   ns_unmapped        — NS bill whose vendor has no dim_grower match (0 today; defensive)
-- NULL join keys use plain equality (never IS NOT DISTINCT FROM — planner lore), so null-consignor
-- rows fall out one-sided by construction, which is exactly the surfacing we want.
--
-- Measures: sum() skips NULLs, never coalesces (house rule) — an all-NULL paid month stays NULL.
-- Deltas are NULL when either side is absent (the match_status labels the row; the one-sided
-- amount speaks for itself).

create or replace view semantic.recon_settlement_source
  with (security_invoker = true) as
with gp as (
  select
    consignor_id,
    (date_trunc('month', payable_on))::date as month,
    max(grower_code)                  as grower_code,
    max(grower_name)                  as grower_name,
    count(*)                          as gp_schedule_count,
    round(sum(gross_sales), 2)        as gp_gross,
    round(sum(total_deductions), 2)   as gp_deductions,   -- signed (≤ 0 normally)
    round(sum(gst_total), 2)          as gp_gst,          -- signed
    round(sum(net_settlement), 2)     as gp_net,          -- gross + deductions + gst
    round(sum(paid_amount), 2)        as gp_paid          -- actual cash; NULL if nothing paid
  from core.fact_gp_settlement
  group by consignor_id, (date_trunc('month', payable_on))::date
),
ns as (
  select
    consignor_id,
    (date_trunc('month', settlement_date))::date as month,
    max(grower_code)                  as grower_code,
    max(grower_name)                  as grower_name,
    count(*)                          as ns_bill_count,
    round(sum(gross_sales), 2)        as ns_gross,
    round(sum(total_deductions), 2)   as ns_deductions,   -- signed (≤ 0)
    round(sum(tax_total), 2)          as ns_tax,          -- signed (GST/RCTI)
    round(sum(net_paid), 2)           as ns_net_paid,     -- gross + deductions + tax
    round(sum(paid_amount), 2)        as ns_paid_amount   -- linked VendPymt cash; NULL if unpaid
  from core.fact_settlement_bill
  group by consignor_id, (date_trunc('month', settlement_date))::date
)
select
  coalesce(gp.consignor_id, ns.consignor_id) as consignor_id,
  coalesce(gp.month, ns.month)               as month,
  coalesce(gp.grower_code, ns.grower_code)   as grower_code,
  coalesce(gp.grower_name, ns.grower_name)   as grower_name,
  case
    when gp.gp_schedule_count is not null and ns.ns_bill_count is not null then 'matched'
    when ns.ns_bill_count is null and gp.consignor_id is null              then 'gp_null_consignor'
    when ns.ns_bill_count is null                                          then 'gp_only'
    when gp.gp_schedule_count is null and ns.consignor_id is null          then 'ns_unmapped'
    else 'ns_only'
  end                                        as match_status,
  gp.gp_schedule_count,
  gp.gp_gross,
  gp.gp_deductions,
  gp.gp_gst,
  gp.gp_net,
  gp.gp_paid,
  ns.ns_bill_count,
  ns.ns_gross,
  ns.ns_deductions,
  ns.ns_tax,
  ns.ns_net_paid,
  ns.ns_paid_amount,
  round(gp.gp_gross      - ns.ns_gross, 2)      as delta_gross,      -- NULL when one-sided
  round(gp.gp_deductions - ns.ns_deductions, 2) as delta_deductions,
  round(gp.gp_gst        - ns.ns_tax, 2)        as delta_gst,
  round(gp.gp_net        - ns.ns_net_paid, 2)   as delta_net,
  round(gp.gp_paid       - ns.ns_net_paid, 2)   as delta_paid        -- cash basis (the 0.6% anchor)
from gp
full join ns
  on ns.consignor_id = gp.consignor_id
 and ns.month = gp.month
where semantic.is_internal_claim();

grant select on semantic.recon_settlement_source to authenticated, cube_readonly;

comment on view semantic.recon_settlement_source is
  'GP ↔ NetSuite settlement tie at grower × month (FULL OUTER: one-sided rows surface with match_status matched/gp_only/ns_only/gp_null_consignor/ns_unmapped). Month anchor: GP payable_on vs NS settlement_date (trandate) — like-for-like business dates; paid_date is cash and NULL for unpaid, so never the anchor. STRICT INTERNAL-ONLY via explicit WHERE semantic.is_internal_claim() gate (the underlying facts'' grower RLS would otherwise show a grower their own recon). Proof: npm run settle:tie.';
