// Minimal FreshTrack GraphQL client. The API is filterLimit-only (no cursor) — callers
// paginate by time window. Uses global fetch (Node ≥ 18).
import { env } from './env.ts';

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

class FreshTrackError extends Error {
  constructor(message: string, readonly errors?: GraphQLError[]) {
    super(message);
    this.name = 'FreshTrackError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

/** POST a GraphQL operation. Retries transient network/5xx failures with backoff. */
export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 1,
): Promise<T> {
  const maxAttempts = 4;
  let res: Response;
  try {
    res = await fetch(env.freshtrackUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: env.freshtrackAuth(),
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    if (attempt < maxAttempts) return retry(query, variables, attempt, e);
    throw new FreshTrackError(`Network error after ${maxAttempts} attempts: ${String(e)}`);
  }

  if (res.status >= 500 && attempt < maxAttempts) {
    return retry(query, variables, attempt, new Error(`HTTP ${res.status}`));
  }
  if (!res.ok) {
    throw new FreshTrackError(`HTTP ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new FreshTrackError(body.errors.map((e) => e.message).join('; '), body.errors);
  }
  if (body.data === undefined) throw new FreshTrackError('GraphQL response had no data');
  return body.data;
}

function retry<T>(
  query: string,
  variables: Record<string, unknown>,
  attempt: number,
  cause: unknown,
): Promise<T> {
  const delayMs = 500 * 2 ** (attempt - 1);
  process.stderr.write(`  freshtrack retry ${attempt} after ${delayMs}ms (${String(cause)})\n`);
  return new Promise((resolve) =>
    setTimeout(() => resolve(gql<T>(query, variables, attempt + 1)), delayMs),
  );
}
