// Centralised, validated environment access. Secrets live in .env (gitignored).
import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : fallback;
}

export const env = {
  freshtrackUrl: () => required('FRESHTRACK_GRAPHQL_URL'),
  freshtrackAuth: () => required('FRESHTRACK_AUTH_HEADER'),
  databaseUrl: () => required('DATABASE_URL'),

  backfillStart: () => optional('BACKFILL_START', '2025-07-01'),
  // Blank BACKFILL_END means "today" (UTC) — resolved by the caller.
  backfillEnd: () => process.env.BACKFILL_END?.trim() || null,
  windowDays: () => Number(optional('WINDOW_DAYS', '7')),
  filterLimit: () => Number(optional('FRESHTRACK_FILTER_LIMIT', '2000')),

  // ── NetSuite (settlement / RCTI domain, Sprint 5) ──────────────────────────
  // Token-Based Auth (OAuth 1.0a, HMAC-SHA256). Account id doubles as the OAuth realm.
  // Read-only integration role; secrets live only in .env (gitignored).
  nsAccountId: () => required('NS_ACCOUNT_ID'),
  nsConsumerKey: () => required('NS_CONSUMER_KEY'),
  nsConsumerSecret: () => required('NS_CONSUMER_SECRET'),
  nsTokenId: () => required('NS_TOKEN_ID'),
  nsTokenSecret: () => required('NS_TOKEN_SECRET'),
  // NetSuite-side scoping for the RCTI extractor.
  nsSubsidiaryId: () => optional('NS_SUBSIDIARY_ID', '2'), // Mackays Marketing
  nsGrowerVendorCategory: () => optional('NS_GROWER_VENDOR_CATEGORY', '110'), // Growers
};

// The test consignors excluded at pull (SPEC §9.6). Resolved dynamically from the entity
// master at load time; these IDs are the confirmed fallback (codes TRUGTEST/LARATEST/ANNRTEST).
export const KNOWN_TEST_CONSIGNOR_IDS: readonly string[] = [
  '0196ccf2-b8d1-15c4-06ae-c09a10e8f722', // TRUGTEST
  '0196cd8d-8298-e55a-6c14-aaab4cbae095', // LARATEST
  '0196cd8e-45e8-5404-46c6-edbc24616938', // ANNRTEST
];
