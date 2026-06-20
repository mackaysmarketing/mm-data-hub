// Pure window arithmetic for the backfill. The FreshTrack API has filterLimit but no
// cursor/offset, so we paginate by walking time in fixed-size half-open [start, end) windows.

export interface Window {
  start: Date;
  end: Date;
}

/**
 * Generate half-open [start, end) windows of `days` length covering [rangeStart, rangeEnd).
 * The final window is clamped to rangeEnd. Throws on non-positive `days` or inverted range.
 */
export function buildWindows(rangeStart: Date, rangeEnd: Date, days: number): Window[] {
  if (!(days > 0)) throw new Error(`windowDays must be > 0, got ${days}`);
  if (rangeEnd.getTime() <= rangeStart.getTime()) return [];

  const stepMs = days * 24 * 60 * 60 * 1000;
  const windows: Window[] = [];
  let cursor = rangeStart.getTime();
  const endMs = rangeEnd.getTime();

  while (cursor < endMs) {
    const next = Math.min(cursor + stepMs, endMs);
    windows.push({ start: new Date(cursor), end: new Date(next) });
    cursor = next;
  }
  return windows;
}

/** Parse a YYYY-MM-DD (or full ISO) date string as a UTC instant. */
export function parseUtcDate(s: string): Date {
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function toIso(d: Date): string {
  return d.toISOString();
}
