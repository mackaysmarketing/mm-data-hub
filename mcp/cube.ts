// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — Cube REST client (the METRIC path). SPEC §4/§5.
// Every call signs a SHORT-LIVED, PER-CALLER Cube JWT carrying the caller's app_metadata.
// Cube's queryRewrite (cube.js) scopes the query to that consignor — the SAME contract as
// migration 0010. The MCP never holds a standing Cube session; identity propagates per call.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { config } from './config.ts';
import { appMetadata, type CallerIdentity } from './identity.ts';

export type CubeRow = Record<string, string | number | null>;

export interface CubeQuery {
  measures?: string[];
  dimensions?: string[];
  timeDimensions?: Array<{ dimension: string; granularity?: string; dateRange?: string[] | string }>;
  filters?: Array<{ member: string; operator: string; values?: string[] }>;
  order?: Record<string, 'asc' | 'desc'> | Array<[string, 'asc' | 'desc']>;
  limit?: number;
  total?: boolean;
}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sign a per-caller Cube token. ONLY app_metadata travels — Cube reads nothing else for RLS. */
export function signCubeToken(id: CallerIdentity): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ app_metadata: appMetadata(id), iat: now, exp: now + 120 });
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', config.cubeApiSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export interface CubeClient {
  load(query: CubeQuery, id: CallerIdentity): Promise<CubeRow[]>;
  meta(id: CallerIdentity): Promise<CubeMetaCube[]>;
}

export interface CubeMetaMember {
  name: string;
  title?: string;
  shortTitle?: string;
  description?: string;
  type?: string;
  format?: string;
  meta?: unknown;
}
export interface CubeMetaCube {
  name: string;
  public?: boolean;
  measures: CubeMetaMember[];
  dimensions: CubeMetaMember[];
}

/** POST /load, retrying while Cube warms its cache ("Continue wait").
 *  renewQuery: the MCP is a low-QPS governed surface — a stale cached answer is worse than the
 *  extra Cube work, and Cube's per-query-shape result cache refreshes lazily (observed serving
 *  pre-load counts for some token shapes ~45 min after an ingest while others were fresh). Forcing
 *  renewal makes every governed read, and the mcp:proof parity checks, deterministic vs the hub. */
async function load(query: CubeQuery, id: CallerIdentity): Promise<CubeRow[]> {
  const token = signCubeToken(id);
  const url = `${config.cubeApiUrl()}/load`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { ...query, renewQuery: true } }),
    });
    const text = await res.text();
    let body: { data?: CubeRow[]; error?: string };
    try {
      body = JSON.parse(text) as { data?: CubeRow[]; error?: string };
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

async function meta(id: CallerIdentity): Promise<CubeMetaCube[]> {
  const res = await fetch(`${config.cubeApiUrl()}/meta`, {
    headers: { Authorization: signCubeToken(id) },
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`Cube /meta error (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { cubes?: CubeMetaCube[] };
  return body.cubes ?? [];
}

export const cubeClient: CubeClient = { load, meta };
