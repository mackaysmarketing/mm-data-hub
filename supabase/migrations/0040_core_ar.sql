-- 0040_core_ar — the AR core: customer invoices with cash/paid status, + remittance reconciliation.
--
-- Two facts, INTERNAL-ONLY (customer book is commercially sensitive; no grower RLS), fail-closed to
-- is_internal_claim() + cube_readonly read-all — the exact 0024 order-fact posture.
--
--   core.fact_customer_invoice — grain = a FreshTrack customer-AR invoice (invoice_type IN
--     PI/SI/CN/DR; RCTI excluded as grower leakage). Lineage via the dispatch_load_invoice junction
--     (1 load/invoice) → dispatch → consignee (customer) + order/po. Cash/paid status DERIVED FROM
--     NETSUITE: FreshTrack `payment_status` is stale (PB on already-paid invoices — proven), so the
--     truth comes from NS via the deterministic crosswalk `ns_customer_invoice.externalid =
--     ft_invoice.invoice_no`, then the apply-link (`previoustransactionlinelink`, previoustype
--     CustInvc): paid_amount = Σ applied CustPymt, credit_amount = Σ applied CustCred, paid_date =
--     max payment nextdate. paid_status = paid / part / unpaid by |settled| vs |invoice|.
--     Unmatched-to-NS (Opening-Balance migration rows, ~885) → null NS fields, flagged.
--
--   core.fact_remittance_line — grain = a Coles remittance line. Classifies each against
--     fact_customer_invoice by literal invoice_no (NEVER strip a suffix — FT003402A ≠ FT003402):
--       matched         — invoice found, remittance document $ ties to our invoice amount
--       amount_mismatch — invoice found, remittance document $ differs (investigate)
--       claim           — LJ / non-FT line (REV…, bare number), no invoice = the deductions bucket
--       unmatched       — a KD line whose invoice_no resolves to no FreshTrack invoice (e.g. suffix
--                         variant) — surfaced, never silently dropped
--     Carries the Coles 2.5% settlement discount and the variance for the discrepancy report.

-- ═══════════════════════════════════════════════════════════════════════════
-- core.fact_customer_invoice
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.fact_customer_invoice (
  invoice_id         uuid primary key,     -- raw.ft_invoice.id
  invoice_no         text,                 -- FTxxxxx (the NS externalid crosswalk key)
  invoice_type       text,                 -- PI / SI / CN / DR
  amount_value       numeric,              -- FreshTrack invoice total (our source of truth; never coalesced)
  amount_currency    text,
  ft_payment_status  text,                 -- STALE FreshTrack code (PB/PD/…) — carried for reference ONLY
  invoice_date       date,                 -- sent_on::date (fallback created_on)
  consignee_id       uuid,                 -- CUSTOMER (via dispatch_load_invoice → dispatch_load)
  consignee_name     text,                 -- denormalised from core.dim_customer
  dispatch_load_id   uuid,
  load_no            text,
  order_id           uuid,
  order_no           text,
  po_no              text,
  ns_invoice_id      text,                 -- raw.ns_customer_invoice.id (null = not synced to NS / Opening Balance)
  ns_tranid          text,
  ns_amount          numeric,              -- NS foreigntotal (should equal amount_value)
  paid_amount        numeric,              -- Σ applied CustPymt (actual cash); null = no NS match
  credit_amount      numeric,              -- Σ applied CustCred
  paid_date          date,                 -- max CustPymt apply date; null = unpaid (never zero-dated)
  paid_status        text,                 -- paid / part / unpaid / no_ns_match
  open_amount        numeric,              -- amount_value − settled (>0 = still owed)
  _built_at          timestamptz not null default now()
);
create index if not exists ix_fci_consignee on core.fact_customer_invoice (consignee_id);
create index if not exists ix_fci_invoice_no on core.fact_customer_invoice (invoice_no);
create index if not exists ix_fci_paid_status on core.fact_customer_invoice (paid_status);
comment on table core.fact_customer_invoice is
  'Customer AR invoice (FreshTrack origin, invoice_type PI/SI/CN/DR; RCTI excluded). Cash/paid status DERIVED from NetSuite via externalid=invoice_no + apply-links (FreshTrack payment_status is stale). INTERNAL-ONLY.';

