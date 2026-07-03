# Sprint: Retail price semantic + Cube metric layer (reporting phase 1)
Date: 2026-07-03
Repo: mm-data-hub (mackaysmarketing/mm-data-hub)
Source: `raw.retail_prices` (migration `0027`, landed daily by the price-reporter repo)
Project: `data_hub` (`uqzfkhsdyeokwnkpcxui`, ap-southeast-2)

> **CLEAR TO RUN** (verified 2026-07-03): the uncommitted SPRINT.md here is an mm-HUB sprint
> ("Grower Access Claims", public/private schemas only, its migration applied to the hub
> 2026-07-02) — it does NOT touch cube.js or raw/core/semantic. No collision. The retail
> queryRewrite branch added here is additive; the future mm-data-hub "freshness guard" companion
> sprint will edit queryRewrite next to it. Do not touch SPRINT.md or that sprint's files.

## Scope
Model the retail shelf-price data (Woolworths per-state stores, Coles AU baseline + per-store
rows when unblocked, ALDI national + Super Savers) from raw into core/semantic, and expose a
governed, internal-only Cube metric layer over it. This makes "price by retailer/state over
time", promo frequency, and cross-retailer gap questions one governed query (Steep / hub MCP)
instead of hand SQL against raw.

Explicitly NOT in scope: Steep dashboards (next sprint consumes this), alerting, any
price-reporter/scraper changes, backfill (data accrues daily from the scheduled run),
any change to grower-facing dispatch/settlement metrics.

## Components
1. **Migration `0028_core_dim_retail_product.sql`** — `core.dim_retail_product`: the 5 Mackays
   watchlist lines with per-retailer ids (the cross-retailer join key). Seeded in-migration from
   the confirmed price-reporter config (labels; WW stockcodes 133211/157649/106218/120080/172659;
   Coles ids 409499/2511791/5900530/6950578; ALDI codes 000000000000380234/…380092/…380298; nulls
   where a retailer has no match). `label` = conformed key. No enums; raw/core/semantic only.
2. **Migration `0029_semantic_retail_prices.sql`** — `semantic.retail_prices` view:
   - Day grain: latest capture per (retailer, state, store_name, product_id) per **local
     (Australia/Brisbane) capture date** — dedupes multiple runs in a day.
   - `scope` column: `'national'` where state='AU', else `'state'` (AU must never chart as a
     ninth state).
   - `is_watchlist` flag via `core.dim_retail_product` (separates the 5 lines from ALDI
     Super Savers catalogue rows).
   - Price fields pass through untouched; **nulls never coalesced** (house invariant).
   - INTERNAL-ONLY access posture: NO grant to `authenticated` (growers get nothing —
     permission-denied, fail closed); SELECT for `cube_readonly` (0012 pattern).
3. **Cube model** (`cube/model/cubes/retail_prices.yml` public:false +
   `cube/model/views/retail.yml`):
   - Dimensions: retailer, state, scope, store_name, product_label, is_watchlist, capture_date,
     promo_flag, promo_label, price, was_price, unit_price.
   - Measures: avg/min/max price, observation count, promo_day count. (Latest-price-as-of is the
     day grain itself; windowed change metrics are a later additive contract.)
   - CONTRACTS.md entries — **additive-only**, incl. the "filter scope before cross-state
     comparisons" consumer note.
4. **`cube.js` queryRewrite** — retail view is **internal-only**: `is_internal` context passes
   unscoped; any grower/no-claim/invalid context → NIL (0 rows). The inverse of the dispatch
   pattern; same `app_metadata`-only, fail-closed contract. (Coordination point with the
   grower-access-claims sprint — see QUEUED note.)
5. **Proofs (runnable, house pattern):**
   - `npm run retail:semantic:proof` — SQL: one row per grain; watchlist split correct against
     the loaded day (37-row day: 7 watchlist + 30 specials); scope column correct; re-run doc'd
     for day 2 when WW state rows land.
   - `scripts/cube_retail_check.ts` (invoke directly: `node --experimental-strip-types
     scripts/cube_retail_check.ts`; the npm alias waits on package.json's uncommitted state) —
     post-deploy parity vs semantic SQL + fail-closed proof (internal parity; real grower 0;
     no-claim 0; forged 0). Cloud parity is **post-deploy** — no deploy token on this machine;
     deploy is Tim's manual step (`cd cube && npx cubejs-cli deploy`).

## Acceptance criteria
- [ ] 0028 + 0029 applied to the hub with ledger entries; grep-proof migrations touch only
      raw/core/semantic; no enum types anywhere.
- [ ] `semantic.retail_prices`: SQL evidence of exactly one row per (retailer, state, store,
      product, local date); AU rows scope='national'; 7/30 watchlist/specials split on the
      2026-07-03 data.
- [ ] Grower fail-closed evidence: SELECT as `authenticated` context fails (no grant); Cube
      grower context returns 0 rows (post-deploy; compile-level assertion pre-deploy).
- [ ] Cube compile check green; CONTRACTS.md updated additively; typecheck clean.
- [ ] Post-deploy (manual): `npm run cube:retail` parity + RLS proof pasted into HANDOFF.
- [ ] HANDOFF.md updated + committed (push per CLAUDE.md PAT procedure).

## Goal condition
All acceptance criteria above ticked with pasted command/SQL output in the transcript; the two
migrations applied and committed; stop after 25 turns.

## Out of scope (repeat, hard)
SPRINT.md (grower access claims sprint) and its files; Steep; alerting; price-reporter repo;
public/auth/storage schemas; redefining ANY existing metric contract.
