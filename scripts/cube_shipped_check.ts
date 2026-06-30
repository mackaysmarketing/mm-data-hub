// ─────────────────────────────────────────────────────────────────────────────
// Cube shipped-dispatch check — the ADDITIVE dispatch_shipped surface, live on Cube Cloud.
//   npm run cube:shipped   (needs CUBE_API_URL + CUBE_API_SECRET + DATABASE_URL in .env)
//
// Proves Sprint-8 Phase-B acceptance criteria 8 + 10 against the deployed `dispatch_shipped`
// view (built over semantic.grower_dispatch_shipped, migration 0021). NOTHING here can prove an
// un-deployed model — the Cube model must be deployed to prod (deployment id 1) first. The
// VIEW_GROWER_KEYS anchor itself is deploy-free and additionally asserted by reading cube.js.
//
//   (8) RLS (SECURITY-CRITICAL):
//       • cube.js VIEW_GROWER_KEYS contains dispatch_shipped.grower_key  (deploy-free, read source)
//       • a single-grower /load returns ONLY that grower's rows AND strictly fewer loads than internal
//       • NIL / no-claim context → 0 ; forged top-level is_internal / consignor_id → 0
//       • internal context returns ALL growers ; a filter cannot widen one grower into another's rows
//       • grouping by grower_name does NOT fan out the totals (many_to_one dim_grower join)
//       • the new semantic view has the SAME RLS policy (security_invoker=true) as grower_dispatch_detail
//   (10) Additive + parity:
//       • /meta shows dispatch_shipped with shipped_load_count / boxes_packed / dispatch_state /
//         effective_dispatched_on (+ the rest of its member set)
//       • the existing `dispatch` view /meta is BYTE-IDENTICAL — exactly 6 measures + 11 dimensions
//       • shipped_load_count via /load EQUALS semantic.grower_dispatch_shipped's own
//         count(distinct load_id), computed in the SAME run (equality-to-source, not a literal)
//
// Exit 0 = all assertions held; 1 = any failure. Writes reports/cube_shipped_check_<date>.txt.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cubeLoad, cubeMeta, scalar, ctxInternal, ctxGrower } from './cube_lib.ts';
import type { SecurityContext } from './cube_lib.ts';
import { makePool } from '../src/lib/db.ts';

const SHIPPED_LOADS = 'dispatch_shipped.shipped_load_count';
const BOXES = 'dispatch_shipped.boxes_packed';
const PALLETS = 'dispatch_shipped.pallet_count_shipped';
const NET = 'dispatch_shipped.net_weight_shipped';
const GK = 'dispatch_shipped.grower_key';
const GNAME = 'dispatch_shipped.grower_name';

// Frozen catalog of the EXISTING dispatch view — must remain byte-identical (additive contract).
const DISPATCH_MEASURES = [
  'pallet_count', 'net_weight_dispatched', 'line_count',
  'pallets_with_net_weight', 'net_weight_capture_rate', 'load_count',
].sort();
const DISPATCH_DIMENSIONS = [
  'grower_key', 'consignee_key', 'dispatched_on', 'pack_week', 'crop', 'variety',
  'product', 'origin_shed_id', 'origin_shed_name', 'grower_code', 'grower_name',
].sort();

// Expected member set of the NEW dispatch_shipped view.
const SHIPPED_MEASURES = [
  'shipped_load_count', 'boxes_packed', 'pallet_count_shipped', 'net_weight_shipped',
].sort();
const SHIPPED_DIMENSIONS = [
  'grower_key', 'dispatch_state', 'effective_dispatched_on',
  'origin_shed_id', 'origin_shed_name', 'grower_code', 'grower_name',
].sort();

const out: string[] = [];
const log = (s = '') => { out.push(s); console.log(s); };
let failures = 0;
const assert = (cond: boolean, msg: string) => {
  log(`   ${cond ? '✅ PASS' : '❌ FAIL'} — ${msg}`);
  if (!cond) failures++;
};
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const noAccess = (v: number | null): boolean => v === null || v === 0;
const eq = (member: string, value: string) => ({ member, operator: 'equals', values: [value] });