create or replace function core.refresh_fact_customer_invoice() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_customer_invoice;
  insert into core.fact_customer_invoice (
    invoice_id, invoice_no, invoice_type, amount_value, amount_currency, ft_payment_status,
    invoice_date, consignee_id, consignee_name, dispatch_load_id, load_no, order_id, order_no, po_no,
    ns_invoice_id, ns_tranid, ns_amount, paid_amount, credit_amount, paid_date, paid_status,
    open_amount, _built_at
  )
  with load1 as (
    -- 1 dispatch_load per invoice (grain proven); pick deterministically if a dup ever appears
    select distinct on (j.invoice_id) j.invoice_id, j.dispatch_load_id
    from raw.ft_dispatch_load_invoice j order by j.invoice_id, j.dispatch_load_id
  ),
  paid as (
    select previousdoc as ns_id,
           round(sum(foreignamount) filter (where nexttype = 'CustPymt'), 2) as paid_amount,
           round(sum(foreignamount) filter (where nexttype = 'CustCred'), 2) as credit_amount,
           max(nextdate) filter (where nexttype = 'CustPymt') as paid_date
    from raw.ns_ar_apply_link
    where previoustype = 'CustInvc'
    group by previousdoc
  )
  select
    i.id, i.invoice_no, i.invoice_type, i.amount_value, i.amount_currency, i.payment_status,
    coalesce(i.sent_on, i.created_on)::date,
    dl.consignee_id, c.name, l.dispatch_load_id, dl.load_no, dl.order_id, dl.order_no, dl.po_no,
    ni.id, ni.tranid, ni.foreigntotal,
    p.paid_amount, p.credit_amount, p.paid_date,
    case
      when ni.id is null then 'no_ns_match'
      when abs(coalesce(p.paid_amount,0) + coalesce(p.credit_amount,0)) >= abs(coalesce(ni.foreigntotal, i.amount_value)) - 0.01
           and coalesce(p.paid_amount,0) + coalesce(p.credit_amount,0) <> 0 then 'paid'
      when coalesce(p.paid_amount,0) + coalesce(p.credit_amount,0) <> 0 then 'part'
      else 'unpaid'
    end,
    round(coalesce(i.amount_value,0) - (coalesce(p.paid_amount,0) + coalesce(p.credit_amount,0)), 2),
    now()
  from raw.ft_invoice i
  left join load1 l on l.invoice_id = i.id
  left join raw.ft_dispatch_load dl on dl.id = l.dispatch_load_id
  left join core.dim_customer c on c.consignee_id = dl.consignee_id
  left join raw.ns_customer_invoice ni on ni.externalid = i.invoice_no
  left join paid p on p.ns_id = ni.id
  where i.invoice_type in ('PI','SI','CN','DR');   -- customer AR only; RCTI = grower leakage
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_customer_invoice() is
  'Idempotent rebuild of core.fact_customer_invoice. Paid status from NetSuite apply-links via externalid=invoice_no. Run after ft:invoice:load + ns:ar:load + refresh_dim_customer.';

