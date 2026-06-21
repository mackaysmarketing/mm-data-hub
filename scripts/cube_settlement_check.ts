// ─────────────────────────────────────────────────────────────────────────────
// Cube settlement check — the additive settlement metrics, live on Cube Cloud.
//   npm run cube:settlement   (needs CUBE_API_URL + CUBE_API_SECRET + DATABASE_URL)
//
// Proves, against the deployed `settlement` view:
//   • internal net_paid / rcti_count match the DB fact (parity through Cube)
//   • a grower context is scoped to its own settlements (== its DB total); group_by can't widen
//   • no-claim → 0 and forged top-level claims → 0 (the same fail-closed app_metadata contract)
// Exit 0 = all pass; 1 = any failure.
// ─────────────────────────────────────────────────────────────────────────────
import { cubeLoad, scalar, ctxInternal, ctxGrower } from './cube_lib.ts';
import type { SecurityContext } from './cube_lib.ts';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const NET = 'settlement.net_paid';
const RCTI = 'settlement.rcti_count';
const GK = 'settlement.grower_key';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
const near = (a: number | null, b: number, tol = 1) => a != null && Math.abs(a - b) < tol;
const noAccess = (v: number | null) => v === null || v === 0;

async function main(): Promise<void> {
  console.log('=== Cube settlement check (live settlement view) ===\n');
  // DB baselines (the source of truth the Cube metrics must reproduce).
  const pool = makePool();
  const client = await pool.connect();
  let dbNet: number, dbCount: number, grower: { id: string; code: string; net: number; n: number };
  try {
    const tot = (await client.query<{ net: string; c: string }>(
      `select sum(net_paid) net, count(*) c from core.fact_settlement_bill`)).rows[0]!;
    dbNet = Number(tot.net); dbCount = Number(tot.c);
    const g = (await client.query<{ consignor_id: string; grower_code: string; net: string; n: string }>(
      `select consignor_id, grower_code, sum(net_paid) net, count(*) n from core.fact_settlement_bill
        where consignor_id is not null group by 1,2 order by n desc limit 1`)).rows[0]!;
    grower = { id: g.consignor_id, code: g.grower_code, net: Number(g.net), n: Number(g.n) };
  } finally { client.release(); await pool.end(); }
  console.log(`DB: net_paid=${dbNet.toFixed(2)} rcti=${dbCount} | grower ${grower.code} net=${grower.net.toFixed(2)} (${grower.n})\n`);

  // Internal parity.
  const intNet = await scalar(NET, ctxInternal);
  const intCount = await scalar(RCTI, ctxInternal);
  check('internal net_paid == DB fact', near(intNet, dbNet), `cube=${intNet} db=${dbNet.toFixed(2)}`);
  check('internal rcti_count == DB fact', near(intCount, dbCount), `cube=${intCount} db=${dbCount}`);

  // Grower scope.
  const gNet = await scalar(NET, ctxGrower(grower.id));
  check(`grower ${grower.code} net_paid scoped`, near(gNet, grower.net), `cube=${gNet} db=${grower.net.toFixed(2)}`);
  const rows = await cubeLoad({ dimensions: [GK], measures: [RCTI] }, ctxGrower(grower.id));
  const keys = rows.map((r) => String(r[GK]));
  check(`grower ${grower.code} sees only itself`, keys.length === 1 && keys[0] === grower.id, `grower_keys=${JSON.stringify(keys)}`);

  // Fail closed.
  check('no-claim → 0', noAccess(await scalar(NET, {})), `net=${await scalar(NET, {})}`);
  check('forged top-level is_internal → 0', noAccess(await scalar(NET, { is_internal: true } as SecurityContext)), 'forged internal');
  check('forged top-level consignor_id → 0', noAccess(await scalar(NET, { consignor_id: grower.id } as SecurityContext)), 'forged consignor');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('settlement check error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