interface Grower { id: string; code: string; name: string; loads: number; }

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  log('═══════════════════════════════════════════════════════════════════════');
  log(' Cube shipped-dispatch check — additive dispatch_shipped surface (Sprint 8 Phase B)');
  log(` Date: ${date}  ·  Project: data_hub (uqzfkhsdyeokwnkpcxui)  ·  Mechanism: governed REST /load + /meta`);
  log('═══════════════════════════════════════════════════════════════════════');

  // ── DB source-of-truth baselines (the values the Cube surface must reproduce) ──
  const pool = makePool();
  const client = await pool.connect();
  let srcLoads: number, srcBoxes: number, srcGrowers: number;
  let growers: Grower[];
  let reloptions: { view: string; security_invoker: boolean }[];
  try {
    const t = (await client.query<{ loads: string; boxes: string; growers: string }>(
      `select count(distinct load_id) loads, sum(boxes) boxes, count(distinct grower_key) growers
         from semantic.grower_dispatch_shipped`)).rows[0]!;
    srcLoads = Number(t.loads); srcBoxes = Number(t.boxes); srcGrowers = Number(t.growers);

    // Two disjoint growers that DO have shipped rows — data-driven, so "strictly fewer than internal"
    // and "only its own rows" are tested against real, non-empty scopes (not a hard-coded guess).
    growers = (await client.query<{ id: string; code: string; name: string; loads: string }>(
      `select s.grower_key::text id, g.code, g.org_name name, count(distinct s.load_id) loads
         from semantic.grower_dispatch_shipped s
         join core.dim_grower g on g.consignor_id = s.grower_key
        group by 1,2,3 order by loads desc limit 2`)).rows
      .map((r) => ({ id: r.id, code: r.code, name: r.name, loads: Number(r.loads) }));

    reloptions = (await client.query<{ view: string; reloptions: string[] | null }>(
      `select c.relname view, c.reloptions from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='semantic'
          and c.relname in ('grower_dispatch_shipped','grower_dispatch_detail')`)).rows
      .map((r) => ({ view: r.view, security_invoker: (r.reloptions || []).includes('security_invoker=true') }));
  } finally { client.release(); await pool.end(); }

  const [A, B] = growers;
  log(`\nDB source: distinct loads=${srcLoads}  boxes=${srcBoxes}  growers=${srcGrowers}`);
  log(`DB growers: A=${A?.code}(${A?.loads} loads)  B=${B?.code}(${B?.loads} loads)`);
  if (!A || !B) { log('\n❌ Could not find two growers with shipped rows — aborting.'); process.exit(1); }

  // ── (8a) Deploy-free: cube.js registers the RLS anchor ─────────────────────────
  log('\n(8a) cube.js VIEW_GROWER_KEYS registers the new view (deploy-free source check)');
  const cubeJsPath = fileURLToPath(new URL('../cube/cube.js', import.meta.url));
  const cubeJs = readFileSync(cubeJsPath, 'utf8');
  const anchored = /dispatch_shipped:\s*['"]dispatch_shipped\.grower_key['"]/.test(cubeJs);
  log(`   cube.js: ${anchored ? "dispatch_shipped: 'dispatch_shipped.grower_key' present" : 'ANCHOR MISSING'}`);
  assert(anchored, "VIEW_GROWER_KEYS contains dispatch_shipped: 'dispatch_shipped.grower_key'");

  // ── (8b) semantic view RLS policy parity (security_invoker=true, same as detail) ──
  log('\n(8b) semantic.grower_dispatch_shipped RLS policy == grower_dispatch_detail (security_invoker)');
  for (const r of reloptions) log(`   ${r.view.padEnd(26)} security_invoker=${r.security_invoker}`);
  const shipped = reloptions.find((r) => r.view === 'grower_dispatch_shipped');
  const detail = reloptions.find((r) => r.view === 'grower_dispatch_detail');
  assert(!!shipped?.security_invoker, 'grower_dispatch_shipped is security_invoker=true');
  assert(!!detail?.security_invoker, 'grower_dispatch_detail is security_invoker=true');
  assert(shipped?.security_invoker === detail?.security_invoker, 'both views share the SAME RLS posture');

  // ── (10a) /meta: dispatch_shipped present with the new members ──────────────────
  log('\n(10a) /meta — dispatch_shipped view exposes the new measures + dimensions');
  const meta = await cubeMeta(ctxInternal);
  const sView = (meta.cubes || []).find((c: any) => c.name === 'dispatch_shipped');
  assert(!!sView, 'dispatch_shipped view present in /meta');
  const sMeasures = (sView?.measures || []).map((m: any) => String(m.name).replace(/^dispatch_shipped\./, '')).sort();
  const sDims = (sView?.dimensions || []).map((d: any) => String(d.name).replace(/^dispatch_shipped\./, '')).sort();
  log(`   measures (${sMeasures.length}): ${sMeasures.join(', ')}`);
  log(`   dimensions (${sDims.length}): ${sDims.join(', ')}`);
  for (const m of ['shipped_load_count', 'boxes_packed']) assert(sMeasures.includes(m), `measure ${m} present`);
  for (const d of ['dispatch_state', 'effective_dispatched_on', 'grower_key']) assert(sDims.includes(d), `dimension ${d} present`);
  assert(JSON.stringify(sMeasures) === JSON.stringify(SHIPPED_MEASURES), 'dispatch_shipped measures == expected set');
  assert(JSON.stringify(sDims) === JSON.stringify(SHIPPED_DIMENSIONS), 'dispatch_shipped dimensions == expected set');

  // ── (10b) /meta: existing dispatch view BYTE-IDENTICAL (6 measures + 11 dims) ────
  log('\n(10b) /meta — existing `dispatch` view unchanged (6 measures + 11 dimensions)');
  const dView = (meta.cubes || []).find((c: any) => c.name === 'dispatch');
  assert(!!dView, 'dispatch view present in /meta');
  const dMeasures = (dView?.measures || []).map((m: any) => String(m.name).replace(/^dispatch\./, '')).sort();
  const dDims = (dView?.dimensions || []).map((d: any) => String(d.name).replace(/^dispatch\./, '')).sort();
  log(`   measures (${dMeasures.length}): ${dMeasures.join(', ')}`);
  log(`   dimensions (${dDims.length}): ${dDims.join(', ')}`);
  assert(dMeasures.length === 6 && JSON.stringify(dMeasures) === JSON.stringify(DISPATCH_MEASURES), 'dispatch: 6 measures, unchanged');
  assert(dDims.length === 11 && JSON.stringify(dDims) === JSON.stringify(DISPATCH_DIMENSIONS), 'dispatch: 11 dimensions, unchanged');

  // ── (10c) shipped_load_count == DB count(distinct load_id), same session ────────
  log('\n(10c) shipped_load_count (/load, internal) EQUALS the semantic view count(distinct load_id)');
  const cubeLoads = await scalar(SHIPPED_LOADS, ctxInternal);
  const cubeBoxes = await scalar(BOXES, ctxInternal);
  log(`   Cube internal: shipped_load_count=${cubeLoads}  boxes_packed=${cubeBoxes}`);
  log(`   DB source    : count(distinct load_id)=${srcLoads}  sum(boxes)=${srcBoxes}`);
  assert(cubeLoads === srcLoads, `shipped_load_count(${cubeLoads}) == source count(distinct load)(${srcLoads})`);
  assert(cubeBoxes === srcBoxes, `boxes_packed(${cubeBoxes}) == source sum(boxes)(${srcBoxes})`);

  // ── (8c) internal sees ALL growers ─────────────────────────────────────────────
  log('\n(8c) internal context returns ALL growers');
  const internalRows = await cubeLoad({ dimensions: [GK], measures: [SHIPPED_LOADS] }, ctxInternal);
  const internalKeys = internalRows.map((r) => String(r[GK]));
  log(`   internal distinct growers via /load: ${internalKeys.length} (DB: ${srcGrowers})`);
  assert(internalKeys.length === srcGrowers && srcGrowers > 1, `internal sees all ${srcGrowers} growers`);

  // ── (8d) single-grower scope: ONLY its own rows AND strictly fewer than internal ──
  log('\n(8d) single-grower contexts are scoped to their own rows (strictly < internal)');
  for (const g of [A, B]) {
    const rows = await cubeLoad({ dimensions: [GK], measures: [SHIPPED_LOADS] }, ctxGrower(g.id));
    const keys = rows.map((r) => String(r[GK]));
    const loads = num(rows[0]?.[SHIPPED_LOADS]);
    log(`   ${g.code}: ${keys.length} grower_key(s), shipped_load_count=${loads} (DB ${g.loads})`);
    assert(keys.length === 1 && keys[0] === g.id, `${g.code} sees ONLY its own grower_key`);
    assert(loads === g.loads, `${g.code} shipped_load_count(${loads}) == its DB load count(${g.loads})`);
    assert((loads ?? 0) > 0 && (loads ?? 0) < srcLoads, `${g.code} strictly fewer loads than internal (${loads} < ${srcLoads})`);
  }

  // ── (8e) disjoint + a filter cannot widen one grower into another's rows ─────────
  log('\n(8e) growers are disjoint; a filter cannot widen scope');
  assert(A.id !== B.id, 'A and B are distinct growers');
  const aTriesB = await scalar(SHIPPED_LOADS, ctxGrower(A.id), { filters: [eq(GK, B.id)] });
  log(`   ${A.code} filtered to ${B.code}'s grower_key → ${aTriesB}`);
  assert(noAccess(aTriesB), `filter cannot widen scope (${A.code}→${B.code} = ${aTriesB})`);

  // ── (8f) fail-closed: NIL / no-claim and forged top-level claims → 0 ─────────────
  log('\n(8f) fail-closed — no-claim and forged top-level claims see nothing');
  const noClaim = await scalar(SHIPPED_LOADS, {});
  const forgedInternal = await scalar(SHIPPED_LOADS, { is_internal: true } as SecurityContext);
  const forgedConsignor = await scalar(SHIPPED_LOADS, { consignor_id: A.id } as SecurityContext);
  log(`   no-claim=${noClaim}  forged top-level is_internal=${forgedInternal}  forged top-level consignor_id=${forgedConsignor}`);
  assert(noAccess(noClaim), 'no-claim (NIL) context → 0 rows');
  assert(noAccess(forgedInternal), 'forged top-level is_internal → 0 rows (app_metadata-only)');
  assert(noAccess(forgedConsignor), 'forged top-level consignor_id → 0 rows (app_metadata-only)');

  // ── (8g) no fan-out: grouping by grower_name preserves the total ────────────────
  log('\n(8g) grouping by grower_name does not fan out the pallet total (many_to_one join)');
  const intPallets = await scalar(PALLETS, ctxInternal);
  const byName = await cubeLoad({ measures: [PALLETS], dimensions: [GNAME] }, ctxInternal);
  const palletSum = byName.reduce((a, r) => a + (num(r[PALLETS]) ?? 0), 0);
  log(`   Σ pallet_count_shipped grouped by grower_name = ${palletSum} (overall = ${intPallets})`);
  assert(palletSum === intPallets && (intPallets ?? 0) > 0, 'grower_name grouping does not inflate the pallet total');

  // ── (8h) sanity: A + B ≤ internal total ─────────────────────────────────────────
  log('\n(8h) parts do not exceed the whole');
  assert(A.loads + B.loads <= srcLoads, `${A.loads} + ${B.loads} ≤ ${srcLoads}`);

  // ── verdict ──────────────────────────────────────────────────────────────────
  log('\n═══════════════════════════════════════════════════════════════════════');
  log(failures === 0 ? ' RESULT: ✅ ALL ASSERTIONS HELD (criteria 8 + 10)' : ` RESULT: ❌ ${failures} ASSERTION(S) FAILED`);
  log('═══════════════════════════════════════════════════════════════════════');

  const path = `reports/cube_shipped_check_${date}.txt`;
  writeFileSync(path, out.join('\n') + '\n');
  console.log(`\nReport: ${path}`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error('shipped check error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
