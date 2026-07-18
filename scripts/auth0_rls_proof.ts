// ─────────────────────────────────────────────────────────────────────────────
// Auth0 (grower-portal) RLS proof — semantic.auth0_consignor_ids() + the additive
// auth0_grower_own_* policies + the 0050 trust-partition guards.
//   npm run auth0:rls
//
// Proves migration 0050 against the LIVE hub:
//   B1  auth0_consignor_ids(): array→set, de-duplicated, uuid-validated; honored ONLY under
//       iss = https://grower-portal.au.auth0.com/ (wrong/missing iss → empty); never errors.
//   B2  exactly 7 auth0_grower_own_* policies live (0026 six + 0054 fact_load_sale); each quals
//       on auth0_consignor_ids(), none carries is_internal_claim(); the 7 grower_own_* mm-hub
//       policies match the pinned (table|name) set.
//   B3  an Auth0 [A] token reproduces the owner-derived per-consignor counts exactly; B/C = 0.
//   B4  an Auth0 [A,B] token = A+B rows only.
//   B5  forgery fails closed: the namespaced claim under a WRONG issuer (incl. the hub's own
//       Supabase issuer) → 0 rows; an mm-hub token carrying the namespaced claim gains nothing.
//   B6  trust partition (0050 guards): an Auth0-issued token carrying forged
//       app_metadata.{consignor_ids,is_internal} gets ONLY its namespaced scope — is_internal
//       is false, internal-only relations return 0, ungranted relations stay permission-denied.
//   B7  mm-hub path untouched: app_metadata tokens (no iss — the Cube/MCP/proof shape — and
//       with the Supabase iss) reproduce owner-derived counts; internal sees all; no-claim → 0.
//   B8  identity parity: every grower-facing semantic view returns IDENTICAL counts for the
//       same consignor via Auth0 and via mm-hub app_metadata.
//
// Staff sections (migration 0056 — the .../staff claim, Tim-approved 2026-07-18):
//   S1  auth0_is_staff(): strict boolean-true, issuer-pinned; "true"/1/false/nested/app_metadata
//       forms and wrong/missing/Supabase issuers → false; never errors.
//   S2  exactly 7 auth0_staff_read_* policies live, covering exactly the grower-scoped set; each
//       quals EXACTLY semantic.auth0_is_staff() (no internal, no consignor branch); the
//       grower_own_* and auth0_grower_own_* pinned sets are untouched (B2 re-asserts them).
//   S3  a staff token reads ALL rows on all 7 relations (owner-derived totals) and every grower
//       view matches the mm-hub internal-token counts; staff+grower hybrid = same (policy OR).
//   S4  staff ≠ internal: internal-only relations return 0 under a staff token; etl-only and
//       ungranted surfaces stay permission-denied.
//   S5  grower_directory: staff == owner-derived grower list (non-test, is_grower); grower,
//       mm-hub-internal (deliberate), and no-claim tokens all → 0 rows.
//
// Expected counts are DERIVED IN-RUN as the table owner (proof-style contract: hardcoded
// baselines are FORBIDDEN); fixture consignors are resolved by live row counts, not uuids.
// Run with loaders QUIESCENT: expected counts derive in B0 and are re-asserted in later
// transactions — a concurrent upsert for a fixture consignor fails checks on pure data movement.
// Read-only: every context runs in a transaction that ROLLS BACK. Exit 0 = all pass.
// Report: reports/auth0_rls_proof_<date>.txt (written even on an aborted run).
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const AUTH0_ISS = 'https://grower-portal.au.auth0.com/';
const CLAIM = 'https://grower-portal.mackays.com.au/consignor_ids';
const STAFF = 'https://grower-portal.mackays.com.au/staff';
const SUPA_ISS = 'https://uqzfkhsdyeokwnkpcxui.supabase.co/auth/v1';

