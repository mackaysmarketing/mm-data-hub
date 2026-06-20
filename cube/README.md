# Cube — Mackays Data Hub semantic layer (dispatch)

The single, code-defined **metric surface** over the dispatch data landed in Sprint 1
(`raw` → `core`). Cube defines the dispatch measures and dimensions **once**; both Steep
and the future Hub MCP consume these governed definitions — they do **not** redefine metrics.

> Schema boundary: this project reads **`raw` / `core`** only. It must **never** model
> mm-hub's `public.*` tables (consignments, remittances, retail prices, etc.). If Cube Cloud
> auto-generated a starter model over the `public` schema, that model is discarded.

## Layout
```
cube/
  cube.js                     # config — RLS (queryRewrite on consignor_id), tenant cache isolation
  model/
    cubes/
      dispatch_loads.yml      # grain: load   — load_count
      dispatch_pallets.yml    # grain: pallet — pallet_count, net_weight_dispatched, line_count, capture rate
      dim_grower.yml          # grower dim (consignor_id) — RLS anchor + readable name/code
    views/
      dispatch.yml            # the ONLY public surface; base cubes are private
```

## Measures (contracts — additive only)
| Measure | Grain | Meaning | Null handling |
|---|---|---|---|
| `load_count` | load | distinct dispatched Sell loads (incl. pallet-less) | — |
| `pallet_count` | pallet | dispatched Sell pallets | — |
| `net_weight_dispatched` | pallet | SUM of `net_weight_value` (kg) | nulls **excluded**, never coalesced to 0 |
| `line_count` | pallet | distinct (load × product) | — |
| `pallets_with_net_weight` / `net_weight_capture_rate` | pallet | capture-rate numerator / ratio | null-safe |

**Baked-in filters every consumer inherits** (encoded once, in each cube's SQL):
`order_type = 'S'` (Sell), `actual_pickup_on IS NOT NULL` (dispatched), non-test consignor
(`dim_grower.is_test = false`). **Dimensions:** grower (`grower_key` = consignor_id) + readable
`grower_code`/`grower_name`, `pack_week` (parsed `Y{YY}W{WW}`), `crop`/`variety`/`product`,
`consignee_key` (customer DC), `dispatched_on` (`actual_pickup_on`).

**Grain safety:** nothing sliceable below pallet/line grain; `location_id` and harvest-load
lineage (`harvest_load_id`, null outbound) are not modelled.

## RLS (multi-tenant)
Tenant scope is enforced in `cube.js` → `queryRewrite`, **not** Postgres RLS. Cube connects on a
read-only role that reads all rows; every query is narrowed to the caller's consignor.

- Grower context: `securityContext.app_metadata.consignor_id` → query filtered to that consignor.
- Internal/service: `securityContext.app_metadata.is_internal` (truthy) → unscoped.
- Neither → **fail closed** (no rows). No dimension selection can widen a grower's scope.

This mirrors the Sprint-1 DB contract (migration `0010`): claims come from the server-controlled
`app_metadata` namespace, which a grower cannot self-set.

## Proofs (runnable)
- `npm run cube:reconcile` — each measure vs a direct SQL aggregate over `raw`/`core`, by grower
  and by pack-week. Variances logged, not hidden. → `reports/reconciliation_cube_<date>.md`.
- `npm run cube:rls` — signs JWTs for grower A, grower B, and internal; proves isolation.

Both read `CUBE_API_URL` + `CUBE_API_SECRET` (and `DATABASE_URL` for the SQL side) from the repo
root `.env`.

## Deployment
Dev-mode / Cube Cloud Playground proof is sufficient for this sprint. The production hosting
choice (Cube Cloud vs self-host on Railway) is an **open decision** — see `HANDOFF.md`.
