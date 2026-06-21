// NetSuite SuiteQL REST client over OAuth 1.0a TBA. Read-only — this client only ever POSTs
// SuiteQL SELECTs to the query endpoint; it never touches the record (write) REST API.
//
// Endpoint: https://<acct>.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql
//   - POST, body {"q": "<SuiteQL>"}, header `Prefer: transient` (no saved query persisted).
//   - Pagination is offset-based via the URL query params `limit` (≤1000) and `offset`; those
//     params are part of the OAuth signature (see oauth1.signatureBaseString).
//   - Response: { items, count, hasMore, offset, totalResults, links }.
import { env } from './env.ts';
import { buildAuthHeader, type OAuth1Credentials } from './oauth1.ts';

export interface SuiteQLPage<T> {
  items: T[];
  count: number;
  offset: number;
  hasMore: boolean;
  totalResults: number;
}

class NetSuiteError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = 'NetSuiteError';
  }
}

function creds(): OAuth1Credentials {
  return {
    consumerKey: env.nsConsumerKey(),
    consumerSecret: env.nsConsumerSecret(),
    tokenId: env.nsTokenId(),
    tokenSecret: env.nsTokenSecret(),
    realm: env.nsAccountId(),
  };
}

/** The SuiteQL base URL (no query string — query params are added per request + signed). */
export function suiteqlUrl(): string {
  return `https://${env.nsAccountId()}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
}

/** Fetch one page of a SuiteQL query. Retries transient network/5xx/429 with backoff. */
export async function suiteqlPage<T = Record<string, unknown>>(
  sql: string,
  limit = 1000,
  offset = 0,
  attempt = 1,
): Promise<SuiteQLPage<T>> {
  const maxAttempts = 4;
  const url = suiteqlUrl();
  const queryParams = { limit: String(limit), offset: String(offset) };
  // A fresh nonce/timestamp + signature per attempt.
  const { authorization } = buildAuthHeader('POST', url, queryParams, creds());

  let res: Response;
  try {
    res = await fetch(`${url}?limit=${limit}&offset=${offset}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json',
        prefer: 'transient',
      },
      body: JSON.stringify({ q: sql }),
    });
  } catch (e) {
    if (attempt < maxAttempts) return retry(sql, limit, offset, attempt, String(e));
    throw new NetSuiteError(`Network error after ${maxAttempts} attempts: ${String(e)}`);
  }

  if ((res.status >= 500 || res.status === 429) && attempt < maxAttempts) {
    return retry(sql, limit, offset, attempt, `HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new NetSuiteError(`SuiteQL HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`, res.status);
  }

  const body = (await res.json()) as Partial<SuiteQLPage<T>> & { items?: T[] };
  const items = body.items ?? [];
  return {
    items,
    count: body.count ?? items.length,
    offset: body.offset ?? offset,
    hasMore: body.hasMore ?? false,
    totalResults: body.totalResults ?? items.length,
  };
}

function retry<T>(
  sql: string,
  limit: number,
  offset: number,
  attempt: number,
  cause: string,
): Promise<SuiteQLPage<T>> {
  const delayMs = 500 * 2 ** (attempt - 1);
  process.stderr.write(`  netsuite retry ${attempt} after ${delayMs}ms (${cause})\n`);
  return new Promise((resolve) =>
    setTimeout(() => resolve(suiteqlPage<T>(sql, limit, offset, attempt + 1)), delayMs),
  );
}

/** Walk every page of a SuiteQL query (offset pagination). Guards against a non-advancing page. */
export async function suiteqlAll<T = Record<string, unknown>>(
  sql: string,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await suiteqlPage<T>(sql, pageSize, offset);
    out.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.count || page.items.length;
  }
  return out;
}
