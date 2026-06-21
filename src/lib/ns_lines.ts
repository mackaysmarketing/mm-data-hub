// Pure RCTI line classification + bill rollup — the line-type + sign rules as ONE tested source.
//
// The no-double-count contract (proven live): a bill's lines split into
//   summary  → mainline=true   (the A/P total line; foreignamount = the bill total)
//   tax      → taxline=true     (GST / RCTI)
//   gross    → foreignamount>0  (money to the grower: produce sales + credits)
//   deduction→ foreignamount<0  (money off: freight / warehouse / market / larapinta / misc)
// and SUM(non-summary lines) = -(summary line) = the bill total.
//
// This module is used by the reconciliation proof to INDEPENDENTLY recompute the bill aggregates
// (a drift guard against the SQL in core.refresh_fact_settlement, which mirrors these exact rules).

export interface RctiLine {
  mainline: boolean | null;
  taxline: boolean | null;
  foreignamount: number | null;
}
export type LineRole = 'summary' | 'tax' | 'gross' | 'deduction' | 'zero';

/** Classify one line by the mainline/taxline flags then the sign. */
export function classifyLine(line: RctiLine): LineRole {
  if (line.mainline) return 'summary';
  if (line.taxline) return 'tax';
  const a = line.foreignamount ?? 0;
  if (a > 0) return 'gross';
  if (a < 0) return 'deduction';
  return 'zero';
}

export interface BillRollup {
  gross: number;
  deductionsByCategory: Record<string, number>;
  totalDeductions: number;
  tax: number;
  /** gross + totalDeductions + tax — what the grower is paid (positive). */
  net: number;
  /** the mainline (summary) amount = the authoritative bill total (negative payable). */
  summary: number;
  /** non-summary line count. */
  lineCount: number;
  /** net - (-summary): ~0 proves the lines reconcile to the bill total. */
  reconDiff: number;
}

export interface CategorizedLine extends RctiLine {
  /** charge category (FR/WH/MD/LA/MI/PRODUCT/OTHER) from the charge dimension. */
  category: string;
}

/** Recompute a bill's settlement aggregates from its lines (independent of the SQL fact). */
export function rollupBill(lines: CategorizedLine[]): BillRollup {
  const r: BillRollup = {
    gross: 0, deductionsByCategory: {}, totalDeductions: 0, tax: 0,
    net: 0, summary: 0, lineCount: 0, reconDiff: 0,
  };
  for (const line of lines) {
    const role = classifyLine(line);
    const amt = line.foreignamount ?? 0;
    if (role === 'summary') { r.summary += amt; continue; }
    r.lineCount += 1;
    if (role === 'tax') r.tax += amt;
    else if (role === 'gross') r.gross += amt;
    else if (role === 'deduction') {
      r.totalDeductions += amt;
      r.deductionsByCategory[line.category] = (r.deductionsByCategory[line.category] ?? 0) + amt;
    }
  }
  r.net = round2(r.gross + r.totalDeductions + r.tax);
  r.gross = round2(r.gross);
  r.totalDeductions = round2(r.totalDeductions);
  r.tax = round2(r.tax);
  r.summary = round2(r.summary);
  r.reconDiff = round2(r.net - -r.summary);
  for (const k of Object.keys(r.deductionsByCategory)) {
    r.deductionsByCategory[k] = round2(r.deductionsByCategory[k] ?? 0);
  }
  return r;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
