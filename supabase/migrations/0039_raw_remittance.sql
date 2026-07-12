-- 0039_raw_remittance — customer REMITTANCE-ADVICE landing (AR sprint, Chunk 3).
--
-- A remittance advice is a supermarket's statement of what it paid us and how each document was
-- split (gross / settlement discount / net payment / GST / WT). It is the paid-truth mirror on the
-- receivable side: FreshTrack's invoice.payment_status is stale, so the remittance (corroborated by
-- the NetSuite CustPymt) IS the cash truth. Coles is the first retailer; the header carries a natural
-- key (retailer + payment_no) so Woolworths/ALDI land into the same two tables without rework.
--
-- Header grain = one payment (one advice). Line grain = one settled document (invoice or claim).
-- Faithful landing: text not enum (SPEC §2), amounts numeric and NEVER coalesced (SPEC §9.3), a
-- claim/adjustment line may be negative. Dates land as DATE (the parser emits ISO, no +10 JS-Date
-- round-trip). The checksum (Σ line payment_amount == header total_amount) is enforced by the loader
-- BEFORE landing (src/loaders/remittance.ts), not by a DB constraint.
--
-- POSTURE (matches 0017/0018/0033 raw): NO authenticated grant, RLS NOT enabled — raw is reachable
-- only by service_role (ETL) and cube_readonly. The explicit cube_readonly grant is belt-and-braces
-- over the 0011 default privileges. rls_posture class = 'etl-only'.

-- ── remittance (advice header, one per payment) ──────────────────────────────
create table if not exists raw.remittance (
  id             text primary key,   -- retailer || '-' || payment_no (natural key)
  retailer       text not null,
  payment_no     text not null,
  period_ending  date,
  total_amount   numeric,            -- header "Total Amount"; == Σ line payment_amount (loader checksum)
  vendor_no      text,               -- our vendor number in the retailer's system
  source_file    text,               -- provenance: the filename the advice was parsed from
  line_count     integer,            -- Σ document lines landed for this advice
  _raw           jsonb,
  _synced_at     timestamptz not null default now()
);
create index if not exists ix_remittance_retailer on raw.remittance (retailer);
comment on table raw.remittance is 'Customer remittance-advice headers (manual PDF drop; auto-ingest deferred). One row per retailer payment. Natural key id = retailer-payment_no. total_amount = the deposited cash and equals Σ remittance_line.payment_amount (loader-enforced checksum). The paid truth on the receivable side (FreshTrack payment_status is stale).';
comment on column raw.remittance.total_amount is 'Header Total Amount (deposited cash). Ties to Σ line payment_amount and to the NetSuite CustPymt foreigntotal. Numeric, never coalesced.';

-- ── remittance_line (one settled document per row) ───────────────────────────
create table if not exists raw.remittance_line (
  id               text primary key,  -- remittance_id || '-' || seq
  remittance_id    text not null,     -- → raw.remittance.id (no FK: raw lands tolerantly)
  seq              integer not null,  -- 1-based line order within the advice
  invoice_no       text,              -- verbatim; a trailing suffix letter is significant (FT003402A ≠ FT003402)
  doc_type         text,              -- Coles: KD = invoice, LJ = claim/adjustment. Text, never enum.
  doc_date         date,
  store_no         text,              -- Coles: C + consignee b2b_code (e.g. C9314FV)
  document_amount  numeric,           -- gross
  discount_amount  numeric,           -- settlement discount (retail rebate, Coles ~2.5%)
  payment_amount   numeric,           -- net (document - discount); the checksum column
  gst              numeric,
  wt               numeric,           -- withholding tax
  is_claim         boolean,           -- LJ, or invoice_no not an FT number → the deductions bucket
  _synced_at       timestamptz not null default now()
);
create index if not exists ix_remittance_line_remittance on raw.remittance_line (remittance_id);
create index if not exists ix_remittance_line_invoice on raw.remittance_line (invoice_no);
comment on table raw.remittance_line is 'Remittance-advice document lines, one per invoice/claim. payment_amount signed (claim lines can be negative) and never coalesced. invoice_no lands verbatim (suffix letter preserved) — the reconciliation join to core.fact_customer_invoice is literal on invoice_no. is_claim flags LJ / non-FT references (the deductions bucket that matches no invoice).';
comment on column raw.remittance_line.invoice_no is 'Verbatim invoice/claim number. NEVER strip a trailing suffix letter (FT003402A is a distinct document from FT003402). Reconciled literally against FreshTrack invoice.invoice_no.';
comment on column raw.remittance_line.payment_amount is 'Net payment for the line. Signed (a claim/adjustment can be negative). Σ over an advice = raw.remittance.total_amount. Never coalesced.';

-- ── Grants (belt-and-braces over 0011 default privileges; NO authenticated grant, no RLS) ──
grant select on raw.remittance, raw.remittance_line to cube_readonly;
