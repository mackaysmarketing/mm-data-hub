// FreshTrack grower-pool charge classification + GST — the charge dimension (Sprint 6). Pure +
// unit-tested. Mirrors the Sprint-5 NetSuite classifier idea (src/lib/ns_charges.ts), reusing the
// SAME FR/WH/MD/LA/MI taxonomy so the two settlement sources reconcile by category.
//
// SIGNALS (confirmed live), in priority order:
//   1. charge_applied/charge `account_code` FIRST DIGIT — the posted ledger account, the most
//      reliable category signal:  1 FR · 2 WH · 3 MD · 4 MI · 5 LA
//   2. charge_type.scope  — e.g. 'Freight' / 'WH - Handling' / 'MD- Levy' / 'MD-Load Adjustment'.
//      MESSY (inconsistent spacing 'WH  - Handling', case 'FREIGHT', null on ~6k rows) → a fallback.
//   3. charge.name        — e.g. 'FR - Blenners …', 'LA - Banana Sales', 'Ripening'.
//   else OTHER (surfaced + counted, never silently dropped).
//
// ⚠ TAXONOMY DIVERGENCE FROM NETSUITE (documented, not a bug): in FreshTrack GP the "LA" bucket
//    (account 5xxxxx / charge_type 'MD-Load Adjustment' / 'LA -*' charge names) means **Load
//    Adjustment** — FreshTrack's reconsignment/correction bucket. In NetSuite, LA = **Larapinta**
//    (a parallel sales+charge set, itemid 591xxx). We keep the shared code `LA` (the 5th category)
//    so the schemas align, but LABEL GP's as 'Load Adjustment'. LA is tiny in GP (a net credit,
//    ~-$22k) so it does not affect the cross-source deduction tie (FR/WH/MD carry ~$32.5M).
//
// GST is keyed off `vat_info` exactly as FreshTrack's own v_power_bi_charge_split view computes it:
//   EX (GST-exclusive) → +10% on top   ·   INC (GST-inclusive) → 1/11 extracted   ·   FREE → 0.

export type GpChargeCategory = 'FR' | 'WH' | 'MD' | 'MI' | 'LA' | 'OTHER';

export interface GpChargeClass {
  category: GpChargeCategory;
  /** Human label. NB: LA = 'Load Adjustment' in FreshTrack (≠ NetSuite's LA = Larapinta). */
  categoryLabel: string;
  /** The detail after the category token in the scope/name (Ripening, Commission, Levy, …); null if absent. */
  subcategory: string | null;
}

const CATEGORY_LABEL: Record<GpChargeCategory, string> = {
  FR: 'Freight',
  WH: 'Warehouse',
  MD: 'Market Deductions',
  MI: 'Misc',
  LA: 'Load Adjustment', // FreshTrack GP semantic; documented divergence from NetSuite (Larapinta)
  OTHER: 'Other',
};

/** Category from the leading digit of a posted account_code. Null if not a clean 1–5 lead. */
function categoryFromAccountCode(accountCode: string | null | undefined): GpChargeCategory | null {
  const c = (accountCode ?? '').trim();
  switch (c[0]) {
    case '1': return 'FR';
    case '2': return 'WH';
    case '3': return 'MD';
    case '4': return 'MI';
    case '5': return 'LA';
    default: return null; // blank, GL-string (6xxxxx-…), 'M', tab, etc. → fall through to scope/name
  }
}

/** Normalise a scope/name for matching: uppercase, collapse internal whitespace, trim. */
function norm(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Category from a charge_type.scope or charge.name string (the fallback signal). */
function categoryFromText(text: string | null | undefined): GpChargeCategory | null {
  const n = norm(text);
  if (n === '') return null;
  // Load Adjustment FIRST — it carries an 'MD' prefix ('MD-Load Adjustment') but is the LA bucket.
  if (n.includes('LOAD ADJUSTMENT') || /^LA\b/.test(n) || n.startsWith('LA-') || n.startsWith('LA ')) return 'LA';
  if (n.startsWith('FR') || n.includes('FREIGHT')) return 'FR';
  if (n.startsWith('WH') || n.includes('WAREHOUSE')) return 'WH';
  if (n.startsWith('MD') || n.includes('MARKET')) return 'MD';
  if (n.startsWith('MI') || n.includes('MISC')) return 'MI';
  return null;
}

/** The detail token after a leading category prefix in a scope/name (e.g. 'WH - Ripening' → 'Ripening'). */
function subcategoryFrom(scope: string | null | undefined, name: string | null | undefined): string | null {
  for (const raw of [scope, name]) {
    const s = (raw ?? '').trim();
    if (s === '') continue;
    // Split on a dash with optional surrounding whitespace; drop a leading category token.
    const parts = s.split(/\s*-\s*/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const lead = norm(parts[0]);
    const rest = ['FR', 'WH', 'MD', 'MI', 'LA', 'FREIGHT'].includes(lead) ? parts.slice(1) : parts;
    const sub = rest.join(' - ').trim();
    if (sub !== '') return sub;
  }
  return null;
}

/**
 * Classify a FreshTrack charge into the shared FR/WH/MD/LA/MI taxonomy. Pass the charge's
 * `account_code` (primary), its `charge_type.scope` and `charge.name` (fallbacks). Unknown → OTHER
 * (surfaced, never dropped). Sign (deduction vs credit) is NOT decided here — that is the applied
 * row's `is_deductible` + `total_amount_value` sign at the fact layer.
 */
export function classifyGpCharge(
  accountCode: string | null | undefined,
  scope: string | null | undefined,
  name: string | null | undefined,
): GpChargeClass {
  const category =
    categoryFromAccountCode(accountCode) ??
    categoryFromText(scope) ??
    categoryFromText(name) ??
    'OTHER';
  return {
    category,
    categoryLabel: CATEGORY_LABEL[category],
    subcategory: subcategoryFrom(scope, name),
  };
}

export type VatTreatment = 'EX' | 'INC' | 'FREE' | 'UNKNOWN';

/** Canonicalise a raw vat_info value. FreshTrack stores EX / INC / FREE; display sometimes 'No GST'. */
export function vatTreatment(vatInfo: string | null | undefined): VatTreatment {
  const v = norm(vatInfo);
  if (v === 'EX') return 'EX';
  if (v === 'INC') return 'INC';
  if (v === 'FREE' || v === 'NO GST') return 'FREE';
  return 'UNKNOWN';
}

/**
 * GST on a (positive) charge amount, matching FreshTrack's v_power_bi_charge_split:
 *   EX → amount × 0.10 (GST added on top)   ·   INC → amount × 1/11 (extracted from inclusive)
 *   FREE → 0   ·   UNKNOWN → 0 (surfaced by the caller via vatTreatment()).
 */
export function gstForVatInfo(vatInfo: string | null | undefined, amount: number): number {
  switch (vatTreatment(vatInfo)) {
    case 'EX': return amount * 0.1;
    case 'INC': return amount * (1 / 11);
    default: return 0; // FREE + UNKNOWN
  }
}
