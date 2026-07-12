// PURE Coles remittance-advice parser: text (pypdf/pdf extract) → ParsedRemittance. No I/O.
//
// Layout (per the two committed fixtures, tests/fixtures/remittance/coles_*.txt):
//   Line table, one document per row:
//     Invoice/Claim No | (Doc Reference) | Doc Type | Date DD.MM.YYYY | Store No | Document$ |
//     Discount$ | Payment$ | GST | WT
//   The "Doc Reference" column is UNPOPULATED on Coles advices — the doc-type token (KD/LJ) follows
//   the invoice number directly. Header/footer fields (repeated per page, identical): Vendor No.,
//   Payment No., Period Ending, Total Amount. A "Total for Coles Supermarkets" grand-total line and a
//   Payment-No summary block also appear — neither is a document line (no doc-type + date) so the line
//   regex ignores them.
//
// Contracts:
//   • is_claim = doc_type === 'LJ' OR invoice_no not matching /^FT\d+[A-Z]?$/ (a claim/adjustment or a
//     non-FT reference matches no invoice → the deductions bucket).
//   • A trailing suffix letter on the invoice number is significant and NEVER stripped
//     (FT003402A ≠ FT003402).
//   • Amounts strip commas and honour a leading '-' (claim lines can be negative).
//   • Dates DD.MM.YYYY → ISO.
//   • Checksum (colesChecksum / assertColesChecksum): round(Σ payment_amount, 2) === total_amount.
//     The parser stays total/pure (never throws on a mismatch); the loader enforces + surfaces drift.

import {
  type ParsedRemittance,
  type RemittanceLine,
  auDateToIso,
  parseAmount,
} from './remittance.ts';

export const COLES_RETAILER = 'coles';

/** An `FT…` invoice number, optionally with a single trailing suffix letter (e.g. `FT003402A`). */
const FT_INVOICE_RE = /^FT\d+[A-Z]?$/;

/** A document row: `<invoiceNo> <docType> <DD.MM.YYYY> <storeNo> <doc> <disc> <pay> <gst> <wt>`.
 *  The five trailing 2-dp amounts + the date anchor make a false positive on a header/footer line
 *  effectively impossible. `docType` is 2–3 uppercase letters (known: KD, LJ). */
const LINE_RE =
  /^(\S+)\s+([A-Z]{2,3})\s+(\d{2}\.\d{2}\.\d{4})\s+(\S+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})$/;

/** First capture group of `re` in `text`, or `null` if absent. */
function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? (m[1] as string) : null;
}

function classifyClaim(invoiceNo: string, docType: string): boolean {
  return docType === 'LJ' || !FT_INVOICE_RE.test(invoiceNo);
}

/** Parse Coles remittance text into a ParsedRemittance. Pure. Throws only on a structurally broken
 *  advice (missing Payment No / Total Amount, or a malformed amount/date) — never on a checksum drift. */
export function parseColesRemittanceText(text: string, sourceFile: string): ParsedRemittance {
  const paymentNo = firstMatch(text, /Payment No\.:\s*(\S+)/);
  if (!paymentNo) throw new Error(`Coles remittance (${sourceFile}): no "Payment No.:" header found`);

  const periodRaw = firstMatch(text, /Period Ending:\s*(\d{2}\.\d{2}\.\d{4})/);
  if (!periodRaw) throw new Error(`Coles remittance (${sourceFile}): no "Period Ending:" header found`);

  const totalRaw = firstMatch(text, /Total Amount:\s*\$?\s*(-?[\d,]+\.\d{2})/);
  if (!totalRaw) throw new Error(`Coles remittance (${sourceFile}): no "Total Amount:" header found`);

  // Vendor No is present on every sampled advice; keep it optional-tolerant (empty string) rather
  // than throwing, so a future variant that omits it still lands.
  const vendorNo = firstMatch(text, /Vendor No\.:\s*(\S+)/) ?? '';

  const lines: RemittanceLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const invoiceNo = m[1] as string;
    const docType = m[2] as string;
    lines.push({
      invoice_no: invoiceNo,
      doc_type: docType,
      doc_date: auDateToIso(m[3] as string),
      store_no: m[4] as string,
      document_amount: parseAmount(m[5] as string),
      discount_amount: parseAmount(m[6] as string),
      payment_amount: parseAmount(m[7] as string),
      gst: parseAmount(m[8] as string),
      wt: parseAmount(m[9] as string),
      is_claim: classifyClaim(invoiceNo, docType),
    });
  }

  return {
    retailer: COLES_RETAILER,
    payment_no: paymentNo,
    period_ending: auDateToIso(periodRaw),
    total_amount: parseAmount(totalRaw),
    vendor_no: vendorNo,
    source_file: sourceFile,
    lines,
  };
}

export interface ChecksumResult {
  ok: boolean;
  /** round(Σ line payment_amount, 2). */
  sum: number;
  /** Header total_amount. */
  total: number;
  /** sum − total (rounded 2 dp); 0 when the advice reconciles. */
  diff: number;
}

/** round(Σ payment_amount, 2) vs the header total. Pure — the invariant every Coles advice must hold. */
export function colesChecksum(r: ParsedRemittance): ChecksumResult {
  const sum = Math.round(r.lines.reduce((a, l) => a + l.payment_amount, 0) * 100) / 100;
  const diff = Math.round((sum - r.total_amount) * 100) / 100;
  return { ok: diff === 0, sum, total: r.total_amount, diff };
}

/** Throw unless the checksum holds. The loader calls this before landing (SPRINT: enforce + surface). */
export function assertColesChecksum(r: ParsedRemittance): void {
  const c = colesChecksum(r);
  if (!c.ok) {
    throw new Error(
      `Coles remittance checksum FAILED for ${r.source_file} (payment ${r.payment_no}): ` +
        `Σ payment ${c.sum} ≠ Total Amount ${c.total} (diff ${c.diff}, ${r.lines.length} lines)`,
    );
  }
}
