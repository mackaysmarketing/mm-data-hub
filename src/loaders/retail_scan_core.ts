// Retail-scan CORE builder → core.fact_retail_scan.
//   npm run scan:core
//
// Idempotent (refresh = DELETE + re-INSERT). Run AFTER scan:load. Prints the weekly-grain counts +
// the conformance self-checks so a bad build is loud: every weekly raw row lands exactly once, the
// unique logical-grain index guarantees no mapping collision, and unknown segment/geography values
// surface verbatim rather than vanish.
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export async function buildRetailScanCore(): Promise<number> {
  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c = await pool.connect();
    try {
      const n = (await c.query<{ n: number }>('select core.refresh_fact_retail_scan() as n')).rows[0]!.n;
      log(`  core.fact_retail_scan rebuilt: ${n} rows (weekly grain)`);

      const parity = (await c.query<{ raw_weekly: string; fact: string }>(
        `select (select count(*) from raw.retail_scan where time_label like 'W/E %')::text as raw_weekly,
                (select count(*) from core.fact_retail_scan)::text as fact`)).rows[0]!;
      log(`  parity: raw weekly rows=${parity.raw_weekly} fact=${parity.fact} (expect equal)`);

      const dims = (await c.query<{ weeks: string; geos: string; segs: string; sups: string; causals: string }>(
        `select count(distinct week_ending)::text weeks, count(distinct geography_code)::text geos,
                count(distinct segment)::text segs, count(distinct supplier)::text sups,
                count(distinct causal)::text causals
           from core.fact_retail_scan`)).rows[0]!;
      log(`  dims: weeks=${dims.weeks} geographies=${dims.geos} segments=${dims.segs} suppliers=${dims.sups} causals=${dims.causals}`);

      const unknown = (await c.query<{ n: string }>(
        `select count(*)::text n from core.fact_retail_scan
          where segment not in ('ALL','REGULAR','PRE_PACK','LADY_FINGER','OTHER')
             or geography_code not in ('AU','NSW+ACT','QLD','SA+NT','TAS','VIC','WA')
             or causal not in ('total','in_store','online')`)).rows[0]!.n;
      log(`  unmapped segment/geography/causal rows: ${unknown} (surfaced verbatim if > 0)`);
      return n;
    } finally { c.release(); }
  } finally { await pool.end(); }
}

if (isMain(import.meta.url)) {
  const n = await buildRetailScanCore();
  log(`done: fact_retail_scan=${n}`);
}
