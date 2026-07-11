// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — identity-propagation + parity PROOF (runnable).  npm run mcp:proof
//
// Drives the REAL tool handlers (same code the stdio server runs) under the full caller-context
// matrix, proving the central requirement: every tool runs scoped to the caller, no argument can
// widen scope, and absent/forged identity fails closed — across ALL THREE surfaces:
//   • metric path  → query_metric (Cube REST, per-caller JWT, queryRewrite RLS)
//   • detail path  → list_grower_dispatches + run_select (Postgres, SET ROLE authenticated + claims)
//   • sales path   → list_grower_sales over semantic.grower_gp_settlement (same detail funnel)
// plus the MULTI-FARM consignor SET contract (migration 0026): a consignor_ids[] token sees the
// UNION of its farms on every path; a single-id token stays single-farm (byte-identical claims).
//
// SELF-DERIVING: expectations are computed IN THIS RUN from source SQL over raw/core via
// DATABASE_URL (makePool), applying the exact baked-in filter sets the metric definitions document
// (cube/CONTRACTS.md; migration 0008's view WHERE; core.fact_gp_settlement). No hardcoded counts —
// the proof can never rot into stale-baseline failures. Grower fixtures are resolved by CODE from
// core.dim_grower (active rows), not hardcoded uuids.
//
// Env: DATABASE_URL (derivation) + CUBE_API_URL + CUBE_API_SECRET (metric path) + MCP_DB_URL
// (detail/sales path). Exit 0 = all assertions pass. Writes reports/mcp_proof_<date>.txt.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { makeDeps } from '../mcp/deps.ts';
import { TOOLS_BY_NAME } from '../mcp/tools.ts';
import { identityFromSecurityContext, appMetadata, type CallerIdentity } from '../mcp/identity.ts';
import { isReadResult, type ReadResult } from '../mcp/output.ts';
import { ValidationError } from '../mcp/errors.ts';
import { makePool } from '../src/lib/db.ts';

// Grower fixtures BY CODE (uuids resolved live from core.dim_grower — never hardcoded).
// MMLAR/MMTRU: the original dispatch-path pair. LRCLA/LRCTU: L & R Collins — the REAL multi-farm
// grower migration 0026 was built for (one grower, two farms), which also holds GP settlement rows.
const CODE_A = 'MMLAR';
const CODE_B = 'MMTRU';
const CODE_M1 = 'LRCLA';
const CODE_M2 = 'LRCTU';
const FIXTURE_CODES = [CODE_A, CODE_B, CODE_M1, CODE_M2];

// ── Self-derived expectations (source SQL, same run) ─────────────────────────
interface Expected {
  /** code → active consignor_id */
  ids: Record<string, string>;
  /** Cube metric-path pallet_count — baked-in per CONTRACTS.md: Sell + dispatched + non-test. */
  cube: { internal: number; byGrower: Record<string, number> };
  /** Detail-path rows — 0008 view WHERE: dispatched + non-test (NOT order_type='S'). */
  detail: { internal: number; byGrower: Record<string, number> };
  /** Sales-path schedules — core.fact_gp_settlement (all schedules; RLS is the only filter). */
  gp: { internal: number; byGrower: Record<string, number> };
}

