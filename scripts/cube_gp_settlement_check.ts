// ─────────────────────────────────────────────────────────────────────────────
// Cube GP-settlement check — the additive gp_settlement metrics, live on Cube Cloud.
//   npm run cube:gp   (needs CUBE_API_URL + CUBE_API_SECRET + DATABASE_URL; run AFTER deploy)
//
// Proves, against the deployed `gp_settlement` view:
//   • internal gp_net_paid / gp_schedule_count match the DB fact (parity through Cube)
//   • a grower context is scoped to its own settlements (== its DB total); group_by can't widen
//   • no-claim → 0 and forged top-level claims → 0 (the same fail-closed app_metadata contract)
//   • the load-grain view (gp_settlement_load) is scoped on the SCHEDULE consignor too
// Exit 0 = all pass; 1 = any failure.
// ─────────────────────────────────────────────────────────────────────────────
import { cubeLoad, scalar, ctxInternal, ctxGrower } from './cube_lib.ts';
import type { SecurityContext } from './cube_lib.ts';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const NET = 'gp_settlement.gp_net_paid';
const COUNT = 'gp_settlement.gp_schedule_count';
const GK = 'gp_settlement.grower_key';
const LOAD_NET = 'gp_settlement_load.gp_load_net_paid';
const LOAD_GK = 'gp_settlement_load.grower_key';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
const near = (a: number | null, b: number, tol = 1) => a != null && Math.abs(a - b) < tol;
const noAccess = (v: number | null) => v === null || v === 0;

async function main(): Promise<void> {
  console.log('=== Cube GP-settlement check (live gp_settlement view) ===\n');
  // DB baselines (the source of truth the Cube metrics must reproduce).
  const pool = makePool();
  const client = await pool.connect();
  let dbNet: number, dbCount: number, grower: { id: string; code: string; net: number; n: number };
  try {
    const tot = (await client.query<{ net: string; c: string }>(
      `select sum(net_settlement) net, count(*) c from core.fact_gp_settlement`)).rows[0]!;
    dbNet = Number(tot.net); dbCount = Number(tot.c);
    const g = (await client.query<{ consignor_id: string; grower_code: string; net: string; n: string }>(
      `select consignor_id, grower_code, sum(net_settlement) net, count(*) n from core.fact_gp_settlement
        where consignor_id is not null group by 1,2 order by n desc limit 1`)).rows[0]!;
    grower = { id: g.consignor_id, code: g.grower_code, net: Number(g.net), n: Number(g.n) };
  } finally { client.release(); await pool.end(); }
  console.log(`DB: net=${dbNet.toFixed(2)} schedules=${dbCount} | grower ${grower.code} net=${grower.net.toFixed(2)} (${grower.n})\n`);

  // Internal parity.
  const intNet = await scalar(NET, ctxInternal);
  const intCount = await scalar(COUNT, ctxInternal);
  check('internal gp_net_paid == DB fact', near(intNet, dbNet), `cube=${intNet} db=${dbNet.toFixed(2)}`);
  check('internal gp_schedule_count == DB fact', near(intCount, dbCount), `cube=${intCount} db=${dbCount}`);

  // Grower scope (schedule grain).
  const gNet = await scalar(NET, ctxGrower(grower.id));
  check(`grower ${grower.code} gp_net_paid scoped`, near(gNet, grower.net), `cube=${gNet} db=${grower.net.toFixed(2)}`);
  const rows = await cubeLoad({ dimensions: [GK], measures: [COUNT] }, ctxGrower(grower.id));
  const keys = rows.map((r) => String(r[GK]));
  check(`grower ${grower.code} sees only itself`, keys.length === 1 && keys[0] === grower.id, `grower_keys=${JSON.stringify(keys)}`);

  // Fail closed (schedule grain).
  check('no-claim → 0', noAccess(await scalar(NET, {})), `net=${await scalar(NET, {})}`);
  check('forged top-level is_internal → 0', noAccess(await scalar(NET, { is_internal: true } as SecurityContext)), 'forged internal');
  check('forged top-level consignor_id → 0', noAccess(await scalar(NET, { consignor_id: grower.id } as SecurityContext)), 'forged consignor');

  // Load grain — scoped on the SCHEDULE consignor; grower sees only its own, fail-closed holds.
  const loadRows = await cubeLoad({ dimensions: [LOAD_GK], measures: [LOAD_NET] }, ctxGrower(grower.id));
  const loadKeys = [...new Set(loadRows.map((r) => String(r[LOAD_GK])))];
  check(`load grain: grower ${grower.code} sees only itself`, loadKeys.length === 1 && loadKeys[0] === grower.id, `keys=${JSON.stringify(loadKeys)}`);
  check('load grain: no-claim → 0', noAccess(await scalar(LOAD_NET, {})), 'fail-closed');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('gp settlement check error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
