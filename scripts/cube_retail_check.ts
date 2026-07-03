// ─────────────────────────────────────────────────────────────────────────────
// Cube retail check — the internal-only retail view, live on Cube Cloud.
//   node --experimental-strip-types scripts/cube_retail_check.ts
//   (needs CUBE_API_URL + CUBE_API_SECRET + DATABASE_URL. An npm alias "cube:retail"
//    can be added once package.json's uncommitted state is resolved.)
//
// Run AFTER deploying the retail model (cd cube && npx cubejs-cli deploy). Proves, against
// the deployed `retail` view:
//   • internal observation_count / promo_observations / avg_price match semantic.retail_prices
//     (parity through Cube)
//   • a REAL grower context gets 0 rows (the INTERNAL_ONLY_VIEWS queryRewrite gate)
//   • no-claim → 0 and forged top-level claims → 0 (same fail-closed app_metadata contract)
// Exit 0 = all pass; 1 = any failure.
// ─────────────────────────────────────────────────────────────────────────────
import { cubeLoad, scalar, ctxInternal, ctxGrower } from './cube_lib.ts';
import type { SecurityContext } from './cube_lib.ts';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const OBS = 'retail.observation_count';
const PROMO = 'retail.promo_observations';
const AVG = 'retail.avg_price';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
const near = (a: number | null, b: number, tol = 0.01) => a != null && Math.abs(a - b) < tol;
const noAccess = (v: number | null) => v === null || v === 0;

async function main(): Promise<void> {
  console.log('=== Cube retail check (live retail view) ===\n');
  // DB baselines from the semantic view (the source of truth Cube must reproduce).
  const pool = makePool();
  const client = await pool.connect();
  let dbObs: number, dbPromo: number, dbAvg: number, growerId: string, growerCode: string;
  try {
    const t = (await client.query<{ obs: string; promo: string; avg: string }>(
      `select count(*) obs,
              count(*) filter (where promo_flag) promo,
              avg(price) avg
         from semantic.retail_prices`)).rows[0]!;
    dbObs = Number(t.obs); dbPromo = Number(t.promo); dbAvg = Number(t.avg);
    const g = (await client.query<{ consignor_id: string; code: string }>(
      `select consignor_id, code from core.dim_grower
        where consignor_id is not null limit 1`)).rows[0]!;
    growerId = g.consignor_id; growerCode = g.code;
  } finally { client.release(); await pool.end(); }
  console.log(`DB: observations=${dbObs} promos=${dbPromo} avg_price=${dbAvg.toFixed(4)} | probe grower ${growerCode}\n`);

  // Internal parity.
  check('internal observation_count == DB', near(await scalar(OBS, ctxInternal), dbObs, 0.5),
    `cube=${await scalar(OBS, ctxInternal)} db=${dbObs}`);
  check('internal promo_observations == DB', near(await scalar(PROMO, ctxInternal), dbPromo, 0.5),
    `cube=${await scalar(PROMO, ctxInternal)} db=${dbPromo}`);
  check('internal avg_price == DB', near(await scalar(AVG, ctxInternal), dbAvg),
    `cube=${await scalar(AVG, ctxInternal)} db=${dbAvg.toFixed(4)}`);

  // Internal-only gate: a REAL grower must see NOTHING (not scoped — zero).
  const gObs = await scalar(OBS, ctxGrower(growerId));
  check(`real grower ${growerCode} → 0 observations`, noAccess(gObs), `obs=${gObs}`);
  const gRows = await cubeLoad({ dimensions: ['retail.retailer'], measures: [OBS] }, ctxGrower(growerId));
  check(`real grower ${growerCode} → 0 rows with group_by`, gRows.length === 0, `rows=${gRows.length}`);

  // Fail closed.
  check('no-claim → 0', noAccess(await scalar(OBS, {})), `obs=${await scalar(OBS, {})}`);
  check('forged top-level is_internal → 0',
    noAccess(await scalar(OBS, { is_internal: true } as SecurityContext)), 'forged internal');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('retail check error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
