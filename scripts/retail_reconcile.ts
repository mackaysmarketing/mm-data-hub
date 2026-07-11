// ─────────────────────────────────────────────────────────────────────────────
// Retail raw→semantic reconciliation — brings retail to house proof parity.
//   npm run retail:reconcile
//
// Proves semantic.retail_prices (0029) against raw.retail_prices (0027) +
// core.dim_retail_product (0028), SQL as the oracle — expectations are DERIVED
// from raw in the same run, never hardcoded:
//   0. Fail-closed posture: semantic.retail_prices has NO authenticated grant
//      (deliberate, 0029); raw/dim are RLS-on cube-only; cube_readonly can read.
//   1. Day-grain dedupe: exactly one view row per (retailer, state, store_name,
//      product_id, Australia/Brisbane capture date) — zero duplicate groups.
//   2. Latest capture wins: every view row carries max(captured_at) of its raw
//      day-group; view row count == distinct raw day-group count (global parity).
//   3. Spot-check N=20 day-groups against raw (multi-capture groups first):
//      run_id / captured_at / price / was_price / promo_flag / label all match.
//   4. Watchlist flags match core.dim_retail_product (retailer-specific id join);
//      dim coverage (ids never yet observed in raw) is SURFACED, not failed.
//   5. Per-retailer/state row parity vs raw day-groups (the view's only filter
//      is the rn=1 dedupe — expected counts derived from raw in the same query).
//   6. NULL prices preserved: view nulls == raw-latest nulls; zero per-row price
//      or was_price mutations (nothing coalesced to 0 — house invariant).
//
// Connects via makePool() (table owner) because the view deliberately has no
// authenticated grant. Writes reports/retail_reconcile_<date>.md.
// Exit 0 = all checks pass; 1 = any fail. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain, log } from '../src/lib/util.ts';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '∅').length)));
  log('  ' + cols.map((c, i) => c.padEnd(w[i]!)).join('  '));
  for (const r of rows) log('  ' + cols.map((c, i) => String(r[c] ?? '∅').padEnd(w[i]!)).join('  '));
}

/** raw day-groups — the view's documented grain, derived fresh from raw every run. */
const RAW_DAY = `
  select retailer, state, store_name, product_id,
         (captured_at at time zone 'Australia/Brisbane')::date as capture_date,
         max(captured_at) as latest_captured_at,
         count(*) as captures
    from raw.retail_prices
   group by 1, 2, 3, 4, 5`;

