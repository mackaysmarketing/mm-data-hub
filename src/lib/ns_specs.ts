// NetSuite landing specs: column ↔ SuiteQL-column mapping in one auditable place, mirroring the
// FreshTrack specs.ts pattern. The SuiteQL SELECT list is derived from these (nsSelectList), so the
// query and the upsert can never drift. Temporal columns are formatted ISO in SQL (TO_CHAR) so they
// parse unambiguously into Postgres date/timestamptz (NetSuite returns DD/MM/YYYY in this locale).
import type { UpsertSpec, Column } from './db.ts';

export interface NsColumn extends Column {
  /** SuiteQL select expression; defaults to the source column name (= key). */
  select?: string;
}
export interface NsSpec extends UpsertSpec {
  columns: NsColumn[];
}

/** `expr AS key` select list — keeps the SuiteQL query and the upsert mapping in lockstep. */
export function nsSelectList(spec: NsSpec): string {
  return spec.columns.map((c) => `${c.select ?? c.key} AS ${c.key}`).join(', ');
}

const isoDate = (col: string) => `TO_CHAR(${col},'YYYY-MM-DD')`;
const isoTs = (col: string) => `TO_CHAR(${col},'YYYY-MM-DD HH24:MI:SS')`;

// ── raw.ns_vendor (grower vendor master) ─────────────────────────────────────
export const nsVendorSpec: NsSpec = {
  schema: 'raw', table: 'ns_vendor', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'bigint' },
    { col: 'entityid', key: 'entityid', kind: 'text' },
    { col: 'externalid', key: 'externalid', kind: 'text' },
    { col: 'companyname', key: 'companyname', kind: 'text' },
    { col: 'category', key: 'category', kind: 'int' },
    { col: 'isinactive', key: 'isinactive', kind: 'bool' },
    { col: 'subsidiary', key: 'subsidiary', kind: 'int' },
  ],
};

// ── raw.ns_item (product + charge taxonomy) ──────────────────────────────────
export const nsItemSpec: NsSpec = {
  schema: 'raw', table: 'ns_item', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'bigint' },
    { col: 'itemid', key: 'itemid', kind: 'text' },
    { col: 'displayname', key: 'displayname', kind: 'text' },
    { col: 'itemtype', key: 'itemtype', kind: 'text' },
  ],
};

// ── raw.ns_vendor_bill (RCTI headers) ────────────────────────────────────────
export const nsBillSpec: NsSpec = {
  schema: 'raw', table: 'ns_vendor_bill', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'bigint' },
    { col: 'tranid', key: 'tranid', kind: 'text' },
    { col: 'type', key: 'type', kind: 'text' },
    { col: 'entity', key: 'entity', kind: 'bigint' },
    { col: 'trandate', key: 'trandate', kind: 'date', select: isoDate('trandate') },
    { col: 'lastmodifieddate', key: 'lastmodifieddate', kind: 'timestamptz', select: isoTs('lastmodifieddate') },
    { col: 'status', key: 'status', kind: 'text' },
    { col: 'approvalstatus', key: 'approvalstatus', kind: 'int' },
    { col: 'foreigntotal', key: 'foreigntotal', kind: 'numeric' },
    { col: 'currency', key: 'currency', kind: 'int' },
    { col: 'memo', key: 'memo', kind: 'text' },
  ],
};

// ── raw.ns_vendor_bill_line (RCTI lines) ─────────────────────────────────────
// The source line id column is `id`; aliased to line_id (uniquekey is the PK).
export const nsBillLineSpec: NsSpec = {
  schema: 'raw', table: 'ns_vendor_bill_line', idColumn: 'uniquekey', withRaw: false,
  columns: [
    { col: 'uniquekey', key: 'uniquekey', kind: 'bigint' },
    { col: 'transaction', key: 'transaction', kind: 'bigint' },
    { col: 'line_id', key: 'line_id', kind: 'int', select: 'id' },
    { col: 'linesequencenumber', key: 'linesequencenumber', kind: 'int' },
    { col: 'mainline', key: 'mainline', kind: 'bool' },
    { col: 'taxline', key: 'taxline', kind: 'bool' },
    { col: 'item', key: 'item', kind: 'bigint' },
    { col: 'accountinglinetype', key: 'accountinglinetype', kind: 'text' },
    { col: 'netamount', key: 'netamount', kind: 'numeric' },
    { col: 'foreignamount', key: 'foreignamount', kind: 'numeric' },
    { col: 'memo', key: 'memo', kind: 'text' },
  ],
};

// ── raw.ns_vendor_payment (VendPymt — paid date source) ──────────────────────
export const nsPaymentSpec: NsSpec = {
  schema: 'raw', table: 'ns_vendor_payment', idColumn: 'id', withRaw: true,
  columns: [
    { col: 'id', key: 'id', kind: 'bigint' },
    { col: 'tranid', key: 'tranid', kind: 'text' },
    { col: 'type', key: 'type', kind: 'text' },
    { col: 'entity', key: 'entity', kind: 'bigint' },
    { col: 'trandate', key: 'trandate', kind: 'date', select: isoDate('trandate') },
    { col: 'lastmodifieddate', key: 'lastmodifieddate', kind: 'timestamptz', select: isoTs('lastmodifieddate') },
    { col: 'status', key: 'status', kind: 'text' },
    { col: 'foreigntotal', key: 'foreigntotal', kind: 'numeric' },
    { col: 'currency', key: 'currency', kind: 'int' },
    { col: 'memo', key: 'memo', kind: 'text' },
  ],
};

// ── raw.ns_bill_payment_link (PTLL apply map) ────────────────────────────────
// PTLL has no single id; synthesize a deterministic key from the four-part natural key.
export const nsBillPaymentLinkSpec: NsSpec = {
  schema: 'raw', table: 'ns_bill_payment_link', idColumn: 'link_key', withRaw: false,
  columns: [
    { col: 'link_key', key: 'link_key', kind: 'text',
      select: "previousdoc||'-'||nextdoc||'-'||previousline||'-'||nextline" },
    { col: 'previoustype', key: 'previoustype', kind: 'text' },
    { col: 'previousdoc', key: 'previousdoc', kind: 'bigint' },
    { col: 'previousline', key: 'previousline', kind: 'int' },
    { col: 'nexttype', key: 'nexttype', kind: 'text' },
    { col: 'nextdoc', key: 'nextdoc', kind: 'bigint' },
    { col: 'nextline', key: 'nextline', kind: 'int' },
    { col: 'nextdate', key: 'nextdate', kind: 'date', select: isoDate('nextdate') },
    { col: 'linktype', key: 'linktype', kind: 'text' },
    { col: 'foreignamount', key: 'foreignamount', kind: 'numeric' },
    { col: 'lastmodifieddate', key: 'lastmodifieddate', kind: 'timestamptz', select: isoTs('lastmodifieddate') },
  ],
};
