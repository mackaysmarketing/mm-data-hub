# Sprint 7 · Source→Target column map + Step-0 findings (dispatch backfill)

Date: 2026-06-23 · Author: build session
Source (read-only): FreshTrack prod — `fts-cloud-prod-rds.…ap-southeast-2.rds.amazonaws.com` / `cloud_mackaysmarketing` (`cloud_mackaysmarketing_readonly`)
Target (write): Supabase hub `uqzfkhsdyeokwnkpcxui` (ap-southeast-2) — `raw.ft_dispatch_load`, `raw.ft_pallet` only.
Evidence: `npm run ft:dispatch:recon` → `reports/ft_dispatch_recon_2026-06-23.md`; `scripts/ft_dispatch_lmb_probe.ts`.
Method: LOAD-SAFE — information_schema metadata + `pg_class.reltuples` estimates + LMB-scoped aggregates only. Both sessions pinned `default_transaction_read_only=on`. No sample-row hauling.

---

## 1. Source identity, grain, PK, volume

| Hub target table | Source table | Grain | Source PK | Source est. rows | Hub current rows |
|---|---|---|---|---|---|
| `raw.ft_dispatch_load` | `public.dispatch_load` | one load | `id` (uuid) | ~22,190 | 5,926 |
| `raw.ft_pallet` | `public.pallet` | one pallet | `id` (uuid) | ~203,242 | 38,796 |

The hub is a partial Sprint-1 GraphQL snapshot: ~27% of source loads, ~19% of source pallets. Confirms the sprint premise that the warehouse dispatch layer is frozen/partial.

Pallet→load linkage: **`public.pallet.dispatch_load_id = public.dispatch_load.id`** (same as the hub join `raw.ft_pallet.dispatch_load_id = raw.ft_dispatch_load.id`).

Source table names = hub table minus `ft_` prefix — identical to the GP loader's `sourceTable()` convention (`ft_dispatch_load`→`dispatch_load`, `ft_pallet`→`pallet`).

---

## 2. Column map — `raw.ft_dispatch_load` ← `public.dispatch_load`

**1:1 by name** (snake_case), exactly like the GP loader. Every hub column has an identically-named source column (recon auto-diff: 0 gaps). Dates/timestamps read as `::text` to avoid the node-postgres `+10h`/off-by-one round-trip (GP precedent; see memory "watch date off-by-one").

| Hub column | kind | Source column | Notes |
|---|---|---|---|
| id | uuid | id | PK / upsert key / keyset cursor |
| load_no | text | load_no | |
| order_type | text | order_type | 'S'/'B' text, never enum (SPEC §9.6) |
| state_id | uuid | state_id | |
| scheduled_pickup_on | timestamptz | scheduled_pickup_on | ::text on read |
| actual_pickup_on | timestamptz | actual_pickup_on | **= view `dispatched_on`/`dispatched_at`**; ::text on read |
| scheduled_delivery_on | timestamptz | scheduled_delivery_on | ::text |
| actual_delivery_on | timestamptz | actual_delivery_on | ::text |
| pack_date | date | pack_date | ::text |
| asn_sent_on | timestamptz | asn_sent_on | ::text |
| latest_order_modified_on | timestamptz | latest_order_modified_on | ::text |
| consignor_id | uuid | consignor_id | **grower key / RLS anchor / view `grower_key`** |
| consignee_id | uuid | consignee_id | |
| marketer_id | uuid | marketer_id | |
| carrier_id | uuid | carrier_id | |
| shed_id | uuid | shed_id | |
| market_area_id | uuid | market_area_id | |
| order_id | uuid | order_id | |
| order_no | text | order_no | |
| po_no | text | po_no | |
| latest_order_version_no | int | latest_order_version_no | |
| stock_boxes | int | stock_boxes | |
| reconsigned_boxes | int | reconsigned_boxes | |
| is_complete | bool | is_complete | |
| is_locked | bool | is_locked | |
| attached_document_count | int | attached_document_count | |
| manifest_no | text | manifest_no | |
| certificate_no | text | certificate_no | |
| pallet_transfer_no | text | pallet_transfer_no | |
| dc_slot_ref | text | dc_slot_ref | |
| temperature_profile_id | uuid | temperature_profile_id | |
| temperature_value | numeric | temperature_value | |
| comment | text | comment | |
| extra_text_2 | text | extra_text_2 | **= view `pack_week`**; Y{YY}W{WW} code (SPEC §9.5) |
| _raw | jsonb | (the whole source row) | hub bookkeeping (withRaw=true, small table) |
| _synced_at | timestamptz | now() | hub bookkeeping |

