# Sprint: Accounts Receivable — customer invoices, cash mirror, Coles remittance reconciliation
Date: 2026-07-12
Repo: mm-data-hub

## Why this bundle
The hub models the PAYABLE side of grower money two ways (NetSuite RCTIs + FreshTrack GP). This sprint
builds the RECEIVABLE mirror: customer invoices (what supermarkets owe us), the cash/paid status, and
automated reconciliation of **customer remittance advices** against our invoices. All INTERNAL-ONLY
(the customer book is commercially sensitive; never grower-facing). Every design fact below was
verified live 2026-07-12 — do not re-derive, but re-confirm counts (they grow).

## Ground truth (verified live 2026-07-12 — the design rests on these)
- **FreshTrack = invoice ORIGIN.** `public.invoice` (14,086 rows; customer AR = `invoice_type IN
  ('PI','SI','CN','DR')` ≈ 13,275; exclude 742 `RCTI` grower-leakage rows). HEADER GRAIN — no
  invoice-line table. `public.dispatch_load_invoice` junction = exactly 1 dispatch_load per invoice →
  joins `raw.ft_dispatch_load` (already landed) → consignee (customer) + order_id/po_no. Lineage
  proven: on PI+SI invoiced loads po_no 100%, dispatch_load_id 100%, order_id 88%. FreshTrack has NO
  usable paid date (`invoice.paid_on` dead 4/14,086); `invoice.payment_status` is a STALE code (PB
  on already-remitted invoices — proven). Incremental key `last_modified_on`.
- **NetSuite = debtor/cash MIRROR** (subsidiary 2; `customer.subsidiary=2` reachable). Types:
  `CustInvc` 13,216 · `CustPymt` 2,173 · `CustCred` 578 · `CustDep` 17 (2024-09-24→2026-07-10).
  **THE CROSSWALK: `CustInvc.externalid` = FreshTrack `invoice.invoice_no` (FTxxxxx)** — deterministic
  (verified: externalid `FT000899`/`FT001311`…). `tranid` = NS number (MM…; 697 `35…` = Opening
  Balance migration rows, memo='Opening Balance', NO FT number → flag+exclude from FT reconciliation).
  Paid path = `previoustransactionlinelink` `linktype='Payment'`, `previoustype='CustInvc'` →
  `CustPymt` (12,104 links) → payment `trandate` = paid date, applied `foreignamount` = applied cash.
  `CustPymt.foreigntotal` ties to remittance Total (payment 181998 = $1,898,521.87 = Coles Payment No
  3300004309). `CustCred.otherrefnum` carries Coles claim/payment refs (e.g. `3300270575`, or an
  `FT…`). Same REST SuiteQL shape as the RCTI loader (mainline='T' summary = `foreigntotal`, taxline,
  `uniquekey` line PK, `foreignamount`/`netamount`; NO amount/posting/account, NO transaction.subsidiary).
- **Coles remittance = text-based PDF** (clean pypdf extract, NO OCR). Filename
  `YYYYMMDD_<colesAcct 942306>_<seq>_<paymentNo>.pdf`. Line table: `Invoice/Claim No | Doc Type
  (KD=invoice / LJ=claim-adjustment) | Date DD.MM.YYYY | Store No (C+consignee b2b_code, e.g.
  C9314FV=Coles Melbourne) | Document $ (gross) | Discount $ (Coles 2.5% settlement = the retail
  rebate) | Payment $ (net) | GST | WT`; then `Total for Coles Supermarkets` + a Payment-No summary.
  Header/footer: **Payment No**, **Period Ending**, **Total Amount**, Vendor No 6007716. Checksum:
  Σ line Payment$ = Total Amount (proven $1,898,521.87 / 81 lines / 3 pages incl. a negative claim).
  **Reconciliation join proven live: KD line `invoice_no` (FTxxxxx) = FreshTrack `invoice.invoice_no`
  EXACT on amount → Coles consignee (6/6 sampled).** Edge cases (all in the 2 samples): suffix
  variants (`FT003402A` ≠ `FT003402` — match literally, NEVER strip the letter), claim/adjustment
  lines (`REV…`, bare `1295067`, type LJ, can be negative) that match no invoice = the deductions
  bucket. **Key value: FreshTrack payment_status is stale → the remittance (corroborated by NS
  CustPymt) IS the paid truth.**

## Scope — build order

