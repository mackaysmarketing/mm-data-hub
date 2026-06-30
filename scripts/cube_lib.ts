// Shared helpers for the Cube proof scripts: HS256 token signing + REST /load client.
// No external deps — Node's built-in fetch + crypto. Reads CUBE_API_URL / CUBE_API_SECRET
// from the repo-root .env (gitignored).
import 'dotenv/config';
import crypto from 'node:crypto';

export interface SecurityContext {
  app_metadata?: { consignor_id?: string; is_internal?: boolean | string };
  // top-level claims are intentionally NOT trusted by cube.js — used only to PROVE that.
  consignor_id?: string;
  is_internal?: boolean | string;
}

export interface CubeQuery {
  measures?: string[];
  dimensions?: string[];
  timeDimensions?: unknown[];
  filters?: unknown[];
  order?: unknown;
  limit?: number;
}

export type CubeRow = Record<string, string | number | null>;

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function cubeApiUrl(): string {
  const u = process.env.CUBE_API_URL;
  if (!u) throw new Error('Missing CUBE_API_URL (see .env / .env.example)');
  return u.replace(/\/+$/, '');
}

function cubeSecret(): string {
  const s = process.env.CUBE_API_SECRET;
  if (!s || s.startsWith('REPLACE')) throw new Error('Missing CUBE_API_SECRET (see .env / .env.example)');
  return s;
}

/** Sign an HS256 Cube token. The WHOLE JWT payload becomes the Cube securityContext. */
export function signToken(securityContext: SecurityContext): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ ...securityContext, iat: now, exp: now + 600 });
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', cubeSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** POST /load, retrying while Cube warms cache/pre-aggs ("Continue wait"). */
export async function cubeLoad(query: CubeQuery, securityContext: SecurityContext): Promise<CubeRow[]> {
  const token = signToken(securityContext);
  const url = `${cubeApiUrl()}/load`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    let body: { data?: CubeRow[]; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Cube non-JSON (${res.status}): ${text.slice(0, 300)}`);
    }
    if (res.status === 200 && Array.isArray(body.data)) return body.data;
    if (body && body.error === 'Continue wait') {
      await sleep(1000);
      continue;
    }
    throw new Error(`Cube error (${res.status}): ${JSON.stringify(body).slice(0, 500)}`);
  }
  throw new Error('Cube /load kept returning "Continue wait" after 30 tries');
}

/** GET /meta — the built model's catalog. Returns the cubes/views array verbatim. */
export async function cubeMeta(securityContext: SecurityContext): Promise<any> {
  const token = signToken(securityContext);
  const res = await fetch(`${cubeApiUrl()}/meta`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Cube /meta non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status !== 200) throw new Error(`Cube /meta error (${res.status}): ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

/** Single scalar measure; returns null verbatim (never coalesced) so null integrity is testable. */
export async function scalar(measure: string, ctx: SecurityContext, extra: Partial<CubeQuery> = {}): Promise<number | null> {
  const rows = await cubeLoad({ measures: [measure], ...extra }, ctx);
  const v = rows[0]?.[measure];
  return v == null ? null : Number(v);
}

// Security contexts.
export const ctxInternal: SecurityContext = { app_metadata: { is_internal: true } };
export const ctxGrower = (consignorId: string): SecurityContext => ({ app_metadata: { consignor_id: consignorId } });

// Grower contexts for the proofs — confirmed non-test consignors with disjoint row sets.
export const GROWER_A = { code: 'MMLAR', name: 'MM Larapinta', id: '0191e996-93b7-fcd1-170e-87c6aa517087' };
export const GROWER_B = { code: 'MMTRU', name: 'MM Truganina', id: '0191f981-c9dc-4203-4f1b-3e9c5f5758d3' };
