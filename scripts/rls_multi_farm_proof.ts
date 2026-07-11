// ─────────────────────────────────────────────────────────────────────────────
// Multi-farm grower RLS proof — semantic.current_consignor_ids() + every grower_own_* policy.
//   node --experimental-strip-types scripts/rls_multi_farm_proof.ts
//
// Proves the single→set switch (migration 0026) against the LIVE hub:
//   A2  current_consignor_ids() returns uuid[]: array→array, scalar→1-elem, none→empty, app_metadata-only
//   A3  every grower_own_* policy filters `= ANY(current_consignor_ids())`; none uses the scalar shim
//   A4  a LEGACY single-consignor_id token reproduces the owner-derived per-consignor counts exactly
//   A5  a [A,B] token returns rows for A and B only (by-consignor breakdown); unrelated C → 0
//   A6  farm A sees 0 of B; no-claim & empty-set → 0; functions never error on missing/malformed
//   A7  an internal token returns the full unfiltered count on every grower table
//
// Expected counts are DERIVED IN-RUN as the table owner (RLS does not apply to the owner), so the
// proof cannot rot as data grows — the original hardcoded A0 snapshot (2026-07-01) failed 15/45 on
// pure data drift after the first freshness load (closeout sprint C6). The invariant is unchanged:
// an RLS-scoped count must equal the owner-derived truth for the same consignor filter.
//
// Read-only: every context runs in a transaction that ROLLS BACK. Exit 0 = all pass.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

// Test set (A0): real multi-farm grower L & R Collins (LRCLA Lakeland + LRCTU Tully) + unrelated ZONTA.
const A = '019439a6-fb95-f543-c2e0-40d9f9b719fa'; // LRCLA
const B = '019439a8-7d01-187c-89ff-970d71bdba6c'; // LRCTU
const C = '019439d4-6e3a-2339-88d1-85b11877ed6a'; // ZONTA (unrelated)

// Expected counts per table — DERIVED IN-RUN as the table owner (see header). Filled in main().
const EXPECTED: Record<string, { internal: number; a: number; b: number; c: number }> = {};
const TABLES = [
  'raw.ft_dispatch_load',
  'raw.ft_pallet',
  'core.dim_grower',
  'core.fact_settlement_bill',
  'core.fact_gp_settlement',
  'core.fact_gp_settlement_load',
];
// consignor column for each table (pallet is scoped through its load).
const CONSIGNOR_EXPR: Record<string, string> = {
  'raw.ft_dispatch_load': 'consignor_id',
  'raw.ft_pallet': '(select d.consignor_id from raw.ft_dispatch_load d where d.id = dispatch_load_id)',
  'core.dim_grower': 'consignor_id',
  'core.fact_settlement_bill': 'consignor_id',
  'core.fact_gp_settlement': 'consignor_id',
  'core.fact_gp_settlement_load': 'consignor_id',
};

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const j = (o: object) => JSON.stringify({ role: 'authenticated', ...o });

async function underCtx<T>(c: PoolClient, claimsJson: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role authenticated');
    if (claimsJson === null) await c.query("select set_config('request.jwt.claims', '', true)");
    else await c.query("select set_config('request.jwt.claims', $1, true)", [claimsJson]);
    return await fn();
  } finally {
    await c.query('rollback');
  }
}
async function count(c: PoolClient, claimsJson: string | null, tbl: string): Promise<number> {
  return underCtx(c, claimsJson, async () => Number((await c.query(`select count(*) n from ${tbl}`)).rows[0]!.n));
}
async function breakdown(c: PoolClient, claimsJson: string, tbl: string): Promise<{ total: number; a: number; b: number; cc: number }> {
  const expr = CONSIGNOR_EXPR[tbl]!;
  return underCtx(c, claimsJson, async () => {
    const r = await c.query(
      `select count(*) total,
              count(*) filter (where ${expr} = $1) a,
              count(*) filter (where ${expr} = $2) b,
              count(*) filter (where ${expr} = $3) cc
         from ${tbl}`, [A, B, C]);
    const x = r.rows[0]!;
    return { total: Number(x.total), a: Number(x.a), b: Number(x.b), cc: Number(x.cc) };
  });
}
// Call the function under an arbitrary raw claims string; returns the uuid[] as string[].
async function idsUnder(c: PoolClient, rawClaims: string): Promise<string[]> {
  await c.query('begin');
  try {
    await c.query("select set_config('request.jwt.claims', $1, true)", [rawClaims]);
    const r = await c.query<{ ids: string[] | null }>('select semantic.current_consignor_ids() as ids');
    return r.rows[0]!.ids ?? [];
  } finally {
    await c.query('rollback');
  }
}
async function scalarShimUnder(c: PoolClient, rawClaims: string): Promise<string | null> {
  await c.query('begin');
  try {
    await c.query("select set_config('request.jwt.claims', $1, true)", [rawClaims]);
    const r = await c.query<{ id: string | null }>('select semantic.current_consignor_id() as id');
    return r.rows[0]!.id;
  } finally {
    await c.query('rollback');
  }
}
const sameSet = (got: string[], want: string[]) =>
  got.length === want.length && [...got].sort().join(',') === [...want].sort().join(',');

