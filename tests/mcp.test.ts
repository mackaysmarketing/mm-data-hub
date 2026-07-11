import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  identityFromSecurityContext,
  NONE_IDENTITY,
  hasScope,
  appMetadata,
  claimsJson,
  signCallerToken,
  verifyCallerToken,
} from '../mcp/identity.ts';
import { buildCatalog, resolveMetric, resolveDimension, lookupDefinition } from '../mcp/registry.ts';
import { buildResult, isReadResult } from '../mcp/output.ts';
import { guardSelect } from '../mcp/runSelect.ts';
import { ValidationError, IdentityError } from '../mcp/errors.ts';
import { TOOLS, TOOLS_BY_NAME, type ToolDeps } from '../mcp/tools.ts';
import type { CubeMetaCube, CubeQuery } from '../mcp/cube.ts';

const A = '0191e996-93b7-fcd1-170e-87c6aa517087';
const B = '0191f981-c9dc-4203-4f1b-3e9c5f5758d3';

// ── Identity: app_metadata-only contract, forged top-level rejected (fail closed) ────────────
test('identity: forged TOP-LEVEL claims are ignored → no scope', () => {
  const id = identityFromSecurityContext({ is_internal: true, consignor_id: A });
  assert.equal(id, NONE_IDENTITY);
  assert.equal(hasScope(id), false);
  // The multi-farm array claim is app_metadata-only too (0026 contract).
  assert.equal(identityFromSecurityContext({ consignor_ids: [A, B] }), NONE_IDENTITY);
});

// ── Identity: multi-farm consignor SET (migration 0026 contract) ─────────────────────────────
test('identity: consignor_ids[] → SET; scalar folds in; malformed skipped; single-farm byte-identical', () => {
  const multi = identityFromSecurityContext({ app_metadata: { consignor_ids: [A, B] } });
  assert.deepEqual([...multi.consignorIds], [A, B]);
  assert.equal(multi.consignorId, A); // legacy scalar view = element 1
  assert.equal(hasScope(multi), true);
  assert.deepEqual(appMetadata(multi), { consignor_ids: [A, B] });

  // array + legacy scalar → de-duplicated union (same fold as 0026 / cube.js readClaims)
  const union = identityFromSecurityContext({ app_metadata: { consignor_ids: [A, B], consignor_id: A } });
  assert.deepEqual([...union.consignorIds].sort(), [A, B].sort());

  // malformed elements are skipped (fail closed for them), duplicates collapse
  const skipped = identityFromSecurityContext({ app_metadata: { consignor_ids: ['not-a-uuid', A, A] } });
  assert.deepEqual([...skipped.consignorIds], [A]);
  // a single-element set emits the LEGACY scalar claim — byte-identical to pre-0026 payloads
  assert.deepEqual(appMetadata(skipped), { consignor_id: A });

  // empty array / non-array / all-malformed → fail closed
  assert.equal(identityFromSecurityContext({ app_metadata: { consignor_ids: [] } }), NONE_IDENTITY);
  assert.equal(identityFromSecurityContext({ app_metadata: { consignor_ids: 'not-an-array' } }), NONE_IDENTITY);
  assert.equal(identityFromSecurityContext({ app_metadata: { consignor_ids: ['nope'] } }), NONE_IDENTITY);
});

test('identity: multi-farm claims round-trip the caller token and reach claimsJson', () => {
  const secret = 'test-secret';
  const tok = signCallerToken({ app_metadata: { consignor_ids: [A, B] } }, secret);
  const id = verifyCallerToken(tok, secret);
  assert.deepEqual([...id.consignorIds], [A, B]);
  // the detail path presents the SAME set under request.jwt.claims.app_metadata
  assert.deepEqual(JSON.parse(claimsJson(id)), { app_metadata: { consignor_ids: [A, B] } });
});

test('identity: app_metadata grower → scoped; internal → internal; malformed uuid → none', () => {
  const g = identityFromSecurityContext({ app_metadata: { consignor_id: A } });
  assert.equal(g.consignorId, A);
  assert.equal(g.isInternal, false);
  assert.equal(hasScope(g), true);

  const i = identityFromSecurityContext({ app_metadata: { is_internal: true } });
  assert.equal(i.isInternal, true);
  assert.equal(i.tier, 'internal');

  const bad = identityFromSecurityContext({ app_metadata: { consignor_id: 'not-a-uuid' } });
  assert.equal(bad, NONE_IDENTITY);
});

test('identity: claims JSON only ever carries app_metadata (fail-closed when empty)', () => {
  assert.deepEqual(JSON.parse(claimsJson(NONE_IDENTITY)), { app_metadata: {} });
  assert.deepEqual(appMetadata(identityFromSecurityContext({ app_metadata: { consignor_id: A } })), {
    consignor_id: A,
  });
});

