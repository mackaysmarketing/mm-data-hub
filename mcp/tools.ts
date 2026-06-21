// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — the READ tool surface (SPEC §5). Pure handlers: (args, identity, deps) → ReadResult.
// Identity is injected, never an argument. Metrics are consumed from the Cube catalog, never
// redefined. Every handler returns the governed output shape. Deferred surfaces are stubbed
// with an explicit guard (UnavailableError), never faked.
// ─────────────────────────────────────────────────────────────────────────────
import { LIMITS, BAKED_IN_FILTERS } from './config.ts';
import { ValidationError, UnavailableError } from './errors.ts';
import { scopeLabel, type CallerIdentity } from './identity.ts';
import type { CubeClient, CubeQuery, CubeRow } from './cube.ts';
import type { CallerDb } from './db.ts';
import {
  resolveMetric,
  resolveDimension,
  lookupDefinition,
  CANONICAL_DEFINITIONS,
  type Catalog,
  type MetricMeta,
} from './registry.ts';
import { buildResult, type ReadResult, type Row } from './output.ts';
import { guardSelect } from './runSelect.ts';

export interface ToolDeps {
  cube: CubeClient;
  db: CallerDb;
  /** Cached catalog provider (Cube /meta → Catalog). */
  catalog: (id: CallerIdentity) => Promise<Catalog>;
}

export type ToolHandler = (args: Record<string, unknown>, id: CallerIdentity, deps: ToolDeps) => Promise<ReadResult>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const capOf = (limit: unknown): number =>
  Math.min(Math.max(1, typeof limit === 'number' && limit > 0 ? Math.floor(limit) : LIMITS.DEFAULT_ROWS), LIMITS.MAX_ROWS);

const short = (full: string): string => (full.includes('.') ? full.slice(full.indexOf('.') + 1) : full);

/** Re-key a Cube response row from `dispatch.x` → `x` for a readable output surface. */
function shortenRow(r: CubeRow): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[short(k)] = v;
  return out;
}

const FILTER_OPERATORS = new Set([
  'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith',
  'gt', 'gte', 'lt', 'lte', 'set', 'notSet', 'inDateRange', 'beforeDate', 'afterDate',
]);
const TIME_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);

const asStringArray = (v: unknown, label: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ValidationError(`${label} must be an array of strings`);
  }
  return v as string[];
};

// ── get_catalog ──────────────────────────────────────────────────────────────
const getCatalog: ToolHandler = async (_args, id, deps) => {
  const cat = await deps.catalog(id);
  const rows: Row[] = [
    ...cat.metrics.map((m) => ({
      kind: 'metric', name: m.name, title: m.title, type: m.type, unit: m.unit,
      format: m.format ?? null, description: m.description ?? null,
    })),
    ...cat.dimensions.map((d) => ({
      kind: 'dimension', name: d.name, title: d.title, type: d.type, unit: null,
      format: null, description: d.description ?? null,
    })),
    ...CANONICAL_DEFINITIONS.map((def) => ({
      kind: 'definition', name: def.term, title: def.kind, type: 'concept', unit: null,
      format: null, description: def.definition + (def.filters ? ` [${def.filters}]` : ''),
    })),
  ];
  return buildResult({
    rows,
    cap: rows.length,
    columns: ['kind', 'name', 'title', 'type', 'unit', 'format', 'description'],
    metricDefinition: { view: cat.view, consumes: 'Cube governed catalog (additive-only; never redefined)' },
    filtersApplied: { baked_in: BAKED_IN_FILTERS, rls: scopeLabel(id) },
  });
};