async function deriveExpectations(): Promise<Expected> {
  const pool = makePool();
  try {
    const g = await pool.query<{ code: string; cid: string }>(
      `select code, consignor_id::text as cid
         from core.dim_grower
        where code = any($1) and coalesce(is_active, false)`,
      [FIXTURE_CODES],
    );
    const ids: Record<string, string> = {};
    for (const r of g.rows) {
      if (ids[r.code]) throw new Error(`fixture code ${r.code} maps to MULTIPLE active dim_grower rows`);
      ids[r.code] = r.cid;
    }
    for (const c of FIXTURE_CODES) {
      if (!ids[c]) throw new Error(`fixture grower code ${c} not found active in core.dim_grower`);
    }
    const uuids = FIXTURE_CODES.map((c) => ids[c] as string);
    const filters = uuids.map((_, i) => `count(*) filter (where d.consignor_id = $${i + 1})::int as g${i}`);

    // Metric path — the EXACT baked-in filter set every dispatch metric inherits (CONTRACTS.md):
    // order_type='S' AND actual_pickup_on IS NOT NULL AND non-test consignor.
    const cubeQ = await pool.query(
      `select count(*)::int as n, ${filters.join(', ')}
         from raw.ft_pallet p
         join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
         join core.dim_grower g on g.consignor_id = d.consignor_id
        where d.order_type = 'S' and d.actual_pickup_on is not null
          and coalesce(g.is_test, false) = false`,
      uuids,
    );

    // Detail path — migration 0008's view WHERE: dispatched + non-test, NO order_type filter
    // (this is exactly why the two surfaces legitimately differ).
    const detailQ = await pool.query(
      `select count(*)::int as n, ${filters.join(', ')}
         from raw.ft_pallet p
         join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
         join core.dim_grower g on g.consignor_id = d.consignor_id
        where d.actual_pickup_on is not null
          and coalesce(g.is_test, false) = false`,
      uuids,
    );

    // Sales path — schedule grain, straight over the fact (the view adds no WHERE; RLS only).
    const gpFilters = uuids.map((_, i) => `count(*) filter (where consignor_id = $${i + 1})::int as g${i}`);
    const gpQ = await pool.query(
      `select count(*)::int as n, ${gpFilters.join(', ')} from core.fact_gp_settlement`,
      uuids,
    );

    const byGrower = (row: Record<string, unknown>): Record<string, number> =>
      Object.fromEntries(FIXTURE_CODES.map((c, i) => [ids[c] as string, Number(row[`g${i}`])]));

    return {
      ids,
      cube: { internal: Number(cubeQ.rows[0]!.n), byGrower: byGrower(cubeQ.rows[0]!) },
      detail: { internal: Number(detailQ.rows[0]!.n), byGrower: byGrower(detailQ.rows[0]!) },
      gp: { internal: Number(gpQ.rows[0]!.n), byGrower: byGrower(gpQ.rows[0]!) },
    };
  } finally {
    await pool.end();
  }
}

