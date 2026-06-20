# Spec: Mackays Data Hub — FreshTrack source + Grower Portal v1

Date: 2026-06-20
Status: Design locked, ready to build

This is the design contract. It encodes decisions and data-quality findings established during scoping so a build session doesn't re-discover them. Phase-1 build scope lives in `SPRINT.md`.

---

## 1. Architecture

Single warehouse (Supabase). Everything above the hub reads from the hub, not from each other.

```
Sources → Ingestion → Supabase hub (raw → core → semantic) → Access (Hub MCP · SQL · PostgREST) → Apps · BI · Agents
```

- **Sources:** FreshTrack (packhouse), NetSuite (finance/RCTI), retail scan (IRI/Quantium), pricing + EDI. FreshTrack is the first and only source in v1.
- **Hub schemas:** `raw` (per-source landing) → `core` (conformed, cleaned, cast) → `semantic` (the only thing apps/BI/agents read).
- **Access:** Hub MCP for agents, direct SQL for Steep, PostgREST/Supabase client for apps.
- **Identity:** MS Entra SSO (internal), grower email auth (portal). RLS propagates to the MCP and agents — every query runs as the caller's role.

---

## 2. Decisions locked

| Decision | Choice |
|---|---|
| Semantic / metric layer | **Cube** (metrics defined in code; Steep consumes via its native Cube integration; Hub MCP queries the same Cube layer) |
| Grower identity key | **`consignor_id`** — consignor = grower across both dispatch and GP/settlement (`supplier_id` is null on GP records) |
| Dispatch data transport | GraphQL windowed loaders (no cursor in the API → paginate by time window) |
| GP/settlement transport | **Read-replica (direct Postgres)** — the `gpDetails` GraphQL resolver is broken (see §9) |
| Schema evolution | Additive-only. Text enums (never Postgres enum types). Stable column names, never repurpose a column |
| Safety net | `_raw jsonb` on the small tables (`entity`, `dispatch_load`, `gp_schedule`); UUID PKs; idempotent upsert |

---

## 3. Data model

All landed tables carry `id uuid` PK, `_synced_at`, and (small tables only) `_raw jsonb`. Field lists are the **profiled, trimmed** sets — empty/duplicate/unused columns dropped (verified across banana, avocado and papaya).

### Dispatch domain (`raw.ft_*`, GraphQL source)

**dispatch_load** (grain: one load)
`id, load_no, order_type (source codes 'S'=Sell / 'B'=Buy), state_id, scheduled_pickup_on, actual_pickup_on, scheduled_delivery_on, actual_delivery_on, pack_date, asn_sent_on, latest_order_modified_on, consignor_id, consignee_id, marketer_id, carrier_id, shed_id, market_area_id, order_id, order_no, po_no, latest_order_version_no, stock_boxes, reconsigned_boxes, is_complete, is_locked, attached_document_count, manifest_no, certificate_no, pallet_transfer_no, dc_slot_ref, temperature_profile_id, temperature_value, comment, extra_text_2`
*`dispatched_at = actual_pickup_on`. `extra_text_2` is 100% populated with ~9 distinct values — confirm what it codes before naming the column.*

**pallet** (grain: one pallet)
`id, pallet_no, barcode, dispatch_load_id, product_id, product_description, crop_description, variety_description, consignee_id, shed_id, state_id, type_id, spaces, expected_box_count, box_count, stock_boxes, reconsigned_boxes, net_weight_value, net_weight_unit, packed_on, is_archived, is_field, supplier_highlights, comment`
*`net_weight_value` is nullable and produce-dependent (avocado often traded by count). `is_field` retained — varies by produce. Do not model `location_id` (declared non-null but returns null — see §9).*

**entity** (grower/consignor/customer master)
`id, code, org_name, org_legal_name, type, tags, is_active, is_grower, is_test (derived), org_tax_no, ext_link, consignor_id, consignee_id, marketer_id, carrier_id, supplier_id, farm_id, shed_id, parent_id, org_market_area_id, payment_term_id`
*Banking and contact fields held out (sparse + financial PII). `is_test` derived: inactive entity with `*TEST` code (`TRUGTEST`, `LARATEST`, `ANNRTEST`).*

