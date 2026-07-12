# Sprint: Retail scan ingestion — Coles weekly sell-through (Circana supplier export)
Date: 2026-07-12
Repo: mm-data-hub

## Why
The demand signal: actual units/kg/dollars sold through Coles checkouts, weekly, by state and banana
segment — turning "what's on the shelf at what price" (raw.retail_prices, landed) into "what's
actually selling". Named in SPEC §1 as the planned "retail scan (IRI/Quantium)" source. Tim supplied
the first real export 2026-07-12; build as much as possible autonomously from it.

## Ground truth (profiled live from the sample, 2026-07-12 — the design rests on these)
- **File:** `Weekly Sales (Scan)_SUP*.csv` — a Circana/IRI-style supplier export from Coles (7.5MB,
  5,345 lines). ASCII CSV, scientific-notation floats (8.7783691936E7), empty string = null.
- **Multi-section:** 7 sections, one per GEOGRAPHY — `All Geography by Coles Supermarkets` (national)
  + NSW+ACT, QLD, SA+NT, TAS, VIC, WA. Each section = 5 metadata lines (title, Geography:,
  Manufacturer:, Brand:, SubBrand: — all COLES SUPERMARKET own-brand) + 2 header lines + data rows.
- **Row grain:** Product × Time × Causal. Product = banana category total (`BANANAS`) + 4 segments
  (`REGULAR BANANAS-BANANAS`, `PRE PACK BANANAS-BANANAS`, `LADY FINGER-BANANAS`,
  `OTHER BANANAS-BANANAS`). NO EAN/article — category-level scan, no SKU crosswalk. Causal =
  TOTAL / In store / Online. Time = 52 weekly rows `W/E DD-MM-YY` (rolling window ending 07-07-26)
  + 3 aggregates `Latest 52|4|1 W/E 07-07-26`.
- **Measures:** 19 × 5 variants (Current, % Change vs YA, Change vs YA, Year Ago, % Change vs 2 YA)
  = 95 numeric cols + 3 id cols = 98. Measures: Unit/Volume/Dollar Sales, Price Per Unit/Volume,
  Avg Weekly ACV Distribution, % Stores, Avg Weekly $/Units/Volume per Store Selling,
  Dollar/Unit/Volume Share of Parent, Base + Incremental Dollar/Unit/Volume (the promo split).
- **Verified invariant (the checksum): In store + Online == TOTAL exactly (275/275 sampled, 0 fail).**
  Segment shares ("Share of Parent") and state-vs-national sums are secondary tie checks (tolerance).
- **Derivability:** `Change vs YA` = current − year_ago and `% Change vs YA` = change/year_ago are
  PURE derivations → not landed. `% Change vs 2 YA` embeds the 2-years-ago value (not otherwise
  present) → landed. So raw lands 3 variants × 19 measures = 57 numeric columns.
