-- 0041_semantic_ar — internal AR surfaces (security_invoker over the 0040 facts).
--
-- INTERNAL-ONLY, ALL OF THEM (customer book + selling side is commercially sensitive; never grower-
-- facing — no grower_* prefix, no grower-own policy). security_invoker over core.fact_customer_invoice
-- / core.fact_remittance_line, whose RLS is fail-closed to internal (is_internal_claim, 0040): an
-- internal claim sees everything; a grower JWT sees ZERO rows. Names already denormalised on the facts.

-- ── Customer invoices with cash/paid status + lineage ────────────────────────
create or replace view semantic.ar_customer_invoice
  with (security_invoker = true) as
select
  invoice_id, invoice_no, invoice_type, invoice_date,
  consignee_id, consignee_name, dispatch_load_id, load_no, order_id, order_no, po_no,
  amount_value, ns_amount, paid_amount, credit_amount, open_amount,
  paid_date, paid_status,
  ns_invoice_id, ns_tranid, ft_payment_status
from core.fact_customer_invoice;
grant select on semantic.ar_customer_invoice to authenticated, cube_readonly;
comment on view semantic.ar_customer_invoice is
  'Customer AR invoices + NetSuite-derived paid status + dispatch/order/customer lineage. INTERNAL-ONLY; security_invoker → grower JWT sees 0 rows.';

-- ── Open debtor ledger (unpaid / part-paid, aged) ────────────────────────────
create or replace view semantic.ar_debtor_open
  with (security_invoker = true) as
select
  invoice_id, invoice_no, invoice_type, invoice_date, consignee_id, consignee_name,
  amount_value, paid_amount, credit_amount, open_amount, paid_status,
  (current_date - invoice_date) as days_outstanding,
  case
    when invoice_date is null then 'unknown'
    when current_date - invoice_date <= 30 then '0-30'
    when current_date - invoice_date <= 60 then '31-60'
    when current_date - invoice_date <= 90 then '61-90'
    else '90+'
  end as aging_bucket
from core.fact_customer_invoice
where paid_status in ('unpaid', 'part') and coalesce(open_amount, 0) > 0.01;
grant select on semantic.ar_debtor_open to authenticated, cube_readonly;
comment on view semantic.ar_debtor_open is
  'Open receivables (unpaid / part-paid) with aging buckets. INTERNAL-ONLY; security_invoker → grower sees 0. NB paid status is NetSuite-derived; no_ns_match invoices are excluded (not provably open).';

-- ── Remittance reconciliation (the discrepancy report) ───────────────────────
create or replace view semantic.ar_remittance_reconciliation
  with (security_invoker = true) as
select
  rl.line_id, rl.retailer, rl.payment_no, rl.period_ending, rl.seq,
  rl.invoice_no, rl.doc_type, rl.doc_date, rl.store_no, rl.is_claim,
  rl.document_amount, rl.discount_amount, rl.payment_amount,
  rl.matched_invoice_id, rl.invoice_amount, rl.variance,
  rl.consignee_id, rl.consignee_name,
  rl.recon_status,
  fci.paid_status as invoice_paid_status,
  fci.paid_date   as invoice_paid_date
from core.fact_remittance_line rl
left join core.fact_customer_invoice fci on fci.invoice_id = rl.matched_invoice_id;
grant select on semantic.ar_remittance_reconciliation to authenticated, cube_readonly;
comment on view semantic.ar_remittance_reconciliation is
  'Customer remittance lines reconciled to invoices: matched / amount_mismatch / claim / unmatched, with the Coles settlement discount + variance. The headline AR-automation surface. INTERNAL-ONLY; security_invoker → grower sees 0.';