async function main(): Promise<void> {
  const pool = makePool();
  const c = await pool.connect();
  try {
    // ── A0' — derive the expected counts as the table OWNER (no role switch → RLS off) ──
    console.log('=== A0  expected counts derived in-run as table owner (proof cannot rot) ===');
    for (const t of TABLES) {
      const expr = CONSIGNOR_EXPR[t]!;
      const r = await c.query(
        `select count(*) internal,
                count(*) filter (where ${expr} = $1) a,
                count(*) filter (where ${expr} = $2) b,
                count(*) filter (where ${expr} = $3) c
           from ${t}`, [A, B, C]);
      const x = r.rows[0]!;
      EXPECTED[t] = { internal: Number(x.internal), a: Number(x.a), b: Number(x.b), c: Number(x.c) };
      console.log(`  ${t}: internal=${x.internal} A=${x.a} B=${x.b} C=${x.c}`);
    }
    // ── A2: current_consignor_ids() return semantics (app_metadata only) ─────────
    console.log('\n=== A2  semantic.current_consignor_ids() returns uuid[] (app_metadata only) ===');
    const arr = await idsUnder(c, JSON.stringify({ app_metadata: { consignor_ids: [A, B] } }));
    check('array claim → the array', sameSet(arr, [A, B]), JSON.stringify(arr));
    const one = await idsUnder(c, JSON.stringify({ app_metadata: { consignor_id: A } }));
    check('scalar consignor_id → one-element array', sameSet(one, [A]), JSON.stringify(one));
    const none = await idsUnder(c, '');
    check('no claim → empty array', none.length === 0, JSON.stringify(none));
    const noAm = await idsUnder(c, JSON.stringify({ consignor_ids: [A, B], consignor_id: A })); // TOP-LEVEL only
    check('top-level claims ignored (app_metadata only) → empty', noAm.length === 0, JSON.stringify(noAm));
    const union = await idsUnder(c, JSON.stringify({ app_metadata: { consignor_ids: [A, B], consignor_id: C } }));
    check('array + scalar → de-duplicated union', sameSet(union, [A, B, C]), JSON.stringify(union));
    const emptyArr = await idsUnder(c, JSON.stringify({ app_metadata: { consignor_ids: [] } }));
    check('empty array claim → empty set', emptyArr.length === 0, JSON.stringify(emptyArr));
    // scalar shim = element 1
    check('scalar shim current_consignor_id() = element 1 (legacy)',
      (await scalarShimUnder(c, JSON.stringify({ app_metadata: { consignor_id: A } }))) === A);
    check('scalar shim = NULL on empty set',
      (await scalarShimUnder(c, '')) === null);

    // ── A6 (functions never error) folded in: malformed inputs return, never throw ──
    console.log('\n=== A6a  functions never error on missing/malformed claims ===');
    let threw = false; let badElem: string[] = [];
    try { badElem = await idsUnder(c, JSON.stringify({ app_metadata: { consignor_ids: ['not-a-uuid', B] } })); }
    catch { threw = true; }
    check('malformed array element skipped, no error → {B}', !threw && sameSet(badElem, [B]), JSON.stringify(badElem));
    threw = false; let badJson: string[] = [];
    try { badJson = await idsUnder(c, '{not valid json'); } catch { threw = true; }
    check('malformed claims JSON → empty, no error', !threw && badJson.length === 0, JSON.stringify(badJson));
    threw = false; let badScalar: string[] = [];
    try { badScalar = await idsUnder(c, JSON.stringify({ app_metadata: { consignor_id: 'xyz' } })); } catch { threw = true; }
    check('malformed scalar consignor_id → empty, no error', !threw && badScalar.length === 0, JSON.stringify(badScalar));

    // ── A3: policy definitions now use the SET, not the scalar shim ───────────────
    console.log('\n=== A3  every grower_own_* policy filters = ANY(current_consignor_ids()); none uses scalar ===');
    const pol = await c.query<{ tbl: string; policyname: string; qual: string }>(
      `select schemaname||'.'||tablename tbl, policyname, qual
         from pg_policies where policyname like 'grower_own_%' order by tbl, policyname`);
    for (const p of pol.rows) {
      const usesSet = /current_consignor_ids\(\)/.test(p.qual);
      const usesScalar = /current_consignor_id\(\)/.test(p.qual);
      check(`${p.policyname}: uses SET & not scalar`, usesSet && !usesScalar, p.qual.replace(/\s+/g, ' '));
    }
    check('exactly 6 grower_own_* policies present', pol.rows.length === 6, `${pol.rows.length} found`);

    // ── A7: internal token → full unfiltered counts (== baseline internal) ───────
    console.log('\n=== A7  internal token → full unfiltered count on every grower table ===');
    for (const t of TABLES) {
      const n = await count(c, j({ app_metadata: { is_internal: true } }), t);
      check(`internal ${t} = derived ${EXPECTED[t]!.internal}`, n === EXPECTED[t]!.internal, `got ${n}`);
    }

    // ── A4: legacy single-consignor tokens reproduce the A0 baseline exactly ─────
    console.log('\n=== A4  legacy single-consignor_id token == A0 baseline (backward compatible) ===');
    for (const t of TABLES) {
      const a = await count(c, j({ app_metadata: { consignor_id: A } }), t);
      const b = await count(c, j({ app_metadata: { consignor_id: B } }), t);
      const cc = await count(c, j({ app_metadata: { consignor_id: C } }), t);
      const bl = EXPECTED[t]!;
      check(`${t} legacy A/B/C = derived ${bl.a}/${bl.b}/${bl.c}`, a === bl.a && b === bl.b && cc === bl.c, `got ${a}/${b}/${cc}`);
    }

    // ── A5: [A,B] token → rows for A and B ONLY (breakdown); C → 0 ───────────────
    console.log('\n=== A5  multi-farm [A,B] token → A and B only (by-consignor breakdown); C = 0 ===');
    const abToken = j({ app_metadata: { consignor_ids: [A, B] } });
    for (const t of TABLES) {
      const bd = await breakdown(c, abToken, t);
      const bl = EXPECTED[t]!;
      const ok = bd.a === bl.a && bd.b === bl.b && bd.cc === 0 && bd.total === bl.a + bl.b;
      check(`${t}: A=${bd.a} B=${bd.b} C=${bd.cc} total=${bd.total}`, ok, `(expect A=${bl.a} B=${bl.b} C=0 total=${bl.a + bl.b})`);
    }
    // Unrelated C under the [A,B] claim sees none of its own rows.
    const cUnderAb = await breakdown(c, abToken, 'raw.ft_dispatch_load');
    check('unrelated C returns 0 under the [A,B] claim', cUnderAb.cc === 0, `C rows under [A,B] = ${cUnderAb.cc}`);

    // ── A6b: isolation + fail-closed row counts ──────────────────────────────────
    console.log('\n=== A6b  isolation + fail-closed (A sees 0 of B; no-claim/empty-set → 0) ===');
    const aTok = j({ app_metadata: { consignor_ids: [A] } });
    const aSeesB = (await breakdown(c, aTok, 'raw.ft_dispatch_load')).b;
    check('farm A token sees 0 of farm B rows', aSeesB === 0, `B rows under A = ${aSeesB}`);
    const bTok = j({ app_metadata: { consignor_ids: [B] } });
    const bSeesA = (await breakdown(c, bTok, 'raw.ft_pallet')).a;
    check('farm B token sees 0 of farm A pallets', bSeesA === 0, `A pallets under B = ${bSeesA}`);
    for (const t of TABLES) {
      const noClaim = await count(c, null, t);
      const emptySet = await count(c, j({ app_metadata: { consignor_ids: [] } }), t);
      check(`${t}: no-claim=0 & empty-set=0`, noClaim === 0 && emptySet === 0, `no-claim=${noClaim} empty=${emptySet}`);
    }

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('proof error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
