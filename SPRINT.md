# Module Spec: WOW Scan Data Ingest (Q.Checkout)
Date: 2026-07-13
Repo: mm-data-hub
Status: Ready to build

## Scope

Ingest the Woolworths Q.Checkout "Scan data export" CSV into the medallion warehouse:
raw landing -> core fact table -> semantic rollups exposed through Cube. The feed is the
Woolworths counterpart to the existing Coles Synergy scan feed and must join to it on
week and article for cross-retailer reporting.

Explicitly NOT in scope: automating the export out of Q.Checkout (manual download for
now), store-level data (not available at current subscription tier — finest location
grain is State x Simple VCU), and any Cube dashboard work beyond exposing the view.

## Source characteristics (verified against the 13 Jul 2026 sample)

- File: report-wizard CSV, ~40 MB, 303k rows for 27 products x 52 weeks.
- Layout: metadata block (export parameters) above a `Promo Week` header row, then data.
- `Promo Week` is week-ENDING Tuesday (Woolworths Wed-Tue promo week), DD/MM/YYYY.
- Dimensions: Sub-Category, Segment, Product, Location (Australia + 7 states),
  Simple VCU (Total / CORE / UP / VALUE — Woolworths store-format clusters),
  Channel (Total / INSTORE / ONLINE), Promotion (Total / On / Off promotion).
- Metrics: Volume, Sales, Units, Average price per volume, Average unit price.
  Metric column names carry a `- N Week(s)` suffix that varies with wizard settings.
- Nulls appear as blank OR `-`. 62% of rows are blank cross-join padding.
- Total-grain rows coexist with their splits: naive SUM over the file multiplies
  results up to 8x. Only the finest grain is loaded; totals are derived.
- The Product field parses as `{article_number}-{UOM} - {description}`
  (e.g. `0133211-KG - BANANA 1KG`), 100% parse rate on the sample.

## Architecture

```
uploads/ (manual CSV)                       raw.wow_scan_export   (landed verbatim + load_id)
        -> parse_wow_scan.py ->             core.wow_scan_weekly  (finest grain, typed, keyed)
                                            semantic.v_wow_scan_* (totals, promo split, x-retailer)
```

### raw.wow_scan_export
Land the file verbatim (all columns text) plus `load_id uuid`, `source_filename`,
`loaded_at`. The metadata sidecar JSON from the parser is stored in
`raw.wow_scan_loads (load_id, export_parameters jsonb, stats jsonb, loaded_at)`.

### core.wow_scan_weekly (DDL)

```sql
create table core.wow_scan_weekly (
  week_ending          date        not null,  -- Tuesday
  article_number       text        not null,  -- zero-padded, e.g. '0133211'
  uom                  text        not null,  -- 'KG' | 'EA'
  article_description  text        not null,
  sub_category         text        not null,  -- BANANA | TROPICAL FRUIT
  segment              text        not null,
  state                text        not null,  -- 7 AU states, no 'Australia'
  vcu                  text        not null,  -- CORE | UP | VALUE, no 'Total'
  channel              text        not null,  -- INSTORE | ONLINE, no 'Total'
  promotion            text        not null,  -- ON_PROMOTION | OFF_PROMOTION, no 'Total'
  volume               numeric,
  sales                numeric,
  units                numeric,
  avg_price_per_volume numeric,
  avg_unit_price       numeric,
  load_id              uuid        not null references raw.wow_scan_loads(load_id),
  primary key (week_ending, article_number, state, vcu, channel, promotion)
);
```

Load strategy: upsert on the primary key (re-exports of overlapping windows replace
prior rows — Quantium restates recent weeks). RLS: internal-only for now; this is
Mackays category data, not grower-scoped, so no consignor_id policy applies.

### Semantic layer
- `semantic.v_wow_scan_national` — week x article totals (derived, matches the
  export's own Australia/Total slice to the cent — see AC3).
- `semantic.v_wow_scan_promo` — promo vs off-promo split with promo share of sales.
- `semantic.v_scan_cross_retailer` — union with the Synergy Coles feed on
  (week_ending, article/mapping, state). Note the week-basis difference:
  Woolworths weeks end Tuesday; align on week_ending date, document the offset
  against the Coles week before anyone compares "same week" numbers.

## Parser contract (parse_wow_scan.py)

1. Locate the `Promo Week` header row dynamically; capture the metadata block above it.
2. FAIL LOUDLY (non-zero exit) if the eight dimension columns change or a metric
   column prefix is missing. Never silently adapt to a changed export format.
3. Drop blank-metric rows (count them). Treat blank and `-` as null.
4. Drop Total-grain rows (Location='Australia' OR any dimension = 'Total') unless
   `--keep-totals` is passed. Count them.
5. Parse Product into article_number / uom / description; count parse failures.
6. Convert dates to ISO; normalise channel and promotion to uppercase enums.
7. Emit clean CSV + JSON sidecar (export parameters, stats, coverage).
8. Row accounting must balance: rows_in = rows_out + blank_dropped + total_dropped,
   else exit 1.

## Acceptance Criteria
- [ ] AC1: Parser processes the 13 Jul 2026 sample with exit code 0; sidecar shows
      rows_in 303,264 / rows_out 35,335 / blank 188,690 / total-grain 79,239 /
      unparsed products 0. Paste the sidecar stats block.
- [ ] AC2: `select count(*) from core.wow_scan_weekly` = 35,335 after load; primary
      key holds (load does not error on duplicates). Paste the query result.
- [ ] AC3: Reconciliation — SUM(sales) and SUM(volume) from core.wow_scan_weekly
      equal the source file's Australia/Total/Total/Total slice to 0.001%
      (expected: sales $497,463,530; volume 111,445,503). Paste both numbers.
- [ ] AC4: Re-running the same load is idempotent — row count unchanged, no dupes.
      Paste count before/after.
- [ ] AC5: `semantic.v_wow_scan_national` for week 2026-07-07, article 0133211
      matches the source's Australia/Total row for that week. Paste both values.
- [ ] AC6: Feeding the parser a CSV with a renamed dimension column exits non-zero
      with a clear message. Paste the command output.

## Definition of Done
- [ ] All acceptance criteria checked, each with pasted evidence
- [ ] Parser + loader committed with tests covering: null markers, Total-grain
      filtering, product parse, header-change failure, row accounting
- [ ] Views created and queryable in Cube
- [ ] HANDOFF.md updated and committed
- [ ] Wiki page added to the mm-data-hub knowledge wiki (source quirks: Tuesday
      weeks, '-' nulls, 8x total-grain trap, VCU definitions, restatement window)

## Goal Condition

/goal All six acceptance criteria in MODULE-WOW-SCAN-SPEC.md pass with real command
output or query rows pasted for each — especially the AC3 reconciliation figures and
the AC6 failure-mode output. Do not modify the Synergy ingest or any existing core
tables. Stop after 25 turns.

## Out of Scope
- Q.Checkout export automation (browser automation is a later sprint)
- Store-level data (subscription tier limitation — commercial, not technical)
- Coles/Woolworths article mapping table (separate sprint; v_scan_cross_retailer
  can ship with a manual seed mapping for the banana lines)

## Known source risks
- Quantium restates recent weeks: always re-export a trailing 4-week overlap and
  rely on the upsert to correct.
- Three articles in the sample have zero data (0826819, 0224551, 0104055) and four
  have one week of life — expect the article list to churn; never hard-code SKUs.
- The wizard ignored the state filter in the sample (all 7 states came back despite
  4 selected). Treat filename-derived assumptions as unreliable; trust file content.