### Chunk 1 — FreshTrack invoice landing (migration 0037, loader `ft:invoice:load`)
`raw.ft_invoice` (header, faithful useful-subset incl. `invoice_no`, `invoice_type`, `amount_value`,
`amount_currency`, `payment_status`, `sync_status`, `ext_link`, `sent_on`, `paid_on`, `created_on`,
`last_modified_on`) + `raw.ft_dispatch_load_invoice` (junction: id, invoice_id, dispatch_load_id,
timestamps). Replica full-sync/incremental by `last_modified_on`, idempotent upsert on id, sync_window
resume — mirror `src/loaders/ft_gp.ts` + the reference loader. Posture: raw etl-only (cube_readonly
grant, no authenticated, no RLS — the 0017/0018 pattern).

### Chunk 2 — NetSuite AR landing (migration 0038, loader `ns:ar:load`)
`raw.ns_customer_invoice` (header: id, tranid, externalid=FT no, trandate, entity, foreigntotal,
status, otherrefnum) + `raw.ns_customer_invoice_line` (uniquekey PK, transaction, mainline, taxline,
item, foreignamount, netamount) + `raw.ns_customer_payment` (id, tranid, trandate, entity,
foreigntotal, otherrefnum) + `raw.ns_customer_credit` (id, tranid, trandate, entity, foreigntotal,
otherrefnum) + `raw.ns_ar_apply_link` (PTLL AR side: previousdoc, nextdoc, previoustype, nexttype,
linktype, foreignamount, nextdate). SuiteQL via existing `src/lib/netsuite.ts`; scope customers to
`subsidiary=2`; incremental by `lastmodifieddate`. Mirror `src/loaders/ns_settlement.ts`. Raw etl-only.

### Chunk 3 — Coles remittance parser + landing (migration 0039, `src/lib/remittance_coles.ts`, loader `remit:load`)
Pure, unit-tested parser: PDF text (via a text extractor — use `pdf-parse` or the same pypdf approach
invoked as a child process, OR a dependency-free text pass — decide at build; text extraction is
clean) → `{ header: {retailer:'coles', payment_no, period_ending, total_amount, vendor_no, source_file},
lines: [{ invoice_no, doc_type, doc_date, store_no, document_amount, discount_amount, payment_amount,
gst, wt, is_claim }] }`. Enforce the checksum (Σ payment_amount == total_amount) and surface any
drift. `raw.remittance` (header grain, natural key = retailer+payment_no) + `raw.remittance_line`.
Loader takes a file/dir of PDFs (channel = manual drop for now; auto-ingest deferred). Raw etl-only.
Parser is per-retailer pluggable (`remittance_coles` today; woolworths/aldi later) — keep the retailer
dispatch clean.

### Chunk 4 — Core: fact_customer_invoice + reconciliation (migration 0040, loader `ar:core`)
- `core.fact_customer_invoice` (invoice grain = FreshTrack invoice, customer AR types only): keys
  invoice_id, invoice_no, invoice_type, consignee_id (via junction→dispatch_load), dispatch_load_id,
  order_id, po_no, crop/product where available; measures amount_value; NS enrichment via
  `externalid=invoice_no` → ns_invoice_id, ns_tranid, **paid_date** (max apply-link nextdate),
  **paid_amount** (Σ applied), paid_status (paid/part/unpaid), is_short_pay. Denormalise
  consignee_name (dim_customer). Idempotent temp-table refresh (0031 perf pattern).
- `core.fact_remittance_line` (remittance line grain) with recon status: match remittance `invoice_no`
  → fact_customer_invoice (literal, incl. suffix); classify **matched / short_pay / over_pay /
  claim (LJ, no invoice) / unmatched**; carry document/discount/payment amounts + the invoice's
  amount for the variance. Crosswalks: NS customer→dim_customer by entityid/name (documented,
  surfaced-not-dropped); store_no→consignee b2b_code.

### Chunk 5 — Semantic + RLS (migration 0041)
INTERNAL-ONLY, security_invoker, fail-closed to `is_internal_claim()` + cube_readonly (the 0024/0025
pattern): `semantic.ar_customer_invoice` (invoice + paid status + lineage), `semantic.ar_debtor_open`
(open/aged invoices), `semantic.ar_remittance_reconciliation` (the discrepancy report: matched /
short-pay / claim / unmatched, with $ variance). Update `scripts/rls_posture.ts` REGISTRY for every
new relation (the sweep FAILS on unregistered relations — that is the point).

