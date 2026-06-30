// ─────────────────────────────────────────────────────────────────────────────
// Proof: dispatch.grower_name text=uuid join cast fix (Sprint 2026-06-30).
//
//   npm run cube:grower-name   (CUBE_API_URL + CUBE_API_SECRET from .env; internal context)
//
// Runs the deploy-dependent acceptance criteria through the GOVERNED REST /load + /meta API
// with an internal-signed context (app_metadata.is_internal:true) — the same mechanism as
// cube:reconcile / cube:rls. NOTHING here can prove against an un-deployed model; the model
// must be deployed to prod (deployment id 1) first. Criterion 4 (queryRewrite anchor) is
// deploy-free and verified by reading cube.js, not here.
//
//   (1) grower_name selectable — grower_name + pallet_count returns named rows, no text=uuid.
//   (2) no regression — pallet_count / load_count overall totals unchanged vs pre-fix.
//   (3) additive — dispatch /meta = 6 measures + 11 dimensions, nothing added/removed/renamed.
//   (5) no origin_shed regression — pallet_count by origin_shed_name (non-null sheds, LMB row)
//       + the uuid filter on origin_shed_id returns its single LMB-shed row.
//
// Exit 0 = all assertions held; 1 = any failure. Writes reports/cube_grower_name_proof_<date>.txt.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { cubeLoad, cubeMeta, ctxInternal } from './cube_lib.ts';

// Pre-fix baseline totals — measured on the SAME current data with the join reverted to the
// pre-fix (text=uuid) state, captured 2026-06-30. The cast aligns types only; it must NOT change
// which rows match. NOTE: these are HIGHER than the 2026-06-23 reconciliation report (42336/6037)
// purely because the Sprint-7 LMB backfill landed on 2026-06-29 — a join type-cast cannot add rows;
// the backfill did. The honest no-regression test is pre-fix vs post-fix on identical data:
//   pre-fix  (join reverted): pallet_count=43754  load_count=6189  (+ grower_name → text=uuid error)
//   post-fix (this model)   : pallet_count=43754  load_count=6189  (+ grower_name selects cleanly)
const BASELINE = { pallet_count: 43754, load_count: 6189 };

// The dispatch view's frozen catalog. The fix is ADDITIVE-NEUTRAL: it touches a JOIN predicate,
// never a member. /meta must still be exactly this set — nothing added, removed, or renamed.
const EXPECTED_MEASURES = [
  'pallet_count',
  'net_weight_dispatched',
  'line_count',
  'pallets_with_net_weight',
  'net_weight_capture_rate',
  'load_count',
].sort();
const EXPECTED_DIMENSIONS = [
  'grower_key',
  'consignee_key',
  'dispatched_on',
  'pack_week',
  'crop',
  'variety',
  'product',
  'origin_shed_id',
  'origin_shed_name',
  'grower_code',
  'grower_name',
].sort();

const out: string[] = [];
const log = (s = '') => { out.push(s); console.log(s); };
let failures = 0;
const assert = (cond: boolean, msg: string) => {
  log(`   ${cond ? '✅ PASS' : '❌ FAIL'} — ${msg}`);
  if (!cond) failures++;
};

