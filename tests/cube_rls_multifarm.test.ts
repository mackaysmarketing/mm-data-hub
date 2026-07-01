import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// B2/B3: the Cube grower filter uses SET MEMBERSHIP (migration 0026). Drives the REAL
// cube/cube.js queryRewrite (required as CommonJS) — no deploy, no DB. Proves:
//   • a multi-farm securityContext (app_metadata.consignor_ids:[A,B]) scopes to the UNION {A,B}
//   • a single-farm context (legacy app_metadata.consignor_id:A) behaves exactly as before → {A}
//   • internal → unscoped (no grower filter appended)
//   • no claim / empty set → fail closed (NIL uuid → 0 rows)
//   • MULTI-FARM ISOLATION: a [A,B] scope contains neither an unrelated C nor anything outside its
//     farms; and a consumer-supplied filter cannot widen it (scope filter still appended)
//   • cache keys (contextToAppId/OrchestratorId) differ for [A] vs [A,B] — no cross-tenant bleed
// ─────────────────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const cube = require(fileURLToPath(new URL('../cube/cube.js', import.meta.url))) as {
  queryRewrite: (q: any, ctx: { securityContext: any }) => any;
  contextToAppId: (ctx: { securityContext: any }) => string;
  contextToOrchestratorId: (ctx: { securityContext: any }) => string;
};

const A = '019439a6-fb95-f543-c2e0-40d9f9b719fa'; // LRCLA
const B = '019439a8-7d01-187c-89ff-970d71bdba6c'; // LRCTU
const C = '019439d4-6e3a-2339-88d1-85b11877ed6a'; // ZONTA (unrelated)
const NIL = '00000000-0000-0000-0000-000000000000';
const GK = 'dispatch.grower_key';

/** The scope filter cube.js appended for a given view's grower_key (the last matching filter). */
function scopeFilterFor(query: any, member: string): any {
  return (query.filters || []).find((f: any) => f && f.member === member && f.operator === 'equals');
}
function rewrite(securityContext: any, query: any = { measures: ['dispatch.pallet_count'] }): any {
  return cube.queryRewrite({ ...query }, { securityContext });
}

test('multi-farm context scopes to the UNION of its farms {A,B}', () => {
  const q = rewrite({ app_metadata: { consignor_ids: [A, B] } });
  const f = scopeFilterFor(q, GK);
  assert.ok(f, 'a grower_key scope filter must be appended');
  assert.deepEqual([...f.values].sort(), [A, B].sort());
});

test('single-farm legacy context (scalar consignor_id) behaves as before → {A}', () => {
  const q = rewrite({ app_metadata: { consignor_id: A } });
  const f = scopeFilterFor(q, GK);
  assert.deepEqual(f.values, [A]);
});

test('array + legacy scalar → de-duplicated union {A,B,C}', () => {
  const q = rewrite({ app_metadata: { consignor_ids: [A, B], consignor_id: C } });
  const f = scopeFilterFor(q, GK);
  assert.deepEqual([...f.values].sort(), [A, B, C].sort());
});

test('internal context is unscoped (no grower filter appended)', () => {
  const q = rewrite({ app_metadata: { is_internal: true } });
  assert.equal(scopeFilterFor(q, GK), undefined);
});

test('no claim and empty set both fail closed → NIL uuid', () => {
  assert.deepEqual(scopeFilterFor(rewrite({}), GK).values, [NIL]);
  assert.deepEqual(scopeFilterFor(rewrite({ app_metadata: { consignor_ids: [] } }), GK).values, [NIL]);
});

test('top-level (forged) claims are ignored — app_metadata only → NIL', () => {
  const q = rewrite({ consignor_ids: [A, B], consignor_id: A, is_internal: true } as any);
  assert.deepEqual(scopeFilterFor(q, GK).values, [NIL]);
});

test('MULTI-FARM ISOLATION: [A,B] scope excludes unrelated C and anything outside its farms', () => {
  const f = scopeFilterFor(rewrite({ app_metadata: { consignor_ids: [A, B] } }), GK);
  assert.ok(!f.values.includes(C), 'unrelated C must not be in the scope');
  for (const v of f.values) assert.ok([A, B].includes(v), `scope value ${v} is outside the grower's farms`);
  // A disjoint grower [C] scopes only to C — no overlap with [A,B].
  const fC = scopeFilterFor(rewrite({ app_metadata: { consignor_ids: [C] } }), GK);
  assert.deepEqual(fC.values, [C]);
  assert.equal(fC.values.some((v: string) => [A, B].includes(v)), false);
});

test('a consumer-supplied filter cannot widen scope (scope filter still appended)', () => {
  // Grower [A,B] tries to also select C via their own filter — the {A,B} scope is STILL appended,
  // so the effective query is (their filter) AND (grower_key IN {A,B}); C is unreachable.
  const q = rewrite(
    { app_metadata: { consignor_ids: [A, B] } },
    { measures: ['dispatch.pallet_count'], filters: [{ member: GK, operator: 'equals', values: [C] }] },
  );
  const scopeFilters = (q.filters || []).filter((f: any) => f.member === GK && [...f.values].sort().join() === [A, B].sort().join());
  assert.equal(scopeFilters.length, 1, 'the {A,B} scope filter must be present alongside the consumer filter');
});

test('set membership is appended on EVERY governed view a query references', () => {
  const q = rewrite(
    { app_metadata: { consignor_ids: [A, B] } },
    { measures: ['dispatch.pallet_count', 'settlement.net_paid'] },
  );
  assert.deepEqual([...scopeFilterFor(q, 'dispatch.grower_key').values].sort(), [A, B].sort());
  assert.deepEqual([...scopeFilterFor(q, 'settlement.grower_key').values].sort(), [A, B].sort());
});

test('cache keys isolate [A] from [A,B] (no single↔multi cache bleed)', () => {
  const single = { securityContext: { app_metadata: { consignor_ids: [A] } } };
  const multi = { securityContext: { app_metadata: { consignor_ids: [A, B] } } };
  assert.notEqual(cube.contextToAppId(single), cube.contextToAppId(multi));
  assert.notEqual(cube.contextToOrchestratorId(single), cube.contextToOrchestratorId(multi));
  // Order-independent: [A,B] and [B,A] hit the SAME bucket.
  assert.equal(
    cube.contextToAppId({ securityContext: { app_metadata: { consignor_ids: [A, B] } } }),
    cube.contextToAppId({ securityContext: { app_metadata: { consignor_ids: [B, A] } } }),
  );
});
