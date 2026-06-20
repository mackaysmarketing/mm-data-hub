// ─────────────────────────────────────────────────────────────────────────────
// Cube configuration — mm-data-hub dispatch semantic layer
// ─────────────────────────────────────────────────────────────────────────────
// TENANT RLS LIVES HERE. Cube enforces grower scope itself via queryRewrite on the
// security context — NOT via Postgres RLS. Cube connects on a read-only role that can
// read all rows; every query is narrowed to the caller's consignor before it runs.
//
// Claim contract — IDENTICAL to the Sprint-1 DB hardening (migration 0010): the grower
// identity and the internal flag are read ONLY from the SERVER-controlled `app_metadata`
// namespace, never from top-level / user_metadata claims a grower could self-set —
//   securityContext.app_metadata.consignor_id  (uuid)   → the grower
//   securityContext.app_metadata.is_internal   (truthy) → hub staff / service (sees all)
//
// Fail-closed: a context that is neither internal nor carries a VALID consignor_id sees
// NOTHING. A malformed consignor_id is treated as absent (no rows), never trusted. No
// dimension or filter a consumer selects can widen scope — the scope filter is appended
// unconditionally on top of whatever the consumer asked for.

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read grower identity + internal flag from a Cube security context — app_metadata ONLY. */
function readClaims(securityContext) {
  const am = (securityContext && securityContext.app_metadata) || {};

  const rawConsignor = am.consignor_id;
  const consignorId =
    typeof rawConsignor === 'string' && UUID_RE.test(rawConsignor) ? rawConsignor : null;

  const rawInternal = am.is_internal;
  const isInternal =
    rawInternal === true ||
    rawInternal === 1 ||
    (typeof rawInternal === 'string' &&
      ['true', 't', '1', 'yes'].includes(rawInternal.toLowerCase()));

  return { consignorId, isInternal };
}

module.exports = {
  // Per-tenant isolation of cache / pre-aggregations: each grower (and internal) keyed apart,
  // so one tenant's cached result can never be served to another.
  contextToAppId: ({ securityContext }) => {
    const { consignorId, isInternal } = readClaims(securityContext);
    return isInternal ? 'app_internal' : `app_grower_${consignorId || 'none'}`;
  },
  contextToOrchestratorId: ({ securityContext }) => {
    const { consignorId, isInternal } = readClaims(securityContext);
    return isInternal ? 'orch_internal' : `orch_grower_${consignorId || 'none'}`;
  },

  queryRewrite: (query, { securityContext }) => {
    const { consignorId, isInternal } = readClaims(securityContext);
    query.filters = query.filters || [];

    // Internal / service context → unscoped (every consignor).
    if (isInternal) return query;

    // Grower context → scope every query to the caller's consignor. Appended
    // unconditionally; no member the consumer selects can widen the scope.
    if (consignorId) {
      query.filters.push({
        member: 'dispatch.grower_key',
        operator: 'equals',
        values: [consignorId],
      });
      return query;
    }

    // Neither internal nor a valid consignor → fail closed (return no rows).
    query.filters.push({
      member: 'dispatch.grower_key',
      operator: 'equals',
      values: [NIL_UUID],
    });
    return query;
  },
};