const num = (v: unknown): number | null => (v == null ? null : Number(v));

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  log('═══════════════════════════════════════════════════════════════════════');
  log(' Proof: dispatch.grower_name text=uuid join cast fix');
  log(` Date: ${date}  ·  Context: internal/unscoped (app_metadata.is_internal:true)`);
  log(' Mechanism: governed REST /load + /meta  ·  Project: data_hub (uqzfkhsdyeokwnkpcxui)');
  log('═══════════════════════════════════════════════════════════════════════');

  // ── (1) grower_name selectable ───────────────────────────────────────────────
  log('\n(1) grower_name + pallet_count returns named rows (no text = uuid error)');
  const q1 = {
    measures: ['dispatch.pallet_count'],
    dimensions: ['dispatch.grower_name'],
    order: { 'dispatch.pallet_count': 'desc' },
    limit: 10,
  };
  log(`   query: ${JSON.stringify(q1)}`);
  const r1 = await cubeLoad(q1, ctxInternal);
  log('   rows (top 10 by pallet_count):');
  for (const r of r1) log(`     ${String(r['dispatch.grower_name'] ?? '∅(null)').padEnd(40)} ${r['dispatch.pallet_count']}`);
  assert(r1.length > 0, `query returned ${r1.length} rows (no SQL error)`);
  assert(r1.some((r) => r['dispatch.grower_name'] != null), 'at least one named (non-null) grower row');

  // ── (2) no row-count regression ──────────────────────────────────────────────
  log('\n(2) pallet_count / load_count overall totals unchanged vs pre-fix');
  const r2 = (await cubeLoad({ measures: ['dispatch.pallet_count', 'dispatch.load_count'] }, ctxInternal))[0] || {};
  const palletNow = num(r2['dispatch.pallet_count']);
  const loadNow = num(r2['dispatch.load_count']);
  log(`   pre-fix : pallet_count=${BASELINE.pallet_count}  load_count=${BASELINE.load_count}`);
  log(`   post-fix: pallet_count=${palletNow}  load_count=${loadNow}`);
  assert(palletNow === BASELINE.pallet_count, `pallet_count unchanged (${palletNow} == ${BASELINE.pallet_count})`);
  assert(loadNow === BASELINE.load_count, `load_count unchanged (${loadNow} == ${BASELINE.load_count})`);

  // grower_name must not fan out the load/pallet totals (LEFT JOIN, many_to_one — no inflation).
  const fullByName = await cubeLoad(
    { measures: ['dispatch.pallet_count'], dimensions: ['dispatch.grower_name'] },
    ctxInternal,
  );
  const palletSum = fullByName.reduce((a, r) => a + (num(r['dispatch.pallet_count']) ?? 0), 0);
  log(`   Σ pallet_count grouped by grower_name = ${palletSum} (must equal overall ${palletNow})`);
  assert(palletSum === palletNow, 'grouping by grower_name does not fan out the pallet total');

  // ── (3) additive — /meta unchanged ───────────────────────────────────────────
  log('\n(3) dispatch view /meta member list — 6 measures + 11 dimensions, unchanged');
  const meta = await cubeMeta(ctxInternal);
  const view = (meta.cubes || []).find((c: any) => c.name === 'dispatch');
  assert(!!view, 'dispatch view present in /meta');
  const measures = (view?.measures || []).map((m: any) => String(m.name).replace(/^dispatch\./, '')).sort();
  const dimensions = (view?.dimensions || []).map((d: any) => String(d.name).replace(/^dispatch\./, '')).sort();
  log(`   measures (${measures.length}): ${measures.join(', ')}`);
  log(`   dimensions (${dimensions.length}): ${dimensions.join(', ')}`);
  assert(measures.length === 6, `6 measures (got ${measures.length})`);
  assert(dimensions.length === 11, `11 dimensions (got ${dimensions.length})`);
  assert(
    JSON.stringify(measures) === JSON.stringify(EXPECTED_MEASURES),
    'measure names identical to expected set (nothing added/removed/renamed)',
  );
  assert(
    JSON.stringify(dimensions) === JSON.stringify(EXPECTED_DIMENSIONS),
    'dimension names identical to expected set (incl. origin_shed_id/name)',
  );

  // ── (5) no origin_shed regression ────────────────────────────────────────────
  log('\n(5) origin_shed proofs still return');
  log('   (5a) pallet_count by origin_shed_name:');
  const shedRows = await cubeLoad(
    { measures: ['dispatch.pallet_count'], dimensions: ['dispatch.origin_shed_name'], order: { 'dispatch.pallet_count': 'desc' } },
    ctxInternal,
  );
  for (const r of shedRows) {
    log(`     ${String(r['dispatch.origin_shed_name'] ?? '∅(null)').padEnd(40)} ${r['dispatch.pallet_count']}`);
  }
  const nonNullSheds = shedRows.filter((r) => r['dispatch.origin_shed_name'] != null);
  log(`   non-null sheds: ${nonNullSheds.length}`);
  assert(nonNullSheds.length >= 1, `${nonNullSheds.length} non-null origin sheds returned`);
  const lmbRow = nonNullSheds.find((r) => /LMB/i.test(String(r['dispatch.origin_shed_name'])));
  assert(!!lmbRow, `an LMB origin shed is present (${lmbRow ? String(lmbRow['dispatch.origin_shed_name']) : 'none'} = ${lmbRow?.['dispatch.pallet_count']})`);

  // (5b) uuid filter on origin_shed_id returns its single LMB-shed row.
  log('   (5b) uuid filter on origin_shed_id returns its single LMB row:');
  const shedById = await cubeLoad(
    { measures: ['dispatch.pallet_count'], dimensions: ['dispatch.origin_shed_id', 'dispatch.origin_shed_name'], order: { 'dispatch.pallet_count': 'desc' } },
    ctxInternal,
  );
  const lmbShed = shedById.find((r) => /LMB/i.test(String(r['dispatch.origin_shed_name'] ?? '')));
  if (lmbShed) {
    const shedId = String(lmbShed['dispatch.origin_shed_id']);
    const q5b = {
      measures: ['dispatch.pallet_count'],
      dimensions: ['dispatch.origin_shed_id', 'dispatch.origin_shed_name'],
      filters: [{ member: 'dispatch.origin_shed_id', operator: 'equals', values: [shedId] }],
    };
    log(`   query: ${JSON.stringify(q5b)}`);
    const r5b = await cubeLoad(q5b, ctxInternal);
    for (const r of r5b) log(`     ${r['dispatch.origin_shed_id']}  ${String(r['dispatch.origin_shed_name']).padEnd(30)} ${r['dispatch.pallet_count']}`);
    assert(r5b.length === 1, `uuid filter returns exactly 1 row (got ${r5b.length})`);
    assert(/LMB/i.test(String(r5b[0]?.['dispatch.origin_shed_name'] ?? '')), 'the single row is the LMB shed');
  } else {
    assert(false, 'no LMB origin shed found to filter on');
  }

  // ── verdict ──────────────────────────────────────────────────────────────────
  log('\n═══════════════════════════════════════════════════════════════════════');
  log(failures === 0 ? ' RESULT: ✅ ALL ASSERTIONS HELD' : ` RESULT: ❌ ${failures} ASSERTION(S) FAILED`);
  log('═══════════════════════════════════════════════════════════════════════');

  const path = `reports/cube_grower_name_proof_${date}.txt`;
  writeFileSync(path, out.join('\n') + '\n');
  console.log(`\nReport: ${path}`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error('Proof error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
