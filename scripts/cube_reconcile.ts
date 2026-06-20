// ─────────────────────────────────────────────────────────────────────────────
// Cube parity reconciliation — every measure vs a direct SQL aggregate over raw/core.
//
//   npm run cube:reconcile     (CUBE_API_URL + CUBE_API_SECRET, and DATABASE_URL for the
//                               SQL side; without DATABASE_URL it prints the Cube side only)
//
// Reconciles load_count / pallet_count / net_weight_dispatched / line_count:
//   • overall   • by grower (grower_key)   • by pack_week
// plus produce capture rates by crop. Counts must match EXACTLY; net weight within 0.01 kg.
// Null integrity: a null measure (e.g. all-null net weight) must stay null on BOTH sides —
// never coalesced to 0. Variances are LOGGED, not hidden. Writes reports/reconciliation_cube_<date>.md.
// Exit 0 = within tolerance; 1 = any variance (when the SQL side ran).
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { cubeLoad, ctxInternal } from './cube_lib.ts';

// SQL side connects on the READ-ONLY Cube role (CUBE_DB_URL), falling back to DATABASE_URL.
// Keeping it separate from the loaders' (write) DATABASE_URL means a read-only URL here can
// never be mistaken for a loader connection.
const SQL_URL = process.env.CUBE_DB_URL || process.env.DATABASE_URL || '';

const BAKED = `d.order_type = 'S' AND d.actual_pickup_on IS NOT NULL AND COALESCE(g.is_test, false) = false`;
const PACK_WEEK = `CASE WHEN d.extra_text_2 ~ '^Y[0-9][0-9]W[0-9][0-9]$' THEN d.extra_text_2 END`;
const NULLKEY = '∅(null)';
const WEIGHT_TOL = 0.01;

type Num = number | null;
const toNum = (v: unknown): Num => (v == null ? null : Number(v));
const key = (v: unknown): string => (v == null ? NULLKEY : String(v));
const M = (rec: Record<string, Map<string, Num>>, k: string): Map<string, Num> => rec[k] ?? new Map<string, Num>();

interface Line { scope: string; group: string; cube: Num; sql: Num; ok: boolean; note: string }

// ── Cube side ────────────────────────────────────────────────────────────────
async function cubeMap(measure: string, dim?: string): Promise<Map<string, Num>> {
  const rows = await cubeLoad({ measures: [measure], dimensions: dim ? [dim] : [] }, ctxInternal);
  const m = new Map<string, Num>();
  for (const r of rows) m.set(dim ? key(r[dim]) : 'overall', toNum(r[measure]));
  return m;
}

