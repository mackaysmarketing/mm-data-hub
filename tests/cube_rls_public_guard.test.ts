import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// RLS regression guard: a tenant-data base cube must be UNREACHABLE unless it is
// scoped. Cube's queryRewrite (cube/cube.js) only appends a tenant filter to objects
// whose prefix is a key in VIEW_GROWER_KEYS — i.e. the governed VIEWS. A BASE CUBE
// (e.g. dispatch_shipped_pallets) carries grower_key rows but is NOT a VIEW_GROWER_KEYS
// key, so queryRewrite adds NO scope filter to it. The ONLY thing keeping such a cube
// ungated-but-unreachable is `public: false` (Cube refuses to serve a hidden member).
// If a future edit flips one to public:true (or adds a new base cube and forgets
// public:false), a grower could query it unscoped and read every tenant's rows.
//
// This test DERIVES the at-risk set (any cube with a grower_key dimension whose name is
// not itself a VIEW_GROWER_KEYS anchor) — it does NOT hardcode a list, so a NEW base cube
// added later that forgets public:false is caught automatically. Test + read-only; no deps
// beyond node:fs (the model files are flat YAML lists, parsed with targeted regex).
// ─────────────────────────────────────────────────────────────────────────────

const cubesDir = fileURLToPath(new URL('../cube/model/cubes', import.meta.url));
const cubeJsPath = fileURLToPath(new URL('../cube/cube.js', import.meta.url));

/** The view names registered in cube.js VIEW_GROWER_KEYS — the ONLY prefixes queryRewrite scopes. */
function readViewGrowerKeys(): Set<string> {
  const src = readFileSync(cubeJsPath, 'utf8');
  const block = src.match(/const\s+VIEW_GROWER_KEYS\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'could not locate VIEW_GROWER_KEYS object in cube.js');
  const keys = new Set<string>();
  for (const m of (block[1] ?? '').matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) { if (m[1]) keys.add(m[1]); }
  return keys;
}

interface CubeBlock {
  name: string;
  file: string;
  exposesTenantData: boolean;
  publicValue: 'false' | 'true' | 'absent';
}

/** Parse every top-level cube out of one cube YAML file (no YAML dep — the files are flat lists). */
function parseCubes(file: string, text: string): CubeBlock[] {
  const lines = text.split(/\r?\n/);
  // Top-level cube list items live at exactly 2-space indent: "  - name: <cube>".
  const starts: { idx: number; name: string }[] = [];
  lines.forEach((ln, i) => {
    const m = ln.match(/^ {2}- name:\s*(\S+)\s*$/);
    if (m && m[1]) starts.push({ idx: i, name: m[1] });
  });
  return starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.idx : lines.length;
    const body = lines.slice(s.idx, end);
    // grower_key as a NESTED member (indent >= 4 spaces) = the tenant anchor / tenant-row exposure.
    const exposesTenantData = body.some((ln) => /^\s{4,}- name:\s*grower_key\b/.test(ln));
    // Cube-LEVEL public is at exactly 4-space indent (member-level public sits deeper at 8). A
    // trailing "# ..." comment is allowed. Absence of the line ⇒ Cube's default of public:true.
    let publicValue: 'false' | 'true' | 'absent' = 'absent';
    for (const ln of body) {
      const pm = ln.match(/^ {4}public:\s*(false|true)\b/);
      if (pm) { publicValue = pm[1] as 'false' | 'true'; break; }
    }
    return { name: s.name, file, exposesTenantData, publicValue };
  });
}

function allBaseCubes(): CubeBlock[] {
  return readdirSync(cubesDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .flatMap((f) => parseCubes(f, readFileSync(join(cubesDir, f), 'utf8')));
}

test('VIEW_GROWER_KEYS still anchors the known governed views', () => {
  const keys = readViewGrowerKeys();
  for (const v of ['dispatch', 'dispatch_shipped', 'settlement', 'gp_settlement', 'gp_settlement_load']) {
    assert.ok(keys.has(v), `VIEW_GROWER_KEYS is missing the RLS anchor for view "${v}"`);
  }
});

test('every tenant-data base cube not anchored in VIEW_GROWER_KEYS is public:false', () => {
  const anchored = readViewGrowerKeys();
  const cubes = allBaseCubes();

  // Parser self-test — never let a broken parse make this guard pass vacuously.
  assert.ok(cubes.length >= 6, `parsed only ${cubes.length} cubes from cube/model/cubes — parser likely broken`);
  const tenantBaseCubes = cubes.filter((c) => c.exposesTenantData && !anchored.has(c.name));
  assert.ok(
    tenantBaseCubes.some((c) => c.name === 'dispatch_shipped_pallets') &&
      tenantBaseCubes.some((c) => c.name === 'dispatch_loads'),
    `tenant base-cube detection failed — grower_key parsing is broken (found: ${tenantBaseCubes.map((c) => c.name).join(', ') || 'none'})`,
  );

  // THE GUARD: a base cube carrying grower_key whose prefix queryRewrite never scopes
  // (not a VIEW_GROWER_KEYS key) MUST be unreachable, i.e. public:false.
  const offenders = tenantBaseCubes
    .filter((c) => c.publicValue !== 'false')
    .map((c) => `${c.file}: cube "${c.name}" is public:${c.publicValue}`);

  assert.deepEqual(
    offenders,
    [],
    'RLS HOLE — a base cube exposes grower_key, is NOT registered in cube.js VIEW_GROWER_KEYS (so ' +
      'queryRewrite appends no tenant filter), yet is not public:false. A grower could query it ' +
      'unscoped and read every tenant\'s rows. Fix: set public:false on the cube, OR add a ' +
      `VIEW_GROWER_KEYS anchor for it in cube/cube.js. Offenders:\n  ${offenders.join('\n  ')}`,
  );
});
