// Pure GP grower crosswalk helpers. Unlike the NetSuite crosswalk (entityid=code, with WADDA-style
// duplicates), GP is DETERMINISTIC: gp_schedule.consignor_id IS the dim_grower.consignor_id — no
// code-matching. The only subtlety is RECONSIGNMENT: gp_detail.consignor_id can be the ORIGINAL
// grower (the load was reconsigned to the settled grower), while gp_schedule.consignor_id is the
// party actually being settled. RLS + attribution anchor on the SCHEDULE consignor, ALWAYS.
//
// Used by the reconciliation/verify to surface the detail-only (original-load) consignors — the
// 45-vs-35 distinct-consignor gap — so they are explained, never silently dropped.

/**
 * The settlement / RLS anchor for a line: the SCHEDULE consignor, never the detail (original-load)
 * consignor. Returns null when the schedule has no consignor (unmapped — surfaced upstream).
 */
export function settlementConsignor(scheduleConsignorId: string | null | undefined): string | null {
  return scheduleConsignorId ?? null;
}

/**
 * Detail consignors that never appear as a SCHEDULE consignor = reconsignment originals. These are
 * surfaced (not dropped): their loads are settled under another grower's schedule. Deterministic,
 * sorted output.
 */
export function detailOnlyConsignors(
  scheduleConsignors: Iterable<string | null | undefined>,
  detailConsignors: Iterable<string | null | undefined>,
): string[] {
  const settled = new Set<string>();
  for (const s of scheduleConsignors) if (s) settled.add(s);
  const out = new Set<string>();
  for (const d of detailConsignors) if (d && !settled.has(d)) out.add(d);
  return [...out].sort();
}