// ── SQL side (pg) ──────────────────────────────────────────────────────────────
async function sqlMaps(): Promise<Record<string, Map<string, Num>>> {
  const pool = new pg.Pool({ connectionString: SQL_URL, ssl: { rejectUnauthorized: false }, max: 4 });
  const out: Record<string, Map<string, Num>> = {};
  const run = async (name: string, sql: string, keyCol: string, valCol: string) => {
    const res = await pool.query(sql);
    const m = new Map<string, Num>();
    for (const row of res.rows) m.set(key(row[keyCol]), toNum(row[valCol]));
    out[name] = m;
  };
  const loadsFrom = `FROM raw.ft_dispatch_load d JOIN core.dim_grower g ON g.consignor_id = d.consignor_id WHERE ${BAKED}`;
  const palletsFrom = `FROM raw.ft_pallet p JOIN raw.ft_dispatch_load d ON d.id = p.dispatch_load_id JOIN core.dim_grower g ON g.consignor_id = d.consignor_id WHERE ${BAKED}`;
  const lineExpr = `count(distinct p.dispatch_load_id::text || ':' || coalesce(p.product_id::text, '__nullpid__'))`;

  // overall
  await run('load_count|overall', `SELECT 'overall' k, count(distinct d.id) v ${loadsFrom}`, 'k', 'v');
  await run('pallet_count|overall', `SELECT 'overall' k, count(*) v ${palletsFrom}`, 'k', 'v');
  await run('net_weight_dispatched|overall', `SELECT 'overall' k, sum(p.net_weight_value) v ${palletsFrom}`, 'k', 'v');
  await run('line_count|overall', `SELECT 'overall' k, ${lineExpr} v ${palletsFrom}`, 'k', 'v');
  // by grower
  await run('load_count|grower', `SELECT d.consignor_id::text k, count(distinct d.id) v ${loadsFrom} GROUP BY 1`, 'k', 'v');
  await run('pallet_count|grower', `SELECT d.consignor_id::text k, count(*) v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  await run('net_weight_dispatched|grower', `SELECT d.consignor_id::text k, sum(p.net_weight_value) v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  await run('line_count|grower', `SELECT d.consignor_id::text k, ${lineExpr} v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  // by pack_week
  await run('load_count|pack_week', `SELECT ${PACK_WEEK} k, count(distinct d.id) v ${loadsFrom} GROUP BY 1`, 'k', 'v');
  await run('pallet_count|pack_week', `SELECT ${PACK_WEEK} k, count(*) v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  await run('net_weight_dispatched|pack_week', `SELECT ${PACK_WEEK} k, sum(p.net_weight_value) v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  await run('line_count|pack_week', `SELECT ${PACK_WEEK} k, ${lineExpr} v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  // capture by crop
  await run('capture|crop_pallets', `SELECT p.crop_description k, count(*) v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  await run('capture|crop_withwt', `SELECT p.crop_description k, count(p.net_weight_value) v ${palletsFrom} GROUP BY 1`, 'k', 'v');
  await run('net_weight_dispatched|crop', `SELECT p.crop_description k, sum(p.net_weight_value) v ${palletsFrom} GROUP BY 1`, 'k', 'v');

  await pool.end();
  return out;
}

function compare(scope: string, measure: string, cube: Map<string, Num>, sql: Map<string, Num>): Line[] {
  const lines: Line[] = [];
  const isWeight = measure.includes('net_weight');
  for (const g of new Set([...cube.keys(), ...sql.keys()])) {
    const c = cube.get(g) ?? null;
    const s = sql.has(g) ? sql.get(g)! : null;
    let ok: boolean;
    let note = '';
    if (c === null || s === null) {
      ok = c === null && s === null;
      if (ok && c === null) note = 'null on both (not coalesced) ✓';
      else note = `null mismatch cube=${c} sql=${s}`;
    } else if (isWeight) {
      ok = Math.abs(c - s) <= WEIGHT_TOL;
      if (!ok) note = `Δ=${(c - s).toFixed(3)}`;
    } else {
      ok = c === s;
      if (!ok) note = `Δ=${c - s}`;
    }
    lines.push({ scope: `${measure}|${scope}`, group: g, cube: c, sql: s, ok, note });
  }
  return lines;
}

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const hasDb = !!SQL_URL && !SQL_URL.includes('REPLACE');

  console.log('=== Cube parity reconciliation (internal/unscoped context) ===\n');

  const measures = ['load_count', 'pallet_count', 'net_weight_dispatched', 'line_count'];
  const cube: Record<string, Map<string, Num>> = {};
  for (const m of measures) {
    cube[`${m}|overall`] = await cubeMap(`dispatch.${m}`);
    cube[`${m}|grower`] = await cubeMap(`dispatch.${m}`, 'dispatch.grower_key');
    cube[`${m}|pack_week`] = await cubeMap(`dispatch.${m}`, 'dispatch.pack_week');
  }
  const capPallets = await cubeMap('dispatch.pallet_count', 'dispatch.crop');
  const capWithWt = await cubeMap('dispatch.pallets_with_net_weight', 'dispatch.crop');
  const capNetWeight = await cubeMap('dispatch.net_weight_dispatched', 'dispatch.crop');
  cube['net_weight_dispatched|crop'] = capNetWeight;

  // Mixed-grain: all 4 measures (load grain + pallet grain) in ONE query must not inflate via
  // the one-to-many join — validates the dispatch_loads-rooted view.
  const mixedRow = (await cubeLoad({ measures: measures.map((m) => `dispatch.${m}`) }, ctxInternal))[0] || {};

  console.log('Cube overall:',
    measures.map((m) => `${m}=${M(cube, `${m}|overall`).get('overall')}`).join('  '));

  if (!hasDb) {
    console.log('\nDATABASE_URL not set → SQL side skipped. Cube-side numbers above.');
    console.log('Set DATABASE_URL to run the full automated diff + write the report.');
    return;
  }

  const sql = await sqlMaps();
  const allLines: Line[] = [];
  for (const m of measures) {
    for (const scope of ['overall', 'grower', 'pack_week']) {
      allLines.push(...compare(scope, m, M(cube, `${m}|${scope}`), M(sql, `${m}|${scope}`)));
    }
  }

  // Null integrity at crop grain: net_weight SUM over an all-null crop (Mango) must stay NULL on
  // BOTH sides (count()=0 is a different op from sum()=null, so this is the real null-coalesce test).
  allLines.push(...compare('crop', 'net_weight_dispatched', M(cube, 'net_weight_dispatched|crop'), M(sql, 'net_weight_dispatched|crop')));

  // Mixed-grain: a single query combining load-grain + pallet-grain measures must equal each
  // measure's standalone raw aggregate (no join fan-out).
  for (const m of measures) {
    const combined = mixedRow[`dispatch.${m}`] == null ? null : Number(mixedRow[`dispatch.${m}`]);
    const s = M(sql, `${m}|overall`).get('overall') ?? null;
    const isW = m.includes('net_weight');
    const ok = combined === null || s === null ? combined === s : isW ? Math.abs(combined - s) <= WEIGHT_TOL : combined === s;
    allLines.push({ scope: `${m}|mixed_grain`, group: 'all-4-in-one-query', cube: combined, sql: s, ok, note: ok ? 'no join fan-out ✓' : 'JOIN INFLATION' });
  }

  const fails = allLines.filter((l) => !l.ok);
  const byScope = (s: string) => allLines.filter((l) => l.scope.endsWith(`|${s}`));

  // Capture-rate table (Cube vs SQL).
  const crops = new Set([...capPallets.keys(), ...M(sql, 'capture|crop_pallets').keys()]);
  const capRows: string[] = [];
  for (const c of crops) {
    const cp = capPallets.get(c) ?? 0;
    const cw = capWithWt.get(c) ?? 0;
    const cn = capNetWeight.get(c) ?? null;                       // cube net-weight SUM (null if all-null)
    const sp = M(sql, 'capture|crop_pallets').get(c) ?? 0;
    const sw = M(sql, 'capture|crop_withwt').get(c) ?? 0;
    const sn = M(sql, 'net_weight_dispatched|crop').get(c) ?? null;
    const rate = cp ? ((cw as number) / (cp as number) * 100).toFixed(1) : '—';
    const nwOk = cn === null || sn === null ? cn === sn : Math.abs((cn as number) - (sn as number)) <= WEIGHT_TOL;
    const nwDisp = cn === null ? '**null**' : cn;
    capRows.push(`| ${c} | ${cp} | ${cw} | ${nwDisp} | ${rate}% | ${cp === sp && cw === sw && nwOk ? '✓' : '✗'} |`);
  }

  const md = [
    `# Cube reconciliation — dispatch measures vs raw SQL`,
    ``,
    `Date: ${date}  ·  Context: internal/unscoped  ·  Project: data_hub (uqzfkhsdyeokwnkpcxui)`,
    `Baked-in filters: order_type='S' (Sell), actual_pickup_on not null, non-test consignor.`,
    ``,
    `## Result: ${fails.length === 0 ? '✅ all measures reconcile within tolerance' : `⚠️ ${fails.length} variance(s) — see below`}`,
    ``,
    `| Measure | Overall (Cube = SQL) | by-grower groups | by-pack_week groups |`,
    `|---|---|---|---|`,
    ...measures.map((m) => {
      const o = M(cube, `${m}|overall`).get('overall');
      const gFails = byScope('grower').filter((l) => l.scope.startsWith(m) && !l.ok).length;
      const wFails = byScope('pack_week').filter((l) => l.scope.startsWith(m) && !l.ok).length;
      const gN = M(cube, `${m}|grower`).size;
      const wN = M(cube, `${m}|pack_week`).size;
      return `| \`${m}\` | ${o} = ${M(sql, `${m}|overall`).get('overall')} | ${gN - gFails}/${gN} match | ${wN - wFails}/${wN} match |`;
    }),
    ``,
    `## Produce capture rate (null integrity — nulls excluded, never 0)`,
    `net_weight_kg is the SUM; **null** (e.g. Mango — sold by count) proves the sum is NOT coalesced to 0.`,
    `| crop | pallets | with net_weight | net_weight_kg | capture | Cube=SQL |`,
    `|---|---|---|---|---|---|`,
    ...capRows,
    ``,
    fails.length
      ? `## Variances (logged, not hidden)\n` +
        fails.map((f) => `- \`${f.scope}\` group=${f.group}: cube=${f.cube} sql=${f.sql} (${f.note})`).join('\n')
      : `## Variances\nNone — every measure matched on every group (counts exact, net weight within ${WEIGHT_TOL} kg).`,
    ``,
  ].join('\n');

  const path = `reports/reconciliation_cube_${date}.md`;
  writeFileSync(path, md);
  console.log(`\n${allLines.length - fails.length}/${allLines.length} group comparisons match. Report: ${path}`);
  if (fails.length) {
    console.log('Variances:', fails.slice(0, 20).map((f) => `${f.scope}/${f.group} ${f.note}`).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Reconcile error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
