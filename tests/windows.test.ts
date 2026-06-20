import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindows, parseUtcDate } from '../src/lib/windows.ts';

test('buildWindows splits an exact multiple into equal half-open windows', () => {
  const w = buildWindows(parseUtcDate('2025-07-01'), parseUtcDate('2025-07-29'), 7);
  assert.equal(w.length, 4);
  assert.equal(w[0]!.start.toISOString(), '2025-07-01T00:00:00.000Z');
  assert.equal(w[0]!.end.toISOString(), '2025-07-08T00:00:00.000Z');
  // half-open: window N end == window N+1 start (no overlap, no gap)
  assert.equal(w[0]!.end.getTime(), w[1]!.start.getTime());
  assert.equal(w[3]!.end.toISOString(), '2025-07-29T00:00:00.000Z');
});

test('buildWindows clamps the final partial window to rangeEnd', () => {
  const w = buildWindows(parseUtcDate('2025-07-01'), parseUtcDate('2025-07-10'), 7);
  assert.equal(w.length, 2);
  assert.equal(w[1]!.start.toISOString(), '2025-07-08T00:00:00.000Z');
  assert.equal(w[1]!.end.toISOString(), '2025-07-10T00:00:00.000Z');
});

test('buildWindows covers the whole range with no gaps', () => {
  const start = parseUtcDate('2025-07-01');
  const end = parseUtcDate('2026-06-20');
  const w = buildWindows(start, end, 7);
  assert.equal(w[0]!.start.getTime(), start.getTime());
  assert.equal(w[w.length - 1]!.end.getTime(), end.getTime());
  for (let i = 1; i < w.length; i++) assert.equal(w[i]!.start.getTime(), w[i - 1]!.end.getTime());
});

test('buildWindows returns [] for an inverted or empty range', () => {
  assert.deepEqual(buildWindows(parseUtcDate('2025-07-08'), parseUtcDate('2025-07-01'), 7), []);
  assert.deepEqual(buildWindows(parseUtcDate('2025-07-01'), parseUtcDate('2025-07-01'), 7), []);
});

test('buildWindows rejects non-positive window size', () => {
  assert.throws(() => buildWindows(parseUtcDate('2025-07-01'), parseUtcDate('2025-07-08'), 0));
});

test('parseUtcDate rejects garbage', () => {
  assert.throws(() => parseUtcDate('not-a-date'));
});