// ── list_metrics ─────────────────────────────────────────────────────────────
const listMetrics: ToolHandler = async (args, id, deps) => {
  const domain = args.domain;
  if (domain !== undefined && domain !== 'dispatch') {
    if (domain === 'sales') {
      throw new UnavailableError('Sales/settlement metrics are unavailable until Phase 2 (GP data not landed).');
    }
    throw new ValidationError(`Unknown domain '${String(domain)}'. Available: dispatch`);
  }
  const cat = await deps.catalog(id);
  const sliceable = cat.dimensions.map((d) => d.name);
  const rows: Row[] = cat.metrics.map((m) => ({
    metric: m.name, title: m.title, type: m.type, unit: m.unit, format: m.format ?? null,
    sliceable_dimensions: sliceable, description: m.description ?? null,
  }));
  return buildResult({
    rows,
    cap: rows.length,
    columns: ['metric', 'title', 'type', 'unit', 'format', 'sliceable_dimensions', 'description'],
    metricDefinition: { domain: 'dispatch', view: cat.view },
    filtersApplied: { baked_in: BAKED_IN_FILTERS, rls: scopeLabel(id) },
  });
};

// ── get_definition ───────────────────────────────────────────────────────────
const getDefinition: ToolHandler = async (args, id, deps) => {
  const term = args.term;
  if (typeof term !== 'string' || term.trim() === '') {
    throw new ValidationError('get_definition requires a non-empty `term`');
  }
  const cat = await deps.catalog(id);
  const def = lookupDefinition(cat, term);
  const rows: Row[] = [{ term: def.term, kind: def.kind, definition: def.definition, filters: def.filters ?? null }];
  return buildResult({
    rows,
    cap: 1,
    columns: ['term', 'kind', 'definition', 'filters'],
    metricDefinition: def,
    filtersApplied: { rls: scopeLabel(id) },
  });
};

// ── list_dimension_values ────────────────────────────────────────────────────
const listDimensionValues: ToolHandler = async (args, id, deps) => {
  const cat = await deps.catalog(id);
  const dim = resolveDimension(cat, String(args.dimension ?? ''));
  const cap = capOf(args.limit);
  const search = typeof args.search === 'string' && args.search.trim() !== '' ? args.search.trim() : null;

  const query: CubeQuery = {
    dimensions: [dim.full],
    order: { [dim.full]: 'asc' },
    limit: cap + 1,
  };
  if (search) query.filters = [{ member: dim.full, operator: 'contains', values: [search] }];

  const data = await deps.cube.load(query, id);
  const rows: Row[] = data.map((r) => ({ [dim.name]: r[dim.full] ?? null }));
  return buildResult({
    rows,
    cap,
    columns: [dim.name],
    metricDefinition: { dimension: dim.name, title: dim.title, type: dim.type, description: dim.description ?? null },
    filtersApplied: { rls: scopeLabel(id), dimension: dim.name, search },
  });
};

