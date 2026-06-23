-- 0018_raw_ft_gp_charges — FreshTrack grower-pool CHARGE LEDGER + dims (Sprint 6).
--
-- Extends the GP raw landing (0017: ft_gp_schedule/detail/payment) with the DEDUCTION MODEL:
--   ft_charge_applied — the normalized charge ledger (~117k rows; ~94k carry a gp_schedule_id =
--                       settled). Each row links gp_schedule_id + gp_detail_id + dispatch_load_id +
--                       charge_id and carries total_amount_value, account_code, is_deductible,
--                       vat_info (GST), text_1 (human label). THE authoritative deduction source —
--                       NOT the gp_detail.extra_* slots (SPEC/Sprint discovery).
--   ft_charge       — the rate-card dimension (name, charge_type_id, account_code, netsuite_id).
--   ft_charge_type  — the taxonomy dimension (code, name, scope, account_code, is_deductible).
--   ft_gp_status    — PA Payable / PD Paid / DR Draft.
--
-- Same contract as 0017: faithful native-column mirror, snake_case already matches the source,
-- text not enum (SPEC §2), amounts numeric never coalesced (SPEC §9.3), temporal columns read via
-- ::text in the loader to dodge the +10 date off-by-one. _raw jsonb kept on the small dims only
-- (charge/charge_type/gp_status) — NOT on the ~117k-row ledger. Source NOT-NULL/length constraints
-- are intentionally not replicated (raw lands tolerantly; integrity asserted in core/semantic).
--
-- DISCOVERY (confirmed live, build to this — see HANDOFF Sprint-6 build entry):
--   • Settlement scope = charge_applied WHERE gp_schedule_id IS NOT NULL (Σ = $32.53M ≈ NetSuite
--     deductions $32.50M). The ~24k null-gp_schedule_id rows are UNSETTLED charges (out of scope).
--   • netsuite_id is essentially UNPOPULATED (2/155 charges, 0/30 charge_types) — the cross-source
--     join is by grower (consignor_id) + period + shared taxonomy, NOT charge.netsuite_id.
--   • account_code first digit is the category signal: 1 FR / 2 WH / 3 MD / 4 MI / 5 LA(Load
--     Adjustment) — charge_type.scope / charge.name are the fallback (both messy: 'WH  - Handling'
--     double-space, 'MD- Levy' no-space, null scope on ~6k rows).

