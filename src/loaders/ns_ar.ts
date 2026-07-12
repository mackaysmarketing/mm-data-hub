// NetSuite ACCOUNTS-RECEIVABLE extractor → raw.ns_customer_* (AR sprint, chunk C2).
//
// READ-ONLY out of NetSuite (SuiteQL SELECT only). The debtor/cash mirror of customer invoices:
//   customers   WHERE subsidiary=2                                (127 debtors)
//   invoices    WHERE type='CustInvc' AND entity IN (those)       + their lines
//   payments    WHERE type='CustPymt' AND entity IN (those)
//   credits     WHERE type='CustCred' AND entity IN (those)
//   apply-links WHERE previoustype='CustInvc' (payments AND credits against an invoice)
//
// Subsidiary-2 scope is transitive through the customer filter (the REST `transaction` schema has no
// subsidiary column). Idempotent: every stream upserts on its PK, so re-running is a no-op for
// unchanged rows. Incremental key = transaction.lastmodifieddate (an invoice/payment/credit mutates
// after trandate — applied, credited, paid — none of which move trandate); the apply-link stream is
// incremental on the link's own lastmodifieddate.
//
//   npm run ns:ar:load                        full backfill
//   npm run ns:ar:load -- --since=YYYY-MM-DD  incremental by lastmodifieddate (change capture)
//
// The REST SuiteQL column names were confirmed live via a read-only probe before this loader was
// written. Dates arrive DD/MM/YYYY and are formatted ISO in the SELECT (TO_CHAR) so they parse
// unambiguously into Postgres date. All ids are landed as text (the AR set stays text end-to-end).
import type { Pool, PoolClient } from 'pg';
import {
  makePool, assertHubTarget, upsertNodes, beginWindow, completeWindow, failWindow,
} from '../lib/db.ts';
import { suiteqlAll } from '../lib/netsuite.ts';
import { nsSelectList, type NsSpec } from '../lib/ns_specs.ts';
import { env } from '../lib/env.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;

const SUB = () => env.nsSubsidiaryId(); // '2' (Mackays Marketing) — compared as text

const isoDate = (col: string) => `TO_CHAR(${col},'YYYY-MM-DD')`;

// ── Landing specs (AR set: all ids text; mainline/taxline text; dates ISO via isoDate) ───────────
const nsCustomerSpec: NsSpec = {
  schema: 'raw', table: 'ns_customer', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'entityid', key: 'entityid', kind: 'text' },
    { col: 'companyname', key: 'companyname', kind: 'text' },
    { col: 'externalid', key: 'externalid', kind: 'text' },
    { col: 'subsidiary', key: 'subsidiary', kind: 'text' },
    { col: 'isinactive', key: 'isinactive', kind: 'text' },
  ],
};

const nsCustomerInvoiceSpec: NsSpec = {
  schema: 'raw', table: 'ns_customer_invoice', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'tranid', key: 'tranid', kind: 'text' },
    { col: 'externalid', key: 'externalid', kind: 'text' },
    { col: 'trandate', key: 'trandate', kind: 'date', select: isoDate('trandate') },
    { col: 'entity', key: 'entity', kind: 'text' },
    { col: 'foreigntotal', key: 'foreigntotal', kind: 'numeric' },
    { col: 'status', key: 'status', kind: 'text' },
    { col: 'otherrefnum', key: 'otherrefnum', kind: 'text' },
  ],
};

const nsCustomerInvoiceLineSpec: NsSpec = {
  schema: 'raw', table: 'ns_customer_invoice_line', idColumn: 'uniquekey', withRaw: false,
  columns: [
    { col: 'uniquekey', key: 'uniquekey', kind: 'text' },
    { col: 'transaction', key: 'transaction', kind: 'text' },
    { col: 'mainline', key: 'mainline', kind: 'text' },
    { col: 'taxline', key: 'taxline', kind: 'text' },
    { col: 'item', key: 'item', kind: 'text' },
    { col: 'foreignamount', key: 'foreignamount', kind: 'numeric' },
    { col: 'netamount', key: 'netamount', kind: 'numeric' },
  ],
};

const nsCustomerPaymentSpec: NsSpec = {
  schema: 'raw', table: 'ns_customer_payment', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'tranid', key: 'tranid', kind: 'text' },
    { col: 'trandate', key: 'trandate', kind: 'date', select: isoDate('trandate') },
    { col: 'entity', key: 'entity', kind: 'text' },
    { col: 'foreigntotal', key: 'foreigntotal', kind: 'numeric' },
    { col: 'otherrefnum', key: 'otherrefnum', kind: 'text' },
  ],
};

const nsCustomerCreditSpec: NsSpec = {
  schema: 'raw', table: 'ns_customer_credit', idColumn: 'id', withRaw: false,
  columns: [
    { col: 'id', key: 'id', kind: 'text' },
    { col: 'tranid', key: 'tranid', kind: 'text' },
    { col: 'trandate', key: 'trandate', kind: 'date', select: isoDate('trandate') },
    { col: 'entity', key: 'entity', kind: 'text' },
    { col: 'foreigntotal', key: 'foreigntotal', kind: 'numeric' },
    { col: 'otherrefnum', key: 'otherrefnum', kind: 'text' },
  ],
};

