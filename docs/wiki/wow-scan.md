# WOW scan — Woolworths Q.Checkout weekly sell-through

The Woolworths counterpart to the Coles Circana scan feed (`raw.retail_scan` /
`core.fact_retail_scan`). Source is the Q.Checkout "Scan data export" CSV (report wizard,
weekly trend) that Tim downloads manually — ~40 MB, 303k rows for 27 products x 52 weeks
on the 13 Jul 2026 sample. Pipeline (spec: `MODULE-WOW-SCAN-SPEC.md` in `SPRINT.md`,
migration `0049`):

```
uploads/ (manual CSV)
  -> scripts/parse_wow_scan.py        clean finest-grain CSV + JSON sidecar
  -> src/loaders/wow_scan.ts          raw.wow_scan_export (verbatim) + raw.wow_scan_loads (sidecar)
                                      core.wow_scan_weekly (typed, PK-upserted)
  -> semantic.v_wow_scan_*            national totals / promo split / cross-retailer
```

Posture: INTERNAL-ONLY throughout (Mackays category data, never grower-scoped). Raw is
etl-only; core + views follow the 0040/0043 internal-only pattern.

## Source quirks (encode, don't re-discover)

- **Weeks end TUESDAY.** `Promo Week` is the week-ENDING date of the Woolworths Wed-Tue
  promo week, formatted DD/MM/YYYY. The Coles Circana scan weeks ALSO end Tuesday, so
  cross-retailer alignment is **exact-date equality on `week_ending`** — no offset
  arithmetic. (The spec's early draft warned of a week-basis offset; verification showed
  both feeds are Tuesday-ending. Do not "correct" one side by 6 days.)
- **Nulls are blank OR `-`.** Both must land as SQL NULL — never 0. An `avg_*` of 0 is a
  data lie; a volume of 0 corrupts averages (same invariant as `net_weight_value` in
  SPEC §9). The parser also tolerates `n/a` / `na` / `null`, but blank and `-` are what
  Q.Checkout actually emits. 62% of the sample's rows are blank cross-join padding —
  dropped and counted, never loaded.
- **The 8x total-grain trap.** Total-grain rows coexist with their splits in the same
  file: `Location='Australia'`, `Simple VCU='Total'`, `Channel='Total'`,
  `Promotion='Total'` in every combination. A naive `SUM()` over the file multiplies
  results **up to 8x**. Only the finest grain (State x VCU x Channel x Promotion) is
  loaded into `core.wow_scan_weekly`; every total is DERIVED downstream
  (`semantic.v_wow_scan_national` must tie back to the export's own Australia/Total slice
  — that is the reconciliation, not a coincidence).
- **VCU = Woolworths store-format clusters.** `Simple VCU` in {`CORE`, `UP`, `VALUE`}
  (plus the excluded `Total`): CORE = mainstream supermarkets, UP = premium/metro
  formats, VALUE = price-led stores. It is a store segmentation, not a product one —
  finest location grain at the current subscription tier is State x Simple VCU (no
  store-level data; commercial limitation, not technical).
- **Quantium restates recent weeks.** Numbers for recent weeks change between exports.
  Always re-export with a trailing **4-week overlap**; the upsert on the core PK
  (`week_ending, article_number, state, vcu, channel, promotion`) corrects prior rows.
  Same pattern as the Coles scan's rolling 52-week re-drops.
- **Article churn — never hard-code SKUs.** Three articles in the 13 Jul 2026 sample had
  zero data (0826819, 0224551, 0104055) and four lived for a single week. The article
  list is data, not configuration. The `Product` field parses as
  `{article_number}-{UOM} - {description}` (e.g. `0133211-KG - BANANA 1KG`; UOM is `KG`
  or `EA`), 100% parse rate on the sample; parse failures are counted and surfaced.
- **The wizard's state filter is unreliable.** The sample requested 4 states and got all
  7 back. Treat wizard parameters and filename-derived assumptions as decoration — trust
  file CONTENT only. (The export parameters are still captured verbatim into the sidecar
  for provenance.)
- **Metric headers carry a variable suffix.** `Volume - 52 Weeks` etc. — the `- N
  Week(s)` tail follows the wizard's time setting, so the parser matches metric columns
  by prefix. The eight dimension columns are pinned EXACTLY; any rename or reorder is a
  hard parser failure (see contract below).

## Run commands

Parse standalone (no DB touched — clean CSV + sidecar only):

```
py -3 scripts/parse_wow_scan.py uploads/<export>.csv --out clean.csv --meta meta.json
py -3 scripts/parse_wow_scan.py uploads/<export>.csv --keep-totals   # keep Total rows (debug/recon only)
```

Load into the hub (parses internally, lands `raw.wow_scan_export` verbatim +
`raw.wow_scan_loads` sidecar, upserts `core.wow_scan_weekly`):

```
npm run wow:load -- uploads/<export>.csv        # full source CSV: verbatim raw + core upsert
npm run wow:load -- --clean clean.csv --meta meta.json
                                                # pre-parsed variant: core only,
                                                # raw.wow_scan_loads.verbatim_landed = false
npm run wow:verify                              # row accounting, PK idempotency,
                                                # Australia/Total reconciliation (AC1-AC5)
```

Tests (no DB, drives the real parser via `py -3`): `npm test` runs
`tests/wow_scan_parser.test.ts` over the committed fixtures in
`tests/fixtures/wow_scan/`.

## Load-accounting contract

Every source row must be accounted for, or nothing loads:

```
rows_in == rows_out + rows_blank_dropped + rows_total_grain_dropped
```

The parser exits 1 on any imbalance (and on any header drift, and on unparsed-product
rows being silently possible — they are counted in `rows_unparsed_product` and must be 0
before a load is accepted). The sidecar (export parameters + stats + coverage) is stored
per load in `raw.wow_scan_loads`, so every core row traces to a load whose accounting
balanced. Reference numbers from the 13 Jul 2026 sample (AC1):

| stat | value |
|---|---|
| rows_in | 303,264 |
| rows_out (finest grain) | 35,335 |
| rows_blank_dropped | 188,690 |
| rows_total_grain_dropped | 79,239 |
| rows_unparsed_product | 0 |

Reconciliation target (AC3): `SUM(sales)` and `SUM(volume)` over `core.wow_scan_weekly`
must equal the export's own Australia/Total/Total/Total slice to 0.001% (sample: sales
$497,463,530; volume 111,445,503). The mini fixture
(`tests/fixtures/wow_scan/mini_source.csv`) is built to the same property: its
finest-grain rows sum exactly to the Australia/Total anchor rows it contains, so the tie
is proven in unit tests before it is ever run against the database.

## Cross-retailer notes

- Join to the Coles scan on exact `week_ending` (both Tuesday-ending — see quirks).
- Article mapping Coles<->WOW is a separate sprint; `core.wow_article_segment_map`
  (migration 0049) seeds the banana lines mechanically from the description so
  `semantic.v_scan_cross_retailer` can ship. Tim's manual overrides use `source='tim'`
  and must survive rebuilds (same persistence rule as `revenue_class` in
  `core.dim_gp_charge`).
- WOW gives State x VCU x Channel x Promotion at article grain; the Coles feed is
  category/segment grain with a supplier split — compare at segment level, not SKU.
