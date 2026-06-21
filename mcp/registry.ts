// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — metric/dimension REGISTRY. The MCP CONSUMES the governed Cube catalog; it never
// redefines a metric. Names are validated against Cube /meta — unknowns are rejected. SPEC §4.
// ─────────────────────────────────────────────────────────────────────────────
import { DISPATCH_VIEW, BAKED_IN_FILTERS } from './config.ts';
import { ValidationError } from './errors.ts';
import type { CubeMetaCube, CubeMetaMember } from './cube.ts';

export interface MetricMeta {
  name: string; // short, e.g. pallet_count
  full: string; // e.g. dispatch.pallet_count
  title: string;
  type: string;
  format?: string;
  unit: string;
  description?: string;
}
export interface DimMeta {
  name: string;
  full: string;
  title: string;
  type: string;
  description?: string;
}
export interface Catalog {
  view: string;
  metrics: MetricMeta[];
  dimensions: DimMeta[];
  metricByName: Map<string, MetricMeta>;
  dimByName: Map<string, DimMeta>;
}

const short = (full: string): string => (full.includes('.') ? full.slice(full.indexOf('.') + 1) : full);

function unitOf(m: CubeMetaMember): string {
  if (m.format === 'percent') return 'percent';
  if (m.name.includes('net_weight') && !m.name.includes('capture')) return 'kg';
  if (m.name.includes('rate')) return 'ratio';
  return 'count';
}

/** Pure: build the Catalog from Cube /meta cubes. Only the public `dispatch` view is exposed. */
export function buildCatalog(cubes: CubeMetaCube[]): Catalog {
  const view = cubes.find((c) => c.name === DISPATCH_VIEW && c.public !== false);
  if (!view) {
    throw new Error(`Cube /meta did not expose the public '${DISPATCH_VIEW}' view`);
  }
  const metrics: MetricMeta[] = view.measures.map((m) => ({
    name: short(m.name),
    full: m.name,
    title: m.title ?? m.shortTitle ?? short(m.name),
    type: m.type ?? 'number',
    format: m.format,
    unit: unitOf(m),
    description: m.description,
  }));
  const dimensions: DimMeta[] = view.dimensions.map((d) => ({
    name: short(d.name),
    full: d.name,
    title: d.title ?? d.shortTitle ?? short(d.name),
    type: d.type ?? 'string',
    description: d.description,
  }));
  const metricByName = new Map(metrics.map((m) => [m.name, m]));
  const dimByName = new Map(dimensions.map((d) => [d.name, d]));
  return { view: DISPATCH_VIEW, metrics, dimensions, metricByName, dimByName };
}

/** Resolve + validate a metric name (accepts short or `dispatch.`-prefixed). Throws on unknown. */
export function resolveMetric(cat: Catalog, name: string): MetricMeta {
  const m = cat.metricByName.get(short(name));
  if (!m) {
    throw new ValidationError(
      `Unknown metric '${name}'. Valid metrics: ${cat.metrics.map((x) => x.name).join(', ')}`,
    );
  }
  return m;
}

/** Resolve + validate a dimension name. Throws ValidationError on unknown. */
export function resolveDimension(cat: Catalog, name: string): DimMeta {
  const d = cat.dimByName.get(short(name));
  if (!d) {
    throw new ValidationError(
      `Unknown dimension '${name}'. Valid dimensions: ${cat.dimensions.map((x) => x.name).join(', ')}`,
    );
  }
  return d;
}

// ── Canonical definitions (SPEC §4 + CONTRACTS.md) — for get_definition / get_catalog ───────
export interface Definition {
  term: string;
  kind: string;
  definition: string;
  filters?: string;
}

export const CANONICAL_DEFINITIONS: Definition[] = [
  {
    term: 'dispatched',
    kind: 'concept',
    definition: 'A load is dispatched when actual_pickup_on is set; the dispatch date used is actual_pickup_on.',
  },
  {
    term: 'grower',
    kind: 'concept',
    definition:
      'The consignor (consignor_id), consistent across dispatch and settlement. Grower attribution = the LOAD\'s consignor, never pallet.harvest_load_id (null outbound, SPEC §9.1).',
  },
  {
    term: 'non_test_grower',
    kind: 'concept',
    definition: 'Consignor entity excluding the inactive *TEST sites (TRUGTEST, LARATEST, ANNRTEST).',
  },
  {
    term: 'net_weight',
    kind: 'concept',
    definition:
      'Produce-dependent and nullable (e.g. mango sold by count). Summed with nulls EXCLUDED; NEVER coalesced to 0 (SPEC §9.8).',
  },
  {
    term: 'baked_in_filters',
    kind: 'governance',
    definition:
      'Filters every dispatch metric inherits, encoded in the cube SQL below the view — no consumer can drop them.',
    filters: BAKED_IN_FILTERS.join(' AND '),
  },
  {
    term: 'rls',
    kind: 'governance',
    definition:
      'Tenant scope is enforced per query from app_metadata.consignor_id (grower) / app_metadata.is_internal (internal), reading ONLY app_metadata (migration 0010). Neither/malformed → fail closed (0 rows). No dimension or filter can widen a grower\'s scope.',
  },
  {
    term: 'grain_safety',
    kind: 'governance',
    definition:
      'Nothing is sliceable below pallet/line grain. pallet.location_id (SPEC §9.2) and harvest-load lineage (harvest_load_id, SPEC §9.1) are not modelled.',
  },
];

const DEFS_BY_TERM = new Map(CANONICAL_DEFINITIONS.map((d) => [d.term, d]));

/** Look up a definition for a term, a metric, or a dimension. Throws if nothing matches. */
export function lookupDefinition(cat: Catalog, term: string): Definition {
  const canonical = DEFS_BY_TERM.get(term);
  if (canonical) return canonical;

  const metric = cat.metricByName.get(short(term));
  if (metric) {
    return {
      term: metric.name,
      kind: 'metric',
      definition: metric.description ?? metric.title,
      filters: BAKED_IN_FILTERS.join(' AND '),
    };
  }
  const dim = cat.dimByName.get(short(term));
  if (dim) {
    return { term: dim.name, kind: 'dimension', definition: dim.description ?? dim.title };
  }
  const known = [
    ...CANONICAL_DEFINITIONS.map((d) => d.term),
    ...cat.metrics.map((m) => m.name),
    ...cat.dimensions.map((d) => d.name),
  ];
  throw new ValidationError(`Unknown term '${term}'. Known terms: ${known.join(', ')}`);
}