-- ── ft_charge_type (taxonomy dim) ────────────────────────────────────────────
create table if not exists raw.ft_charge_type (
  id                uuid primary key,
  code              text,
  name              text,
  scope             text,          -- e.g. 'Freight' / 'WH - Handling' / 'MD- Levy' (messy; fallback signal)
  account_code      text,
  is_deductible     boolean,
  is_active         boolean,
  sequence          numeric,
  description       text,
  netsuite_id       text,          -- 0/30 populated — NOT a usable cross-source key
  ext_link          text,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_charge_type is 'FreshTrack charge taxonomy (read-replica). scope/account_code feed the FR/WH/MD/LA/MI classifier (core.dim_gp_charge). netsuite_id unpopulated. Incremental key = last_modified_on.';
comment on column raw.ft_charge_type.scope is 'Human category scope, e.g. Freight / WH - Handling / MD- Levy. Messy (inconsistent spacing/case, nullable) — a FALLBACK to account_code in the classifier, never the primary signal.';

-- ── ft_charge (rate-card dim) ────────────────────────────────────────────────
create table if not exists raw.ft_charge (
  id                uuid primary key,
  name              text,
  vat_info          text,          -- EX / INC / FREE (the GST treatment)
  account_code      text,
  charge_type_id    uuid,
  consignor_id      uuid,
  product_id        uuid,
  crop_id           uuid,
  market_area_id    uuid,
  is_active         boolean,
  sequence          numeric,
  netsuite_id       text,          -- 2/155 populated — NOT a usable cross-source key
  ext_link          text,
  ext_code          text,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_charge is 'FreshTrack charge rate card (read-replica). name/account_code/charge_type_id drive core.dim_gp_charge classification. _raw keeps the full source row. Incremental key = last_modified_on.';

-- ── ft_gp_status (PA/PD/DR) ──────────────────────────────────────────────────
create table if not exists raw.ft_gp_status (
  id                uuid primary key,
  code              text,          -- PA Payable / PD Paid / DR Draft
  name              text,
  sequence          numeric,
  created_on        timestamptz,
  last_modified_on  timestamptz,
  _raw              jsonb,
  _synced_at        timestamptz not null default now()
);
comment on table raw.ft_gp_status is 'FreshTrack GP settlement status: PA Payable / PD Paid / DR Draft. gp_schedule.gp_status_id → this. Drives paid_status (flagged, never zero-dated).';

-- ── ft_charge_applied (the deduction ledger) ─────────────────────────────────
-- Faithful mirror of ALL 36 source columns (no _raw — too large, ~117k rows; cf. 0017 ft_gp_detail).
create table if not exists raw.ft_charge_applied (
  id                          uuid primary key,
  text_1                      text,          -- human label, e.g. 'FR - Blenners - Road - Tully…', 'Ripening', 'Admin Fee'
  text_2                      text,          -- original-load split quantity denominator (reconsignment); landed faithfully, NOT decoded
  text_3                      text,          -- group label, e.g. 'Sales'
  account_code                text,          -- posted account; first digit = category (1 FR/2 WH/3 MD/4 MI/5 LA)
  quantity_value              numeric,
  quantity_unit               text,
  amount_value                numeric,
  amount_currency             text,
  total_amount_value          numeric,       -- the charge amount (positive); deduction when is_deductible
  total_amount_currency       text,
  vat_info                    text,          -- EX → +10% / INC → 1/11 inclusive / FREE → 0
  applied_on                  timestamptz,
  created_on                  timestamptz,
  last_modified_on            timestamptz,   -- the INCREMENTAL watermark
  created_on_auto             timestamptz,
  is_active                   boolean,
  is_deductible               boolean,       -- TRUE = money off the grower (a deduction)
  is_auto                     boolean,
  reference                   text,
  ext_code                    text,
  box_id                      uuid,
  charge_id                   uuid,          -- → raw.ft_charge.id (the rate card / classification)
  dispatch_load_id            uuid,          -- → raw.ft_dispatch_load.id (load-grain lineage)
  original_dispatch_load_id   uuid,          -- the original load on reconsignment (lineage; not apportioned)
  harvest_load_id             uuid,
  harvest_load_bin_id         uuid,
  order_id                    uuid,
  pallet_id                   uuid,
  product_id                  uuid,
  gp_detail_id                uuid,          -- → raw.ft_gp_detail.id
  gp_schedule_id              uuid,          -- → raw.ft_gp_schedule.id (NULL = unsettled, out of settlement scope)
  gp_payment_id               uuid,
  gp_group_id                 uuid,
  supplier_id                 uuid,
  marketer_id                 uuid,
  _synced_at                  timestamptz not null default now()
);
create index if not exists ix_ft_charge_applied_schedule on raw.ft_charge_applied (gp_schedule_id);
create index if not exists ix_ft_charge_applied_detail on raw.ft_charge_applied (gp_detail_id);
create index if not exists ix_ft_charge_applied_dispatch_load on raw.ft_charge_applied (dispatch_load_id);
create index if not exists ix_ft_charge_applied_charge on raw.ft_charge_applied (charge_id);
create index if not exists ix_ft_charge_applied_lastmod on raw.ft_charge_applied (last_modified_on);
comment on table raw.ft_charge_applied is 'FreshTrack grower-pool charge ledger (read-replica) — THE deduction model. Settlement scope = gp_schedule_id IS NOT NULL. gross/deduction by is_deductible; category by account_code prefix; GST by vat_info. text_2 = original-load split denominator (landed, not decoded — the split apportionment is NOT replicated this sprint). Incremental key = last_modified_on.';
comment on column raw.ft_charge_applied.total_amount_value is 'Charge amount, positive. Deduction when is_deductible. Never coalesced (SPEC §9.3). Net = gross − Σ(deductible) − Σ(GST).';
comment on column raw.ft_charge_applied.gp_schedule_id is 'Settlement linkage. NULL = an unsettled charge (excluded from settlement; ~24k of ~117k rows).';
comment on column raw.ft_charge_applied.original_dispatch_load_id is 'Original load on reconsignment. FreshTrack''s v_power_bi_charge_split apportions original-load charges by quantity; this sprint anchors on gp_payment and reconciles within tolerance rather than replicating that split.';
