-- 0037_raw_ft_invoice — FreshTrack CUSTOMER INVOICE landing (read-replica source), Sprint: AR.
--
-- The RECEIVABLE mirror's ORIGIN. FreshTrack is where a customer invoice is born (it EDIs to the
-- supermarkets and pushes to NetSuite for debtor management). Lands the invoice header + the
-- dispatch-load junction that carries the load-grain lineage back into raw.ft_dispatch_load
-- (already landed) → consignee (customer) + order/po.
--
--   ft_invoice               — header grain (14,086 rows live 2026-07-12). NO invoice-line table
--                              exists at source; the invoice IS the grain. amount_value = the
--                              invoiced total.
--   ft_dispatch_load_invoice — junction (14,054 rows). Exactly 1 dispatch_load per invoice
--                              (verified live: 14,054 invoices × 1 load) → deterministic join to
--                              raw.ft_dispatch_load for consignee_id / order_id / po_no.
--
-- CUSTOMER-AR SCOPE = invoice_type IN ('PI','SI','CN','DR')  (≈ 13,275 rows live).
--   PI Product Invoice · SI Service Invoice · CN Credit Note · DR Debit note.
--   invoice_type = 'RCTI' (742 rows) is GROWER-settlement leakage (the payable side, already modelled
--   by NetSuite RCTIs + FreshTrack GP) — landed faithfully here but EXCLUDED in core (this is an AR
--   domain). ~69 rows carry a NULL invoice_type — neither AR nor RCTI; landed, resolved in core.
--   Raw lands EVERY row faithfully; the scope filter is applied downstream in core, never at pull.
--
-- Same contract as the other raw FreshTrack landings (0017/0018/0033, copied): faithful useful-subset
-- mirror of the source columns (snake_case already matches the replica), text not enum (SPEC §2),
-- numerics never coalesced (SPEC §9.3), temporal columns read via ::text in the loader (never through
-- a +10 JS Date). _raw jsonb on the header (keeps comment/paid_currency/etc. for audit); NO _raw on
-- the junction (mirrors 0017 ft_gp_detail — the leaner child table). Source NOT-NULL constraints are
-- intentionally not replicated (raw lands tolerantly; integrity asserted in core/semantic).
--
-- DESIGN FACTS (verified live 2026-07-12 — build to these, see SPRINT.md ground truth):
--   • ext_link = the NetSuite internalid (the push target). The deterministic FT↔NetSuite crosswalk
--     is NetSuite CustInvc.externalid = this.invoice_no (FTxxxxx), NOT ext_link — but ext_link is
--     landed for provenance.
--   • payment_status is a STALE code (PB observed on already-remitted invoices) and paid_on is dead
--     (4/14,086 populated) — FreshTrack has NO usable paid truth. The paid date/amount comes from the
--     NetSuite CustPymt apply-links (Chunk 2) and the customer remittance (Chunk 3), joined in core.
--     Both columns are landed faithfully so the staleness is visible, never trusted.
--   • Incremental key = last_modified_on (both source tables; NOT NULL at source).
--
-- POSTURE (raw etl-only, matches 0017/0018/0033): NO authenticated grant, RLS NOT enabled — raw is
-- reachable only by service_role (ETL) and cube_readonly. The explicit cube_readonly grant is
-- belt-and-braces over the 0011 default privileges. rls_posture class = 'etl-only'.

-- ── ft_invoice (customer invoice header) ─────────────────────────────────────
create table if not exists raw.ft_invoice (
  id                uuid primary key,
  invoice_no        text,          -- FTxxxxx — the FT↔NetSuite crosswalk key (= NS CustInvc.externalid)
  invoice_type      text,          -- PI / SI / CN / DR (customer AR) · RCTI (grower leakage, excluded in core) · null
  amount_value      numeric,       -- invoiced total; nullable, never coalesced (SPEC §9.3)
  amount_currency   text,
  payment_status    text,          -- PB / PD / DR / VD — STALE (PB seen on remitted invoices); not trusted for paid truth
  sync_status       text,          -- SY / US — NetSuite push status
  ext_link          text,          -- NetSuite internalid (push target); provenance only, not the crosswalk key
  sent_on           timestamptz,
  paid_on           timestamptz,   -- DEAD at source (4/14,086); paid truth comes from NetSuite/remittance in core
  paid_value        numeric,       -- likewise unreliable; never coalesced
  created_on        timestamptz,
  last_modified_on  timestamptz,   -- the INCREMENTAL watermark
  sync_on           timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
create index if not exists ix_ft_invoice_type on raw.ft_invoice (invoice_type);
create index if not exists ix_ft_invoice_no on raw.ft_invoice (invoice_no);
create index if not exists ix_ft_invoice_lastmod on raw.ft_invoice (last_modified_on);
comment on table raw.ft_invoice is 'FreshTrack customer invoice header (read-replica) — the AR ORIGIN. Header grain (no line table at source). Customer-AR scope = invoice_type IN (PI,SI,CN,DR); RCTI (742) is grower leakage excluded in core. invoice_no (FTxxxxx) = the NetSuite CustInvc.externalid crosswalk key. Incremental key = last_modified_on.';
comment on column raw.ft_invoice.invoice_no is 'FTxxxxx. The deterministic crosswalk to NetSuite (CustInvc.externalid) and to Coles remittance (KD line invoice_no). Match literally incl. any suffix letter (FT003402A ≠ FT003402).';
comment on column raw.ft_invoice.payment_status is 'PB/PD/DR/VD. STALE — PB observed on already-remitted invoices. Landed for visibility; the paid truth is the NetSuite CustPymt apply-links + the customer remittance, joined in core. Never trusted here.';
comment on column raw.ft_invoice.paid_on is 'DEAD at source (4/14,086 populated). Never a paid-date source; landed faithfully so its emptiness is auditable.';
comment on column raw.ft_invoice.ext_link is 'NetSuite internalid (the push target). Provenance only — the FT↔NetSuite join is CustInvc.externalid = invoice_no, not ext_link.';

-- ── ft_dispatch_load_invoice (invoice ↔ dispatch_load junction) ──────────────
create table if not exists raw.ft_dispatch_load_invoice (
  id                uuid primary key,
  invoice_id        uuid,          -- → raw.ft_invoice.id
  dispatch_load_id  uuid,          -- → raw.ft_dispatch_load.id (already landed) — the lineage anchor
  created_on        timestamptz,
  last_modified_on  timestamptz,   -- the INCREMENTAL watermark
  _synced_at        timestamptz not null default now()
);
create index if not exists ix_ft_dispatch_load_invoice_invoice on raw.ft_dispatch_load_invoice (invoice_id);
create index if not exists ix_ft_dispatch_load_invoice_load on raw.ft_dispatch_load_invoice (dispatch_load_id);
create index if not exists ix_ft_dispatch_load_invoice_lastmod on raw.ft_dispatch_load_invoice (last_modified_on);
comment on table raw.ft_dispatch_load_invoice is 'FreshTrack invoice ↔ dispatch_load junction (read-replica). Exactly 1 dispatch_load per invoice (verified live). Joins raw.ft_invoice → raw.ft_dispatch_load for consignee (customer) + order_id/po_no lineage. Incremental key = last_modified_on.';

-- ── Grants (belt-and-braces over 0011 default privileges; NO authenticated grant, no RLS) ──
grant select on raw.ft_invoice, raw.ft_dispatch_load_invoice to cube_readonly;
