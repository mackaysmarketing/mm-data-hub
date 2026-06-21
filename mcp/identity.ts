// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — CALLER IDENTITY (the security boundary). SPEC §5/§7, CLAUDE.md claim contract.
// ─────────────────────────────────────────────────────────────────────────────
// Identity is read ONLY from the server-controlled `app_metadata` namespace — IDENTICAL to
// DB migration 0010 and cube.js. A grower can only edit user_metadata / top-level claims, so a
// FORGED top-level `is_internal` / `consignor_id` is ignored here → fail closed (no scope).
//
// Identity enters the MCP from a TRUSTED channel (a host-signed token), never as a tool
// argument the model controls. No filter / group_by / run_select input can assert or widen it.
import crypto from 'node:crypto';
import { config } from './config.ts';
import { IdentityError } from './errors.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tier = 'internal' | 'grower-admin' | 'grower-user' | 'none';

export interface CallerIdentity {
  /** Grower key = consignor_id (uuid) or null. */
  readonly consignorId: string | null;
  /** Internal / service context → unscoped (sees all consignors). */
  readonly isInternal: boolean;
  /** Capability gate for the deferred sales surface (SPEC §7). */
  readonly canViewSales: boolean;
  readonly tier: Tier;
  /** Provenance, for logging/output only — never trusted for authz. */
  readonly source: string;
}

/** The fail-closed identity: no scope at all. Every data tool returns 0 rows / refuses. */
export const NONE_IDENTITY: CallerIdentity = {
  consignorId: null,
  isInternal: false,
  canViewSales: false,
  tier: 'none',
  source: 'none',
};

/** Has this caller ANY legitimate scope? Neither internal nor a valid consignor → false. */
export function hasScope(id: CallerIdentity): boolean {
  return id.isInternal || id.consignorId !== null;
}

/** The `app_metadata` object to carry into Cube tokens / Postgres request.jwt.claims. */
export function appMetadata(id: CallerIdentity): Record<string, unknown> {
  const am: Record<string, unknown> = {};
  if (id.isInternal) am.is_internal = true;
  if (id.consignorId) am.consignor_id = id.consignorId;
  if (id.canViewSales) am.can_view_sales = true;
  return am;
}

/** The exact JSON set as Postgres `request.jwt.claims` (app_metadata-only, like PostgREST). */
export function claimsJson(id: CallerIdentity): string {
  return JSON.stringify({ app_metadata: appMetadata(id) });
}

/** Human-readable scope description for `filters_applied` (never a security decision). */
export function scopeLabel(id: CallerIdentity): string {
  if (id.isInternal) return 'internal (unscoped — all consignors)';
  if (id.consignorId) return `grower-scoped to consignor_id=${id.consignorId}`;
  return 'no scope (fail closed — 0 rows)';
}

/**
 * Build a CallerIdentity from a raw security context, reading app_metadata ONLY.
 * This is the single funnel: tokens, tests, and the proof all go through here, so the
 * forged-top-level-claim rejection is guaranteed everywhere.
 */
export function identityFromSecurityContext(
  sc: Record<string, unknown> | null | undefined,
  source = 'context',
): CallerIdentity {
  const am = (sc && typeof sc === 'object' ? (sc as Record<string, unknown>).app_metadata : null) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!am || typeof am !== 'object') return NONE_IDENTITY;

  const rawConsignor = am.consignor_id;
  const consignorId =
    typeof rawConsignor === 'string' && UUID_RE.test(rawConsignor) ? rawConsignor : null;

  const isInternal = truthy(am.is_internal);
  const canViewSales = truthy(am.can_view_sales);

  if (!isInternal && consignorId === null) return NONE_IDENTITY;

  const tier: Tier = isInternal
    ? 'internal'
    : am.tier === 'grower-admin'
      ? 'grower-admin'
      : 'grower-user';

  return { consignorId, isInternal, canViewSales, tier, source };
}

function truthy(v: unknown): boolean {
  return (
    v === true ||
    v === 1 ||
    (typeof v === 'string' && ['true', 't', '1', 'yes'].includes(v.toLowerCase()))
  );
}

// ── Inbound caller-token verification (HS256) ────────────────────────────────
// The host presents HUB_MCP_CALLER_TOKEN — a signed JWT whose payload carries app_metadata.
// We verify the signature + exp with the caller secret, then funnel through the SAME
// app_metadata-only reader. Any failure → NONE_IDENTITY (the server still runs, but fails closed).

const b64urlJson = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Sign a caller token (used by the proof / tests / a host to mint identities). */
export function signCallerToken(
  securityContext: Record<string, unknown>,
  secret: string,
  ttlSeconds = 600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ ...securityContext, iat: now, exp: now + ttlSeconds });
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verify + decode an inbound caller token into a CallerIdentity. Throws IdentityError on tamper. */
export function verifyCallerToken(token: string, secret: string): CallerIdentity {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityError('Malformed caller token (expected 3 JWT segments)');
  const [header, payload, sig] = parts as [string, string, string];
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  // constant-time compare; mismatched lengths are an immediate fail.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new IdentityError('Caller token signature invalid');
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new IdentityError('Caller token payload is not valid JSON');
  }
  const exp = claims.exp;
  if (typeof exp === 'number' && exp < Math.floor(Date.now() / 1000)) {
    throw new IdentityError('Caller token expired');
  }
  return identityFromSecurityContext(claims, 'token');
}

/**
 * Resolve the session identity from the environment-provided caller token.
 * No token → NONE (fail closed). Invalid token → NONE (logged), never elevated.
 */
export function resolveSessionIdentity(): CallerIdentity {
  const token = config.callerToken();
  if (!token) return NONE_IDENTITY;
  try {
    return verifyCallerToken(token, config.callerSecret());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[hub-mcp] caller token rejected (${msg}) → fail closed`);
    return NONE_IDENTITY;
  }
}