// ── query_metric ─────────────────────────────────────────────────────────────
const queryMetric: ToolHandler = async (args, id, deps) => {
  const cat = await deps.catalog(id);

  const metricNames = typeof args.metric === 'string' ? [args.metric] : asStringArray(args.metric, 'metric');
  if (metricNames.length === 0) throw new ValidationError('query_metric requires `metric` (a name or array of names)');
  const metrics: MetricMeta[] = metricNames.map((m) => resolveMetric(cat, m));

  const groupBy = asStringArray(args.group_by, 'group_by').map((g) => resolveDimension(cat, g));
  const cap = capOf(args.limit);

  const query: CubeQuery = {
    measures: metrics.map((m) => m.full),
    dimensions: groupBy.map((d) => d.full),
    limit: cap + 1,
  };

  // User filters → validated Cube filters (dimension names registry-checked, operators allow-listed).
  const userFilters = (args.filters as Array<Record<string, unknown>> | undefined) ?? [];
  if (userFilters.length > 0) {
    if (!Array.isArray(userFilters)) throw new ValidationError('filters must be an array of {dimension, operator, values}');
    query.filters = userFilters.map((f) => {
      const dim = resolveDimension(cat, String(f.dimension ?? ''));
      const op = String(f.operator ?? 'equals');
      if (!FILTER_OPERATORS.has(op)) {
        throw new ValidationError(`Unknown filter operator '${op}'. Allowed: ${[...FILTER_OPERATORS].join(', ')}`);
      }
      return { member: dim.full, operator: op, values: asStringArray(f.values, 'filter.values') };
    });
  }

  // time_range / time_grain → a time dimension on dispatched_on (or a named time dim).
  const timeRange = args.time_range as { from?: string; to?: string; dimension?: string } | string[] | undefined;
  const timeGrain = args.time_grain;
  if (timeRange || timeGrain !== undefined) {
    let timeDimName = 'dispatched_on';
    let dateRange: string[] | undefined;
    if (Array.isArray(timeRange)) {
      dateRange = asStringArray(timeRange, 'time_range');
    } else if (timeRange && typeof timeRange === 'object') {
      if (timeRange.dimension) timeDimName = timeRange.dimension;
      if (timeRange.from && timeRange.to) dateRange = [timeRange.from, timeRange.to];
      else if (timeRange.from || timeRange.to) {
        throw new ValidationError('time_range needs both `from` and `to` (or neither)');
      }
    }
    const timeDim = resolveDimension(cat, timeDimName);
    if (timeDim.type !== 'time') throw new ValidationError(`Dimension '${timeDim.name}' is not a time dimension`);
    let granularity: string | undefined;
    if (timeGrain !== undefined) {
      granularity = String(timeGrain);
      if (!TIME_GRAINS.has(granularity)) {
        throw new ValidationError(`Unknown time_grain '${granularity}'. Allowed: ${[...TIME_GRAINS].join(', ')}`);
      }
    }
    query.timeDimensions = [{ dimension: timeDim.full, ...(granularity ? { granularity } : {}), ...(dateRange ? { dateRange } : {}) }];
  }

  // order → validated members only.
  const orderArg = args.order as Array<[string, string]> | Record<string, string> | undefined;
  if (orderArg) {
    const pairs: Array<[string, string]> = Array.isArray(orderArg) ? orderArg : Object.entries(orderArg);
    const order: Record<string, 'asc' | 'desc'> = {};
    for (const [member, dir] of pairs) {
      const full = cat.metricByName.get(short(member))?.full ?? cat.dimByName.get(short(member))?.full;
      if (!full) throw new ValidationError(`Cannot order by unknown member '${member}'`);
      if (dir !== 'asc' && dir !== 'desc') throw new ValidationError(`order direction must be 'asc' or 'desc' (got '${dir}')`);
      order[full] = dir;
    }
    query.order = order;
  }

  const data = await deps.cube.load(query, id);
  const rows = data.map(shortenRow);

  const columns = [
    ...groupBy.map((d) => d.name),
    ...(query.timeDimensions?.map((t) => short(t.dimension)) ?? []),
    ...metrics.map((m) => m.name),
  ];
  return buildResult({
    rows,
    cap,
    columns,
    metricDefinition: metrics.map((m) => ({
      metric: m.name, title: m.title, type: m.type, unit: m.unit, format: m.format ?? null, description: m.description ?? null,
    })),
    filtersApplied: {
      rls: scopeLabel(id),
      baked_in: BAKED_IN_FILTERS,
      group_by: groupBy.map((d) => d.name),
      filters: userFilters,
      time_range: timeRange ?? null,
      time_grain: timeGrain ?? null,
      limit: cap,
    },
  });
};

// ── list_grower_dispatches (semantic.grower_dispatch_detail, Postgres RLS) ────────────────────
const DETAIL_COLUMNS = [
  'dispatched_on', 'load_no', 'pack_week', 'crop', 'variety', 'product',
  'boxes', 'net_weight', 'net_weight_unit', 'pallet_no', 'grower_key',
];

