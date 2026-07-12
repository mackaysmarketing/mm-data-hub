-- 0038_raw_ns_customer_ar — NetSuite ACCOUNTS-RECEIVABLE landing (AR sprint, chunk C2).
--
-- The debtor/cash MIRROR of customer invoices. FreshTrack is the invoice ORIGIN (raw.ft_invoice,
-- 0037); NetSuite is where those invoices are booked as receivables, paid, and credited. This
-- lands the four AR transaction streams + the apply map + the customer crosswalk master, read-only
-- via the SuiteQL REST endpoint over OAuth 1.0a TBA (src/lib/netsuite.ts, same client as the RCTIs).
--
-- THE CROSSWALK (deterministic): raw.ns_customer_invoice.externalid = FreshTrack invoice.invoice_no
-- (FTxxxxx). Opening-Balance migration rows carry a non-FT externalid + memo='Opening Balance' and
-- are flagged/excluded from the FT reconciliation in core — landed faithfully here, never dropped.
--
-- Field names are the REAL REST SuiteQL columns (confirmed live 2026-07-12 via a read-only probe).
-- The REST `transactionline` schema is NARROWER than SuiteScript's — NO amount/posting/account
-- columns (use foreignamount/netamount), and `transaction` has NO subsidiary column. Subsidiary-2
-- scope comes transitively from the customer filter (customer.subsidiary=2, 127 customers). Dates
-- arrive DD/MM/YYYY from SuiteQL and are landed ISO via TO_CHAR(...) in the loader SELECT, so a date
-- never round-trips through a +10 JS Date (off-by-one). All ids are NetSuite internal ids, landed as
-- TEXT (the AR set stays text end-to-end; the bridge to the FreshTrack/uuid world is core, via
-- externalid=invoice_no → consignee). No enums (SPEC §2); numerics never coalesced (SPEC §9.3).
--
-- POSTURE (matches the 0017/0018/0033/0014 raw pattern): NO authenticated grant, RLS NOT enabled —
-- raw is reachable only by service_role (ETL) and cube_readonly. The explicit cube_readonly grant is
-- belt-and-braces over the 0011 default privileges. rls_posture class 'etl-only'.

-- ── Customer master (the AR crosswalk source; subsidiary-2 debtors) ───────────
create table if not exists raw.ns_customer (
  id            text primary key,              -- NetSuite customer internal id
  entityid      text,                          -- the customer CODE / number
  companyname   text,
  externalid    text,                          -- may carry an FT id on some customers
  subsidiary    text,                          -- '2' = Mackays Marketing
  isinactive    text,                          -- 'T' / 'F' (landed faithfully as text, no enum)
  _raw          jsonb,
  _synced_at    timestamptz not null default now()
);
comment on table raw.ns_customer is 'NetSuite subsidiary-2 customers (the AR debtor book). Small master (127 rows) — full-sync each run, _raw kept. Bridges to core.dim_customer by entityid/name (documented in core).';

-- ── Customer invoices (CustInvc headers) ─────────────────────────────────────
create table if not exists raw.ns_customer_invoice (
  id           text primary key,               -- NetSuite transaction internal id
  tranid       text,                           -- the NS number (MM…; 35… = Opening Balance migration)
  externalid   text,                           -- = FreshTrack invoice.invoice_no (FTxxxxx) — THE crosswalk
  trandate     date,                           -- the invoice (business) date
  entity       text,                           -- customer id → raw.ns_customer.id
  foreigntotal numeric,                        -- the authoritative invoice total (positive receivable)
  status       text,
  otherrefnum  text,                           -- customer PO / reference
  _synced_at   timestamptz not null default now()
);
create index if not exists ns_customer_invoice_externalid_idx on raw.ns_customer_invoice (externalid);
create index if not exists ns_customer_invoice_entity_idx     on raw.ns_customer_invoice (entity);
comment on table raw.ns_customer_invoice is 'NetSuite customer invoices (AR). externalid = FreshTrack invoice_no (FTxxxxx) is THE deterministic crosswalk. Opening-Balance rows (tranid 35…, memo Opening Balance) carry a non-FT externalid — flagged/excluded from FT reconciliation in core, never dropped.';
comment on column raw.ns_customer_invoice.externalid is 'FreshTrack invoice.invoice_no (FTxxxxx). The join key core.fact_customer_invoice uses to enrich the FT invoice with NS paid_date/paid_amount.';

