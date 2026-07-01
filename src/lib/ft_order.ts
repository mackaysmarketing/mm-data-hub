// Order-domain derivation oracle. The replica has NO order-header dollar total and NO version
// pointer (A0 finding) — so the header total is DERIVED from the current-version lines, and the
// authoritative version is max(version_no) per order. These pure functions are the TS oracle the
// core SQL (core.refresh_dim_order / refresh_fact_order_item) and the reconciliation proof are
// checked against (drift guard), exactly as ft_gp_settlement.ts is for the GP domain.

export interface OrderLine {
  order_version_id: string;
  price_per: string | null;        // 'BOX' | 'WEIGHT_UNIT' | ...
  price_value: number | null;      // never coalesced to 0
  total_box_count: number | null;
  pallet_count: number | null;
  total_price_value: number | null; // the native pre-computed line $ (preferred)
}

export interface OrderVersion { id: string; version_no: number }

/**
 * Extended line value. Prefer the native pre-computed `total_price_value`; where a caller wants the
 * DERIVED value (to reconcile against native), the rule is per `price_per`:
 *   BOX          → total_box_count × price_value
 *   PALLET       → pallet_count    × price_value
 *   WEIGHT_UNIT / CUSTOM / other → no line quantity → fall back to native total_price_value
 * Returns null when the inputs needed are null (never coalesced to 0 — SPEC §9.3).
 */
export function derivedLineValue(line: OrderLine): number | null {
  const pp = (line.price_per ?? '').toUpperCase();
  if (pp === 'BOX') {
    if (line.total_box_count == null || line.price_value == null) return line.total_price_value;
    return round2(line.total_box_count * line.price_value);
  }
  if (pp === 'PALLET') {
    if (line.pallet_count == null || line.price_value == null) return line.total_price_value;
    return round2(line.pallet_count * line.price_value);
  }
  return line.total_price_value; // WEIGHT_UNIT / CUSTOM — defer to the native total
}

/** The authoritative version id for an order = the one with the highest version_no. Null if none. */
export function latestVersion(versions: OrderVersion[]): OrderVersion | null {
  if (versions.length === 0) return null;
  return versions.reduce((a, b) => (b.version_no > a.version_no ? b : a));
}

export interface OrderRollup {
  latest_version_no: number | null;
  total_box_count: number | null;  // Σ current-version line total_box_count (null if no lines)
  total_price_value: number | null; // Σ current-version line native total_price_value (null if no lines)
  derived_price_value: number | null; // Σ current-version derivedLineValue (for the recon drift check)
  line_count: number;
}

/** Roll a single order up from its versions + all its lines, selecting the current version only.
 *  Sums exclude nulls (never coalesced); an order with no current-version lines yields null totals. */
export function rollupOrder(versions: OrderVersion[], lines: OrderLine[]): OrderRollup {
  const cur = latestVersion(versions);
  if (!cur) return { latest_version_no: null, total_box_count: null, total_price_value: null, derived_price_value: null, line_count: 0 };
  const curLines = lines.filter((l) => l.order_version_id === cur.id);
  const sumOrNull = (xs: (number | null)[]): number | null => {
    const vals = xs.filter((x): x is number => x != null);
    return vals.length === 0 ? null : round2(vals.reduce((a, b) => a + b, 0));
  };
  return {
    latest_version_no: cur.version_no,
    total_box_count: sumOrNull(curLines.map((l) => l.total_box_count)),
    total_price_value: sumOrNull(curLines.map((l) => l.total_price_value)),
    derived_price_value: sumOrNull(curLines.map((l) => derivedLineValue(l))),
    line_count: curLines.length,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