export async function reconcile(c: PoolClient): Promise<boolean> {
  log('=== Retail raw→semantic reconciliation (expectations derived from raw) ===');

  // ── 0. Fail-closed grant posture (0027/0028/0029 contract) ─────────────────
  log('\n--- 0. Grant / RLS posture (fail-closed, asserted explicitly) ---');
  const posture = (await c.query(
    `select has_table_privilege('authenticated', 'semantic.retail_prices', 'select')::text  as auth_view,
            has_table_privilege('anon',          'semantic.retail_prices', 'select')::text  as anon_view,
            has_table_privilege('authenticated', 'raw.retail_prices', 'select')::text       as auth_raw,
            has_table_privilege('authenticated', 'core.dim_retail_product', 'select')::text as auth_dim,
            has_table_privilege('cube_readonly', 'semantic.retail_prices', 'select')::text  as cube_view,
            (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'raw' and c.relname = 'retail_prices')::text                 as raw_rls,
            (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'core' and c.relname = 'dim_retail_product')::text          as dim_rls,
            (select c.reloptions::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'semantic' and c.relname = 'retail_prices')                 as view_opts`,
  )).rows[0]!;
  table([posture]);
  check('semantic.retail_prices has NO authenticated grant (fail-closed by design, 0029)',
    posture.auth_view === 'false' && posture.anon_view === 'false',
    `authenticated=${posture.auth_view} anon=${posture.anon_view}`);
  check('raw.retail_prices + core.dim_retail_product are cube-only (no authenticated grant, RLS on)',
    posture.auth_raw === 'false' && posture.auth_dim === 'false'
      && posture.raw_rls === 'true' && posture.dim_rls === 'true',
    `auth_raw=${posture.auth_raw} auth_dim=${posture.auth_dim} raw_rls=${posture.raw_rls} dim_rls=${posture.dim_rls}`);
  check('cube_readonly CAN read the view; view is security_invoker',
    posture.cube_view === 'true' && (posture.view_opts ?? '').includes('security_invoker=true'),
    `cube=${posture.cube_view} reloptions=${posture.view_opts}`);

  // ── 1. Day-grain dedupe: one row per (product, retailer, state-scope, local day) ──
  log('\n--- 1. Day-grain uniqueness in the view ---');
  const dup = (await c.query(
    `select count(*)::text as dup_groups from (
       select retailer, state, store_name, product_id, capture_date
         from semantic.retail_prices
        group by 1, 2, 3, 4, 5 having count(*) > 1) x`,
  )).rows[0]!;
  check('exactly one view row per (retailer, state, store, product, local day)',
    dup.dup_groups === '0', `duplicate groups=${dup.dup_groups}`);

  // ── 2. Latest-capture correctness + global parity (full set, not sampled) ──
  log('\n--- 2. Latest capture wins (full set) ---');
  const latest = (await c.query(
    `with raw_day as (${RAW_DAY})
     select (select count(*) from raw_day)::text                        as expected_groups,
            (select count(*) from semantic.retail_prices)::text        as view_rows,
            (select count(*) from raw_day where captures > 1)::text    as multi_capture_groups,
            (select count(*) from semantic.retail_prices v
               join raw_day r
                 on r.retailer = v.retailer and r.state = v.state
                and r.store_name = v.store_name and r.product_id = v.product_id
                and r.capture_date = v.capture_date
              where v.captured_at <> r.latest_captured_at)::text       as stale_rows,
            (select count(*) from semantic.retail_prices v
               left join raw_day r
                 on r.retailer = v.retailer and r.state = v.state
                and r.store_name = v.store_name and r.product_id = v.product_id
                and r.capture_date = v.capture_date
              where r.retailer is null)::text                          as orphan_view_rows`,
  )).rows[0]!;
  table([latest]);
  check('view rows == raw day-groups (nothing dropped, nothing invented)',
    latest.expected_groups === latest.view_rows,
    `expected=${latest.expected_groups} view=${latest.view_rows}`);
  check('every view row is the LATEST capture of its day-group',
    latest.stale_rows === '0' && latest.orphan_view_rows === '0',
    `stale=${latest.stale_rows} orphans=${latest.orphan_view_rows} (multi-capture groups today=${latest.multi_capture_groups})`);

  // ── 3. Spot-check N=20 day-groups against raw ──────────────────────────────
  log('\n--- 3. Spot-check (N=20, multi-capture groups first, deterministic order) ---');
  // The view carries run_id, and (run_id, retailer, state, product_id) is raw's natural
  // key — so the raw join below fetches exactly the row the view surfaced, then asserts
  // it is the day-group's latest and that every value passed through unmutated.
  const spot = (await c.query(
    `with raw_day as (${RAW_DAY}),
     sample as (
       select * from raw_day
        order by captures desc,
                 md5(retailer || '|' || state || '|' || store_name || '|' || product_id || '|' || capture_date::text)
        limit 20)
     select s.retailer, s.state, s.product_id, s.capture_date::text as capture_date,
            s.captures::text as captures,
            (r.captured_at = s.latest_captured_at)::text          as is_latest,
            (r.store_name = s.store_name)::text                   as store_ok,
            (v.price is not distinct from r.price)::text          as price_ok,
            (v.was_price is not distinct from r.was_price)::text  as was_price_ok,
            (v.promo_flag = r.promo_flag)::text                   as promo_ok,
            (v.product_label = r.product_label)::text             as label_ok
       from sample s
       join semantic.retail_prices v
         on v.retailer = s.retailer and v.state = s.state
        and v.store_name = s.store_name and v.product_id = s.product_id
        and v.capture_date = s.capture_date
       join raw.retail_prices r
         on r.run_id = v.run_id and r.retailer = v.retailer
        and r.state = v.state and r.product_id = v.product_id
      order by s.captures desc, s.retailer, s.product_id`,
  )).rows;
  table(spot);
  const expectedN = Math.min(20, Number(latest.expected_groups));
  const spotBad = spot.filter((r) => [r.is_latest, r.store_ok, r.price_ok, r.was_price_ok, r.promo_ok, r.label_ok].some((v) => v !== 'true'));
  check(`spot-check: ${expectedN} sampled day-groups match raw latest exactly`,
    spot.length === expectedN && spotBad.length === 0,
    `sampled=${spot.length} expected=${expectedN} mismatched=${spotBad.length}`);

  // ── 4. Watchlist flags vs core.dim_retail_product ──────────────────────────
  log('\n--- 4. Watchlist flags vs core.dim_retail_product ---');
  const wl = (await c.query(
    `select count(*) filter (where v.is_watchlist <> (p.product_key is not null))::text as flag_mismatches,
            count(*) filter (where v.is_watchlist and v.product_key is distinct from p.product_key)::text as key_mismatches,
            count(*) filter (where v.is_watchlist)::text as watchlist_rows,
            count(*)::text as view_rows
       from semantic.retail_prices v
       left join core.dim_retail_product p
         on (v.retailer = 'woolworths' and v.product_id = p.ww_product_id)
         or (v.retailer = 'coles'      and v.product_id = p.coles_product_id)
         or (v.retailer = 'aldi'       and v.product_id = p.aldi_product_id)`,
  )).rows[0]!;
  check('is_watchlist / product_key match a fresh dim join on every view row',
    wl.flag_mismatches === '0' && wl.key_mismatches === '0',
    `flag_mismatches=${wl.flag_mismatches} key_mismatches=${wl.key_mismatches} (watchlist rows=${wl.watchlist_rows}/${wl.view_rows})`);
  // Dim coverage — which watchlist ids have actually been observed (surfaced, not failed:
  // e.g. Woolworths has landed no rows yet; that is scraper coverage, not view correctness).
  const coverage = (await c.query(
    `select p.product_key,
            case when p.ww_product_id    is null then 'no listing' when ww.n    > 0 then 'seen' else 'NEVER SEEN' end as woolworths,
            case when p.coles_product_id is null then 'no listing' when coles.n > 0 then 'seen' else 'NEVER SEEN' end as coles,
            case when p.aldi_product_id  is null then 'no listing' when aldi.n  > 0 then 'seen' else 'NEVER SEEN' end as aldi
       from core.dim_retail_product p
       left join lateral (select count(*) n from raw.retail_prices r where r.retailer = 'woolworths' and r.product_id = p.ww_product_id) ww on true
       left join lateral (select count(*) n from raw.retail_prices r where r.retailer = 'coles'      and r.product_id = p.coles_product_id) coles on true
       left join lateral (select count(*) n from raw.retail_prices r where r.retailer = 'aldi'       and r.product_id = p.aldi_product_id) aldi on true
      order by p.product_key`,
  )).rows;
  log('  dim coverage (informational — NEVER SEEN = scraper gap, surfaced not failed):');
  table(coverage);

  // ── 5. Per-retailer/state row parity vs raw ────────────────────────────────
  log('\n--- 5. Per-retailer/state parity (expected derived from raw in the same query) ---');
  const parity = (await c.query(
    `with raw_day as (${RAW_DAY})
     select coalesce(r.retailer, v.retailer) as retailer,
            coalesce(r.state, v.state)       as state,
            coalesce(r.expected, 0)::text    as expected,
            coalesce(v.actual, 0)::text      as actual
       from (select retailer, state, count(*) as expected from raw_day group by 1, 2) r
       full join (select retailer, state, count(*) as actual from semantic.retail_prices group by 1, 2) v
         using (retailer, state)
      order by 1, 2`,
  )).rows;
  table(parity);
  const parityBad = parity.filter((r) => r.expected !== r.actual);
  check('every (retailer, state) bucket: view rows == raw day-groups',
    parityBad.length === 0,
    `buckets=${parity.length} mismatched=${parityBad.length}${parityBad.length ? ' → ' + parityBad.map((b) => `${b.retailer}/${b.state} ${b.expected}≠${b.actual}`).join(', ') : ''}`);

  // ── 6. NULL prices preserved (never coalesced to 0) ────────────────────────
  log('\n--- 6. NULL price preservation ---');
  const nulls = (await c.query(
    `select (select count(*) from semantic.retail_prices where price is null)::text     as view_null_price,
            (select count(*) from semantic.retail_prices where was_price is null)::text as view_null_was,
            (select count(*) from semantic.retail_prices v
               join raw.retail_prices r
                 on r.run_id = v.run_id and r.retailer = v.retailer
                and r.state = v.state and r.product_id = v.product_id
              where r.price is null)::text                                              as raw_latest_null_price,
            (select count(*) from semantic.retail_prices v
               join raw.retail_prices r
                 on r.run_id = v.run_id and r.retailer = v.retailer
                and r.state = v.state and r.product_id = v.product_id
              where v.price is distinct from r.price
                 or v.was_price is distinct from r.was_price)::text                     as value_mutations,
            (select count(*) from semantic.retail_prices v
               join raw.retail_prices r
                 on r.run_id = v.run_id and r.retailer = v.retailer
                and r.state = v.state and r.product_id = v.product_id
              where (v.price = 0 and r.price is null)
                 or (v.was_price = 0 and r.was_price is null))::text                    as coalesced_zeros`,
  )).rows[0]!;
  table([nulls]);
  check('NULL prices preserved — 0 rows coalesced to 0, 0 value mutations',
    nulls.value_mutations === '0' && nulls.coalesced_zeros === '0'
      && nulls.view_null_price === nulls.raw_latest_null_price,
    `view_nulls=${nulls.view_null_price} raw_latest_nulls=${nulls.raw_latest_null_price} mutations=${nulls.value_mutations} coalesced_zeros=${nulls.coalesced_zeros}`);

  // ── Report ──────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString();
  const rp = `reports/retail_reconcile_${stamp.slice(0, 10)}.md`;
  const failed = results.filter((r) => !r.pass);
  const L: string[] = [];
  L.push(`# Retail raw→semantic reconciliation — ${stamp}`, '');
  L.push(`raw.retail_prices → semantic.retail_prices (0027/0028/0029). All expectations derived from raw in the same run — no hardcoded baselines.`, '');
  L.push('| Check | Result | Detail |', '|---|---|---|');
  for (const r of results) L.push(`| ${r.name} | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.detail} |`);
  L.push('');
  L.push('## Per-retailer/state parity');
  L.push('| retailer | state | expected (raw day-groups) | actual (view rows) |', '|---|---|---:|---:|');
  for (const r of parity) L.push(`| ${r.retailer} | ${r.state} | ${r.expected} | ${r.actual} |`);
  L.push('');
  L.push('## Watchlist dim coverage (surfaced, not failed)');
  L.push('| product_key | woolworths | coles | aldi |', '|---|---|---|---|');
  for (const r of coverage) L.push(`| ${r.product_key} | ${r.woolworths} | ${r.coles} | ${r.aldi} |`);
  L.push('');
  L.push('## Surfaced facts');
  L.push(`- Multi-capture day-groups (where the latest-wins dedupe actually bites): **${latest.multi_capture_groups}**`);
  L.push(`- View rows / raw day-groups: **${latest.view_rows} / ${latest.expected_groups}** · watchlist rows: **${wl.watchlist_rows}**`);
  L.push(`- NULL prices in view: **${nulls.view_null_price}** (== raw latest) · NULL was_price: **${nulls.view_null_was}** — passed through, never coalesced.`);
  L.push(`- Posture: semantic.retail_prices has NO authenticated grant (fail-closed, 0029); raw/dim are RLS-on cube-only.`);
  L.push('');
  writeFileSync(rp, L.join('\n'), 'utf8');

  log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) log('FAILED: ' + failed.map((f) => f.name).join('; '));
  log(`→ ${rp}`);
  return failed.length === 0;
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const pass = await reconcile(client);
    if (!pass) process.exitCode = 1;
  } catch (e) {
    console.error('retail:reconcile error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
