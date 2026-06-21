// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — the governed READ output shape (SPEC §5).
// Every read tool returns EXACTLY: { columns, rows, metric_definition, filters_applied,
// row_count, truncated }. metric_definition + filters_applied make governance visible to
// the caller (which metric, which baked-in filters, which RLS scope, what was capped).
// ─────────────────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

export interface ReadResult {
  columns: string[];
  rows: Row[];
  /** The governed definition behind the data (metric contract, view descriptor, or term). */
  metric_definition: unknown;
  /** Baked-in filters, RLS scope, and the caller's narrowing filters — the full filter story. */
  filters_applied: unknown;
  row_count: number;
  truncated: boolean;
}

/** Column order: explicit `columns` if given, else the union of keys across rows (stable order). */
function deriveColumns(rows: Row[], columns?: string[]): string[] {
  if (columns) return columns;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/**
 * Apply the row cap and report truncation honestly. Callers should fetch `cap + 1` rows so a
 * full page can be distinguished from an exactly-cap page; pass the raw fetched rows here.
 */
export function buildResult(args: {
  rows: Row[];
  cap: number;
  columns?: string[];
  metricDefinition: unknown;
  filtersApplied: unknown;
}): ReadResult {
  const truncated = args.rows.length > args.cap;
  const rows = truncated ? args.rows.slice(0, args.cap) : args.rows;
  return {
    columns: deriveColumns(rows, args.columns),
    rows,
    metric_definition: args.metricDefinition,
    filters_applied: args.filtersApplied,
    row_count: rows.length,
    truncated,
  };
}

/** Is this a well-formed ReadResult? Used by the proof + unit tests. */
export function isReadResult(v: unknown): v is ReadResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r.columns) &&
    Array.isArray(r.rows) &&
    'metric_definition' in r &&
    'filters_applied' in r &&
    typeof r.row_count === 'number' &&
    typeof r.truncated === 'boolean'
  );
}