-- ═══════════════════════════════════════════════════════════════════════════
-- core.fact_remittance_line
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.fact_remittance_line (
  line_id           text primary key,      -- raw.remittance_line.id
  remittance_id     text,
  retailer          text,
  payment_no        text,                  -- the Coles cash reference
  period_ending     date,
  seq               integer,
  invoice_no        text,                  -- verbatim (suffix preserved)
  doc_type          text,                  -- KD invoice / LJ claim
  doc_date          date,
  store_no          text,                  -- C + consignee b2b_code
  document_amount   numeric,               -- gross Coles says the invoice was
  discount_amount   numeric,               -- Coles 2.5% settlement discount (= the retail rebate)
  payment_amount    numeric,               -- net cash on this line (= document − discount)
  gst               numeric,
  wt                numeric,
  is_claim          boolean,
  matched_invoice_id uuid,                 -- core.fact_customer_invoice.invoice_id (null = no match)
  invoice_amount    numeric,               -- our FreshTrack invoice amount for the matched invoice
  consignee_id      uuid,
  consignee_name    text,
  recon_status      text,                  -- matched / amount_mismatch / claim / unmatched
  variance          numeric,               -- document_amount − invoice_amount (matched/mismatch)
  _built_at         timestamptz not null default now()
);
create index if not exists ix_frl_remittance on core.fact_remittance_line (remittance_id);
create index if not exists ix_frl_status on core.fact_remittance_line (recon_status);
create index if not exists ix_frl_invoice on core.fact_remittance_line (matched_invoice_id);
comment on table core.fact_remittance_line is
  'Coles remittance line reconciled to core.fact_customer_invoice by literal invoice_no. recon_status matched/amount_mismatch/claim/unmatched. INTERNAL-ONLY.';

create or replace function core.refresh_fact_remittance_line() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_remittance_line;
  insert into core.fact_remittance_line (
    line_id, remittance_id, retailer, payment_no, period_ending, seq, invoice_no, doc_type, doc_date,
    store_no, document_amount, discount_amount, payment_amount, gst, wt, is_claim,
    matched_invoice_id, invoice_amount, consignee_id, consignee_name, recon_status, variance, _built_at
  )
  select
    rl.id, rl.remittance_id, r.retailer, r.payment_no, r.period_ending, rl.seq, rl.invoice_no,
    rl.doc_type, rl.doc_date, rl.store_no, rl.document_amount, rl.discount_amount, rl.payment_amount,
    rl.gst, rl.wt, rl.is_claim,
    fci.invoice_id, fci.amount_value, fci.consignee_id, fci.consignee_name,
    case
      when rl.is_claim then 'claim'
      when fci.invoice_id is null then 'unmatched'
      when abs(rl.document_amount - coalesce(fci.amount_value, 0)) <= 0.01 then 'matched'
      else 'amount_mismatch'
    end,
    case when fci.invoice_id is not null
         then round(rl.document_amount - coalesce(fci.amount_value, 0), 2) end,
    now()
  from raw.remittance_line rl
  join raw.remittance r on r.id = rl.remittance_id
  -- literal join (suffix preserved). fact_customer_invoice.invoice_no is unique per invoice.
  left join core.fact_customer_invoice fci on fci.invoice_no = rl.invoice_no;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_remittance_line() is
  'Idempotent rebuild of core.fact_remittance_line. Literal invoice_no join to fact_customer_invoice. Run after refresh_fact_customer_invoice + remit:load.';

-- ── RLS: INTERNAL-ONLY (fail-closed) + cube read-all — the 0024 pattern ──────
alter table core.fact_customer_invoice enable row level security;
alter table core.fact_remittance_line  enable row level security;
grant select on core.fact_customer_invoice, core.fact_remittance_line to authenticated;

drop policy if exists internal_only_fact_customer_invoice on core.fact_customer_invoice;
create policy internal_only_fact_customer_invoice on core.fact_customer_invoice
  for select to authenticated using (semantic.is_internal_claim());
drop policy if exists internal_only_fact_remittance_line on core.fact_remittance_line;
create policy internal_only_fact_remittance_line on core.fact_remittance_line
  for select to authenticated using (semantic.is_internal_claim());

grant select on core.fact_customer_invoice, core.fact_remittance_line to cube_readonly;
drop policy if exists cube_readonly_read_all on core.fact_customer_invoice;
create policy cube_readonly_read_all on core.fact_customer_invoice for select to cube_readonly using (true);
drop policy if exists cube_readonly_read_all on core.fact_remittance_line;
create policy cube_readonly_read_all on core.fact_remittance_line for select to cube_readonly using (true);
