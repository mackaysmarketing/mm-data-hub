// Schema-diff watcher (SPRINT / SPEC §8). Re-introspects FreshTrack, normalises to
// { typeName: { fieldName: typeString } }, and diffs against the stored snapshot, flagging
// added / removed / type-changed fields before they break a loader.
//
//   npm run schema:snapshot   # --init: write references/freshtrack-schema.snapshot.json
//   npm run schema:diff        # diff live schema vs the snapshot; exit 1 if changed
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gql } from './lib/freshtrack.ts';
import { isMain, log } from './lib/util.ts';

const SNAPSHOT_PATH = 'references/freshtrack-schema.snapshot.json';

export type Snapshot = Record<string, Record<string, string>>;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}
interface Field {
  name: string;
  type: TypeRef;
}
interface FullType {
  kind: string;
  name: string | null;
  fields: Field[] | null;
  inputFields: Field[] | null;
  enumValues: { name: string }[] | null;
}

const INTROSPECTION = `query Introspect {
  __schema { types {
    kind name
    fields(includeDeprecated:true){ name type { ...Tr } }
    inputFields { name type { ...Tr } }
    enumValues(includeDeprecated:true){ name }
  } }
}
fragment Tr on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

function renderType(t: TypeRef | null): string {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${renderType(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${renderType(t.ofType)}]`;
  return t.name ?? '?';
}

export function normalize(types: FullType[]): Snapshot {
  const snap: Snapshot = {};
  for (const t of types) {
    if (!t.name || t.name.startsWith('__')) continue;
    const fields = t.fields ?? t.inputFields;
    if (fields) {
      const m: Record<string, string> = {};
      for (const f of fields) m[f.name] = renderType(f.type);
      snap[t.name] = m;
    } else if (t.enumValues) {
      const m: Record<string, string> = {};
      for (const v of t.enumValues) m[v.name] = 'ENUM_VALUE';
      snap[t.name] = m;
    }
  }
  return snap;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const data = await gql<{ __schema: { types: FullType[] } }>(INTROSPECTION);
  return normalize(data.__schema.types);
}

export interface Diff {
  addedTypes: string[];
  removedTypes: string[];
  addedFields: string[]; // "Type.field: T"
  removedFields: string[];
  changedFields: string[]; // "Type.field: old → new"
}

export function diffSnapshots(prev: Snapshot, next: Snapshot): Diff {
  const d: Diff = { addedTypes: [], removedTypes: [], addedFields: [], removedFields: [], changedFields: [] };
  for (const t of Object.keys(next)) if (!(t in prev)) d.addedTypes.push(t);
  for (const t of Object.keys(prev)) if (!(t in next)) d.removedTypes.push(t);
  for (const t of Object.keys(next)) {
    if (!(t in prev)) continue;
    const pf = prev[t] as Record<string, string>;
    const nf = next[t] as Record<string, string>;
    for (const f of Object.keys(nf)) {
      if (!(f in pf)) d.addedFields.push(`${t}.${f}: ${nf[f]}`);
      else if (pf[f] !== nf[f]) d.changedFields.push(`${t}.${f}: ${pf[f]} → ${nf[f]}`);
    }
    for (const f of Object.keys(pf)) if (!(f in nf)) d.removedFields.push(`${t}.${f}: ${pf[f]}`);
  }
  return d;
}

export function hasChanges(d: Diff): boolean {
  return (
    d.addedTypes.length + d.removedTypes.length + d.addedFields.length +
      d.removedFields.length + d.changedFields.length >
    0
  );
}

async function main(): Promise<void> {
  const init = process.argv.includes('--init');
  const next = await fetchSnapshot();

  if (init) {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    log(`snapshot written: ${SNAPSHOT_PATH} (${Object.keys(next).length} types)`);
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    log(`no snapshot at ${SNAPSHOT_PATH}; run \`npm run schema:snapshot\` first`);
    process.exit(2);
  }
  const prev = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  const d = diffSnapshots(prev, next);

  if (!hasChanges(d)) {
    log('✓ FreshTrack schema unchanged');
    return;
  }
  log('⚠ FreshTrack schema changed:');
  for (const t of d.addedTypes) log(`  + type ${t}`);
  for (const t of d.removedTypes) log(`  - type ${t}`);
  for (const f of d.addedFields) log(`  + ${f}`);
  for (const f of d.removedFields) log(`  - ${f}`);
  for (const f of d.changedFields) log(`  ~ ${f}`);
  process.exit(1);
}

if (isMain(import.meta.url)) {
  await main();
}
