// OAuth 1.0a request signing (RFC 5849) — dependency-free, for NetSuite Token-Based Auth.
//
// NetSuite TBA is three-legged OAuth 1.0a with HMAC-SHA256 and a `realm` = the account id.
// The signature is computed over the HTTP method, the base URL (NO query string), and the
// normalized parameter set (oauth_* params + any URL query params such as limit/offset). The
// JSON request body is NOT form-encoded, so per RFC 5849 §3.4.1.3 it is excluded from the
// signature — only application/x-www-form-urlencoded bodies are signed.
//
// Pure + unit-tested against the published Twitter OAuth 1.0a example (an HMAC-SHA1 known-answer
// vector), so the percent-encoding → base-string → HMAC pipeline is proven correct independent of
// the hash. Production signs with HMAC-SHA256 (the `algorithm` knob only varies for that KAT).
// No external deps — Node's crypto only. No TS parameter-properties/enums (erasable-TS safe so it
// runs under `node --experimental-strip-types`).
import crypto from 'node:crypto';

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
  /** NetSuite account id, used as the OAuth `realm`. */
  realm: string;
}

export interface OAuth1Options {
  /** Fixed nonce (tests/KAT); otherwise a random 128-bit hex string. */
  nonce?: string;
  /** Fixed timestamp in epoch seconds (tests/KAT); otherwise now. */
  timestamp?: string;
  /** 'sha256' for NetSuite (default); 'sha1' only for the published KAT. */
  algorithm?: 'sha256' | 'sha1';
}

export interface SignedRequest {
  /** The full `Authorization: OAuth …` header value. */
  authorization: string;
  /** The signature base string (exposed for test assertions / debugging). */
  baseString: string;
  /** The oauth_* params incl. oauth_signature (exposed for assertions). */
  oauthParams: Record<string, string>;
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!*'()` unescaped (and they are NOT in
 * the RFC 3986 unreserved set), while it correctly leaves `-_.~`. We additionally escape `!*'()`.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * RFC 5849 §3.4.1: signature base string = METHOD & pct(base-url) & pct(normalized-params).
 * `url` MUST be the base URL with no query string; query params belong in `params`. Params are
 * percent-encoded, then sorted by encoded key (ties broken by encoded value), then joined.
 */
export function signatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const normalized = Object.keys(params)
    .map((k): [string, string] => [percentEncode(k), percentEncode(params[k] ?? '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), percentEncode(url), percentEncode(normalized)].join('&');
}

/** HMAC sign a base string with key = pct(consumerSecret)&pct(tokenSecret); base64 digest. */
export function sign(
  baseString: string,
  consumerSecret: string,
  tokenSecret: string,
  algorithm: 'sha256' | 'sha1' = 'sha256',
): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac(algorithm, key).update(baseString, 'utf8').digest('base64');
}

/**
 * Build the full `Authorization: OAuth …` header for a request. `url` is the base URL (no query);
 * `queryParams` are the URL query params that must participate in the signature (limit/offset).
 */
export function buildAuthHeader(
  method: string,
  url: string,
  queryParams: Record<string, string>,
  creds: OAuth1Credentials,
  opts: OAuth1Options = {},
): SignedRequest {
  const algorithm = opts.algorithm ?? 'sha256';
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.tokenId,
    oauth_signature_method: algorithm === 'sha256' ? 'HMAC-SHA256' : 'HMAC-SHA1',
    oauth_timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_nonce: opts.nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  // Sign over query params + oauth params (NOT the JSON body).
  const baseString = signatureBaseString(method, url, { ...queryParams, ...oauth });
  const oauth_signature = sign(baseString, creds.consumerSecret, creds.tokenSecret, algorithm);

  const headerParams: Record<string, string> = { ...oauth, oauth_signature };
  // `realm` is not part of the signature; it leads the header. Remaining params sorted for stability.
  const header =
    `OAuth realm="${percentEncode(creds.realm)}", ` +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k] ?? '')}"`)
      .join(', ');

  return { authorization: header, baseString, oauthParams: headerParams };
}
