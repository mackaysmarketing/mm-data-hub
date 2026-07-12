// NL glossary loader tests — the PURE parts of src/loaders/nl_glossary.ts (validation +
// submission-file resolution). Inputs mirror what scripts/nl_glossary_tool.ts exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateSubmission, newestSubmissionPath, ENTITY_TYPES, PHRASE_CATEGORIES,
} from '../src/loaders/nl_glossary.ts';

const term = (over: Record<string, unknown> = {}) => ({
  entity_type: 'product', entity_key: 'abc-123', canonical_name: 'Bananas Cavendish 13kg',
  alias: 'cavs', notes: null, ...over,
});
const phrase = (over: Record<string, unknown> = {}) => ({
  category: 'questions', phrase: 'How many cavs did we send Coles last week?', ...over,
});

test('accepts the tool-export shape (terms + phrases, extra top-level keys ignored)', () => {
  const sub = validateSubmission({
    generated: '2026-07-12T00:00:00Z', tool: 'nl_glossary_2026-07-12',
    terms: [term(), term({ alias: 'thirteens', notes: 'the 13kg carton' })],
    phrases: [phrase(), phrase({ category: 'units', phrase: 'ctn = carton', meaning: 'carton' })],
  });
  assert.equal(sub.terms.length, 2);
  assert.equal(sub.phrases.length, 2);
  assert.equal(sub.terms[0]!.alias, 'cavs');
  assert.equal(sub.phrases[1]!.category, 'units');
});

test('terms-only and phrases-only submissions are both valid; empty is not', () => {
  assert.equal(validateSubmission({ terms: [term()] }).phrases.length, 0);
  assert.equal(validateSubmission({ phrases: [phrase()] }).terms.length, 0);
  assert.throws(() => validateSubmission({ terms: [], phrases: [] }), /no terms and no phrases/);
});

test('every problem is listed, not just the first', () => {
  try {
    validateSubmission({
      terms: [term({ entity_type: 'nonsense' }), term({ alias: '  ' })],
      phrases: [phrase({ category: 'jokes' })],
    });
    assert.fail('should have thrown');
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /3 problem\(s\)/);
    assert.match(msg, /terms\[0\].*entity_type/);
    assert.match(msg, /terms\[1\].*alias/);
    assert.match(msg, /phrases\[0\].*category/);
  }
});

test('entity_type is validated against the 0048 documented set; entity_key rejects "|"', () => {
  for (const t of ENTITY_TYPES) assert.doesNotThrow(() => validateSubmission({ terms: [term({ entity_type: t })] }));
  assert.throws(() => validateSubmission({ terms: [term({ entity_key: 'a|b' })] }), /must not contain/);
});

test('phrase category is validated against the documented set', () => {
  for (const c of PHRASE_CATEGORIES) assert.doesNotThrow(() => validateSubmission({ phrases: [phrase({ category: c })] }));
});

test('values are trimmed; non-object rows and non-array containers are rejected', () => {
  const sub = validateSubmission({ terms: [term({ alias: '  cavs  ', entity_key: ' k1 ' })] });
  assert.equal(sub.terms[0]!.alias, 'cavs');
  assert.equal(sub.terms[0]!.entity_key, 'k1');
  assert.throws(() => validateSubmission({ terms: 'nope' }), /must be an array/);
  assert.throws(() => validateSubmission([term()]), /must be a JSON object/);
  assert.throws(() => validateSubmission({ terms: ['nope'] }), /not an object/);
});

test('newestSubmissionPath picks the newest nl_glossary_submission*.json by mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nlgloss-'));
  try {
    const old = join(dir, 'nl_glossary_submission_2026-07-01.json');
    const newer = join(dir, 'nl_glossary_submission_2026-07-12.json');
    const decoy = join(dir, 'other_report.json');
    for (const f of [old, newer, decoy]) writeFileSync(f, '{}');
    utimesSync(old, new Date('2026-07-01'), new Date('2026-07-01'));
    utimesSync(newer, new Date('2026-07-12'), new Date('2026-07-12'));
    utimesSync(decoy, new Date('2026-07-13'), new Date('2026-07-13'));
    assert.equal(newestSubmissionPath(dir), newer);
    assert.equal(newestSubmissionPath(join(dir, 'missing')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
