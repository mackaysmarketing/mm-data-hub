// ─────────────────────────────────────────────────────────────────────────────
// Cube configuration — mm-data-hub dispatch semantic layer
// ─────────────────────────────────────────────────────────────────────────────
// TENANT RLS LIVES HERE. Cube enforces grower scope itself via queryRewrite on the
// security context — NOT via Postgres RLS. Cube connects on a read-only role that can
// read all rows; every query is narrowed to the caller's consignor before it runs.
//
// Claim contract — IDENTICAL to the DB hardening (migrations 0010/0026): the grower identity and
// the internal flag are read ONLY from the SERVER-controlled `app_metadata` namespace, never from
// top-level / user_metadata claims a grower could self-set —
//   securityContext.app_metadata.consignor_ids ([uuid]) → the grower's farms (multi-farm; 0026)
//   securityContext.app_metadata.consignor_id  (uuid)   → legacy single farm (folds into the set)
//   securityContext.app_metadata.is_internal   (truthy) → hub staff / service (sees all)
//
// Fail-closed: a context that is neither internal nor carries a VALID consignor is scoped to NIL →
// NOTHING. A malformed consignor is treated as absent (no rows), never trusted. No dimension or
// filter a consumer selects can widen scope — the scope filter is appended unconditionally on top
// of whatever the consumer asked for. The SET is enforced with an `equals`/multi-value (IN) filter,
// so a multi-farm grower sees the UNION of its farms and nothing else.

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read grower identity SET + internal flag from a Cube security context — app_metadata ONLY.
 *  consignorIds = de-duplicated, valid-only UNION of app_metadata.consignor_ids[] (multi-farm, 0026)
 *  and the legacy scalar app_metadata.consignor_id. consignorId keeps element 1 for compatibility. */
function readClaims(securityContext) {
  const am = (securityContext && securityContext.app_metadata) || {};

  const consignorIds = [];
  const add = (raw) => {
    if (typeof raw === 'string' && UUID_RE.test(raw) && !consignorIds.includes(raw)) consignorIds.push(raw);
  };
  if (Array.isArray(am.consignor_ids)) am.consignor_ids.forEach(add);
  add(am.consignor_id); // legacy scalar folds into the set (backward-compatible)

  const rawInternal = am.is_internal;
  const isInternal =
    rawInternal === true ||
    rawInternal === 1 ||
    (typeof rawInternal === 'string' &&
      ['true', 't', '1', 'yes'].includes(rawInternal.toLowerCase()));

  return { consignorIds, consignorId: consignorIds.length ? consignorIds[0] : null, isInternal };
}

/** Stable per-tenant cache key: the WHOLE sorted consignor set, so a [A] token and a [A,B] token
 *  never share a cache bucket (a single-farm grower must not be served a multi-farm cached result). */
function tenantKey(consignorIds) {
  return consignorIds.length ? consignorIds.slice().sort().join('_') : 'none';
}

// Each governed view's RLS anchor. queryRewrite scopes whichever views a query references — so the
// SAME app_metadata contract covers dispatch, NetSuite settlement, and GP settlement (schedule +
// load grain) without one ever leaking into another. ADDITIVE: new views are scoped here on the
// identical fail-closed contract; the existing dispatch/settlement scoping is untouched.
const VIEW_GROWER_KEYS = {
  dispatch: 'dispatch.grower_key',
  dispatch_shipped: 'dispatch_shipped.grower_key',
  settlement: 'settlement.grower_key',
  gp_settlement: 'gp_settlement.grower_key',
  gp_settlement_load: 'gp_settlement_load.grower_key',
};

/** Every member name referenced anywhere in a query (measures/dims/segments/time/filters/order). */
function collectMembers(query) {
  const out = [];
  const push = (m) => { if (typeof m === 'string') out.push(m); };
  (query.measures || []).forEach(push);
  (query.dimensions || []).forEach(push);
  (query.segments || []).forEach(push);
  (query.timeDimensions || []).forEach((td) => { if (td && td.dimension) push(td.dimension); });
  const walk = (fs) => (fs || []).forEach((f) => {
    if (!f) return;
    push(f.member);
    push(f.dimension);
    if (Array.isArray(f.and)) walk(f.and);
    if (Array.isArray(f.or)) walk(f.or);
  });
  walk(query.filters);
  if (Array.isArray(query.order)) query.order.forEach((o) => { if (Array.isArray(o)) push(o[0]); });
  else if (query.order && typeof query.order === 'object') Object.keys(query.order).forEach(push);
  return out;
}

/** The set of governed views (dispatch/settlement) a query touches. */
function viewsInQuery(query) {
  const views = new Set();
  for (const m of collectMembers(query)) {
    const prefix = String(m).split('.')[0];
    if (VIEW_GROWER_KEYS[prefix]) views.add(prefix);
  }
  return views;
}

module.exports = {
  // Per-tenant isolation of cache / pre-aggregations: each grower (and internal) keyed apart,
  // so one tenant's cached result can never be served to another.
  contextToAppId: ({ securityContext }) => {
    const { consignorIds, isInternal } = readClaims(securityContext);
    return isInternal ? 'app_internal' : `app_grower_${tenantKey(consignorIds)}`;
  },
  contextToOrchestratorId: ({ securityContext }) => {
    const { consignorIds, isInternal } = readClaims(securityContext);
    return isInternal ? 'orch_internal' : `orch_grower_${tenantKey(consignorIds)}`;
  },

  queryRewrite: (query, { securityContext }) => {
    const { consignorIds, isInternal } = readClaims(securityContext);
    query.filters = query.filters || [];

    // Internal / service context → unscoped (every consignor, every view).
    if (isInternal) return query;

    // Grower → own consignor SET; neither internal nor any valid consignor → fail closed (NIL → 0).
    // `equals` with multiple values is set membership (IN), so a multi-farm grower sees the UNION of
    // its farms. Scope is appended on EACH governed view the query references (dispatch and/or
    // settlement), so no dimension/filter the consumer selects can widen it, and views never cross-leak.
    const values = consignorIds.length ? consignorIds : [NIL_UUID];
    for (const view of viewsInQuery(query)) {
      query.filters.push({
        member: VIEW_GROWER_KEYS[view],
        operator: 'equals',
        values,
      });
    }
    return query;
  },

  // SQL API auth (Steep / BI tools). Cube's SQL API speaks the Postgres wire protocol; BI tools
  // connect HERE — not to Supabase directly — so they consume the governed `dispatch` view + the
  // RLS/baked-in filters. This BI connection runs as an INTERNAL (unscoped) analytics context:
  // without it, the queryRewrite above sees no app_metadata and fails closed (0 rows). Credentials
  // come from env (CUBEJS_SQL_USER / CUBEJS_SQL_PASSWORD), never code. Treat them as an internal
  // service credential — anyone holding them sees all consignors (appropriate for internal BI).
  checkSqlAuth: async (query, user) => {
    const expectedUser = process.env.CUBEJS_SQL_USER;
    const expectedPassword = process.env.CUBEJS_SQL_PASSWORD;
    if (!expectedUser || !expectedPassword || user !== expectedUser) {
      throw new Error('Invalid SQL API user');
    }
    // Cube compares the client-supplied password to the returned `password`.
    return {
      password: expectedPassword,
      securityContext: { app_metadata: { is_internal: true } },
    };
  },
};
