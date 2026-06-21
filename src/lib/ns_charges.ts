// NetSuite RCTI line classification — the charge dimension (Sprint 5). Pure + unit-tested.
//
// The item is the code: itemid prefix = category, displayname = "Category - Subcategory - Detail"
// for charges (a product's displayname is just the product name). Categories (confirmed live):
//   9xxxxx  PRODUCT — gross sale; produce by 3-digit prefix (910 banana, 920 papaya, 930 avocado,
//                     960 passionfruit)
//   1xxxxx  FR — Freight              2xxxxx  WH — Warehouse        3xxxxx  MD — Market Deductions
//   4xxxxx  MI — Misc                 591xxx  LA — Larapinta (a full parallel sales+charge set)
// NB: gross-vs-deduction is decided at the LINE level by SIGN (foreignamount), NOT by category —
// LA carries both "LA - Banana Sales" (positive=gross) and "LA - Freight" (negative=deduction).
// This module classifies the ITEM (category/subcategory/produce); the fact layer applies the sign.

export type ChargeCategory = 'PRODUCT' | 'FR' | 'WH' | 'MD' | 'LA' | 'MI' | 'OTHER';

export interface ChargeClass {
  category: ChargeCategory;
  /** Human label for the category. */
  categoryLabel: string;
  /** 2nd displayname token for charges (Commission, Levy, Ripening, Freight, …); null if absent. */
  subcategory: string | null;
  /** Remainder of the displayname after the subcategory. */
  detail: string | null;
  /** banana/papaya/avocado/passionfruit for 9xxxxx products; null otherwise. */
  produce: string | null;
  /** True for 9xxxxx produce items (gross-sale SKUs). Sign still decides gross vs deduction. */
  isProduct: boolean;
}

const CATEGORY_LABEL: Record<ChargeCategory, string> = {
  PRODUCT: 'Product',
  FR: 'Freight',
  WH: 'Warehouse',
  MD: 'Market Deductions',
  LA: 'Larapinta',
  MI: 'Misc',
  OTHER: 'Other',
};

const PRODUCE: Record<string, string> = {
  '910': 'banana',
  '920': 'papaya',
  '930': 'avocado',
  '960': 'passionfruit',
};

const CATEGORY_TOKENS = new Set(['FR', 'WH', 'MD', 'LA', 'MI']);

function categoryFromItemid(itemid: string): ChargeCategory {
  if (itemid.startsWith('591')) return 'LA';
  switch (itemid[0]) {
    case '9': return 'PRODUCT';
    case '1': return 'FR';
    case '2': return 'WH';
    case '3': return 'MD';
    case '4': return 'MI';
    default: return 'OTHER';
  }
}

/**
 * Classify a NetSuite line item into the charge dimension. `itemid` is the code (e.g. "910102",
 * "121008", "591001"); `displayname` is the item label. Null/unknown → OTHER (surfaced, never
 * silently dropped). Sign (gross vs deduction) is NOT decided here — that's per-line at the fact layer.
 */
export function classifyCharge(
  itemid: string | null | undefined,
  displayname: string | null | undefined,
): ChargeClass {
  const code = (itemid ?? '').trim();
  const name = (displayname ?? '').trim();

  if (code === '') {
    return { category: 'OTHER', categoryLabel: CATEGORY_LABEL.OTHER, subcategory: null, detail: null, produce: null, isProduct: false };
  }

  const category = categoryFromItemid(code);
  const isProduct = category === 'PRODUCT';
  const produce = isProduct ? PRODUCE[code.slice(0, 3)] ?? null : null;

  // Products: the displayname is the product name, not a "Cat - Sub - Detail" string.
  if (isProduct) {
    return { category, categoryLabel: CATEGORY_LABEL[category], subcategory: null, detail: name || null, produce, isProduct: true };
  }

  // Charges: split on " - ". Drop a leading category token (FR/WH/MD/LA/MI) if present, then
  // subcategory = next token, detail = the remainder. Handles no-dash names (e.g. "Miscellaneous").
  const parts = name.split(' - ').map((s) => s.trim()).filter((s) => s.length > 0);
  const rest = parts.length > 1 && CATEGORY_TOKENS.has((parts[0] ?? '').toUpperCase())
    ? parts.slice(1)
    : parts;
  const subcategory = rest[0] ?? null;
  const detail = rest.length > 1 ? rest.slice(1).join(' - ') : null;

  return { category, categoryLabel: CATEGORY_LABEL[category], subcategory, detail, produce: null, isProduct: false };
}
