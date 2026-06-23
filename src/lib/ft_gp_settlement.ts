// Pure GP-schedule settlement rollup — the net formula as ONE tested source. Mirrors the Sprint-5
// ns_lines.rollupBill drift-guard idea: the reconciliation proof recomputes each schedule's net
// here, INDEPENDENTLY of the SQL in core.refresh_fact_gp_settlement (which mirrors these rules), and
// checks the two against each other AND against gp_payment / FreshTrack's own v_power_bi view.
//
// The formula (validated live — 97% of paid schedules within 1%, grand total within 0.24% of
// gp_payment; deductions/GST tie to NetSuite within 0.1%):
//
//   gross = Σ (box_quantity × price_invoiced_value)        [from gp_detail; the "Sales" branch]
//   deductions = Σ total_amount_value WHERE is_deductible  [from charge_applied; by category]
//   gst        = Σ gstForVatInfo(vat_info, amount) WHERE is_deductible
//   net        = gross − deductions − gst                  [what the grower is paid; ties to gp_payment]
//
// The original-load split apportionment (reconsignment) is NOT replicated — the residual it leaves on
// reconsignment schedules is surfaced as recon variance, not hidden (SPRINT decision).

import { gstForVatInfo } from './ft_gp_charges.ts';

export interface GpChargeLine {
  /** FR/WH/MD/MI/LA/OTHER from classifyGpCharge. */
  category: string;
  /** TRUE = a deduction (money off the grower). Non-deductible charges are informational, not netted. */
  isDeductible: boolean;
  /** The charge amount, positive (raw.ft_charge_applied.total_amount_value). */
  totalAmount: number;
  /** EX / INC / FREE — drives the GST portion. */
  vatInfo: string | null;
}

export interface GpScheduleRollup {
  gross: number;
  /** Positive deduction sums per category (deductible lines only). */
  deductionsByCategory: Record<string, number>;
  totalDeductions: number;
  gst: number;
  /** gross − totalDeductions − gst — the grower's net (positive). */
  net: number;
  /** count of deductible lines. */
  deductibleLineCount: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Recompute a schedule's settlement aggregates from its gross + charge lines (independent of SQL). */
export function rollupSchedule(gross: number, lines: GpChargeLine[]): GpScheduleRollup {
  const r: GpScheduleRollup = {
    gross: 0, deductionsByCategory: {}, totalDeductions: 0, gst: 0, net: 0, deductibleLineCount: 0,
  };
  for (const line of lines) {
    if (!line.isDeductible) continue;
    const amt = line.totalAmount ?? 0;
    r.totalDeductions += amt;
    r.gst += gstForVatInfo(line.vatInfo, amt);
    r.deductionsByCategory[line.category] = (r.deductionsByCategory[line.category] ?? 0) + amt;
    r.deductibleLineCount += 1;
  }
  r.gross = round2(gross);
  r.totalDeductions = round2(r.totalDeductions);
  r.gst = round2(r.gst);
  r.net = round2(r.gross - r.totalDeductions - r.gst);
  for (const k of Object.keys(r.deductionsByCategory)) {
    r.deductionsByCategory[k] = round2(r.deductionsByCategory[k] ?? 0);
  }
  return r;
}