**Source columns intentionally NOT landed** (outside the curated SPEC §3 set; landing them would mean altering the view-backing table — out of scope): `sales_order_no, extra_text_1, extra_text_3, extra_number_1..3, created_on, last_modified_on, temperature_unit, highlights, order_highlights, supplier_highlights, info, pallet_overview, rejected_boxes, repacked_boxes, waste_boxes, email_sent_on, bin_transfer_no, crate_transfer_no, is_archived`.
- `last_modified_on` is the **incremental read filter** (see §4) but is not persisted in the hub (the table shape is fixed by the view; GP-style operator `--since` drives increments).

---

## 3. Column map — `raw.ft_pallet` ← `public.pallet`

**1:1 by name** (recon auto-diff: 0 gaps). No `_raw` (large table), same as today.

| Hub column | kind | Source column | Notes |
|---|---|---|---|
| id | uuid | id | PK / upsert key / keyset cursor; = view `pallet_id` |
| pallet_no | text | pallet_no | |
| barcode | text | barcode | |
| dispatch_load_id | uuid | dispatch_load_id | **FK → dispatch_load.id (view join)** |
| product_id | uuid | product_id | |
| product_description | text | product_description | = view `product`; may carry ^{…} codes (SPEC §9.7) |
| crop_description | text | crop_description | = view `crop` |
| variety_description | text | variety_description | = view `variety` |
| consignee_id | uuid | consignee_id | |
| shed_id | uuid | shed_id | |
| state_id | uuid | state_id | |
| type_id | uuid | type_id | |
| spaces | numeric | spaces | |
| expected_box_count | numeric | expected_box_count | |
| box_count | numeric | box_count | **= view `boxes`**; often null (SPEC §9 / see §6 LMB finding) |
| stock_boxes | int | stock_boxes | |
| reconsigned_boxes | int | reconsigned_boxes | |
| net_weight_value | numeric | net_weight_value | = view `net_weight`; nullable, NEVER coalesce to 0 (SPEC §9.3) |
| net_weight_unit | text | net_weight_unit | |
| packed_on | timestamptz | packed_on | ::text on read |
| is_archived | bool | is_archived | = view `is_archived` |
| is_field | bool | is_field | = view `is_field` |
| supplier_highlights | text | supplier_highlights | may carry ^{…} codes |
| comment | text | comment | |
| _synced_at | timestamptz | now() | hub bookkeeping |

**Source columns intentionally NOT landed:** `loaded_on, gross_weight_value, gross_weight_unit, created_on, last_modified_on, label_template_id, subvariety_description, best_before, site_id, stack_index, repacked_boxes, waste_boxes, rejected_boxes, palletized_by_id, packing_batch, work_area_id, truck_no, temperature_unit, temperature_value, col_no, level_no, row_no, shipment_id, harvest_method_id, grader_id, harvested_on, tipped_on`, and deliberately **`location_id`** (SPEC §9.2 — not modelled) and **`harvest_load_id`** (SPEC §9.1 — null on outbound; grower attribution is the load consignor). Unlike the GraphQL source where selecting `location_id` errored, raw SQL exposes it — we still do not model it, per SPEC.

---

## 4. Incremental key, pickup date, date handling