const { deps, close } = makeDeps();
const log: string[] = [];
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`;
  console.log(line);
  log.push(line);
}
function say(line: string): void {
  console.log(line);
  log.push(line);
}

const call = (tool: string, args: Record<string, unknown>, id: CallerIdentity): Promise<ReadResult> => {
  const t = TOOLS_BY_NAME.get(tool);
  if (!t) throw new Error(`no such tool ${tool}`);
  return t.handler(args, id, deps);
};

// query_metric → a single scalar measure value (null/absent → 0).
async function metric(name: string, id: CallerIdentity, args: Record<string, unknown> = {}): Promise<number> {
  const r = await call('query_metric', { metric: name, ...args }, id);
  const v = r.rows[0]?.[name];
  return v == null ? 0 : Number(v);
}
// run_select count(*) over a semantic view → exact RLS-scoped row count.
async function scopedCount(id: CallerIdentity, view: string): Promise<number> {
  const r = await call('run_select', { sql: `select count(*)::int as n from semantic.${view}` }, id);
  const v = r.rows[0]?.n;
  return v == null ? 0 : Number(v);
}
const detailCount = (id: CallerIdentity): Promise<number> => scopedCount(id, 'grower_dispatch_detail');
const salesCount = (id: CallerIdentity): Promise<number> => scopedCount(id, 'grower_gp_settlement');

async function main(): Promise<void> {
  say('=== Hub MCP identity-propagation + parity proof (self-deriving) ===\n');

  const exp = await deriveExpectations();
  const A = exp.ids[CODE_A]!;
  const B = exp.ids[CODE_B]!;
  const M1 = exp.ids[CODE_M1]!;
  const M2 = exp.ids[CODE_M2]!;
  say(`fixtures (resolved live from core.dim_grower):`);
  for (const c of FIXTURE_CODES) say(`  ${c} = ${exp.ids[c]}`);
  say(`derived expectations (source SQL, this run):`);
  say(`  cube pallet_count: internal=${exp.cube.internal} ${CODE_A}=${exp.cube.byGrower[A]} ${CODE_B}=${exp.cube.byGrower[B]} ${CODE_M1}=${exp.cube.byGrower[M1]} ${CODE_M2}=${exp.cube.byGrower[M2]}`);
  say(`  detail rows:       internal=${exp.detail.internal} ${CODE_A}=${exp.detail.byGrower[A]} ${CODE_B}=${exp.detail.byGrower[B]} ${CODE_M1}=${exp.detail.byGrower[M1]} ${CODE_M2}=${exp.detail.byGrower[M2]}`);
  say(`  gp schedules:      internal=${exp.gp.internal} ${CODE_A}=${exp.gp.byGrower[A]} ${CODE_B}=${exp.gp.byGrower[B]} ${CODE_M1}=${exp.gp.byGrower[M1]} ${CODE_M2}=${exp.gp.byGrower[M2]}\n`);

  // Identities are built ONLY from app_metadata — forged ones carry TOP-LEVEL claims and must
  // therefore collapse to no-scope (fail closed).
  const ID = {
    internal: identityFromSecurityContext({ app_metadata: { is_internal: true } }, 'proof'),
    growerA: identityFromSecurityContext({ app_metadata: { consignor_id: A } }, 'proof'),
    growerB: identityFromSecurityContext({ app_metadata: { consignor_id: B } }, 'proof'),
    salesA: identityFromSecurityContext({ app_metadata: { consignor_id: M1 } }, 'proof'),
    salesB: identityFromSecurityContext({ app_metadata: { consignor_id: M2 } }, 'proof'),
    multi: identityFromSecurityContext({ app_metadata: { consignor_ids: [M1, M2] } }, 'proof'),
    multiSingle: identityFromSecurityContext({ app_metadata: { consignor_ids: [M1] } }, 'proof'),
    none: identityFromSecurityContext({}, 'proof'),
    forged: identityFromSecurityContext({ is_internal: true, consignor_id: A }, 'proof'),
    forgedMulti: identityFromSecurityContext({ consignor_ids: [M1, M2] }, 'proof'),
  };

  // ── Identity unit invariants (byte-identical single-farm claims; forged set rejected) ─────
  check(
    'identity: legacy scalar token → byte-identical app_metadata {consignor_id}',
    JSON.stringify(appMetadata(ID.growerA)) === JSON.stringify({ consignor_id: A }),
    JSON.stringify(appMetadata(ID.growerA)),
  );
  check(
    'identity: multi-farm token → app_metadata {consignor_ids:[M1,M2]}',
    JSON.stringify(appMetadata(ID.multi)) === JSON.stringify({ consignor_ids: [M1, M2] }),
    JSON.stringify(appMetadata(ID.multi)),
  );
  check(
    'identity: single-element consignor_ids ≡ legacy scalar (same claims)',
    JSON.stringify(appMetadata(ID.multiSingle)) === JSON.stringify(appMetadata(ID.salesA)),
    JSON.stringify(appMetadata(ID.multiSingle)),
  );
  check(
    'identity: forged TOP-LEVEL consignor_ids[] → no scope',
    ID.forgedMulti.consignorIds.length === 0 && !ID.forgedMulti.isInternal,
    `consignorIds=${JSON.stringify(ID.forgedMulti.consignorIds)}`,
  );

  // ── METRIC PATH (Cube) ───────────────────────────────────────────────────
  const mInternal = await metric('pallet_count', ID.internal);
  const mA = await metric('pallet_count', ID.growerA);
  const mB = await metric('pallet_count', ID.growerB);
  const mNone = await metric('pallet_count', ID.none);
  const mForged = await metric('pallet_count', ID.forged);
  say(`\nquery_metric pallet_count — internal=${mInternal} A=${mA} B=${mB} none=${mNone} forged=${mForged}\n`);

  check(`metric: internal parity (=derived ${exp.cube.internal})`, mInternal === exp.cube.internal, `pallet_count=${mInternal}`);
  check(`metric: grower A scoped total (=derived ${exp.cube.byGrower[A]})`, mA === exp.cube.byGrower[A], `A=${mA}`);
  check(`metric: grower B scoped total (=derived ${exp.cube.byGrower[B]})`, mB === exp.cube.byGrower[B], `B=${mB}`);
  check('metric: no-claim fails closed (=0)', mNone === 0, `none=${mNone}`);
  check('metric: forged top-level claim fails closed (=0)', mForged === 0, `forged=${mForged}`);
  check('metric: A + B ≤ internal', mA + mB <= mInternal, `${mA}+${mB} ≤ ${mInternal}`);

  // Parity cross-check: internal filtered to A must equal A's own scoped total.
  const internalFilteredToA = await metric('pallet_count', ID.internal, {
    filters: [{ dimension: 'grower_key', operator: 'equals', values: [A] }],
  });
  check('metric: A == internal-filtered-to-A', mA === internalFilteredToA, `A=${mA} vs internal|A=${internalFilteredToA}`);

  // No widening: grower A filtering toward B returns nothing.
  const aTriesB = await metric('pallet_count', ID.growerA, {
    filters: [{ dimension: 'grower_key', operator: 'equals', values: [B] }],
  });
  check('metric: A cannot filter into B (=0)', aTriesB === 0, `A→B=${aTriesB}`);

  // No widening via group_by: grower A grouped by grower_key sees only itself.
  const aGrouped = await call('query_metric', { metric: 'pallet_count', group_by: ['grower_key'] }, ID.growerA);
  const aKeys = aGrouped.rows.map((r) => String(r.grower_key));
  check('metric: A group_by grower_key = {A} only', aKeys.length === 1 && aKeys[0] === A, `keys=${JSON.stringify(aKeys)}`);

  // ── METRIC PATH — multi-farm consignor SET (0026) ─────────────────────────
  const expMultiCube = exp.cube.byGrower[M1]! + exp.cube.byGrower[M2]!;
  check('multi precondition: both farms have dispatch rows', exp.cube.byGrower[M1]! > 0 && exp.cube.byGrower[M2]! > 0,
    `${CODE_M1}=${exp.cube.byGrower[M1]} ${CODE_M2}=${exp.cube.byGrower[M2]}`);
  const mMulti = await metric('pallet_count', ID.multi);
  check(`metric: [M1,M2] token = UNION of both farms (=derived ${expMultiCube})`, mMulti === expMultiCube, `multi=${mMulti}`);
  const mMultiSingle = await metric('pallet_count', ID.multiSingle);
  check(`metric: [M1] token still single-farm (=derived ${exp.cube.byGrower[M1]})`, mMultiSingle === exp.cube.byGrower[M1], `single=${mMultiSingle}`);
  const mLegacyM1 = await metric('pallet_count', ID.salesA);
  check('metric: legacy scalar M1 token == [M1] token (unchanged behavior)', mLegacyM1 === mMultiSingle, `legacy=${mLegacyM1} array=${mMultiSingle}`);
  const multiGrouped = await call('query_metric', { metric: 'pallet_count', group_by: ['grower_key'] }, ID.multi);
  const multiKeys = new Set(multiGrouped.rows.map((r) => String(r.grower_key)));
  check('metric: [M1,M2] group_by grower_key = BOTH farms, nothing else',
    multiKeys.size === 2 && multiKeys.has(M1) && multiKeys.has(M2), `keys=${JSON.stringify([...multiKeys])}`);
  const mForgedMulti = await metric('pallet_count', ID.forgedMulti);
  check('metric: forged top-level consignor_ids fails closed (=0)', mForgedMulti === 0, `forgedMulti=${mForgedMulti}`);

  // ── DETAIL PATH (Postgres RLS via run_select count) ──────────────────────
  const dInternal = await detailCount(ID.internal);
  const dA = await detailCount(ID.growerA);
  const dB = await detailCount(ID.growerB);
  const dNone = await detailCount(ID.none);
  const dForged = await detailCount(ID.forged);
  say(`\ndetail count(*) — internal=${dInternal} A=${dA} B=${dB} none=${dNone} forged=${dForged}\n`);

  check(`detail: internal sees all (=derived ${exp.detail.internal})`, dInternal === exp.detail.internal, `internal=${dInternal}`);
  check(`detail: grower A scoped (=derived ${exp.detail.byGrower[A]})`, dA === exp.detail.byGrower[A], `A=${dA}`);
  check(`detail: grower B scoped (=derived ${exp.detail.byGrower[B]})`, dB === exp.detail.byGrower[B], `B=${dB}`);
  check('detail: no-claim fails closed (=0)', dNone === 0, `none=${dNone}`);
  check('detail: forged top-level fails closed (=0)', dForged === 0, `forged=${dForged}`);

  // ── DETAIL PATH — multi-farm consignor SET (0026) ─────────────────────────
  const expMultiDetail = exp.detail.byGrower[M1]! + exp.detail.byGrower[M2]!;
  const dMulti = await detailCount(ID.multi);
  check(`detail: [M1,M2] token = UNION of both farms (=derived ${expMultiDetail})`, dMulti === expMultiDetail, `multi=${dMulti}`);
  const dMultiSingle = await detailCount(ID.multiSingle);
  check(`detail: [M1] token still single-farm (=derived ${exp.detail.byGrower[M1]})`, dMultiSingle === exp.detail.byGrower[M1], `single=${dMultiSingle}`);
  const dForgedMulti = await detailCount(ID.forgedMulti);
  check('detail: forged top-level consignor_ids fails closed (=0)', dForgedMulti === 0, `forgedMulti=${dForgedMulti}`);

  // ── list_grower_dispatches — row-level scope + no widening ────────────────
  const lA = await call('list_grower_dispatches', { limit: 50 }, ID.growerA);
  const lAkeys = new Set(lA.rows.map((r) => String(r.grower_key)));
  check('list: A sees only its own grower_key', lAkeys.size === 1 && lAkeys.has(A), `keys=${JSON.stringify([...lAkeys])}`);

  const lInternal = await call('list_grower_dispatches', { limit: 200 }, ID.internal);
  const lIkeys = new Set(lInternal.rows.map((r) => String(r.grower_key)));
  check('list: internal sees multiple growers', lIkeys.size > 1, `${lIkeys.size} distinct grower_keys in page`);

  const lNone = await call('list_grower_dispatches', { limit: 50 }, ID.none);
  check('list: no-claim returns 0 rows', lNone.row_count === 0, `rows=${lNone.row_count}`);

  // A passes grower=B as an argument — RLS still returns only A's universe → 0 rows for B.
  const lAtriesB = await call('list_grower_dispatches', { grower: B, limit: 50 }, ID.growerA);
  check('list: A cannot widen via grower=B (=0)', lAtriesB.row_count === 0, `rows=${lAtriesB.row_count}`);

  // ── SALES PATH — list_grower_sales over semantic.grower_gp_settlement ─────
  // Exact scoped counts (run_select) across the full context matrix, all vs derived source SQL.
  const sInternal = await salesCount(ID.internal);
  const sM1 = await salesCount(ID.salesA);
  const sM2 = await salesCount(ID.salesB);
  const sA = await salesCount(ID.growerA);
  const sNone = await salesCount(ID.none);
  const sForged = await salesCount(ID.forged);
  say(`\nsales count(*) — internal=${sInternal} ${CODE_M1}=${sM1} ${CODE_M2}=${sM2} ${CODE_A}=${sA} none=${sNone} forged=${sForged}\n`);

  check(`sales: internal sees all schedules (=derived ${exp.gp.internal})`, sInternal === exp.gp.internal, `internal=${sInternal}`);
  check('sales precondition: both sales growers have schedules', exp.gp.byGrower[M1]! > 0 && exp.gp.byGrower[M2]! > 0,
    `${CODE_M1}=${exp.gp.byGrower[M1]} ${CODE_M2}=${exp.gp.byGrower[M2]}`);
  check(`sales: grower ${CODE_M1} scoped (=derived ${exp.gp.byGrower[M1]})`, sM1 === exp.gp.byGrower[M1], `${CODE_M1}=${sM1}`);
  check(`sales: grower ${CODE_M2} scoped (=derived ${exp.gp.byGrower[M2]})`, sM2 === exp.gp.byGrower[M2], `${CODE_M2}=${sM2}`);
  check(`sales: grower ${CODE_A} scoped (=derived ${exp.gp.byGrower[A]})`, sA === exp.gp.byGrower[A], `${CODE_A}=${sA}`);
  check('sales: no-claim fails closed (=0)', sNone === 0, `none=${sNone}`);
  check('sales: forged top-level fails closed (=0)', sForged === 0, `forged=${sForged}`);

  // Tool-level scope: grower sees ONLY own schedules; internal sees many growers.
  const sListM1 = await call('list_grower_sales', { limit: 100 }, ID.salesA);
  const sM1keys = new Set(sListM1.rows.map((r) => String(r.grower_key)));
  check(`sales list: ${CODE_M1} sees only its own grower_key`, sM1keys.size === 1 && sM1keys.has(M1), `keys=${JSON.stringify([...sM1keys])}`);
  const sListInternal = await call('list_grower_sales', { limit: 500 }, ID.internal);
  const sIkeys = new Set(sListInternal.rows.map((r) => String(r.grower_key)));
  check('sales list: internal sees multiple growers', sIkeys.size > 1, `${sIkeys.size} distinct grower_keys in page`);
  const sListNone = await call('list_grower_sales', { limit: 50 }, ID.none);
  check('sales list: no-claim returns 0 rows', sListNone.row_count === 0, `rows=${sListNone.row_count}`);
  const sListForged = await call('list_grower_sales', { limit: 50 }, ID.forged);
  check('sales list: forged top-level returns 0 rows', sListForged.row_count === 0, `rows=${sListForged.row_count}`);
  const sM1triesM2 = await call('list_grower_sales', { grower: M2, limit: 50 }, ID.salesA);
  check(`sales list: ${CODE_M1} cannot widen via grower=${CODE_M2} (=0)`, sM1triesM2.row_count === 0, `rows=${sM1triesM2.row_count}`);

  // paid flag partitions honestly (paid_date null test — never zero-dated). Generous limit so the
  // partition equality below cannot falsely trip on truncation as the grower's history grows.
  const sPaid = await call('list_grower_sales', { paid: true, limit: 2000 }, ID.salesA);
  const sUnpaid = await call('list_grower_sales', { paid: false, limit: 2000 }, ID.salesA);
  check('sales list: paid=true rows all carry paid_date', sPaid.rows.every((r) => r.paid_date != null), `${sPaid.row_count} paid rows`);
  check('sales list: paid=false rows all have null paid_date', sUnpaid.rows.every((r) => r.paid_date == null), `${sUnpaid.row_count} unpaid rows`);
  check('sales list: paid + unpaid partition the grower total',
    !sPaid.truncated && !sUnpaid.truncated && sPaid.row_count + sUnpaid.row_count === sM1,
    `${sPaid.row_count}+${sUnpaid.row_count}=${sM1}`);

  // ── SALES PATH — multi-farm consignor SET (0026) ──────────────────────────
  const expMultiGp = exp.gp.byGrower[M1]! + exp.gp.byGrower[M2]!;
  const sMulti = await salesCount(ID.multi);
  check(`sales: [M1,M2] token = UNION of both farms (=derived ${expMultiGp})`, sMulti === expMultiGp, `multi=${sMulti}`);
  const sMultiSingle = await salesCount(ID.multiSingle);
  check(`sales: [M1] token still single-farm (=derived ${exp.gp.byGrower[M1]})`, sMultiSingle === exp.gp.byGrower[M1], `single=${sMultiSingle}`);
  const sListMulti = await call('list_grower_sales', { limit: 500 }, ID.multi);
  const sMultiKeys = new Set(sListMulti.rows.map((r) => String(r.grower_key)));
  check('sales list: [M1,M2] token sees BOTH farms, nothing else',
    sMultiKeys.size === 2 && sMultiKeys.has(M1) && sMultiKeys.has(M2), `keys=${JSON.stringify([...sMultiKeys])}`);
  const sForgedMulti = await salesCount(ID.forgedMulti);
  check('sales: forged top-level consignor_ids fails closed (=0)', sForgedMulti === 0, `forgedMulti=${sForgedMulti}`);

  // ── Governance / output shape ────────────────────────────────────────────
  check('output shape on every read', isReadResult(lA) && isReadResult(aGrouped) && isReadResult(sListM1),
    'columns/rows/metric_definition/filters_applied/row_count/truncated');
  const fa = aGrouped.filters_applied as Record<string, unknown>;
  check(
    'output carries baked-in filters + RLS scope',
    Array.isArray(fa.baked_in) && typeof fa.rls === 'string' && aGrouped.metric_definition != null,
    `filters_applied.rls="${String(fa.rls)}"`,
  );
  const sfa = sListM1.filters_applied as Record<string, unknown>;
  check(
    'sales output carries baked-in filters + RLS scope + metric definition',
    Array.isArray(sfa.baked_in) && typeof sfa.rls === 'string' && sListM1.metric_definition != null,
    `filters_applied.rls="${String(sfa.rls)}"`,
  );

  // ── Registry validation + escape-hatch safety ────────────────────────────
  await expectReject('unknown metric rejected', () => metric('bogus_metric', ID.internal));
  await expectReject('unknown dimension rejected', () =>
    call('query_metric', { metric: 'pallet_count', group_by: ['not_a_dim'] }, ID.internal),
  );
  await expectReject('run_select rejects non-semantic schema', () =>
    call('run_select', { sql: 'select * from raw.ft_pallet' }, ID.internal),
  );
  await expectReject('run_select rejects DML', () =>
    call('run_select', { sql: 'delete from semantic.grower_dispatch_detail' }, ID.internal),
  );
  await expectReject('run_select rejects multiple statements', () =>
    call('run_select', { sql: 'select 1 from semantic.grower_dispatch_detail; select 2' }, ID.internal),
  );

  const failed = results.filter((r) => !r.pass);
  say(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) say(`FAILED: ${failed.map((f) => f.name).join('; ')}`);

  const date = new Date().toISOString().slice(0, 10);
  const path = `reports/mcp_proof_${date}.txt`;
  writeFileSync(path, log.join('\n') + '\n');
  say(`report: ${path}`);
  if (failed.length) process.exitCode = 1;
}

async function expectReject(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, 'expected a ValidationError, got success');
  } catch (e) {
    check(name, e instanceof ValidationError, e instanceof Error ? e.message.slice(0, 80) : String(e));
  }
}

main()
  .catch((e) => {
    console.error('mcp proof error:', e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  })
  .finally(() => close());