- **Join to the hub:** by week (`week_ending` → core.dim_date → pack_week_code — ties scan weeks to
  pack weeks/dispatch), by state (aligns with raw.retail_prices state + market areas), by retailer
  (coles → dim_customer's Coles consignees at state level, loosely). Segment↔product is category-level
  only (documented, not forced).

## Scope
1. **Parser** `src/lib/retail_scan_coles.ts` — PURE `parseColesScanCsv(text, sourceFile)`: split
   sections on the title line, read Geography/Manufacturer/Brand/SubBrand, assert the 98-col header
   signature (FAIL LOUDLY on drift), parse rows (scientific notation → number, '' → null), return
   sections+rows with named measures (57 per row: current/_ya/_pct_2ya per measure). Unit tests over
   a committed trimmed fixture (tests/fixtures/retail_scan/) + adversarial cases. The channel-additivity
   checksum exported as a helper (assert In store + Online == TOTAL per product×time within a section).
2. **Raw (0042):** `raw.retail_scan` — wide, natural key
   (retailer, geography, product, time_label, causal) as a synthesized text PK; verbatim id columns +
   the 57 measure columns + manufacturer/brand/subbrand + source_file + _synced_at. etl-only posture.
   `time_label` verbatim (derivations happen in core).
3. **Loader** `src/loaders/retail_scan.ts` (`scan:load`) — file/dir args (default: the Downloads
   export pattern), parse → enforce the channel checksum → idempotent upsert. Weekly re-drops of the
   rolling window simply upsert (revisions win).
4. **Core (0043):** `core.fact_retail_scan` (`scan:core`) — weekly grain only (period_type='week'):
   week_ending date (parsed from `W/E DD-MM-YY`), geography_code (AU / NSW+ACT / QLD / SA+NT / TAS /
   VIC / WA), segment (ALL / REGULAR / PRE_PACK / LADY_FINGER / OTHER), causal (total/in_store/online),
   is_category_total; measures: units, dollars, volume_kg + _ya counterparts, price_per_unit,
   price_per_volume, acv_distribution, pct_stores, base/incremental dollars+units+volume.
   `Latest N` aggregate rows stay in raw only (derivable). INTERNAL-ONLY RLS + cube (0040 pattern).
5. **Semantic (0044):** `semantic.retail_scan` — security_invoker, internal-only; the weekly surface
   + dim_date join (pack_week_code, iso year/week) so scan weeks tie to pack weeks.
6. **Posture registry** — raw.retail_scan (etl-only), core.fact_retail_scan (internal-only),
   semantic.retail_scan (semantic-invoker).
7. **Proofs** `scripts/retail_scan_reconcile.ts` (`scan:reconcile`) — ALL derived in-run:
   (a) landing parity: raw rows == re-parsed source rows; (b) core parity: fact == raw week rows;
   (c) channel checksum: in_store + online == total on every (week, geo, product) for units/dollars/
   volume (0 mismatches); (d) state-vs-national + segment-vs-category ties (tolerance, informational);
   (e) NULL preservation; (f) internal-only RLS behavioral (internal>0; grower/no-claim/forged = 0).
8. Battery re-run + adversarial verify + HANDOFF/CLAUDE.md + commit.

## Acceptance Criteria
- [ ] Parser unit-tested (fixture committed); header-drift fails loudly; 0 silent numeric coercions.
- [ ] raw.retail_scan landed from the real export: 7 sections, counts pasted; idempotent re-run = 0 net-new.
- [ ] core.fact_retail_scan weekly grain: counts pasted; week_ending/geography/segment parses clean.
- [ ] scan:reconcile green with pasted evidence incl. the channel checksum at 0 mismatches.
- [ ] rls:posture green with the 3 new relations; internal-only proven behaviorally.
- [ ] Existing battery + typecheck + tests green; HANDOFF/CLAUDE.md updated; committed.

## Deferred (with reason)
- **Woolworths scan** (and any second retailer) — need their export format; parser is per-retailer
  pluggable like the remittance parsers.
- **SKU-level scan / EAN crosswalk** — this export is category-level; no SKU data present.
- **Auto-ingestion channel** (portal fetch/email) — loader takes files for now; channel TBD with Tim.
- **Cube exposure** — after definitions are signed off.
- **2-years-ago backcast** (derivable from pct_2ya) — landed raw; modeling deferred until wanted.

## Goal Condition
/goal Retail scan ingestion complete per SPRINT.md 2026-07-12: Coles Circana export parsed (pure,
unit-tested, header-drift-loud), raw.retail_scan + core.fact_retail_scan + semantic.retail_scan
landed and refreshed from the real export (0042/0043/0044), posture registry green at 78/78,
scan:reconcile green incl. the in_store+online==total checksum at 0 mismatches, existing battery +
tests + typecheck green, docs updated, committed. READ-ONLY sources; internal-only RLS fail-closed
proven. Stop after 40 turns.
