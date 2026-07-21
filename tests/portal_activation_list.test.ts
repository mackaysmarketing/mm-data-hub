// The hand-curated portal activation list is the source of truth for who can see the grower
// portal (src/config/portal_activation.ts). These guard the FILE itself in CI, so a bad edit fails
// here rather than at 3am against production. The applier's DB-side guards (code → exactly one
// ACTIVE row, refuse test/inactive/non-grower, post-write read-back) are proven live by
// `npm run portal:activate` and by portal:verify F9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_ACTIVATION, activationCodes, duplicateCodes, entriesMissingNote,
} from '../src/config/portal_activation.ts';

test('no duplicate codes — a dupe would silently double-count the declared set', () => {
  assert.deepEqual(duplicateCodes(), []);
});

test('every entry carries a note — the reason is the only thing that survives', () => {
  assert.deepEqual(entriesMissingNote(), []);
});

test('codes are plausible dim_grower codes (uppercase, no stray whitespace)', () => {
  for (const code of activationCodes()) {
    assert.match(code, /^[A-Z0-9]{2,10}$/, `suspicious code: ${JSON.stringify(code)}`);
  }
});

test('the list is non-empty — an empty list would deactivate the entire portal on --apply', () => {
  assert.ok(PORTAL_ACTIVATION.length > 0);
});

test('the four retained parents are present and labelled as parents', () => {
  // They have NO remittance of their own; they exist so parent-level logins keep working.
  // If someone prunes them by "they were never paid", this test explains why they are there.
  for (const code of ['GJFLE', 'LMBFA', 'LRCOL', 'MACKF']) {
    const entry = PORTAL_ACTIVATION.find((e) => e.code === code);
    assert.ok(entry, `${code} missing — parent-level portal logins would be stranded`);
    assert.match(entry.note, /PARENT/, `${code} note must state it is a retained parent`);
  }
});
