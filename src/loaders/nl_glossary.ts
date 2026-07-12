// NL glossary loader — lands Tim's vocabulary submission (the JSON exported by the engagement
// tool, scripts/nl_glossary_tool.ts) into core.business_term + core.nl_phrase with source='tim'.
//   npm run nl:load                    → newest reports/nl_glossary_submission*.json
//   npm run nl:load -- <path.json>     → an explicit file
//
// Contract (mirrors migration 0048):
//   file shape   { terms:   [{entity_type, entity_key, canonical_name?, alias, notes?}],
//                  phrases: [{category, phrase, meaning?, notes?}] }
//   term id      = entity_type||'|'||entity_key||'|'||lower(alias)   (the 0048 PK convention)
//   phrase id    = category||'|'||lower(phrase)
//   idempotent   — re-running the same file is a no-op; rows upsert on id.
//   NEVER touches seed/derived rows: the upsert's ON CONFLICT only updates rows whose existing
//   source is already 'tim'. An id already owned by seed/derived is SKIPPED and LISTED (the alias
//   mapping already exists; Tim's notes on it are surfaced here for manual wiring, never silently
//   dropped).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makePool, assertHubTarget } from '../lib/db.ts';
import { isMain, log } from '../lib/util.ts';

export const ENTITY_TYPES = [
  'product', 'customer', 'grower', 'shed', 'segment', 'geography',
  'charge_category', 'metric', 'period',
] as const;
export const PHRASE_CATEGORIES = ['units', 'time', 'roles', 'questions', 'general'] as const;

export interface GlossaryTerm {
  entity_type: string;
  entity_key: string;
  canonical_name?: string | null;
  alias: string;
  notes?: string | null;
}
export interface GlossaryPhrase {
  category: string;
  phrase: string;
  meaning?: string | null;
  notes?: string | null;
}
export interface GlossarySubmission { terms: GlossaryTerm[]; phrases: GlossaryPhrase[]; }

/** Newest reports/nl_glossary_submission*.json by mtime, or null if none exists. */
export function newestSubmissionPath(dir = 'reports'): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /^nl_glossary_submission.*\.json$/i.test(f));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const byMtime = names
    .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return byMtime[0]!.f;
}

function isStr(v: unknown): v is string { return typeof v === 'string'; }
function optStr(v: unknown): boolean { return v === undefined || v === null || typeof v === 'string'; }