test('identity: caller token verify round-trips; tampered signature is rejected', () => {
  const secret = 'test-secret';
  const tok = signCallerToken({ app_metadata: { consignor_id: A } }, secret);
  const id = verifyCallerToken(tok, secret);
  assert.equal(id.consignorId, A);
  assert.throws(() => verifyCallerToken(tok, 'wrong-secret'), IdentityError);
  assert.throws(() => verifyCallerToken(tok + 'x', secret), IdentityError);
});

// ── Registry: consume + validate, never redefine ────────────────────────────────────────────
const META: CubeMetaCube[] = [
  {
    name: 'dispatch',
    public: true,
    measures: [
      { name: 'dispatch.pallet_count', title: 'Pallet Count', type: 'number', description: 'count of dispatched Sell pallets' },
      { name: 'dispatch.net_weight_dispatched', title: 'Net Weight (kg)', type: 'number' },
      { name: 'dispatch.net_weight_capture_rate', title: 'Capture Rate', type: 'number', format: 'percent' },
    ],
    dimensions: [
      { name: 'dispatch.grower_key', title: 'Grower', type: 'string' },
      { name: 'dispatch.dispatched_on', title: 'Dispatch Date', type: 'time' },
      { name: 'dispatch.crop', title: 'Crop', type: 'string' },
    ],
  },
];
const CAT = buildCatalog(META);

test('registry: builds catalog; units derived; unknowns rejected', () => {
  assert.equal(CAT.metrics.length, 3);
  assert.equal(resolveMetric(CAT, 'pallet_count').full, 'dispatch.pallet_count');
  assert.equal(resolveMetric(CAT, 'dispatch.pallet_count').name, 'pallet_count'); // prefixed form accepted
  assert.equal(CAT.metricByName.get('net_weight_dispatched')?.unit, 'kg');
  assert.equal(CAT.metricByName.get('net_weight_capture_rate')?.unit, 'percent');
  assert.throws(() => resolveMetric(CAT, 'revenue'), ValidationError);
  assert.throws(() => resolveDimension(CAT, 'location_id'), ValidationError);
});

test('registry: definitions resolve for canonical terms, metrics, and reject unknown', () => {
  assert.equal(lookupDefinition(CAT, 'net_weight').kind, 'concept');
  assert.equal(lookupDefinition(CAT, 'baked_in_filters').kind, 'governance');
  assert.equal(lookupDefinition(CAT, 'pallet_count').kind, 'metric');
  assert.equal(lookupDefinition(CAT, 'grower_key').kind, 'dimension');
  assert.throws(() => lookupDefinition(CAT, 'ebitda'), ValidationError);
});

// ── Output shape ────────────────────────────────────────────────────────────────────────────
test('output: buildResult reports truncation honestly + valid shape', () => {
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const capped = buildResult({ rows, cap: 2, metricDefinition: null, filtersApplied: {} });
  assert.equal(capped.row_count, 2);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.columns, ['a']);
  assert.ok(isReadResult(capped));

  const whole = buildResult({ rows: rows.slice(0, 2), cap: 5, metricDefinition: null, filtersApplied: {} });
  assert.equal(whole.truncated, false);
});

// ── run_select guard ──────────────────────────────────────────────────────────────────────
test('run_select guard: accepts a semantic SELECT, rejects everything dangerous', () => {
  const ok = guardSelect('select crop, count(*) from semantic.grower_dispatch_detail group by 1', 10);
  assert.match(ok.sql, /_hub_mcp_capped limit 11/);
  assert.equal(ok.cap, 10);

  assert.throws(() => guardSelect('select * from raw.ft_pallet'), ValidationError); // wrong schema
  assert.throws(() => guardSelect('select * from public.farms'), ValidationError);
  assert.throws(() => guardSelect('delete from semantic.grower_dispatch_detail'), ValidationError); // DML
  assert.throws(() => guardSelect('drop view semantic.grower_dispatch_detail'), ValidationError); // DDL
  assert.throws(() => guardSelect('select 1 from semantic.x; select 2 from semantic.y'), ValidationError); // multi
  assert.throws(() => guardSelect('select 1'), ValidationError); // no semantic ref
  assert.throws(() => guardSelect('update semantic.x set a=1'), ValidationError);
  assert.throws(
    () => guardSelect('select * from semantic.grower_dispatch_detail /* sneaky */ ; drop table semantic.x'),
    ValidationError,
  );
});

// ── Tool surface registration ───────────────────────────────────────────────────────────────
test('tools: the full read surface is registered with input schemas', () => {
  for (const name of [
    'get_catalog', 'list_metrics', 'get_definition', 'list_dimension_values',
    'query_metric', 'list_grower_dispatches', 'list_grower_sales', 'resolve_entity', 'run_select',
  ]) {
    const t = TOOLS_BY_NAME.get(name);
    assert.ok(t, `${name} registered`);
    assert.equal(typeof t?.inputSchema, 'object');
  }
  // every tool's input schema is an object schema
  for (const t of TOOLS) assert.equal((t.inputSchema as { type?: string }).type, 'object');
});

