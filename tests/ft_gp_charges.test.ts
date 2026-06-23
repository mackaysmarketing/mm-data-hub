// GP charge-classification + GST tests — inputs are REAL account_code / scope / name tuples
// observed live on the FreshTrack replica (charge_type rows + charge_applied samples).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGpCharge, gstForVatInfo, vatTreatment } from '../src/lib/ft_gp_charges.ts';

test('account_code first digit is the primary signal (1 FR / 2 WH / 3 MD / 4 MI / 5 LA)', () => {
  assert.equal(classifyGpCharge('100000', 'Freight', 'Freight').category, 'FR');
  assert.equal(classifyGpCharge('210101', 'WH - Ripening', 'Ripening').category, 'WH');
  assert.equal(classifyGpCharge('310000', 'MD - Commission', 'MM Commission').category, 'MD');
  assert.equal(classifyGpCharge('410000', 'MI -', 'Miscellaneous').category, 'MI');
  assert.equal(classifyGpCharge('500000', 'MD-Load Adjustment', 'LA - Banana Sales').category, 'LA');
  // tab/whitespace-prefixed account_code still classifies on the first real digit
  assert.equal(classifyGpCharge('\t350001', null, null).category, 'MD');
});

test('subcategory is the detail after the category token, across messy scope spacing', () => {
  assert.equal(classifyGpCharge('210101', 'WH - Ripening', 'Ripening').subcategory, 'Ripening');
  assert.equal(classifyGpCharge('320000', 'MD- Levy', 'Levy ABGC').subcategory, 'Levy'); // no space after MD-
  assert.equal(classifyGpCharge('100000', 'FR - Fatigue Levy', 'Fatigue Levy').subcategory, 'Fatigue Levy');
  assert.equal(classifyGpCharge('220000', 'WH  - Handling', 'Handling - Outbound').subcategory, 'Handling'); // double space
  assert.equal(classifyGpCharge('410000', 'MI -', 'Miscellaneous').subcategory, 'Miscellaneous'); // empty scope tail → fall to name
});

test('GL-string / 6xxxxx account_codes fall back to scope then name (shrinks OTHER)', () => {
  // 611298-418045-… posts to a GL string, not a 1–5 short code: classify via scope/name.
  const laCommission = classifyGpCharge('611298-418045-260-710-509-03', 'MD-Load Adjustment', 'LA-Commission-3%');
  assert.equal(laCommission.category, 'LA');
  const laSales = classifyGpCharge('641210-641211-260-710-509-02', 'MD-Load Adjustment', 'LA - Banana Sales');
  assert.equal(laSales.category, 'LA');
  // a 6-lead freight GL code with a Freight scope → FR
  assert.equal(classifyGpCharge('611201-611202-260-710-509-03', 'Freight', 'FR - Blenners - Pallet Fee').category, 'FR');
});

test('LA = Load Adjustment in FreshTrack (documented divergence from NetSuite Larapinta)', () => {
  const la = classifyGpCharge('500000', 'MD-Load Adjustment', 'LA - Freight - Blenners');
  assert.equal(la.category, 'LA');
  assert.equal(la.categoryLabel, 'Load Adjustment'); // NOT 'Larapinta'
  // 'Load Adjustment' is detected even when carried under an MD- prefix and no 1–5 account code
  assert.equal(classifyGpCharge('', 'MD-Load Adjustment', null).category, 'LA');
});

test('scope/name category detection: FREIGHT/FR, WH, MD, MI', () => {
  assert.equal(classifyGpCharge(null, 'FREIGHT', null).category, 'FR');
  assert.equal(classifyGpCharge(null, 'FR - Fatigue Levy', null).category, 'FR');
  assert.equal(classifyGpCharge(null, 'WH - Storage', null).category, 'WH');
  assert.equal(classifyGpCharge(null, 'MD - Retail Rebate', null).category, 'MD');
  assert.equal(classifyGpCharge(null, 'MI -', null).category, 'MI');
});

test('unknown / null → OTHER (surfaced, never dropped)', () => {
  assert.equal(classifyGpCharge(null, null, null).category, 'OTHER');
  assert.equal(classifyGpCharge('', '', '').category, 'OTHER');
  assert.equal(classifyGpCharge('  ', 'something weird', 'no signal').category, 'OTHER');
});

test('GST math matches FreshTrack v_power_bi_charge_split: EX +10%, INC 1/11, FREE 0', () => {
  assert.equal(gstForVatInfo('EX', 100), 10);
  assert.ok(Math.abs(gstForVatInfo('INC', 110) - 10) < 1e-9); // 110 inclusive → 10 GST
  assert.equal(gstForVatInfo('FREE', 100), 0);
  assert.equal(gstForVatInfo('No GST', 100), 0); // display alias
  assert.equal(gstForVatInfo(null, 100), 0);
  assert.equal(gstForVatInfo('weird', 100), 0); // unknown → 0 (surfaced via vatTreatment)
});

test('vatTreatment canonicalises raw vat_info', () => {
  assert.equal(vatTreatment('EX'), 'EX');
  assert.equal(vatTreatment(' inc '), 'INC');
  assert.equal(vatTreatment('FREE'), 'FREE');
  assert.equal(vatTreatment('No GST'), 'FREE');
  assert.equal(vatTreatment('zzz'), 'UNKNOWN');
  assert.equal(vatTreatment(null), 'UNKNOWN');
});