### Sales / settlement domain (`raw.ft_*`, **read-replica source**)

**gp_schedule** (grain: grower × crop × period)
`id, schedule_no, gp_group_id, gp_status_id, date_from, date_to, payable_on, crop_id, variety_id, week_no, box_count, weight_value, boxes_delivered, invoiced_amount_value, paid_amount_value, remittable_percentage, consignor_id, consignee_id, marketer_id, is_organic, is_locked`
*Grower = `consignor_id` (`supplier_id` is null). Confirmed populated with real invoiced amounts.*

**gp_detail** (grain: settlement line — the sales-page spine)
`id, gp_schedule_id, gp_payment_id, farm_id, planting_id, crop_id, variety_id, subvariety_id, harvest_load_id, market_area_id, consignee_id, consignor_id, marketer_id, product_id, consignment_type_id, dispatch_load_id, original_dispatch_load_id, box_quantity, net_weight_value, pack_date, price_quoted_value, price_invoiced_value, price_paid_value, price_remitted_value, price_currency`
*`dispatch_load_id` = the sale/customer load; `original_dispatch_load_id` = the load it originated from (the lineage). `harvest_load_id` IS populated here (unlike outbound pallets). Must come via read-replica — the GraphQL resolver is broken.*

### Conformed dimensions & facts (`core.*` → `semantic.*`)

