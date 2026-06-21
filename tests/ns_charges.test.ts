// Charge-classification tests — all inputs are REAL itemid/displayname pairs observed live on
// grower RCTIs (ZONTA bill + the LA/MI item samples).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCharge } from '../src/lib/ns_charges.ts';

test('products (9xxxxx) tag produce by 3-digit prefix; displayname is the product name', () => {
  const banana = classifyCharge('910102', 'BananaCavendishPremiumXL15kg Carton Semi Ripe');
  assert.equal(banana.category, 'PRODUCT');
  assert.equal(banana.isProduct, true);
  assert.equal(banana.produce, 'banana');
  assert.equal(banana.subcategory, null);
  assert.equal(banana.detail, 'BananaCavendishPremiumXL15kg Carton Semi Ripe');
  assert.equal(classifyCharge('920500', 'Papaya X').produce, 'papaya');
  assert.equal(classifyCharge('930111', 'Avocado Y').produce, 'avocado');
  assert.equal(classifyCharge('960222', 'Passionfruit Z').produce, 'passionfruit');
});

test('FR / WH / MD charges classify by first digit with parsed subcategory + detail', () => {
  const fr = classifyCharge('121008', 'FR - Blenners - Road - Tully to Townsville - Chilled per Space');
  assert.equal(fr.category, 'FR');
  assert.equal(fr.subcategory, 'Blenners');
  assert.equal(fr.detail, 'Road - Tully to Townsville - Chilled per Space');
  assert.equal(fr.isProduct, false);
  assert.equal(fr.produce, null);

  const wh = classifyCharge('210302', 'WH - Ripening - Ann Rd - Banana 15kg');
  assert.equal(wh.category, 'WH');
  assert.equal(wh.subcategory, 'Ripening');
  assert.equal(wh.detail, 'Ann Rd - Banana 15kg');

  const md = classifyCharge('310003', 'MD - Commission - Coles 4.5%');
  assert.equal(md.category, 'MD');
  assert.equal(md.subcategory, 'Commission');
  assert.equal(md.detail, 'Coles 4.5%');

  // 34xxxx is still MD (category = leading digit), not MI — Packaging Fees is an MD subcategory.
  const pkg = classifyCharge('340001', 'MD - Packaging Fees - Coles Band Fee Bananas');
  assert.equal(pkg.category, 'MD');
  assert.equal(pkg.subcategory, 'Packaging Fees');
});

test('LA (591xxx) is its own category; mixed sales + charges parse correctly', () => {
  const sales = classifyCharge('591000', 'LA - Banana Sales');
  assert.equal(sales.category, 'LA');
  assert.equal(sales.subcategory, 'Banana Sales');
  assert.equal(sales.detail, null);

  const freight = classifyCharge('591001', 'LA - Freight - Blenners');
  assert.equal(freight.category, 'LA');
  assert.equal(freight.subcategory, 'Freight');
  assert.equal(freight.detail, 'Blenners');

  // "LA - WH - Quarantine ..." — LA stays the category; WH becomes the subcategory.
  const laWh = classifyCharge('591021', 'LA - WH - Quarantine Netting - Truganina - Coles Tasmania per pallet');
  assert.equal(laWh.category, 'LA');
  assert.equal(laWh.subcategory, 'WH');
  assert.equal(laWh.detail, 'Quarantine Netting - Truganina - Coles Tasmania per pallet');
});

test('MI (4xxxxx): dashed and no-dash displaynames both classify', () => {
  const brismark = classifyCharge('400001', 'MI - Brismark Testing');
  assert.equal(brismark.category, 'MI');
  assert.equal(brismark.subcategory, 'Brismark Testing');
  assert.equal(brismark.detail, null);

  // No category token, no dash — keep the whole name as the subcategory.
  const misc = classifyCharge('410000', 'Miscellaneous');
  assert.equal(misc.category, 'MI');
  assert.equal(misc.subcategory, 'Miscellaneous');
  assert.equal(misc.detail, null);
});

test('unknown / null items fall to OTHER (surfaced, never dropped)', () => {
  assert.equal(classifyCharge(null, null).category, 'OTHER');
  assert.equal(classifyCharge('', 'x').category, 'OTHER');
  assert.equal(classifyCharge('700123', 'Something - Else').category, 'OTHER');
  const other = classifyCharge('700123', 'Foo - Bar');
  assert.equal(other.subcategory, 'Foo'); // no known category token → keep first token
  assert.equal(other.detail, 'Bar');
});
