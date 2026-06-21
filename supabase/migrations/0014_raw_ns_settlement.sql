-- 0014_raw_ns_settlement — NetSuite RCTI / grower-settlement landing (Sprint 5).
--
-- Second source system: NetSuite (account 11176992), subsidiary 2 (Mackays Marketing).
-- RCTIs = transaction WHERE type='VendBill' AND entity IN (category-110 grower vendors).
-- Landed read-only via the SuiteQL REST endpoint over OAuth 1.0a TBA (src/lib/netsuite.ts).
--
-- Field names are the REAL SuiteQL REST columns (confirmed live via ns_getSuiteQLMetadata + probes).
-- NB: the REST `transactionline` schema is NARROWER than NetSuite's SuiteScript query API — it has
-- NO `amount`, `posting`, or `account` columns (use `foreignamount`/`netamount`), and `transaction`
-- has NO `subsidiary` column (subsidiary-2 scope comes transitively from the category-110 vendor
-- filter — all 39 grower vendors are subsidiary 2). Dates are landed ISO via SuiteQL TO_CHAR(...).
--
-- All ids are NetSuite internal ids (bigint). The bridge to the FreshTrack/uuid world is in `core`:
-- ns_vendor.entityid = core.dim_grower.code → consignor_id (the RLS anchor). No enums (SPEC §2).

-- ── Grower vendor master (the crosswalk source) ──────────────────────────────
create table if not exists raw.ns_vendor (
  id            bigint primary key,            -- NetSuite vendor internal id
  entityid      text,                          -- the grower CODE; = core.dim_grower.code
  externalid    text,                          -- rotten (LRCTU→'LRCDR', 2 nulls) — DO NOT use for crosswalk
  companyname   text,
  category      integer,                       -- 110 = Growers
  isinactive    boolean,
  subsidiary    integer,                       -- 2 = Mackays Marketing
  _raw          jsonb,
  _synced_at    timestamptz not null default now()
);
comment on table raw.ns_vendor is 'NetSuite grower vendors (category 110). entityid = dim_grower.code crosswalk key; externalid is unreliable.';

-- ── Item taxonomy (products + charge lines) ──────────────────────────────────
create table if not exists raw.ns_item (
  id            bigint primary key,            -- NetSuite item internal id
  itemid        text,                          -- the CODE (e.g. 910102, 121008); prefix = category
  displayname   text,                          -- 'Category - Subcategory - Detail' for charges; product name for 9xxxxx
  itemtype      text,
  _raw          jsonb,
  _synced_at    timestamptz not null default now()
);
comment on table raw.ns_item is 'NetSuite items on grower RCTI lines. itemid prefix + displayname drive the charge dimension (FR/WH/MD/LA/MI + product 910/920/930/960). Tax items are NOT here (isolated by taxline).';

-- ── RCTI headers (VendBill) ──────────────────────────────────────────────────
create table if not exists raw.ns_vendor_bill (
  id               bigint primary key,         -- NetSuite transaction internal id
  tranid           text,                       -- e.g. 2622-ZONTA
  type             text,                        -- always 'VendBill'
  entity           bigint,                     -- vendor id → raw.ns_vendor.id
  trandate         date,                        -- the settlement (business) date
  lastmodifieddate timestamptz,                 -- the INCREMENTAL watermark key (change capture)
  status           text,
  approvalstatus   integer,
  foreigntotal     numeric,                     -- the authoritative bill total (NEGATIVE = payable)
  currency         integer,
  memo             text,
  _raw             jsonb,
  _synced_at       timestamptz not null default now()
);
comment on table raw.ns_vendor_bill is 'Grower RCTI headers. foreigntotal is the authoritative bill total (negative=payable). Incremental key = lastmodifieddate; trandate = settlement date.';

-- ── RCTI lines (transactionline) ─────────────────────────────────────────────
-- Line-type contract (the no-double-count guard):
--   mainline='T'  → the A/P summary line; its foreignamount = the bill total. EXCLUDE from detail.
--   mainline='F' AND taxline='F' → real product (foreignamount>0) / charge (foreignamount<0) lines.
--   taxline='T'   → GST / RCTI tax lines (kept, but isolated from products/deductions).
-- Invariant proven live: SUM(foreignamount WHERE mainline='F') = -(mainline foreignamount) = bill total.
create table if not exists raw.ns_vendor_bill_line (
  uniquekey          bigint primary key,        -- globally unique transactionline key
  transaction        bigint,                    -- bill id → raw.ns_vendor_bill.id
  line_id            integer,                   -- line id within the bill (source col `id`)
  linesequencenumber integer,
  mainline           boolean,                   -- T = the A/P summary line (= bill total)
  taxline            boolean,                   -- T = tax line (GST/RCTI)
  item               bigint,                    -- item id → raw.ns_item.id (null on mainline/tax)
  accountinglinetype text,                      -- e.g. EXPENSE (audit only)
  netamount          numeric,
  foreignamount      numeric,                   -- the signed line amount; reconciles to foreigntotal
  memo               text,
  _synced_at         timestamptz not null default now()
);
create index if not exists ns_vendor_bill_line_txn_idx on raw.ns_vendor_bill_line (transaction);
create index if not exists ns_vendor_bill_line_item_idx on raw.ns_vendor_bill_line (item);
comment on table raw.ns_vendor_bill_line is 'RCTI lines. Clean detail = mainline=false. mainline=true row = bill total. Products foreignamount>0, deductions<0. taxline isolates GST. No amount/posting/account cols in the REST schema.';

-- ── Vendor payments (VendPymt) — the PAID DATE source ────────────────────────
create table if not exists raw.ns_vendor_payment (
  id               bigint primary key,
  tranid           text,
  type             text,                        -- always 'VendPymt'
  entity           bigint,                      -- vendor id
  trandate         date,                        -- the PAID DATE
  lastmodifieddate timestamptz,
  status           text,
  foreigntotal     numeric,
  currency         integer,
  memo             text,
  _raw             jsonb,
  _synced_at       timestamptz not null default now()
);
comment on table raw.ns_vendor_payment is 'Grower vendor payments. trandate = the paid date (what FreshTrack cannot provide). Linked to bills via raw.ns_bill_payment_link.';

-- ── Bill→payment apply map (PreviousTransactionLineLink, linktype=Payment) ───
create table if not exists raw.ns_bill_payment_link (
  link_key         text primary key,            -- synthesized: previousdoc-nextdoc-previousline-nextline
  previoustype     text,                        -- 'VendBill'
  previousdoc      bigint,                      -- bill id → raw.ns_vendor_bill.id
  previousline     integer,
  nexttype         text,                        -- 'VendPymt'
  nextdoc          bigint,                      -- payment id → raw.ns_vendor_payment.id
  nextline         integer,
  nextdate         date,                        -- the payment date (= paid date)
  linktype         text,                        -- 'Payment'
  foreignamount    numeric,                     -- amount of the bill settled by this payment
  lastmodifieddate timestamptz,
  _synced_at       timestamptz not null default now()
);
create index if not exists ns_bill_payment_link_bill_idx on raw.ns_bill_payment_link (previousdoc);
comment on table raw.ns_bill_payment_link is 'Bill→payment apply mapping (PTLL, linktype=Payment). A bill is paid when SUM(foreignamount) over its links = |bill total|; paid_date = max(nextdate). No link = unpaid (null paid_date, never zero-dated).';
