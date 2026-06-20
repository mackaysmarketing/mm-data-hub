// ─────────────────────────────────────────────────────────────────────────────
// Cube RLS proof — three security contexts + adversarial forgery checks.
//
//   npm run cube:rls         (needs CUBE_API_URL + CUBE_API_SECRET in .env)
//
// Proves, against the LIVE deployed `dispatch` view:
//   • grower A (MMLAR) sees ONLY its own rows
//   • grower B (MMTRU) sees ONLY its own rows (disjoint from A)
//   • internal (app_metadata.is_internal) sees ALL rows
//   • no filter/dimension selection can widen a grower's scope
//   • fail-closed: no claim → 0 rows
//   • app_metadata-only contract (matches DB migration 0010): a FORGED top-level
//     is_internal / consignor_id is ignored → 0 rows
//
// Exit code 0 = all assertions pass; 1 = any failure.
// ─────────────────────────────────────────────────────────────────────────────
import { cubeLoad, scalar, ctxInternal, ctxGrower, GROWER_A, GROWER_B } from './cube_lib.ts';
import type { SecurityContext } from './cube_lib.ts';

const PALLETS = 'dispatch.pallet_count';
const LOADS = 'dispatch.load_count';
const GK = 'dispatch.grower_key';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

const eq = (member: string, value: string) => ({ member, operator: 'equals', values: [value] });
const noAccess = (v: number | null): boolean => v === null || v === 0;

async function distinctGrowers(ctx: SecurityContext): Promise<string[]> {
  const rows = await cubeLoad({ dimensions: [GK], measures: [PALLETS] }, ctx);
  return rows.map((r) => String(r[GK])).sort();
}

async function main(): Promise<void> {
  console.log('=== Cube RLS proof (live dispatch view) ===\n');

  // ── Context totals ─────────────────────────────────────────────────────────
  const internalPallets = await scalar(PALLETS, ctxInternal);
  const internalLoads = await scalar(LOADS, ctxInternal);
  const aPallets = await scalar(PALLETS, ctxGrower(GROWER_A.id));
  const bPallets = await scalar(PALLETS, ctxGrower(GROWER_B.id));
  console.log(
    `internal: ${internalPallets} pallets / ${internalLoads} loads | ` +
      `A(${GROWER_A.code}): ${aPallets} | B(${GROWER_B.code}): ${bPallets}\n`,
  );

  check('internal sees data', (internalPallets ?? 0) > 0, `internal pallet_count=${internalPallets}`);

  // ── Scope correctness: grower == internal-filtered-to-that-grower ────────────
  const internalFilteredToA = await scalar(PALLETS, ctxInternal, { filters: [eq(GK, GROWER_A.id)] });
  const internalFilteredToB = await scalar(PALLETS, ctxInternal, { filters: [eq(GK, GROWER_B.id)] });
  check(
    'grower A scope is exact',
    aPallets === internalFilteredToA && (aPallets ?? 0) > 0,
    `A=${aPallets} vs internal|A=${internalFilteredToA}`,
  );
  check(
    'grower B scope is exact',
    bPallets === internalFilteredToB && (bPallets ?? 0) > 0,
    `B=${bPallets} vs internal|B=${internalFilteredToB}`,
  );

  // ── Each grower sees ONLY its own grower_key (dimension can't widen scope) ───
  const gA = await distinctGrowers(ctxGrower(GROWER_A.id));
  const gB = await distinctGrowers(ctxGrower(GROWER_B.id));
  const gInternal = await distinctGrowers(ctxInternal);
  check('grower A sees only itself', gA.length === 1 && gA[0] === GROWER_A.id, `grower_keys=${JSON.stringify(gA)}`);
  check('grower B sees only itself', gB.length === 1 && gB[0] === GROWER_B.id, `grower_keys=${JSON.stringify(gB)}`);
  check('internal sees many growers', gInternal.length > 1, `${gInternal.length} distinct grower_keys`);
  check(
    'A and B are disjoint',
    GROWER_A.id !== GROWER_B.id && !gA.includes(GROWER_B.id) && !gB.includes(GROWER_A.id),
    'no shared grower_key',
  );

  // ── Adversarial: grower A tries to FILTER its way into B's rows ──────────────
  const aTriesB = await scalar(PALLETS, ctxGrower(GROWER_A.id), { filters: [eq(GK, GROWER_B.id)] });
  check('filter cannot widen scope (A→B = 0)', noAccess(aTriesB), `A filtered to B = ${aTriesB}`);

  // ── Fail-closed: no claim at all ────────────────────────────────────────────
  const noClaim = await scalar(PALLETS, {});
  check('no-claim is fail-closed', noAccess(noClaim), `pallet_count=${noClaim}`);

  // ── app_metadata-only contract: forged TOP-LEVEL claims are ignored ─────────
  const forgedInternal = await scalar(PALLETS, { is_internal: true } as SecurityContext);
  check('forged top-level is_internal → 0', noAccess(forgedInternal), `pallet_count=${forgedInternal}`);
  const forgedConsignor = await scalar(PALLETS, { consignor_id: GROWER_A.id } as SecurityContext);
  check('forged top-level consignor_id → 0', noAccess(forgedConsignor), `pallet_count=${forgedConsignor}`);

  // ── Sanity: parts don't exceed the whole ────────────────────────────────────
  check(
    'A + B ≤ internal total',
    (aPallets ?? 0) + (bPallets ?? 0) <= (internalPallets ?? 0),
    `${aPallets} + ${bPallets} ≤ ${internalPallets}`,
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('RLS proof error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