### Chunk 6 — Proofs
- `ar:reconcile` — FreshTrack invoice landing parity vs replica; NS↔FT invoice tie on externalid (match
  rate + unmatched buckets incl. Opening Balance); cash tie (Σ CustPymt applied vs invoices marked
  paid); all expectations DERIVED in-run (no hardcoded baselines — house contract).
- `remit:reconcile` — parser checksum on the 2 sample files; remittance→invoice match rate; the
  discrepancy buckets quantified; committed report.
- `ar:rls` — every AR fact + semantic view returns 0 under a grower/no-claim/forged JWT, real rows
  under internal.
- Re-run `rls:posture` (must stay green with the new relations registered) + the full existing battery.

## Acceptance Criteria
- [ ] **C1:** raw.ft_invoice + raw.ft_dispatch_load_invoice landed; counts pasted; customer-AR filter
      (exclude RCTI) applied; idempotent re-run lands 0 net-new.
- [ ] **C2:** raw.ns_customer_invoice/line/payment/credit + apply-link landed (subsidiary-2 scope);
      counts pasted; externalid=FT-number populated on the expected share (Opening-Balance rows
      flagged); paid-date path resolves (sample pasted).
- [ ] **C3:** Coles parser unit-tested; both sample PDFs parse with the checksum (Σ payment == total)
      EXACT; raw.remittance + raw.remittance_line landed; counts + a parsed sample pasted.
- [ ] **C4:** core.fact_customer_invoice built (invoice grain), paid_date/paid_amount/paid_status
      populated from NS; fact_remittance_line built with recon status; the 6-of-6 proven join holds at
      scale (match-rate pasted); NS↔FT invoice tie pasted.
- [ ] **C5:** semantic AR views exist, INTERNAL-ONLY; rls_posture REGISTRY updated; sweep green.
- [ ] **C6:** ar:reconcile + remit:reconcile + ar:rls all green with pasted evidence; the remittance
      discrepancy report shows matched/short-pay/claim/unmatched buckets on the real Coles payment;
      full existing battery still green; typecheck + tests.
- [ ] HANDOFF.md + CLAUDE.md updated; committed.

## Definition of Done
- [ ] All acceptance criteria checked with pasted evidence
- [ ] `npm run typecheck` clean; `npm test` green; every new + existing proof green
- [ ] Migrations touch only raw/core/semantic; INTERNAL-ONLY RLS proven fail-closed; no policy weakened
- [ ] No secrets; READ-ONLY out of FreshTrack + NetSuite (never write); clean tree at handoff

## Explicitly deferred (with reason)
- **Woolworths + ALDI remittance parsers** — need their sample files/formats (Tim to provide). The
  parser is built per-retailer pluggable so they slot in without rework. Coles is complete this sprint.
- **Auto-ingestion channel** (email/SFTP/portal fetch of remittance PDFs) — an ops integration; the
  loader consumes a file/dir for now. Channel confirmed later.
- **Cube exposure of AR metrics** — after the invoice + reconciliation definitions are signed off.
- **Revenue-class wiring** (settlement bridge) — still waiting on Tim's CSV; unrelated.

## Quality Rubric (Mackays / mm-data-hub)
- SQL is the oracle; counts reconcile across every boundary; no key dropped. Never coalesce nullable
  measures to 0. Deterministic crosswalks (externalid=FT no; NS customer→dim_customer documented).
- READ-ONLY out of both sources. Idempotent, resumable loaders. Parser pure + unit-tested + checksum.
- INTERNAL-ONLY RLS on every AR relation, proven fail-closed; new relations registered in rls_posture.
- Proof-style contract: NO hardcoded baselines — derive expected numbers in-run from source.

## Goal Condition
/goal The AR sprint is complete in mm-data-hub per SPRINT.md dated 2026-07-12: FreshTrack invoices +
NetSuite customer AR (invoices/payments/credits/apply-links) + Coles remittances are landed
(raw 0037/0038/0039); core.fact_customer_invoice carries NS-derived paid_date/paid_amount/paid_status
via CustInvc.externalid=invoice_no, and core.fact_remittance_line classifies every Coles line as
matched/short-pay/claim/unmatched (0040); semantic AR views are INTERNAL-ONLY and fail-closed (0041,
rls_posture registry updated + green); ar:reconcile, remit:reconcile (checksum exact on both sample
PDFs), and ar:rls are green with pasted evidence, and the full existing battery + typecheck + tests
stay green. READ-ONLY out of FreshTrack + NetSuite. Woolworths/ALDI parsers + auto-ingestion channel
deferred. Paste real command output for every criterion. Stop after 50 turns.
