// Shared remittance-advice types + tiny pure helpers, retailer-agnostic.
//
// A remittance advice is a supermarket's statement of what it paid us and how it split each line
// (document/gross, settlement discount, net payment, GST, WT). It is the RECEIVABLE mirror of the
// grower-settlement advices modelled elsewhere. Coles is the first retailer (src/lib/remittance_coles.ts);
// Woolworths / ALDI slot in as additional per-retailer parsers producing this same shape.
//
// Parsers are PURE: text in → ParsedRemittance out, no I/O. PDF→text extraction lives in the loader
// (src/loaders/remittance.ts), never here — so the parser is trivially unit-testable over text fixtures.

/** One settled document line on a remittance advice. Amounts are AUD, rounded to 2 decimals.
 *  Signed: a claim/adjustment line can be negative (money back to the retailer). Never coalesced. */
export interface RemittanceLine {
  /** Invoice or claim/adjustment number, verbatim. A trailing suffix letter is significant and is
   *  NEVER stripped (e.g. `FT003402A` is a distinct document from `FT003402`). */
  invoice_no: string;
  /** Document type code (Coles: `KD` = invoice, `LJ` = claim/adjustment). Text, never an enum. */
  doc_type: string;
  /** Document date, ISO `YYYY-MM-DD`. */
  doc_date: string;
  /** Store number / delivery point (Coles: `C` + consignee b2b_code, e.g. `C9314FV`). */
  store_no: string;
  /** Gross document amount. */
  document_amount: number;
  /** Settlement discount (the retail rebate; Coles ≈ 2.5%). */
  discount_amount: number;
  /** Net payment (document − discount). The checksum column: Σ payment_amount == header total. */
  payment_amount: number;
  /** GST amount. */
  gst: number;
  /** Withholding tax amount. */
  wt: number;
  /** True when the line is a claim/adjustment rather than a matchable invoice — i.e. doc_type is a
   *  claim code OR invoice_no is not an `FT…` invoice number. Claim lines are the deductions bucket
   *  and match no invoice at reconciliation. */
  is_claim: boolean;
}

/** A whole remittance advice (one payment), header + its document lines. */
export interface ParsedRemittance {
  /** Retailer slug, e.g. `coles`. */
  retailer: string;
  /** Retailer's payment/remittance number (natural key with `retailer`). */
  payment_no: string;
  /** Period-ending date, ISO `YYYY-MM-DD`. */
  period_ending: string;
  /** Header "Total Amount" — the deposited cash. Equals Σ line payment_amount (enforced by checksum). */
  total_amount: number;
  /** Our vendor number in the retailer's system. */
  vendor_no: string;
  /** Source filename the advice was parsed from (provenance; not the full path). */
  source_file: string;
  /** The document lines, in file order. */
  lines: RemittanceLine[];
}

/** `DD.MM.YYYY` → ISO `YYYY-MM-DD` (no timezone round-trip). Throws on an unrecognised shape. */
export function auDateToIso(d: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.trim());
  if (!m) throw new Error(`remittance: unrecognised DD.MM.YYYY date: ${JSON.stringify(d)}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Parse a money token: strip thousands commas and a `$`, honour a leading `-`, round to 2 dp.
 *  Throws on a token that is not numeric (a parser must never silently coerce a bad amount to 0). */
export function parseAmount(s: string): number {
  const cleaned = s.replace(/[,$]/g, '').trim();
  const n = Number(cleaned);
  if (cleaned === '' || Number.isNaN(n)) {
    throw new Error(`remittance: unrecognised amount token: ${JSON.stringify(s)}`);
  }
  return Math.round(n * 100) / 100;
}