const TABLES = [
  'raw.ft_dispatch_load',
  'raw.ft_pallet',
  'core.dim_grower',
  'core.fact_settlement_bill',
  'core.fact_gp_settlement',
  'core.fact_gp_settlement_load',
  'core.fact_load_sale',            // 7th grower-scoped relation (0054, grower-portal fix pack)
];
const CONSIGNOR_EXPR: Record<string, string> = {
  'raw.ft_dispatch_load': 'consignor_id',
  'raw.ft_pallet': '(select d.consignor_id from raw.ft_dispatch_load d where d.id = dispatch_load_id)',
  'core.dim_grower': 'consignor_id',
  'core.fact_settlement_bill': 'consignor_id',
  'core.fact_gp_settlement': 'consignor_id',
  'core.fact_gp_settlement_load': 'consignor_id',
  'core.fact_load_sale': 'consignor_id',
};
const GROWER_VIEWS = [
  'semantic.grower_dispatch_detail',
  'semantic.grower_dispatch_shipped',
  'semantic.grower_dispatch_load',      // 0055 (fix pack FIX 4+6)
  'semantic.grower_load_sale',          // 0055 (fix pack FIX 5+7)
  'semantic.grower_settlement',
  'semantic.grower_gp_settlement',
  'semantic.grower_gp_settlement_load',
];

const lines: string[] = [];
function log(msg: string): void { lines.push(msg); console.log(msg); }
const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass });
  log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Claim builders — all carry role=authenticated the way PostgREST presents them.
const auth0Tok = (ids: string[], extra: object = {}) =>
  JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [CLAIM]: ids, ...extra });
const hubTok = (o: object) => JSON.stringify({ role: 'authenticated', ...o }); // no iss — the Cube/MCP/proof shape
const staffTok = (extra: object = {}) =>
  JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [STAFF]: true, ...extra });

async function underCtx<T>(c: PoolClient, claimsJson: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [claimsJson ?? '']);
    return await fn();
  } finally {
    await c.query('rollback');
  }
}
async function count(c: PoolClient, claimsJson: string | null, rel: string): Promise<number> {
  return underCtx(c, claimsJson, async () => Number((await c.query(`select count(*) n from ${rel}`)).rows[0]!.n));
}
/** count that may be permission-denied: returns 'denied' instead of a number. */
async function countOrDenied(c: PoolClient, claimsJson: string, rel: string): Promise<number | 'denied'> {
  try {
    return await count(c, claimsJson, rel);
  } catch (e) {
    if ((e as { code?: string }).code === '42501') return 'denied';
    throw e;
  }
}
async function breakdown(c: PoolClient, claimsJson: string, tbl: string, a: string, b: string, cc: string) {
  const expr = CONSIGNOR_EXPR[tbl]!;
  return underCtx(c, claimsJson, async () => {
    const r = await c.query(
      `select count(*) total,
              count(*) filter (where ${expr} = $1) a,
              count(*) filter (where ${expr} = $2) b,
              count(*) filter (where ${expr} = $3) cc
         from ${tbl}`, [a, b, cc]);
    const x = r.rows[0]!;
    return { total: Number(x.total), a: Number(x.a), b: Number(x.b), cc: Number(x.cc) };
  });
}
// Evaluate a helper under raw claims (owner context — functions are not RLS'd).
async function fnUnder<T>(c: PoolClient, rawClaims: string, expr: string): Promise<T> {
  await c.query('begin');
  try {
    await c.query("select set_config('request.jwt.claims', $1, true)", [rawClaims]);
    return (await c.query(`select ${expr} as v`)).rows[0]!.v as T;
  } finally {
    await c.query('rollback');
  }
}
const sameSet = (got: string[] | null, want: string[]) =>
  (got ?? []).length === want.length && [...(got ?? [])].sort().join(',') === [...want].sort().join(',');

