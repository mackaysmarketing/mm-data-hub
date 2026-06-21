// ─────────────────────────────────────────────────────────────────────────────
// NetSuite TBA smoke — the live OAuth 1.0a gate. Proves the SIGNED SuiteQL request
// authenticates against the live endpoint and returns real rows, BEFORE any loader is
// written (de-risk the hardest part first). Prints HTTP status + row counts only —
// never credentials, never row PII.
//
//   npm run ns:smoke        (needs NS_ACCOUNT_ID + NS_CONSUMER_KEY/SECRET + NS_TOKEN_ID/SECRET)
//
// Exit 0 = signed request authenticated (200) + real rows; 1 = auth/other failure.
// ─────────────────────────────────────────────────────────────────────────────
import { suiteqlPage, suiteqlUrl } from '../src/lib/netsuite.ts';
import { env } from '../src/lib/env.ts';

async function main(): Promise<void> {
  console.log('=== NetSuite TBA smoke (live SuiteQL, read-only) ===');
  console.log(`endpoint: ${suiteqlUrl()}  (account ${env.nsAccountId()})\n`);

  // 1) Trivial: a transaction-type histogram — proves auth + a non-empty result set.
  const types = await suiteqlPage<{ type: string; cnt: number }>(
    'SELECT type, COUNT(*) AS cnt FROM transaction GROUP BY type',
  );
  const vendBill = types.items.find((r) => r.type === 'VendBill');
  console.log(`PASS  transaction types: ${types.items.length} groups; VendBill cnt=${vendBill?.cnt ?? '—'}`);

  // 2) The RCTI universe: category-110 VendBills in subsidiary 2.
  const cat = env.nsGrowerVendorCategory();
  const sub = env.nsSubsidiaryId();
  const rcti = await suiteqlPage<{ rcti_count: number; growers: number }>(
    `SELECT COUNT(*) AS rcti_count, COUNT(DISTINCT t.entity) AS growers
       FROM transaction t
      WHERE t.type='VendBill'
        AND t.entity IN (SELECT id FROM vendor WHERE category=${Number(cat)})`,
  );
  const row = rcti.items[0];
  console.log(`PASS  category-${cat} RCTIs (subsidiary ${sub} target): count=${row?.rcti_count} growers=${row?.growers}`);

  if (!vendBill || (row?.rcti_count ?? 0) <= 0) {
    throw new Error('Authenticated but expected rows were empty — investigate before building the loader.');
  }
  console.log('\n=== SMOKE PASS — signed TBA request authenticated, 200 OK, real rows. ===');
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e instanceof Error ? e.message : e);
  // Set the code and let the loop drain (avoids a libuv teardown assertion on Windows when
  // process.exit races an in-flight socket close).
  process.exitCode = 1;
});