/** Validate + normalise the submission. Throws with EVERY problem listed (not just the first). */
export function validateSubmission(raw: unknown): GlossarySubmission {
  const errs: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('submission must be a JSON object { terms: [...], phrases: [...] }');
  }
  const obj = raw as Record<string, unknown>;
  const termsIn = obj.terms ?? [];
  const phrasesIn = obj.phrases ?? [];
  if (!Array.isArray(termsIn)) errs.push('`terms` must be an array');
  if (!Array.isArray(phrasesIn)) errs.push('`phrases` must be an array');
  if (errs.length) throw new Error(errs.join('\n'));

  const terms: GlossaryTerm[] = [];
  (termsIn as unknown[]).forEach((t, i) => {
    const at = `terms[${i}]`;
    if (t === null || typeof t !== 'object') { errs.push(`${at}: not an object`); return; }
    const r = t as Record<string, unknown>;
    const before = errs.length;
    const entityType = isStr(r.entity_type) ? r.entity_type.trim() : '';
    const entityKey = isStr(r.entity_key) ? r.entity_key.trim() : '';
    const alias = isStr(r.alias) ? r.alias.trim() : '';
    if (!(ENTITY_TYPES as readonly string[]).includes(entityType))
      errs.push(`${at}: entity_type "${String(r.entity_type)}" not in [${ENTITY_TYPES.join(', ')}]`);
    if (entityKey === '') errs.push(`${at}: entity_key missing/empty`);
    if (entityKey.includes('|')) errs.push(`${at}: entity_key must not contain '|'`);
    if (alias === '') errs.push(`${at}: alias missing/empty`);
    if (!optStr(r.canonical_name)) errs.push(`${at}: canonical_name must be a string when present`);
    if (!optStr(r.notes)) errs.push(`${at}: notes must be a string when present`);
    if (errs.length === before) {
      terms.push({
        entity_type: entityType,
        entity_key: entityKey,
        canonical_name: isStr(r.canonical_name) ? r.canonical_name : null,
        alias,
        notes: isStr(r.notes) ? r.notes : null,
      });
    }
  });

  const phrases: GlossaryPhrase[] = [];
  (phrasesIn as unknown[]).forEach((p, i) => {
    const at = `phrases[${i}]`;
    if (p === null || typeof p !== 'object') { errs.push(`${at}: not an object`); return; }
    const r = p as Record<string, unknown>;
    const before = errs.length;
    const category = isStr(r.category) ? r.category.trim() : '';
    const phrase = isStr(r.phrase) ? r.phrase.trim() : '';
    if (!(PHRASE_CATEGORIES as readonly string[]).includes(category))
      errs.push(`${at}: category "${String(r.category)}" not in [${PHRASE_CATEGORIES.join(', ')}]`);
    if (phrase === '') errs.push(`${at}: phrase missing/empty`);
    if (!optStr(r.meaning)) errs.push(`${at}: meaning must be a string when present`);
    if (!optStr(r.notes)) errs.push(`${at}: notes must be a string when present`);
    if (errs.length === before) {
      phrases.push({
        category,
        phrase,
        meaning: isStr(r.meaning) ? r.meaning : null,
        notes: isStr(r.notes) ? r.notes : null,
      });
    }
  });

  if (errs.length) throw new Error(`submission failed validation (${errs.length} problem(s)):\n  ${errs.join('\n  ')}`);
  if (terms.length === 0 && phrases.length === 0) throw new Error('submission carries no terms and no phrases');
  return { terms, phrases };
}

export interface NlLoadResult {
  file: string;
  terms_in_file: number;
  terms_unique: number;
  terms_upserted: number;
  terms_skipped_seed: { id: string; source: string; notes: string | null }[];
  phrases_in_file: number;
  phrases_unique: number;
  phrases_upserted: number;
  phrases_skipped_seed: { id: string; source: string; notes: string | null }[];
}