async function main(): Promise<void> {
  const pool = makePool();
  const c = await pool.connect();
  try {
    // ── B0: fixtures + expected counts DERIVED IN-RUN as the table owner ────────
    log('=== B0  fixtures + expected counts derived in-run (no hardcoded baselines) ===');
    // A, B = the two busiest dispatch consignors that ALSO have GP settlement rows AND invoiced
    // loads (so every grower table — incl. core.fact_load_sale, 0054 — asserts non-trivially);
    // C = the busiest consignor distinct from both.
    const fx = await c.query<{ id: string }>(
      `select d.consignor_id as id
         from raw.ft_dispatch_load d
        where d.consignor_id is not null
          and exists (select 1 from core.fact_gp_settlement g where g.consignor_id = d.consignor_id)
          and exists (select 1 from core.fact_settlement_bill s where s.consignor_id = d.consignor_id)
          and exists (select 1 from core.fact_load_sale fl where fl.consignor_id = d.consignor_id)
        group by 1 order by count(*) desc limit 2`);
    if (fx.rows.length < 2) throw new Error('fixture derivation: need 2 consignors with dispatch+GP+NS rows');
    const A = fx.rows[0]!.id, B = fx.rows[1]!.id;
    const fc = await c.query<{ id: string }>(
      `select consignor_id as id from raw.ft_dispatch_load
        where consignor_id is not null and consignor_id <> $1 and consignor_id <> $2
        group by 1 order by count(*) desc limit 1`, [A, B]);
    if (fc.rows.length < 1) throw new Error('fixture derivation: need an unrelated consignor C');
    const C = fc.rows[0]!.id;
    log(`  A=${A} B=${B} C=${C}`);

    const EXPECTED: Record<string, { internal: number; a: number; b: number; c: number }> = {};
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
      log(`  ${t}: internal=${x.internal} A=${x.a} B=${x.b} C=${x.c}`);
    }
    // Non-triviality on EVERY table for BOTH fixture growers — otherwise a B3/B4/B8 row could
    // pass vacuously as 0==0 without exercising the policy (review finding: schedule-grain GP
    // rows do not imply load-grain rows; a load does not imply pallets).
    for (const t of TABLES) {
      check(`fixtures non-trivial on ${t} (A=${EXPECTED[t]!.a}, B=${EXPECTED[t]!.b})`,
        EXPECTED[t]!.a > 0 && EXPECTED[t]!.b > 0);
    }
    // Internal-only fixtures for B6: the gated relations must be non-empty as owner, or the
    // hostile-token 0-count would be indistinguishable from an empty table.
    const internalOwner: Record<string, number> = {};
    for (const rel of ['core.fact_customer_invoice', 'semantic.order_headers']) {
      internalOwner[rel] = Number((await c.query(`select count(*) n from ${rel}`)).rows[0]!.n);
      check(`internal fixture non-trivial: ${rel} owner count > 0`, internalOwner[rel]! > 0, `got ${internalOwner[rel]}`);
    }

    // ── B1: auth0_consignor_ids() semantics ──────────────────────────────────────
    log('\n=== B1  semantic.auth0_consignor_ids() — issuer-pinned, array-only, fail-closed ===');
    const ids = (raw: string) => fnUnder<string[] | null>(c, raw, 'semantic.auth0_consignor_ids()');
    check('auth0 [A,B] → {A,B}', sameSet(await ids(auth0Tok([A, B])), [A, B]));
    check('duplicates de-duplicated', sameSet(await ids(auth0Tok([A, A, B])), [A, B]));
    check('malformed element skipped → {B}', sameSet(await ids(auth0Tok(['not-a-uuid', B])), [B]));
    check('empty array → empty set', sameSet(await ids(auth0Tok([])), []));
    check('claim not an array (string) → empty',
      sameSet(await ids(JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [CLAIM]: A })), []));
    check('WRONG issuer → empty', sameSet(await ids(JSON.stringify({ iss: 'https://evil.example.com/', role: 'authenticated', [CLAIM]: [A] })), []));
    check('Supabase issuer → empty', sameSet(await ids(JSON.stringify({ iss: SUPA_ISS, role: 'authenticated', [CLAIM]: [A] })), []));
    check('MISSING issuer → empty', sameSet(await ids(JSON.stringify({ role: 'authenticated', [CLAIM]: [A] })), []));
    check('issuer without trailing slash → empty',
      sameSet(await ids(JSON.stringify({ iss: 'https://grower-portal.au.auth0.com', role: 'authenticated', [CLAIM]: [A] })), []));
    check('no claims at all → empty', sameSet(await ids(''), []));
    let threw = false; let bad: string[] | null = [];
    try { bad = await ids('{not valid json'); } catch { threw = true; }
    check('malformed claims JSON → empty, never errors', !threw && sameSet(bad, []));
    // mm-hub app_metadata never leaks into the auth0 helper
    check('app_metadata-only token → auth0 helper empty',
      sameSet(await ids(hubTok({ app_metadata: { consignor_ids: [A] } })), []));

    // ── B2: policy shapes — 6 additive auth0 policies; 6 mm-hub policies untouched ──
    log('\n=== B2  policy shapes (additive; mm-hub set untouched) ===');
    const pol = await c.query<{ tbl: string; policyname: string; qual: string; roles: string }>(
      `select schemaname||'.'||tablename tbl, policyname, qual, roles::text roles
         from pg_policies where policyname like 'auth0\\_grower\\_own\\_%' escape '\\' order by tbl`);
    check('exactly 7 auth0_grower_own_* policies (0026 six + 0054 fact_load_sale)', pol.rows.length === 7, `${pol.rows.length} found`);
    check('auth0 policies cover exactly the grower-scoped relation set',
      [...pol.rows.map((p) => p.tbl)].sort().join(',') === [...TABLES].sort().join(','));
    // Pin the mm-hub policy set as exact (tbl, policyname) pairs, not just a count.
    const HUB_POLICY_PAIRS = [
      'core.dim_grower|grower_own_dim',
      'core.fact_gp_settlement|grower_own_gp_settlement',
      'core.fact_gp_settlement_load|grower_own_gp_settlement_load',
      'core.fact_load_sale|grower_own_load_sale',
      'core.fact_settlement_bill|grower_own_settlement',
      'raw.ft_dispatch_load|grower_own_loads',
      'raw.ft_pallet|grower_own_pallets',
    ];
    // Sort BOTH sides in JS — DB text collation orders '|' vs '_' differently than byte order.
    const hubPairs = (await c.query<{ pair: string }>(
      `select schemaname||'.'||tablename||'|'||policyname as pair
         from pg_policies where policyname like 'grower\\_own\\_%' escape '\\'`)).rows.map((r) => r.pair).sort();
    check('mm-hub grower_own_* policies are exactly the pinned seven (table|name pairs)',
      hubPairs.join(',') === [...HUB_POLICY_PAIRS].sort().join(','), hubPairs.join(' '));
    for (const p of pol.rows) {
      const q = p.qual.replace(/\s+/g, ' ');
      check(`${p.policyname}: quals auth0_consignor_ids(), no internal branch, to authenticated`,
        q.includes('auth0_consignor_ids()') && !q.includes('is_internal_claim') && p.roles.includes('authenticated'), q);
    }
    const legacy = await c.query(
      `select count(*) n from pg_policies where policyname like 'grower\\_own\\_%' escape '\\'
        and qual like '%current_consignor_ids()%' and qual like '%is_internal_claim()%'`);
    check('the 7 mm-hub grower_own_* policies remain live and unchanged in shape', Number(legacy.rows[0]!.n) === 7);

    // ── B3: Auth0 single-farm token == owner-derived counts ─────────────────────
    log('\n=== B3  Auth0 [A] token == owner-derived counts; B/C = 0 ===');
    for (const t of TABLES) {
      const bd = await breakdown(c, auth0Tok([A]), t, A, B, C);
      const bl = EXPECTED[t]!;
      check(`${t}: A=${bd.a} B=${bd.b} C=${bd.cc} total=${bd.total}`,
        bd.a === bl.a && bd.b === 0 && bd.cc === 0 && bd.total === bl.a, `(expect A=${bl.a} B=0 C=0 total=${bl.a})`);
    }

    // ── B4: Auth0 multi-farm [A,B] token == A+B only ─────────────────────────────
    log('\n=== B4  Auth0 [A,B] token == A+B rows only ===');
    for (const t of TABLES) {
      const bd = await breakdown(c, auth0Tok([A, B]), t, A, B, C);
      const bl = EXPECTED[t]!;
      check(`${t}: A=${bd.a} B=${bd.b} C=${bd.cc} total=${bd.total}`,
        bd.a === bl.a && bd.b === bl.b && bd.cc === 0 && bd.total === bl.a + bl.b,
        `(expect A=${bl.a} B=${bl.b} C=0 total=${bl.a + bl.b})`);
    }

    // ── B5: forgery fails closed ─────────────────────────────────────────────────
    log('\n=== B5  forgery: the namespaced claim is inert off-issuer ===');
    const wrongIss = JSON.stringify({ iss: 'https://evil.example.com/', role: 'authenticated', [CLAIM]: [A] });
    const supaIss = JSON.stringify({ iss: SUPA_ISS, role: 'authenticated', [CLAIM]: [A] });
    const hubPlusNs = hubTok({ app_metadata: { consignor_ids: [A] }, [CLAIM]: [B] });
    for (const t of TABLES) {
      const w = await count(c, wrongIss, t);
      const s = await count(c, supaIss, t);
      check(`${t}: wrong-iss=0 supabase-iss=0`, w === 0 && s === 0, `wrong=${w} supa=${s}`);
    }
    for (const t of TABLES) {
      const bd = await breakdown(c, hubPlusNs, t, A, B, C);
      const bl = EXPECTED[t]!;
      check(`${t}: mm-hub token + namespaced [B] claim gains NOTHING (A=${bd.a} B=${bd.b})`,
        bd.a === bl.a && bd.b === 0 && bd.cc === 0 && bd.total === bl.a);
    }

    // ── B6: trust partition — Auth0 token with forged app_metadata ──────────────
    log('\n=== B6  trust partition: Auth0-issued app_metadata is refused (0050 guards) ===');
    const hostile = auth0Tok([A], { app_metadata: { consignor_ids: [B], consignor_id: C, is_internal: true } });
    check('is_internal_claim() = false on an Auth0-issued token',
      (await fnUnder<boolean>(c, hostile, 'semantic.is_internal_claim()')) === false);
    check('current_consignor_ids() = {} on an Auth0-issued token',
      sameSet(await fnUnder<string[] | null>(c, hostile, 'semantic.current_consignor_ids()'), []));
    for (const t of TABLES) {
      const bd = await breakdown(c, hostile, t, A, B, C);
      const bl = EXPECTED[t]!;
      check(`${t}: hostile hybrid sees A only (A=${bd.a} B=${bd.b} C=${bd.cc})`,
        bd.a === bl.a && bd.b === 0 && bd.cc === 0 && bd.total === bl.a);
    }
    const internalOnly = await count(c, hostile, 'core.fact_customer_invoice');
    check(`internal-only core.fact_customer_invoice = 0 under the hostile token (owner has ${internalOwner['core.fact_customer_invoice']})`,
      internalOnly === 0, `got ${internalOnly}`);
    const orderView = await count(c, hostile, 'semantic.order_headers');
    check(`internal-gated semantic.order_headers = 0 under the hostile token (owner has ${internalOwner['semantic.order_headers']})`,
      orderView === 0, `got ${orderView}`);
    check('etl-only raw.ft_gp_schedule stays permission-denied',
      (await countOrDenied(c, hostile, 'raw.ft_gp_schedule')) === 'denied');
    check('ungranted semantic.retail_prices stays permission-denied',
      (await countOrDenied(c, hostile, 'semantic.retail_prices')) === 'denied');

    // ── B7: the mm-hub path is untouched ─────────────────────────────────────────
    log('\n=== B7  mm-hub path untouched (no-iss + supabase-iss app_metadata tokens) ===');
    for (const t of TABLES) {
      const bl = EXPECTED[t]!;
      const noIss = await count(c, hubTok({ app_metadata: { consignor_ids: [A] } }), t);
      const withIss = await count(c, JSON.stringify({ iss: SUPA_ISS, role: 'authenticated', app_metadata: { consignor_ids: [A] } }), t);
      const internal = await count(c, hubTok({ app_metadata: { is_internal: true } }), t);
      const noClaim = await count(c, null, t);
      check(`${t}: no-iss=${noIss} supa-iss=${withIss} internal=${internal} no-claim=${noClaim}`,
        noIss === bl.a && withIss === bl.a && internal === bl.internal && noClaim === 0,
        `(expect A=${bl.a} internal=${bl.internal} no-claim=0)`);
    }
    check('internal via supabase iss still true',
      (await fnUnder<boolean>(c, JSON.stringify({ iss: SUPA_ISS, app_metadata: { is_internal: true } }), 'semantic.is_internal_claim()')) === true);
    check('internal via no-iss claims (Cube/MCP shape) still true',
      (await fnUnder<boolean>(c, JSON.stringify({ app_metadata: { is_internal: true } }), 'semantic.is_internal_claim()')) === true);
    // Legacy SCALAR app_metadata.consignor_id (the 0026 backward-compat branch) still scopes —
    // the 0050 helper recreation must not have dropped it (rls:multifarm also covers this).
    const legacyScalar = await count(c, hubTok({ app_metadata: { consignor_id: A } }), 'raw.ft_dispatch_load');
    check('legacy scalar consignor_id token still scopes exactly', legacyScalar === EXPECTED['raw.ft_dispatch_load']!.a,
      `got ${legacyScalar}, expect ${EXPECTED['raw.ft_dispatch_load']!.a}`);

    // ── B8: identity parity across every grower-facing semantic view ─────────────
    log('\n=== B8  grower views: Auth0 [A,B] == mm-hub app_metadata [A,B] (identical counts) ===');
    let viewRowSum = 0;
    for (const v of GROWER_VIEWS) {
      const viaAuth0 = await count(c, auth0Tok([A, B]), v);
      const viaHub = await count(c, hubTok({ app_metadata: { consignor_ids: [A, B] } }), v);
      viewRowSum += viaAuth0;
      check(`${v}: auth0=${viaAuth0} hub=${viaHub}`, viaAuth0 === viaHub);
    }
    check('view parity is non-trivial (rows > 0 across the grower views)', viewRowSum > 0, `sum=${viewRowSum}`);

    // ── S1: auth0_is_staff() semantics — strict boolean, issuer-pinned, fail-closed ─────────
    log('\n=== S1  semantic.auth0_is_staff() — strict boolean-true, issuer-pinned (0056) ===');
    const staff = (raw: string) => fnUnder<boolean>(c, raw, 'semantic.auth0_is_staff()');
    check('staff=true on the Auth0 issuer → true', (await staff(staffTok())) === true);
    check('staff="true" (string) → false',
      (await staff(JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [STAFF]: 'true' }))) === false);
    check('staff=1 (number) → false',
      (await staff(JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [STAFF]: 1 }))) === false);
    check('staff=false → false',
      (await staff(JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [STAFF]: false }))) === false);
    check('staff=[true] (array) → false',
      (await staff(JSON.stringify({ iss: AUTH0_ISS, role: 'authenticated', [STAFF]: [true] }))) === false);
    check('claim absent → false', (await staff(auth0Tok([]))) === false);
    check('WRONG issuer → false',
      (await staff(JSON.stringify({ iss: 'https://evil.example.com/', role: 'authenticated', [STAFF]: true }))) === false);
    check('Supabase issuer → false',
      (await staff(JSON.stringify({ iss: SUPA_ISS, role: 'authenticated', [STAFF]: true }))) === false);
    check('MISSING issuer → false',
      (await staff(JSON.stringify({ role: 'authenticated', [STAFF]: true }))) === false);
    check('issuer without trailing slash → false',
      (await staff(JSON.stringify({ iss: 'https://grower-portal.au.auth0.com', role: 'authenticated', [STAFF]: true }))) === false);
    check('app_metadata.mm_staff (un-namespaced source form) → false',
      (await staff(auth0Tok([], { app_metadata: { mm_staff: true } }))) === false);
    check('mm-hub internal token → false (staff is Auth0-issuer-only)',
      (await staff(hubTok({ app_metadata: { is_internal: true } }))) === false);
    check('no claims at all → false', (await staff('')) === false);
    let sThrew = false; let sBad = true;
    try { sBad = await staff('{not valid json'); } catch { sThrew = true; }
    check('malformed claims JSON → false, never errors', !sThrew && sBad === false);

    // ── S2: staff policy pins — additive third set; B2's pins already re-asserted above ──────
    log('\n=== S2  policy shapes: exactly 7 auth0_staff_read_* (0056), quals the helper ALONE ===');
    const spol = await c.query<{ tbl: string; policyname: string; qual: string; roles: string }>(
      `select schemaname||'.'||tablename tbl, policyname, qual, roles::text roles
         from pg_policies where policyname like 'auth0\\_staff\\_read\\_%' escape '\\' order by tbl`);
    check('exactly 7 auth0_staff_read_* policies', spol.rows.length === 7, `${spol.rows.length} found`);
    check('staff policies cover exactly the grower-scoped relation set',
      [...spol.rows.map((p) => p.tbl)].sort().join(',') === [...TABLES].sort().join(','));
    for (const p of spol.rows) {
      const q = p.qual.replace(/\s+/g, ' ').trim();
      check(`${p.policyname}: qual is exactly semantic.auth0_is_staff(), to authenticated`,
        q === 'semantic.auth0_is_staff()' && p.roles.includes('authenticated'), q);
    }

    // ── S3: staff token reads ALL rows; hybrid staff+grower = same (policy OR) ───────────────
    log('\n=== S3  staff token == owner-derived totals on all 7 relations + view parity ===');
    for (const t of TABLES) {
      const n = await count(c, staffTok(), t);
      check(`${t}: staff=${n}`, n === EXPECTED[t]!.internal, `(expect ${EXPECTED[t]!.internal})`);
    }
    for (const v of GROWER_VIEWS) {
      const viaStaff = await count(c, staffTok(), v);
      const viaInternal = await count(c, hubTok({ app_metadata: { is_internal: true } }), v);
      check(`${v}: staff=${viaStaff} == mm-hub internal=${viaInternal}`, viaStaff === viaInternal);
    }
    const hybrid = await count(c, staffTok({ [CLAIM]: [A] }), 'raw.ft_dispatch_load');
    check('staff + grower [A] hybrid token still reads ALL loads (policies OR)',
      hybrid === EXPECTED['raw.ft_dispatch_load']!.internal, `got ${hybrid}`);

    // ── S4: staff ≠ internal — the claim never opens internal-only surfaces ──────────────────
    log('\n=== S4  staff ≠ internal: internal-only stays closed under a staff token ===');
    const staffInternalOnly = await count(c, staffTok(), 'core.fact_customer_invoice');
    check(`internal-only core.fact_customer_invoice = 0 under staff (owner has ${internalOwner['core.fact_customer_invoice']})`,
      staffInternalOnly === 0, `got ${staffInternalOnly}`);
    const staffOrders = await count(c, staffTok(), 'semantic.order_headers');
    check(`internal-gated semantic.order_headers = 0 under staff (owner has ${internalOwner['semantic.order_headers']})`,
      staffOrders === 0, `got ${staffOrders}`);
    check('is_internal_claim() = false under a staff token',
      (await fnUnder<boolean>(c, staffTok(), 'semantic.is_internal_claim()')) === false);
    check('etl-only raw.ft_gp_schedule stays permission-denied under staff',
      (await countOrDenied(c, staffTok(), 'raw.ft_gp_schedule')) === 'denied');
    check('ungranted semantic.retail_prices stays permission-denied under staff',
      (await countOrDenied(c, staffTok(), 'semantic.retail_prices')) === 'denied');

    // ── S5: grower_directory — staff-only; everyone else gets ZERO rows ──────────────────────
    log('\n=== S5  semantic.grower_directory: staff-only (explicit gate) ===');
    const dirOwner = Number((await c.query(
      `select count(*) n from core.dim_grower
        where is_grower is true and coalesce(is_test, false) = false`)).rows[0]!.n);
    check('directory owner-derived expectation is non-trivial', dirOwner > 0, `${dirOwner} growers`);
    const dirStaff = await count(c, staffTok(), 'semantic.grower_directory');
    check(`staff token sees the full directory (${dirStaff})`, dirStaff === dirOwner, `(expect ${dirOwner})`);
    const dirGrower = await count(c, auth0Tok([A]), 'semantic.grower_directory');
    check('grower [A] token → 0 directory rows (no enumeration)', dirGrower === 0, `got ${dirGrower}`);
    const dirInternal = await count(c, hubTok({ app_metadata: { is_internal: true } }), 'semantic.grower_directory');
    check('mm-hub internal token → 0 directory rows (gate is staff-claim-only, deliberate)',
      dirInternal === 0, `got ${dirInternal}`);
    const dirNoClaim = await count(c, null, 'semantic.grower_directory');
    check('no-claim token → 0 directory rows', dirNoClaim === 0, `got ${dirNoClaim}`);
    const dirForged = await count(
      c, JSON.stringify({ iss: SUPA_ISS, role: 'authenticated', [STAFF]: true }), 'semantic.grower_directory');
    check('Supabase-iss token carrying the staff claim → 0 directory rows', dirForged === 0, `got ${dirForged}`);

    const failed = results.filter((r) => !r.pass);
    log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { log('FAILED: ' + failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    // Report is written even when a section threw — partial evidence beats none.
    try {
      mkdirSync('reports', { recursive: true });
      const path = `reports/auth0_rls_proof_${new Date().toISOString().slice(0, 10)}.txt`;
      writeFileSync(path, lines.join('\n') + '\n');
      console.log(`report: ${path}`);
    } catch (we) {
      console.error('report write failed:', we instanceof Error ? we.message : we);
    }
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('proof error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