const listGrowerDispatches: ToolHandler = async (args, id, deps) => {
  const cap = capOf(args.limit);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$$', `$${params.length}`));
  };

  // `grower` only NARROWS (RLS already prevents widening past the caller's consignor).
  if (typeof args.grower === 'string' && args.grower.trim() !== '') add('grower_key = $$::uuid', args.grower.trim());
  const tr = args.time_range as { from?: string; to?: string } | undefined;
  if (tr?.from) add('dispatched_on >= $$::date', tr.from);
  if (tr?.to) add('dispatched_on <= $$::date', tr.to);
  if (typeof args.product === 'string' && args.product.trim() !== '') add('product ilike $$', `%${args.product.trim()}%`);
  if (typeof args.crop === 'string' && args.crop.trim() !== '') add('crop ilike $$', `%${args.crop.trim()}%`);

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const sql = `
    select ${DETAIL_COLUMNS.join(', ')}
    from semantic.grower_dispatch_detail
    ${whereSql}
    order by dispatched_on desc nulls last, load_no
    limit ${cap + 1}`;

  const result = await deps.db.query(id, (run) => run(sql, params));
  const rows = result.rows as Row[];
  return buildResult({
    rows,
    cap,
    columns: DETAIL_COLUMNS,
    metricDefinition: {
      grain: 'pallet',
      source: 'semantic.grower_dispatch_detail',
      note: 'net_weight is nullable and NOT coalesced (SPEC §9.8); grower_key = load consignor, not harvest_load_id (§9.1).',
    },
    filtersApplied: {
      rls: scopeLabel(id),
      baked_in: ['dispatched (actual_pickup_on not null)', 'non-test consignor'],
      grower: args.grower ?? null,
      time_range: tr ?? null,
      product: args.product ?? null,
      crop: args.crop ?? null,
      limit: cap,
    },
  });
};

// ── resolve_entity ───────────────────────────────────────────────────────────
const ENTITY_DIMS: Record<string, string[]> = {
  grower: ['grower_key', 'grower_code', 'grower_name'],
  consignee: ['consignee_key'],
  customer: ['consignee_key'],
  product: ['product'],
  crop: ['crop'],
  variety: ['variety'],
};

const resolveEntity: ToolHandler = async (args, id, deps) => {
  const kind = String(args.kind ?? '');
  const dimNames = ENTITY_DIMS[kind];
  if (!dimNames) throw new ValidationError(`Unknown entity kind '${kind}'. Allowed: ${Object.keys(ENTITY_DIMS).join(', ')}`);
  const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
  const cat = await deps.catalog(id);
  const dims = dimNames.map((d) => resolveDimension(cat, d));
  const cap = capOf(args.limit);

  // Distinct dimension members, RLS-scoped by Cube; substring-match client-side across the fields.
  const data = await deps.cube.load({ dimensions: dims.map((d) => d.full), limit: LIMITS.MAX_ROWS }, id);
  let rows = data.map(shortenRow);
  if (search) {
    rows = rows.filter((r) => dims.some((d) => String(r[d.name] ?? '').toLowerCase().includes(search)));
  }
  const truncatedRows = rows.slice(0, cap + 1);
  return buildResult({
    rows: truncatedRows,
    cap,
    columns: dims.map((d) => d.name),
    metricDefinition: { kind, resolves_to: dims.map((d) => d.name) },
    filtersApplied: { rls: scopeLabel(id), kind, search: args.search ?? null },
  });
};

// ── run_select (escape hatch) ────────────────────────────────────────────────
const runSelect: ToolHandler = async (args, id, deps) => {
  const guarded = guardSelect(String(args.sql ?? ''), typeof args.limit === 'number' ? args.limit : undefined);
  const result = await deps.db.query(id, (run) => run(guarded.sql));
  const rows = result.rows as Row[];
  const columns = result.fields?.map((f) => f.name) ?? [];
  return buildResult({
    rows,
    cap: guarded.cap,
    columns,
    metricDefinition: null,
    filtersApplied: {
      rls: scopeLabel(id),
      note: 'run_select escape hatch — single read-only SELECT over semantic.* only, RLS-scoped, capped.',
      cap: guarded.cap,
    },
  });
};

// ── Deferred surfaces (stubbed, NOT faked) ───────────────────────────────────
const listGrowerSales: ToolHandler = async () => {
  throw new UnavailableError(
    'list_grower_sales is unavailable until Phase 2: GP/settlement data is not landed (FreshTrack ' +
      'read-replica credentials are blocked — readonlyDatabaseCredentials returns null). See SPRINT.md › Out of Scope.',
  );
};

