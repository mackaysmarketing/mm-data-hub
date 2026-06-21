// Pure grower crosswalk resolution: ns_vendor.entityid = core.dim_grower.code → consignor_id.
//
// `code` is NOT strictly 1:1 to consignor_id — e.g. WADDA maps to an active and an inactive
// dim_grower row. Resolve to the ACTIVE row, then a deterministic tiebreak (lowest consignor_id)
// so the mapping is stable. Used by the crosswalk proof to verify the SQL crosswalk independently.
// Use `entityid`, NEVER `externalid` (rotten: LRCTU→'LRCDR', plus null externalids).

export interface GrowerCandidate {
  consignor_id: string;
  is_active: boolean | null;
}

/** Resolve the consignor_id for a vendor code's candidate dim_grower rows (active wins). */
export function resolveConsignor(candidates: GrowerCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const aActive = a.is_active === true ? 0 : 1;
    const bActive = b.is_active === true ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive; // active first
    return a.consignor_id < b.consignor_id ? -1 : a.consignor_id > b.consignor_id ? 1 : 0;
  });
  return sorted[0]?.consignor_id ?? null;
}
