// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — run_select GUARD (the escape hatch). SPEC §5.
// Allowed: a SINGLE read-only SELECT / WITH…SELECT referencing ONLY the `semantic.` schema.
// Rejected: DDL/DML, multiple statements, non-semantic schema references, catalog probing.
//
// Defense in depth: even if a string slips past this guard, the query runs as `authenticated`
// (via db.ts), which is granted SELECT on `semantic.grower_dispatch_detail` ONLY and is fully
// RLS-scoped — so it can neither write nor read another consignor's rows. The guard is the
// first wall; the role + RLS are the backstop.
// ─────────────────────────────────────────────────────────────────────────────
import { LIMITS } from './config.ts';
import { ValidationError } from './errors.ts';

const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke',
  'merge', 'call', 'do', 'copy', 'vacuum', 'analyze', 'reindex', 'cluster', 'refresh',
  'comment', 'set', 'reset', 'begin', 'start', 'commit', 'rollback', 'savepoint', 'lock',
  'prepare', 'execute', 'deallocate', 'listen', 'notify', 'unlisten', 'discard', 'fetch',
  'declare', 'into', 'returning',
];

// Any schema reference that is NOT `semantic.` is rejected outright.
const FORBIDDEN_SCHEMAS = [
  'raw', 'core', 'public', 'auth', 'storage', 'extensions', 'graphql', 'graphql_public',
  'realtime', 'vault', 'pgsodium', 'pg_catalog', 'pg_temp', 'pg_toast', 'information_schema',
];

/** Strip -- line comments and block comments so they can't hide forbidden tokens. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

export interface GuardedSelect {
  /** The capped, wrapped SQL ready to run. */
  sql: string;
  /** The cap actually applied (rows fetched = cap + 1 to detect truncation). */
  cap: number;
}

/**
 * Validate `sql` is a safe single read-only SELECT over semantic.* and wrap it with a row cap.
 * Throws ValidationError on anything disallowed.
 */
export function guardSelect(rawSql: string, limit?: number): GuardedSelect {
  if (typeof rawSql !== 'string' || rawSql.trim() === '') {
    throw new ValidationError('run_select requires a non-empty SQL string');
  }
  const cleaned = stripComments(rawSql).trim();
  const noTrailingSemi = cleaned.replace(/;\s*$/, '');

  // Single statement only: no internal semicolons once the trailing one is removed.
  if (noTrailingSemi.includes(';')) {
    throw new ValidationError('run_select allows a single statement only (no “;”-separated statements)');
  }

  const lowered = noTrailingSemi.toLowerCase();

  // Must be a read query.
  if (!/^\s*(select|with)\b/.test(lowered)) {
    throw new ValidationError('run_select allows only SELECT / WITH…SELECT queries');
  }

  // Whole-word forbidden keyword scan (DDL/DML/transaction/session verbs).
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(lowered)) {
      throw new ValidationError(`run_select rejected: keyword “${kw}” is not allowed (read-only, semantic.* only)`);
    }
  }

  // Schema discipline: reject any non-semantic schema-qualified reference.
  for (const schema of FORBIDDEN_SCHEMAS) {
    if (new RegExp(`\\b${schema}\\s*\\.`, 'i').test(noTrailingSemi)) {
      throw new ValidationError(`run_select rejected: only the “semantic.” schema may be referenced (found “${schema}.”)`);
    }
  }
  // Must positively reference semantic.* — prevents unqualified or function-only probing.
  if (!/\bsemantic\s*\./i.test(noTrailingSemi)) {
    throw new ValidationError('run_select must reference the semantic schema (e.g. semantic.grower_dispatch_detail)');
  }

  const cap = Math.min(Math.max(1, limit ?? LIMITS.DEFAULT_ROWS), LIMITS.MAX_ROWS);
  // Wrap so any inner ORDER BY/LIMIT is preserved while we enforce the hard cap (+1 to detect truncation).
  const sql = `select * from (\n${noTrailingSemi}\n) as _hub_mcp_capped limit ${cap + 1}`;
  return { sql, cap };
}