// ── Tool registry ────────────────────────────────────────────────────────────
const STR = { type: 'string' } as const;
const STR_ARR = { type: 'array', items: { type: 'string' } } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'get_catalog',
    description:
      'Return the governed dispatch catalog: metrics, dimensions, and canonical definitions (incl. baked-in filters + RLS). Consumed from Cube; never redefined.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: getCatalog,
  },
  {
    name: 'list_metrics',
    description: 'List dispatch metrics with their unit, type, and sliceable dimensions. `domain` optional (only "dispatch" is live; "sales" is Phase 2).',
    inputSchema: { type: 'object', properties: { domain: STR }, additionalProperties: false },
    handler: listMetrics,
  },
  {
    name: 'get_definition',
    description: 'Return the canonical definition + filter logic for a term, metric, or dimension (e.g. "net_weight", "pallet_count", "baked_in_filters").',
    inputSchema: { type: 'object', properties: { term: STR }, required: ['term'], additionalProperties: false },
    handler: getDefinition,
  },
  {
    name: 'list_dimension_values',
    description: 'List distinct values of a dispatch dimension (RLS-scoped). Optional `search` substring + `limit`.',
    inputSchema: {
      type: 'object',
      properties: { dimension: STR, search: STR, limit: { type: 'number' } },
      required: ['dimension'],
      additionalProperties: false,
    },
    handler: listDimensionValues,
  },
  {
    name: 'query_metric',
    description:
      'Query a governed dispatch metric over the Cube `dispatch` view. group_by[], filters[{dimension,operator,values}], time_range{from,to,dimension?}, time_grain, order, limit. RLS-scoped to the caller; baked-in filters always applied.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { oneOf: [STR, STR_ARR], description: 'Metric name or list of names (e.g. "pallet_count").' },
        group_by: STR_ARR,
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: { dimension: STR, operator: STR, values: STR_ARR },
            required: ['dimension', 'operator'],
            additionalProperties: false,
          },
        },
        time_range: {
          oneOf: [
            { type: 'object', properties: { from: STR, to: STR, dimension: STR }, additionalProperties: false },
            STR_ARR,
          ],
        },
        time_grain: STR,
        order: { type: 'object', additionalProperties: { type: 'string', enum: ['asc', 'desc'] } },
        limit: { type: 'number' },
      },
      required: ['metric'],
      additionalProperties: false,
    },
    handler: queryMetric,
  },
  {
    name: 'list_grower_dispatches',
    description:
      'Grower dispatch detail at pallet grain from semantic.grower_dispatch_detail (Postgres RLS). Optional grower, time_range{from,to}, product, crop, limit. Caller scope cannot be widened.',
    inputSchema: {
      type: 'object',
      properties: {
        grower: STR,
        time_range: { type: 'object', properties: { from: STR, to: STR }, additionalProperties: false },
        product: STR,
        crop: STR,
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: listGrowerDispatches,
  },
  {
    name: 'resolve_entity',
    description: 'Resolve a name/code to dimension members (RLS-scoped). kind ∈ grower|consignee|customer|product|crop|variety; `search` substring.',
    inputSchema: {
      type: 'object',
      properties: { kind: STR, search: STR, limit: { type: 'number' } },
      required: ['kind'],
      additionalProperties: false,
    },
    handler: resolveEntity,
  },
  {
    name: 'run_select',
    description:
      'Escape hatch: run a SINGLE read-only SELECT over the semantic.* schema only (no DDL/DML, row cap + timeout). RLS-scoped to the caller.',
    inputSchema: {
      type: 'object',
      properties: { sql: STR, limit: { type: 'number' } },
      required: ['sql'],
      additionalProperties: false,
    },
    handler: runSelect,
  },
  {
    name: 'list_grower_sales',
    description: '[DEFERRED — Phase 2] Grower sales/settlement detail. Unavailable until GP data is landed (read-replica blocked).',
    inputSchema: {
      type: 'object',
      properties: { grower: STR, time_range: { type: 'object' }, customer: STR, product: STR },
      additionalProperties: true,
    },
    handler: listGrowerSales,
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