- **Incremental key = `last_modified_on`** (timestamptz, NOT NULL) — present on **both** `dispatch_load` and `pallet`. Loader reads `WHERE last_modified_on >= $since` for incremental, mirroring `ft_gp.ts`.
- **Dispatch/pickup date = `actual_pickup_on`** (the view's `dispatched_on`/`dispatched_at`). `pack_date` also landed.
- **Date/timestamptz read as `col::text`** in the SELECT list, recast by the hub upsert — avoids the JS `Date` off-by-one (GP precedent).
- `sync_window` streams: **`dispatch`** (ft_dispatch_load) and **`pallet`** (ft_pallet), matching the AC wording and the `0005` comment (`'dispatch_load' | 'pallet'`).

---

## 5. View dependency check — `semantic.grower_dispatch_detail`

All columns the view consumes are present & mapped:
`d.consignor_id, d.actual_pickup_on, d.pack_date, d.extra_text_2, d.load_no, d.id` · `p.id, p.pallet_no, p.crop_description, p.variety_description, p.product_description, p.box_count, p.net_weight_value, p.net_weight_unit, p.is_field, p.is_archived, p.dispatch_load_id` · `core.dim_grower.consignor_id, .is_test`. View filters: `actual_pickup_on IS NOT NULL` and `is_test=false`. **No view change needed for the column map; none will be made silently.**

---

## 6. ✅ LMB keying — CONFIRMED (the mandatory Step-0 gate)

`public.entity` (the source's only code+consignor_id table) has exactly the four LMB codes, all `is_active=true`, mapping to the same consignor_ids as hub `core.dim_grower`:

| code | consignor_id | source dispatch_load rows |
|---|---|---|
| LMBBF | 0191f866-097d-f8d8-153d-d59d1e4afb71 | 40 |
| LMBCO | 01955ac3-7f27-a033-b4f1-bfeb10ffeaa0 | 317 |
| LMBEP | 0191f867-82cf-4901-472d-c43d21b8ec92 | 303 |
| LMBFA | 019617b7-b9f5-2f75-6c44-9e8bae30710b | 12 |

672 LMB loads total, all keyed to the four LMB consignor_ids. **Loader rows will land under the right `grower_key`.**

---

## 7. ⚠ FLAGGED DECISION — LMB has no recent **actual_pickup** dispatch (AC at risk)

The LMB acceptance test ("≥1 LMB dispatch row for the most recent completed week, non-null boxes, across the four entities") is **not satisfiable by a raw-table backfill alone**, because the source data is shaped differently than the sprint assumed. Evidence (`ft_dispatch_lmb_probe.ts`):

- LMB **created 250 loads in 2026** (last created **today**, 244/250 `is_complete`), **248 order_type 'S'** — LMB is active, not stale.
- But **`actual_pickup_on` is NULL on 0/250** of those 2026 loads; **`scheduled_pickup_on` is set on 250/250**. Across all 672 LMB loads ever, **exactly 1** has `actual_pickup_on` (one LMBCO load @ 2025-07-15). The other 3 entities have **zero** actual-pickup loads ever.
- The view filters `actual_pickup_on IS NOT NULL` → LMB collapses to that single 2025-07-15 row. **The hub already shows it.** This is **source truth, not a load gap.**
- **Boxes:** even with a date fix, LMB pallets carry `box_count` on only **298/5,002 (6%)** of 2026 pallets (they carry `net_weight_value` on 4,989/5,002). So `boxes` for LMB is mostly null at source.
- Global context: only **33.6%** of all 2026 loads have `actual_pickup_on`; the source IS live (243 loads / 18 growers dispatched in the last 14 days, max pickup 2026-06-27) — LMB just isn't one of the actual-pickup growers.
- The AC is also internally inconsistent given this data: "within ~1 week of the source's LMB max" (2025-07-15) vs "most recent completed week" (June 2026) cannot both hold.

**Resolution requires a product/semantics decision (escalated to the user) — NOT a silent view change.** Candidate paths:
- **A. Backfill as scoped; record LMB's ceiling as evidenced source truth.** Brings every actual-pickup grower current; LMB stays at 2025-07-15. Literal LMB AC reported as a data-truth, not a code defect. (In scope, no governed-metric change.)
- **B. Additively redefine "dispatched" to fall back to `scheduled_pickup_on`.** Surfaces LMB + the ~66% scheduled-only loads, but changes the governed dispatch metric for ALL growers + downstream (Cube/MCP/Steep). Out of current scope; needs sign-off + coordinated Cube change.
- **C. Add a separate additive scheduled-dispatch view/column** (`scheduled_dispatched_on`), leaving the `actual_pickup_on` metric untouched. Honors additive-only; LMB surfaces via the new path. (`boxes` still mostly null for LMB.)

---

## 8. Implementation notes carried into the loader (Step 1)

- **Host assertion:** the hub ref `uqzfkhsdyeokwnkpcxui` lives in the pooler **username** (`postgres.uqzfkhsdyeokwnkpcxui`), not the host (`aws-1-…pooler.supabase.com`). The AC's "host contains uqzfkhsdyeokwnkpcxui" must be realized as: **the resolved write connection string carries the ref** AND a live fingerprint (target schema/tables exist) — else it would false-abort against the pooler. Abort loudly otherwise.
- Mirror `src/loaders/ft_gp.ts`: keyset page by `id` (`FETCH_PAGE`), upsert on `id` in batches, fetch from source fully before opening the hub connection, `raw.sync_window` per stream, full/incremental(`--since`)/slice modes.
- Reconcile script `ft:dispatch:reconcile` mirrors `ft_gp_reconcile.ts`: hub vs source counts/volumes per grower+period, variances surfaced.
