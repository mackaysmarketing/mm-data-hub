// NetSuite RCTI / grower-settlement extractor → raw.ns_* (Sprint 5).
//
// READ-ONLY out of NetSuite (SuiteQL SELECT only). Scoped to grower RCTIs:
//   transaction.type='VendBill' AND entity IN (category-110 vendors)  +  their lines, payments, links.
// Subsidiary-2 scope is transitive (all 39 category-110 vendors are subsidiary 2).
//
//   npm run ns:backfill                  full backfill (FY26: 1,095 RCTIs)
//   npm run ns:backfill -- --since=YYYY-MM-DD   incremental by lastmodifieddate (change capture)
//
// Idempotent: every stream upserts on its PK, so re-running is a no-op for unchanged rows.
// The incremental key is lastmodifieddate (a bill mutates after trandate — deductions corrected,
// approval, payment application flips status — none of which move trandate).
import type { Pool, PoolClient } from 'pg';
import { makePool, upsertNodes, beginWindow, completeWindow, failWindow } from '../lib/db.ts';
import { suiteqlAll } from '../lib/netsuite.ts';
import {
  nsSelectList, type NsSpec,
  nsVendorSpec, nsItemSpec, nsBillSpec, nsBillLineSpec, nsPaymentSpec, nsBillPaymentLinkSpec,
} from '../lib/ns_specs.ts';
import { env } from '../lib/env.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;

const CAT = () => Number(env.nsGrowerVendorCategory());
const SUB = () => Number(env.nsSubsidiaryId());

/** Grower-RCTI bill-id subquery, optionally restricted to bills changed since `sinceIso`. */
function growerBillIds(sinceIso?: string): string {
  const since = sinceIso ? ` AND lastmodifieddate >= TO_DATE('${sinceIso}','YYYY-MM-DD')` : '';
  return `SELECT id FROM transaction WHERE type='VendBill' AND entity IN (SELECT id FROM vendor WHERE category=${CAT()})${since}`;
}

/** Build the SuiteQL for each stream. `since` (ISO date) switches full → incremental. */
function queries(sinceIso?: string): Record<string, { spec: NsSpec; sql: string }> {
  const lmd = (col = 'lastmodifieddate') =>
    sinceIso ? ` AND ${col} >= TO_DATE('${sinceIso}','YYYY-MM-DD')` : '';
  return {
    // Dimensions: small, refreshed in full every run.
    ns_vendor: {
      spec: nsVendorSpec,
      sql: `SELECT ${nsSelectList(nsVendorSpec)} FROM vendor WHERE category=${CAT()} ORDER BY id`,
    },
    ns_item: {
      spec: nsItemSpec,
      sql: `SELECT ${nsSelectList(nsItemSpec)} FROM item ORDER BY id`,
    },
    // Facts: full, or restricted by lastmodifieddate when incremental.
    ns_vendor_bill: {
      spec: nsBillSpec,
      sql: `SELECT ${nsSelectList(nsBillSpec)} FROM transaction
            WHERE type='VendBill' AND entity IN (SELECT id FROM vendor WHERE category=${CAT()})${lmd()}
            ORDER BY id`,
    },
    ns_vendor_bill_line: {
      spec: nsBillLineSpec,
      sql: `SELECT ${nsSelectList(nsBillLineSpec)} FROM transactionline
            WHERE transaction IN (${growerBillIds(sinceIso)})
            ORDER BY uniquekey`,
    },
    ns_vendor_payment: {
      spec: nsPaymentSpec,
      sql: `SELECT ${nsSelectList(nsPaymentSpec)} FROM transaction
            WHERE type='VendPymt' AND entity IN (SELECT id FROM vendor WHERE category=${CAT()})${lmd()}
            ORDER BY id`,
    },
    ns_bill_payment_link: {
      spec: nsBillPaymentLinkSpec,
      sql: `SELECT ${nsSelectList(nsBillPaymentLinkSpec)} FROM previoustransactionlinelink
            WHERE linktype='Payment' AND previoustype='VendBill'
              AND previousdoc IN (SELECT id FROM transaction WHERE type='VendBill' AND entity IN (SELECT id FROM vendor WHERE category=${CAT()}))${lmd()}
            ORDER BY previousdoc, nextdoc, previousline, nextline`,
    },
  };
}

/** REST responses carry a per-row `links` array (HATEOAS) — strip it before landing. */
function clean(nodes: Node[]): Node[] {
  return nodes.map((n) => {
    const { links: _drop, ...rest } = n as Node & { links?: unknown };
    return rest;
  });
}

export interface StreamResult { stream: string; seen: number; upserted: number; }

// Upsert in batches — a single INSERT…SELECT over a multi-MB JSON parameter (e.g. the ~22k line
// rows) exceeds the pooler's statement limits and drops the connection. 1000 rows/batch is safe.
const UPSERT_BATCH = 1000;
async function upsertBatched(client: PoolClient, spec: NsSpec, nodes: Node[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < nodes.length; i += UPSERT_BATCH) {
    total += await upsertNodes(client, spec, nodes.slice(i, i + UPSERT_BATCH));
  }
  return total;
}

async function loadStream(
  pool: Pool,
  stream: string,
  spec: NsSpec,
  sql: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<StreamResult> {
  // Fetch from NetSuite WITHOUT holding a DB connection — a connection left idle through a long
  // multi-page fetch gets dropped by the pooler, killing the later upsert. Connect only to write.
  const nodes = clean(await suiteqlAll<Node>(sql, 1000));
  const client = await pool.connect();
  try {
    await beginWindow(client, stream, windowStart, windowEnd);
    const upserted = await upsertBatched(client, spec, nodes);
    await completeWindow(client, stream, windowStart, { seen: nodes.length, upserted });
    return { stream, seen: nodes.length, upserted };
  } catch (e) {
    try {
      await failWindow(client, stream, windowStart, e instanceof Error ? e.message : String(e));
    } catch { /* connection may be gone */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function loadSettlement(pool: Pool, sinceIso?: string): Promise<StreamResult[]> {
  // window_start encodes the mode: the since-date (incremental) or the FY start (full backfill).
  const windowStart = new Date(`${sinceIso ?? env.backfillStart()}T00:00:00Z`);
  const windowEnd = new Date();
  const qs = queries(sinceIso);
  const order = [
    'ns_vendor', 'ns_item', 'ns_vendor_bill', 'ns_vendor_bill_line', 'ns_vendor_payment', 'ns_bill_payment_link',
  ];
  const results: StreamResult[] = [];
  for (const stream of order) {
    const q = qs[stream]!;
    const r = await loadStream(pool, stream, q.spec, q.sql, windowStart, windowEnd);
    log(`  ${stream}: seen=${r.seen} upserted=${r.upserted}`);
    results.push(r);
  }
  return results;
}

if (isMain(import.meta.url)) {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const pool = makePool();
  try {
    log(`NetSuite settlement load (subsidiary ${SUB()}, category ${CAT()})${sinceArg ? ` since ${sinceArg}` : ' — full backfill'}`);
    const results = await loadSettlement(pool, sinceArg);
    const total = results.reduce((n, r) => n + r.upserted, 0);
    log(`done: ${results.length} streams, ${total} rows upserted`);
  } finally {
    await pool.end();
  }
}