// ── Handlers with injected fakes (no live deps): validation + governed output ─────────────────
let lastQuery: CubeQuery | null = null;
let lastSql: string | null = null;
let lastParams: unknown[] | undefined;
function fakeDeps(loadRows: Array<Record<string, string | number | null>>): ToolDeps {
  return {
    cube: {
      load: async (q) => {
        lastQuery = q;
        return loadRows;
      },
      meta: async () => META,
    },
    db: {
      query: async (_id, fn) =>
        fn(async (sql: string, params?: unknown[]) => {
          lastSql = sql;
          lastParams = params;
          return { rows: [{ n: 1 }], fields: [{ name: 'n' }] } as never;
        }),
      end: async () => {},
    },
    catalog: async () => CAT,
  };
}

test('query_metric: rejects unknown metric BEFORE any data call', async () => {
  const deps = fakeDeps([]);
  lastQuery = null;
  await assert.rejects(
    () => TOOLS_BY_NAME.get('query_metric')!.handler({ metric: 'revenue' }, NONE_IDENTITY, deps),
    ValidationError,
  );
  assert.equal(lastQuery, null, 'no Cube call on validation failure');
});

test('query_metric: builds a governed Cube query + governed output shape', async () => {
  const deps = fakeDeps([{ 'dispatch.grower_key': A, 'dispatch.pallet_count': 5 }]);
  const id = identityFromSecurityContext({ app_metadata: { consignor_id: A } });
  const res = await TOOLS_BY_NAME.get('query_metric')!.handler(
    { metric: 'pallet_count', group_by: ['grower_key'] },
    id,
    deps,
  );
  assert.deepEqual(lastQuery?.measures, ['dispatch.pallet_count']);
  assert.deepEqual(lastQuery?.dimensions, ['dispatch.grower_key']);
  assert.equal(lastQuery?.limit, 1001); // default cap + 1
  assert.ok(isReadResult(res));
  const fa = res.filters_applied as Record<string, unknown>;
  assert.ok(Array.isArray(fa.baked_in));
  assert.match(String(fa.rls), /grower-scoped/);
  assert.ok(Array.isArray(res.metric_definition));
});

test('query_metric: rejects an unknown filter operator', async () => {
  const deps = fakeDeps([]);
  await assert.rejects(
    () =>
      TOOLS_BY_NAME.get('query_metric')!.handler(
        { metric: 'pallet_count', filters: [{ dimension: 'crop', operator: 'regex', values: ['x'] }] },
        NONE_IDENTITY,
        deps,
      ),
    ValidationError,
  );
});

test('run_select handler: surfaces the guard rejection as ValidationError', async () => {
  const deps = fakeDeps([]);
  await assert.rejects(
    () => TOOLS_BY_NAME.get('run_select')!.handler({ sql: 'select * from raw.ft_pallet' }, NONE_IDENTITY, deps),
    ValidationError,
  );
});

test('list_grower_sales: wired over semantic.grower_gp_settlement with validated filters', async () => {
  const deps = fakeDeps([]);
  lastSql = null;
  lastParams = undefined;
  const id = identityFromSecurityContext({ app_metadata: { consignor_id: A } });
  const res = await TOOLS_BY_NAME.get('list_grower_sales')!.handler(
    { time_range: { from: '2026-01-01', to: '2026-06-30' }, paid: true, limit: 10 },
    id,
    deps,
  );
  assert.ok(isReadResult(res));
  assert.match(lastSql!, /from semantic\.grower_gp_settlement/);
  assert.match(lastSql!, /payable_on >= \$1::date/);
  assert.match(lastSql!, /payable_on <= \$2::date/);
  assert.match(lastSql!, /paid_date is not null/); // paid flag = pure null test, never zero-dated
  assert.match(lastSql!, /limit 11/); // cap + 1 to detect truncation
  assert.deepEqual(lastParams, ['2026-01-01', '2026-06-30']);
  const fa = res.filters_applied as Record<string, unknown>;
  assert.equal(fa.paid, true);
  assert.match(String(fa.rls), /grower-scoped/);
  assert.ok(Array.isArray(fa.baked_in));
});

test('list_grower_sales: paid=false filters to null paid_date; grower arg only narrows', async () => {
  const deps = fakeDeps([]);
  lastSql = null;
  await TOOLS_BY_NAME.get('list_grower_sales')!.handler(
    { paid: false, grower: B },
    identityFromSecurityContext({ app_metadata: { consignor_id: A } }),
    deps,
  );
  assert.match(lastSql!, /paid_date is null/);
  assert.match(lastSql!, /grower_key = \$1::uuid/); // a narrowing filter — RLS still bounds the universe
  assert.deepEqual(lastParams, [B]);
});
