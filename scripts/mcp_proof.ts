// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — identity-propagation + parity PROOF (runnable).  npm run mcp:proof
//
// Drives the REAL tool handlers (same code the stdio server runs) under five caller contexts,
// proving the central requirement: every tool runs scoped to the caller, no argument can widen
// scope, and absent/forged identity fails closed — across BOTH paths:
//   • metric path  → query_metric (Cube REST, per-caller JWT, queryRewrite RLS)
//   • detail path  → list_grower_dispatches + run_select (Postgres, SET ROLE authenticated + claims)
//
// Baselines (live, confirmed against Cube + raw SQL this session):
//   Cube pallet_count:   internal 38322 · A(MMLAR) 13186 · B(MMTRU) 7631
//   Detail rows:         internal 38796 · A 13281 · B 7631   (detail bakes dispatched+non-test,
//                        NOT order_type='S' — that is why A differs between the two surfaces)
//
// Exit 0 = all assertions pass. Writes reports/mcp_proof_<date>.txt.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { makeDeps } from '../mcp/deps.ts';
import { TOOLS_BY_NAME } from '../mcp/tools.ts';
import { identityFromSecurityContext, type CallerIdentity } from '../mcp/identity.ts';
import { isReadResult, type ReadResult } from '../mcp/output.ts';
import { ValidationError } from '../mcp/errors.ts';

const A = '0191e996-93b7-fcd1-170e-87c6aa517087'; // MMLAR
const B = '0191f981-c9dc-4203-4f1b-3e9c5f5758d3'; // MMTRU

// Identities are built ONLY from app_metadata — the forged one carries TOP-LEVEL claims and must
// therefore collapse to no-scope (fail closed).
const ID = {
  internal: identityFromSecurityContext({ app_metadata: { is_internal: true } }, 'proof'),
  growerA: identityFromSecurityContext({ app_metadata: { consignor_id: A } }, 'proof'),
  growerB: identityFromSecurityContext({ app_metadata: { consignor_id: B } }, 'proof'),
  none: identityFromSecurityContext({}, 'proof'),
  forged: identityFromSecurityContext({ is_internal: true, consignor_id: A }, 'proof'),
};

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
// run_select count(*) over the detail view → exact RLS-scoped row count.
async function detailCount(id: CallerIdentity): Promise<number> {
  const r = await call('run_select', { sql: 'select count(*)::int as n from semantic.grower_dispatch_detail' }, id);
  const v = r.rows[0]?.n;
  return v == null ? 0 : Number(v);
}

async function main(): Promise<void> {
  say('=== Hub MCP identity-propagation + parity proof ===\n');

  // ── METRIC PATH (Cube) ───────────────────────────────────────────────────
  const mInternal = await metric('pallet_count', ID.internal);
  const mA = await metric('pallet_count', ID.growerA);
  const mB = await metric('pallet_count', ID.growerB);
  const mNone = await metric('pallet_count', ID.none);
  const mForged = await metric('pallet_count', ID.forged);
  say(`query_metric pallet_count — internal=${mInternal} A=${mA} B=${mB} none=${mNone} forged=${mForged}\n`);

  check('metric: internal parity (=38322)', mInternal === 38322, `pallet_count=${mInternal}`);
  check('metric: grower A scoped total (=13186)', mA === 13186, `A=${mA}`);
  check('metric: grower B scoped total (=7631)', mB === 7631, `B=${mB}`);
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

  // ── DETAIL PATH (Postgres RLS via run_select count) ──────────────────────
  const dInternal = await detailCount(ID.internal);
  const dA = await detailCount(ID.growerA);
  const dB = await detailCount(ID.growerB);
  const dNone = await detailCount(ID.none);
  const dForged = await detailCount(ID.forged);
  say(`\ndetail count(*) — internal=${dInternal} A=${dA} B=${dB} none=${dNone} forged=${dForged}\n`);

  check('detail: internal sees all (=38796)', dInternal === 38796, `internal=${dInternal}`);
  check('detail: grower A scoped (=13281)', dA === 13281, `A=${dA}`);
  check('detail: grower B scoped (=7631)', dB === 7631, `B=${dB}`);
  check('detail: no-claim fails closed (=0)', dNone === 0, `none=${dNone}`);
  check('detail: forged top-level fails closed (=0)', dForged === 0, `forged=${dForged}`);

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

  // ── Governance / output shape ────────────────────────────────────────────
  check('output shape on every read', isReadResult(lA) && isReadResult(aGrouped), 'columns/rows/metric_definition/filters_applied/row_count/truncated');
  const fa = aGrouped.filters_applied as Record<string, unknown>;
  check(
    'output carries baked-in filters + RLS scope',
    Array.isArray(fa.baked_in) && typeof fa.rls === 'string' && aGrouped.metric_definition != null,
    `filters_applied.rls="${String(fa.rls)}"`,
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