// PTLL has no single id — synthesize the PK from the four-part natural key in the SELECT so the
// apply map upserts idempotently (doc/doc alone can repeat across apply lines).
const nsArApplyLinkSpec: NsSpec = {
  schema: 'raw', table: 'ns_ar_apply_link', idColumn: 'link_key', withRaw: false,
  columns: [
    // A CustInvc line links to BOTH a payment and a credit memo with the same doc/line numbers, so
    // (previousdoc,nextdoc,previousline,nextline) collapses — linktype + nexttype disambiguate
    // (proven unique 13,392/13,392 live). The RCTI side (VendBill→VendPymt only) never collides.
    { col: 'link_key', key: 'link_key', kind: 'text',
      select: "previousdoc||'-'||nextdoc||'-'||previousline||'-'||nextline||'-'||linktype||'-'||nexttype" },
    { col: 'previousdoc', key: 'previousdoc', kind: 'text' },
    { col: 'nextdoc', key: 'nextdoc', kind: 'text' },
    { col: 'previoustype', key: 'previoustype', kind: 'text' },
    { col: 'nexttype', key: 'nexttype', kind: 'text' },
    { col: 'linktype', key: 'linktype', kind: 'text' },
    { col: 'foreignamount', key: 'foreignamount', kind: 'numeric' },
    { col: 'nextdate', key: 'nextdate', kind: 'date', select: isoDate('nextdate') },
  ],
};

/** Subsidiary-2 customer-id subquery — the AR scope anchor for every transaction stream. */
function customerIds(): string {
  return `SELECT id FROM customer WHERE subsidiary='${SUB()}'`;
}

/** Subsidiary-2 customer-invoice-id subquery (line/link membership filter). No since-filter here:
 *  lines/links are re-fetched for all in-scope invoices, and their own membership is stable. */
function arInvoiceIds(): string {
  return `SELECT id FROM transaction WHERE type='CustInvc' AND entity IN (${customerIds()})`;
}

/** Build the SuiteQL for each stream. `since` (ISO date) switches full → incremental. */
function queries(sinceIso?: string): Record<string, { spec: NsSpec; sql: string }> {
  const lmd = (col = 'lastmodifieddate') =>
    sinceIso ? ` AND ${col} >= TO_DATE('${sinceIso}','YYYY-MM-DD')` : '';
  return {
    // Master: small, full-sync every run.
    ns_customer: {
      spec: nsCustomerSpec,
      sql: `SELECT ${nsSelectList(nsCustomerSpec)} FROM customer
            WHERE subsidiary='${SUB()}' ORDER BY id`,
    },
    // Facts: full, or restricted by lastmodifieddate when incremental.
    ns_customer_invoice: {
      spec: nsCustomerInvoiceSpec,
      sql: `SELECT ${nsSelectList(nsCustomerInvoiceSpec)} FROM transaction
            WHERE type='CustInvc' AND entity IN (${customerIds()})${lmd()}
            ORDER BY id`,
    },
    ns_customer_invoice_line: {
      spec: nsCustomerInvoiceLineSpec,
      sql: `SELECT ${nsSelectList(nsCustomerInvoiceLineSpec)} FROM transactionline
            WHERE transaction IN (${arInvoiceIds()})
            ORDER BY uniquekey`,
    },
    ns_customer_payment: {
      spec: nsCustomerPaymentSpec,
      sql: `SELECT ${nsSelectList(nsCustomerPaymentSpec)} FROM transaction
            WHERE type='CustPymt' AND entity IN (${customerIds()})${lmd()}
            ORDER BY id`,
    },
    ns_customer_credit: {
      spec: nsCustomerCreditSpec,
      sql: `SELECT ${nsSelectList(nsCustomerCreditSpec)} FROM transaction
            WHERE type='CustCred' AND entity IN (${customerIds()})${lmd()}
            ORDER BY id`,
    },
    // Apply map: every application against an in-scope invoice (payments + credits). Incremental on
    // the link's OWN lastmodifieddate (a re-application bumps it without touching the invoice).
    ns_ar_apply_link: {
      spec: nsArApplyLinkSpec,
      sql: `SELECT ${nsSelectList(nsArApplyLinkSpec)} FROM previoustransactionlinelink
            WHERE previoustype='CustInvc' AND previousdoc IN (${arInvoiceIds()})${lmd()}
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

// Upsert in batches — a single INSERT…SELECT over a multi-MB JSON parameter (e.g. the ~13k invoice
// or line rows) exceeds the pooler's statement limits and drops the connection. 1000/batch is safe.
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

export async function loadCustomerAr(pool: Pool, sinceIso?: string): Promise<StreamResult[]> {
  // Write-target safety: prove the pool targets the hub before any upsert (SPRINT hard blocker).
  await assertHubTarget(pool);
  // window_start encodes the mode: the since-date (incremental) or the FY start (full backfill).
  const windowStart = new Date(`${sinceIso ?? env.backfillStart()}T00:00:00Z`);
  const windowEnd = new Date();
  const qs = queries(sinceIso);
  const order = [
    'ns_customer', 'ns_customer_invoice', 'ns_customer_invoice_line',
    'ns_customer_payment', 'ns_customer_credit', 'ns_ar_apply_link',
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
    log(`NetSuite AR load (customer subsidiary ${SUB()})${sinceArg ? ` since ${sinceArg}` : ' — full backfill'}`);
    const results = await loadCustomerAr(pool, sinceArg);
    const total = results.reduce((n, r) => n + r.upserted, 0);
    log(`done: ${results.length} streams, ${total} rows upserted`);
  } finally {
    await pool.end();
  }
}