-- ── Customer invoice lines (transactionline) ─────────────────────────────────
-- Same line-type contract as the RCTIs: mainline='T' = the A/R summary line (= foreigntotal);
-- taxline='T' = GST; clean detail = mainline='F' AND taxline='F'. mainline/taxline landed as the
-- raw 'T'/'F' text (no enum). No amount/posting/account cols in the REST schema.
create table if not exists raw.ns_customer_invoice_line (
  uniquekey     text primary key,              -- globally unique transactionline key
  transaction   text,                          -- invoice id → raw.ns_customer_invoice.id
  mainline      text,                          -- 'T' = the A/R summary line (= invoice total)
  taxline       text,                          -- 'T' = tax line (GST)
  item          text,                          -- item id (null on mainline/tax lines)
  foreignamount numeric,                       -- the signed line amount
  netamount     numeric,
  _synced_at    timestamptz not null default now()
);
create index if not exists ns_customer_invoice_line_txn_idx on raw.ns_customer_invoice_line (transaction);
comment on table raw.ns_customer_invoice_line is 'NetSuite customer-invoice lines. mainline=T row = invoice total (foreignamount = foreigntotal); taxline=T isolates GST; clean detail = mainline=F AND taxline=F.';

-- ── Customer payments (CustPymt headers) — the PAID DATE / cash source ────────
create table if not exists raw.ns_customer_payment (
  id           text primary key,               -- NetSuite transaction internal id
  tranid       text,                           -- the NS payment number
  trandate     date,                           -- the PAID DATE (via the apply link → invoice)
  entity       text,                           -- customer id → raw.ns_customer.id
  foreigntotal numeric,                        -- the payment total (ties to a remittance Total)
  otherrefnum  text,                           -- carries the remittance / Coles payment ref
  _synced_at   timestamptz not null default now()
);
create index if not exists ns_customer_payment_entity_idx on raw.ns_customer_payment (entity);
comment on table raw.ns_customer_payment is 'NetSuite customer payments. foreigntotal ties to a remittance Total; otherrefnum carries the remittance/payment ref. Applied to invoices via raw.ns_ar_apply_link (nextdate = paid date).';

-- ── Customer credits (CustCred headers) ──────────────────────────────────────
create table if not exists raw.ns_customer_credit (
  id           text primary key,               -- NetSuite transaction internal id
  tranid       text,                           -- the NS credit-memo number
  trandate     date,
  entity       text,                           -- customer id → raw.ns_customer.id
  foreigntotal numeric,                        -- credit total (negative)
  otherrefnum  text,                           -- carries a Coles claim/payment ref (e.g. 3300270575 or an FT…)
  _synced_at   timestamptz not null default now()
);
create index if not exists ns_customer_credit_entity_idx on raw.ns_customer_credit (entity);
comment on table raw.ns_customer_credit is 'NetSuite customer credit memos (AR). foreigntotal is negative; otherrefnum carries the Coles claim/payment ref used in remittance reconciliation. Applied to invoices via raw.ns_ar_apply_link (nexttype=CustCred).';

-- ── Invoice→(payment|credit) apply map (PreviousTransactionLineLink, AR side) ─
-- previoustype='CustInvc' captures EVERY application against an invoice — payments (nexttype=CustPymt,
-- linktype=Payment) AND credit memos (nexttype=CustCred) — distinguished by linktype/nexttype. PTLL
-- has no single id; the PK is synthesized from the four-part natural key (doc/doc/line/line, computed
-- in the SuiteQL SELECT) so the apply map upserts idempotently without a collision dropping a link.
create table if not exists raw.ns_ar_apply_link (
  link_key      text primary key,              -- previousdoc-nextdoc-previousline-nextline (synthesized)
  previousdoc   text,                          -- invoice id → raw.ns_customer_invoice.id
  nextdoc       text,                          -- payment id (CustPymt) or credit id (CustCred)
  previoustype  text,                          -- 'CustInvc'
  nexttype      text,                          -- 'CustPymt' / 'CustCred'
  linktype      text,                          -- 'Payment' / …
  foreignamount numeric,                       -- amount of the invoice settled by this application
  nextdate      date,                          -- the application date (= paid date when nexttype=CustPymt)
  _synced_at    timestamptz not null default now()
);
create index if not exists ns_ar_apply_link_previousdoc_idx on raw.ns_ar_apply_link (previousdoc);
create index if not exists ns_ar_apply_link_nextdoc_idx     on raw.ns_ar_apply_link (nextdoc);
comment on table raw.ns_ar_apply_link is 'Invoice→payment/credit apply mapping (PTLL, previoustype=CustInvc). An invoice is paid when SUM(foreignamount) over its Payment links = its foreigntotal; paid_date = max(nextdate) over Payment links. No link = unpaid (null paid_date in core, never zero-dated).';

-- ── Grants (belt-and-braces over 0011 default privileges; NO authenticated grant, no RLS) ──
grant select on raw.ns_customer, raw.ns_customer_invoice, raw.ns_customer_invoice_line,
                raw.ns_customer_payment, raw.ns_customer_credit, raw.ns_ar_apply_link
  to cube_readonly;