export async function loadGlossary(path?: string): Promise<NlLoadResult> {
  const file = path ?? newestSubmissionPath();
  if (!file) {
    throw new Error(
      'no submission found: pass a path (npm run nl:load -- <file.json>) or place ' +
      'reports/nl_glossary_submission*.json (exported by the engagement tool, npm run nl:tool)',
    );
  }
  log(`nl:load — ${file}`);
  const sub = validateSubmission(JSON.parse(readFileSync(file, 'utf8')));

  // Dedupe in-file by id (last occurrence wins) — matches the SQL DISTINCT ON below.
  const termId = (t: GlossaryTerm) => `${t.entity_type}|${t.entity_key}|${t.alias.toLowerCase()}`;
  const phraseId = (p: GlossaryPhrase) => `${p.category}|${p.phrase.toLowerCase()}`;
  const termMap = new Map(sub.terms.map((t) => [termId(t), t]));
  const phraseMap = new Map(sub.phrases.map((p) => [phraseId(p), p]));
  const terms = [...termMap.values()];
  const phrases = [...phraseMap.values()];

  const pool = makePool();
  try {
    await assertHubTarget(pool);
    const c = await pool.connect();
    try {
      await c.query('begin');
      try {

      // ── terms: upsert source='tim'; ON CONFLICT updates ONLY existing tim rows ──
      const termsUpserted = terms.length === 0 ? 0 : (await c.query(
        `insert into core.business_term (id, entity_type, entity_key, canonical_name, alias, source, notes, _synced_at)
         select t.entity_type || '|' || t.entity_key || '|' || lower(t.alias),
                t.entity_type, t.entity_key, t.canonical_name, t.alias, 'tim', t.notes, now()
         from jsonb_to_recordset($1::jsonb)
           as t(entity_type text, entity_key text, canonical_name text, alias text, notes text)
         on conflict (id) do update set
           canonical_name = excluded.canonical_name,
           alias          = excluded.alias,
           notes          = excluded.notes,
           _synced_at     = now()
         where core.business_term.source = 'tim'`,
        [JSON.stringify(terms)],
      )).rowCount ?? 0;

      const termsSkipped = terms.length === 0 ? [] : (await c.query<{ id: string; source: string; notes: string | null }>(
        `select bt.id, bt.source, t.notes
         from jsonb_to_recordset($1::jsonb)
           as t(entity_type text, entity_key text, canonical_name text, alias text, notes text)
         join core.business_term bt
           on bt.id = t.entity_type || '|' || t.entity_key || '|' || lower(t.alias)
         where bt.source <> 'tim'
         order by bt.id`,
        [JSON.stringify(terms)],
      )).rows;

      // ── phrases: same contract on core.nl_phrase (mapping stays NULL — wired later) ──
      const phrasesUpserted = phrases.length === 0 ? 0 : (await c.query(
        `insert into core.nl_phrase (id, category, phrase, meaning, mapping, source, notes, _synced_at)
         select p.category || '|' || lower(p.phrase),
                p.category, p.phrase, p.meaning, null, 'tim', p.notes, now()
         from jsonb_to_recordset($1::jsonb)
           as p(category text, phrase text, meaning text, notes text)
         on conflict (id) do update set
           phrase     = excluded.phrase,
           meaning    = excluded.meaning,
           notes      = excluded.notes,
           _synced_at = now()
         where core.nl_phrase.source = 'tim'`,
        [JSON.stringify(phrases)],
      )).rowCount ?? 0;

      const phrasesSkipped = phrases.length === 0 ? [] : (await c.query<{ id: string; source: string; notes: string | null }>(
        `select np.id, np.source, p.notes
         from jsonb_to_recordset($1::jsonb)
           as p(category text, phrase text, meaning text, notes text)
         join core.nl_phrase np on np.id = p.category || '|' || lower(p.phrase)
         where np.source <> 'tim'
         order by np.id`,
        [JSON.stringify(phrases)],
      )).rows;

      await c.query('commit');

      const res: NlLoadResult = {
        file,
        terms_in_file: sub.terms.length,
        terms_unique: terms.length,
        terms_upserted: termsUpserted,
        terms_skipped_seed: termsSkipped,
        phrases_in_file: sub.phrases.length,
        phrases_unique: phrases.length,
        phrases_upserted: phrasesUpserted,
        phrases_skipped_seed: phrasesSkipped,
      };
      log(`  terms:   ${res.terms_in_file} in file (${res.terms_unique} unique) → ${res.terms_upserted} upserted as source='tim', ${termsSkipped.length} already owned by seed/derived (skipped)`);
      for (const s of termsSkipped) {
        log(`    SKIP ${s.id} [${s.source}]${s.notes ? ` — Tim's note (NOT landed, wire manually): ${s.notes}` : ''}`);
      }
      log(`  phrases: ${res.phrases_in_file} in file (${res.phrases_unique} unique) → ${res.phrases_upserted} upserted as source='tim', ${phrasesSkipped.length} already owned by seed/derived (skipped)`);
      for (const s of phrasesSkipped) {
        log(`    SKIP ${s.id} [${s.source}]${s.notes ? ` — Tim's note (NOT landed, wire manually): ${s.notes}` : ''}`);
      }

      const glossary = (await c.query<{ source: string; n: string }>(
        `select source, count(*)::text as n from core.business_term group by source order by source`,
      )).rows;
      log('  business_term by source: ' + (glossary.map((r) => `${r.source}=${r.n}`).join(' ') || '(empty)'));
      return res;
      } catch (e) {
        await c.query('rollback').catch(() => { /* already committed or connection gone */ });
        throw e;
      }
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  try {
    const arg = process.argv[2];
    await loadGlossary(arg);
    log('done.');
  } catch (e) {
    console.error('nl:load FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