- `dim_grower` (keyed on `consignor_id`; `is_grower, is_active, is_test, market_area, payment_term`) — the RLS anchor.
- `dim_customer` (consignee), `dim_site` (shed/DC), `dim_product` (product · crop · variety · pack), `dim_date`.
- `fact_dispatch_load` (grain: load) — filters baked in: `is_test = false AND dispatched_at is not null`.
- `fact_dispatch_pallet` (grain: pallet) — carries `grower_key` propagated from its load (the pallet's own harvest link is null on outbound).
- `fact_sales_line` (grain: gp_detail line) — grower, product, customer, qty, net weight, sale load, **original load**, pricing.

---

## 4. Semantic layer (Cube)

Metrics defined in code as Cube models; both Steep and the Hub MCP read them. Two registries.

**Definitions (canonical, seed these):**
- `dispatched` — `actual_pickup_on` is set; the date used is `actual_pickup_on`.
- `non_test_grower` — consignor entity excluding the inactive `*TEST` sites (`TRUGTEST`, `LARATEST`, `ANNRTEST`).
- `grower` — the consignor (`consignor_id`), consistent across dispatch and settlement.
- `net_weight` — produce-dependent and nullable; never coalesced to 0 in averages.
- `sales_origin_load` — `gp_detail.original_dispatch_load_id`.

**Metrics:**
- Dispatch (internal/analytics): `dispatched_loads`, `dispatched_boxes`, `dispatched_net_weight_kg`, `active_growers`, `avg_boxes_per_load`.
- Sales (grower-facing): `invoiced_amount`, `paid_amount`, `remitted_amount`, `sales_boxes`, `sales_net_weight_kg` — sliceable by grower, crop/product, customer (consignee), week.

*Grower-portal detail pages are RLS views, not metrics. Metrics power rollups and dashboards.*

---

## 5. Hub MCP tool surface

One governed MCP over the semantic layer. Read vs action split. Identity propagates to RLS — the MCP holds no standing elevated access.

**Read tools**

| Tool | Params | Returns | Guardrail |
|---|---|---|---|
| `get_catalog` | — | dims, facts, metrics, definitions | read-only |
| `list_metrics` | `domain?` | metrics + sliceable dims + unit | read-only |
| `query_metric` | `metric, group_by[], filters{}, time_range, time_grain?, order?, limit?` | rows + definition + filters applied | registry-validated, RLS, row cap, timeout |
| `list_grower_dispatches` | `grower?, time_range, product?` | dispatch detail rows | RLS-scoped to caller's grower |
| `list_grower_sales` | `grower?, time_range, customer?, product?` | sales/settlement rows incl. origin load | RLS + `can_view_sales` capability |
| `resolve_entity` | `kind, search` | ids for a name/code | read-only |
| `list_dimension_values` | `dimension, search?, limit?` | dimension members | read-only |
| `get_definition` | `term` | canonical text + filter logic | read-only |
| `run_select` | `sql` | rows | **escape hatch**: `semantic.*` only, timeout, row cap, no DDL |

**Action tools** (separate, explicit, audited; human confirmation for irreversible): `create_grower`, `update_grower_contact`, `raise_rcti` (NetSuite), `send_grower_notice`.

**Output shape (every read):** `{ columns, rows, metric_definition, filters_applied, row_count, truncated }`.

---

## 6. Grower Portal surfaces

Two pages per grower dashboard. Both RLS-scoped to the grower (consignor).

**Dispatch detail page** — pallet/line grain. Columns: date, crop/variety/product, boxes, net weight (nullable), load no. Source: `fact_dispatch_pallet`. No blockers — phase 1.

**Sales page (separate)** — the digital remittance. Grain: `gp_detail` line. Columns: date, product, box qty, net weight, **customer (consignee)**, **originating dispatch load**, sale load, invoiced / paid / remitted price. Source: `fact_sales_line` (from `gp_detail`, read-replica). Customer is shown (matches the existing remittance report). Phase 2.

---

## 7. Access model

Two axes, plus the global tier.

- **Tenant scope (RLS):** all data filtered to the grower via `consignor_id`. A grower sees only their own rows.
- **Capability (delegated):** `can_view_sales` is a per-user grant, administered by the **grower-admin** for their own created users. Sales views and Cube models check both — right grower AND a user holding the sales capability.
- **Global tier:** internal (full) / grower-admin (manages own users) / grower-user (scoped by capability).

Rationale: settlement dollars are commercially sensitive — the grower controls who in their org sees them, not Mackays.

---

## 8. Data sourcing

- **Dispatch (GraphQL):** windowed idempotent loaders. Walk `2025-07-01 → today` in weekly windows (the API has `filterLimit` but no cursor/offset). Upsert on `id`; resumable by window. Exclude the 3 test consignors at pull.
- **GP/settlement (read-replica):** land `gp_schedule` + `gp_detail` directly from Postgres via `readonlyDatabaseCredentials` — the `gpDetails` GraphQL resolver is broken (§9), and the read-replica also exposes the `dispatch_load_id` / `original_dispatch_load_id` FK columns the GraphQL node only offered as nested objects.
- **Schema-diff watcher:** scheduled re-introspect + diff against the stored schema, flags upstream change before it breaks a loader.

---

## 9. Known data-quality constraints (read before building)

These are confirmed against live FreshTrack data. Encode them; don't re-discover them.

1. **`pallet.harvest_load_id` is null on outbound** — no grower-of-fruit trace at dispatch. Grower attribution = consignor on the load.
2. **`pallet.location_id` is declared non-null but returns null** — selecting it errors the query. Do not model as required; skip it.
3. **`gpDetails` GraphQL resolver is broken** — a server-side typo (`consignment_ type`, with a space) fires on every call regardless of selection. Use the read-replica for GP detail. Report to FreshTrack.
4. **`productMovements` returns empty** — the movement ledger isn't actively populated. Don't build lineage on it.
5. **`repackOperation.created_pallet` often equals the source pallet** (in-place repack) — no reliable parent→child genealogy. Lineage comes from `gp_detail.original_dispatch_load_id`, not pallet genealogy.
6. **Test entities:** `TRUGTEST`, `LARATEST`, `ANNRTEST` — inactive, `*TEST` code, appear as consignors. Exclude at pull.
7. **`supplier_id` is null on GP records** — grower = `consignor_id` (consistent with dispatch).
8. **`net_weight_value` is produce-dependent** — ~100% on papaya, ~88% banana, ~41% avocado. Nullable; never coalesce to 0 in averages.
9. **`product_description` carries display format codes** (e.g. `^{b}^{c blue}[36]...`) — parse, don't display raw.

---

## 10. Phasing

1. **Dispatch landing + grower dispatch detail page** (this is `SPRINT.md`). No blockers.
2. **GP landing (read-replica) + grower sales page.** Surfaces `original_dispatch_load_id` lineage + the `can_view_sales` capability.
3. **Cube semantic layer + metrics** (dispatch, then sales).
4. **Hub MCP + agents.**
