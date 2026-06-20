// Source-data parsers for FreshTrack quirks (SPEC §9). Pure + unit-tested.

/** extra_text_2 is a pack-week code Y{YY}W{WW}, e.g. "Y25W31" → { year: 2025, week: 31 }. */
export interface PackWeek {
  year: number;
  week: number;
}

export function parsePackWeek(code: string | null | undefined): PackWeek | null {
  if (!code) return null;
  const m = /^Y(\d{2})W(\d{2})$/.exec(code.trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return { year: 2000 + yy, week };
}

/**
 * product_description / supplier_highlights carry display format codes
 * (e.g. "^{b}^{c blue}[60]^{cl} Mackays - Bolinda"). Strip the ^{...} control tokens so the
 * raw codes are never shown to users (SPEC §9.9). Box-count tokens like [60] are kept.
 */
export function stripFormatCodes(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/\^\{[^}]*\}/g, '') // remove ^{...} tokens
    .replace(/\s+/g, ' ')
    .trim();
}

/** Test consignor detection (SPEC §9.6): inactive entity whose code ends in TEST. */
export function deriveIsTest(code: string | null | undefined, isActive: boolean | null | undefined): boolean {
  if (isActive === true) return false;
  if (!code) return false;
  return /test$/i.test(code.trim());
}
