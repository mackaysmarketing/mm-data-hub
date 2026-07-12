// ─────────────────────────────────────────────────────────────────────────────
// NL glossary engagement tool generator (SPRINT 2026-07-12 Part 2, Tim's vocabulary harvest).
//   npm run nl:tool          → reports/nl_glossary_<date>.html
//
// Emits a SELF-CONTAINED interactive page (no network, works from a double-click — the proven
// scripts/revenue_class_marker.ts engineering) pre-populated LIVE from the hub at generation:
// every fact-referenced product, every customer (+ the 0045 retail crosswalk guess when it has
// landed), every non-test grower, every shed, the scan segments + geographies, the GP + NS charge
// categories + top charges by dollars, and the governed metric catalog (Cube contracts + 0047
// mart measures — read from the 0048 seed when present, embedded fallback otherwise).
//
// Tim fills "what do you CALL this?" aliases (comma-separated) + notes per entity, plus guided
// free-form sections (units of speech, time vocabulary, people & roles, THE TOP-20 QUESTIONS,
// general jargon). Progress autosaves to localStorage (keyed by date) so the page can be closed
// and resumed. "Generate" downloads nl_glossary_submission_<date>.json — the exact shape
// src/loaders/nl_glossary.ts (npm run nl:load) consumes:
//   { terms:   [{entity_type, entity_key, canonical_name, alias, notes}],   ← one row PER alias
//     phrases: [{category, phrase, meaning?, notes?}] }
// Aliases are split on commas at export. A note with NO alias exports as a 'general' phrase so it
// is never silently lost (a term row needs an alias for its id).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain, log } from '../src/lib/util.ts';

interface Item {
  /** entity_type for the export */
  t: string;
  /** entity_key for the export */
  k: string;
  /** canonical name (shown as the row title, exported as canonical_name) */
  c: string;
  /** meta line (context under the title) */
  m: string;
  /** usage badge (right-aligned) */
  u: string;
}
interface Section { key: string; title: string; ask: string; items: Item[]; }
interface FreeForm { cat: string; title: string; ask: string; examples: string[]; }

/** Fallback metric catalog — MUST stay in sync with the seed list in
 *  supabase/migrations/0048_core_business_terms.sql (used only when the 0048 seed
 *  has not run yet; the primary path reads the seeded rows live). */
const METRICS_FALLBACK: { key: string; def: string }[] = [
  { key: 'dispatch.load_count', def: 'How many loads we dispatched (Sell only, actual pickup recorded).' },
  { key: 'dispatch.pallet_count', def: 'How many pallets were on dispatched Sell loads.' },
  { key: 'dispatch.net_weight_dispatched', def: 'Total kg dispatched (pallet net weights; missing weights left out, never counted as zero).' },
  { key: 'dispatch.line_count', def: 'How many load × product lines were dispatched.' },
  { key: 'dispatch.pallets_with_net_weight', def: 'Pallets that carry a recorded net weight (capture-rate numerator).' },
  { key: 'dispatch.net_weight_capture_rate', def: 'Share of pallets with a recorded net weight.' },
  { key: 'dispatch_shipped.shipped_load_count', def: 'Loads that reached Shipped-or-later (the ops shipped definition), Sell only.' },
  { key: 'dispatch_shipped.boxes_packed', def: 'Boxes packed = own-stock boxes + reconsigned boxes (the portal’s "Boxes Packed").' },
  { key: 'dispatch_shipped.pallet_count_shipped', def: 'Pallets on Shipped-or-later Sell loads.' },
  { key: 'dispatch_shipped.net_weight_shipped', def: 'Total kg on Shipped-or-later pallets (missing weights left out).' },
  { key: 'settlement.rcti_count', def: 'How many grower RCTIs (NetSuite settlement bills).' },
  { key: 'settlement.gross_sales', def: 'Grower gross sales on RCTIs (product lines — money to the grower).' },
  { key: 'settlement.total_deductions', def: 'All deductions on RCTIs (signed negative).' },
  { key: 'settlement.freight_deductions', def: 'Freight deductions on RCTIs (signed).' },
  { key: 'settlement.warehouse_deductions', def: 'Warehouse deductions on RCTIs (signed).' },
  { key: 'settlement.market_deductions', def: 'Market deductions on RCTIs (signed).' },
  { key: 'settlement.larapinta_deductions', def: 'Larapinta deductions on RCTIs (signed; NetSuite LA = Larapinta).' },
  { key: 'settlement.misc_deductions', def: 'Misc deductions on RCTIs (signed).' },
  { key: 'settlement.tax_total', def: 'GST on RCTIs.' },
  { key: 'settlement.net_paid', def: 'What the grower receives on RCTIs (gross + deductions + GST).' },
  { key: 'settlement.paid_rcti_count', def: 'RCTIs with a payment applied.' },
  { key: 'settlement.unpaid_rcti_count', def: 'RCTIs without a payment applied (null paid_date, never zero-dated).' },
  { key: 'gp_settlement.gp_schedule_count', def: 'How many FreshTrack grower-pool settlement schedules.' },
  { key: 'gp_settlement.gp_gross_sales', def: 'Grower gross on GP schedules (boxes × invoiced price).' },
  { key: 'gp_settlement.gp_total_deductions', def: 'All GP deductions (signed).' },
  { key: 'gp_settlement.gp_freight_deductions', def: 'GP Freight deductions (signed).' },
  { key: 'gp_settlement.gp_warehouse_deductions', def: 'GP Warehouse deductions (signed).' },
  { key: 'gp_settlement.gp_market_deductions', def: 'GP Market deductions (signed).' },
  { key: 'gp_settlement.gp_larapinta_deductions', def: 'GP LA-bucket deductions (⚠ Load Adjustment in FreshTrack; shared LA code for cross-source alignment).' },
  { key: 'gp_settlement.gp_misc_deductions', def: 'GP Misc deductions (signed).' },
  { key: 'gp_settlement.gp_other_deductions', def: 'GP unclassified deductions (signed; surfaced, never dropped).' },
  { key: 'gp_settlement.gp_gst', def: 'GST on GP deductions (from vat_info: EX ×0.10 / INC ×1/11 / FREE 0).' },
  { key: 'gp_settlement.gp_net_paid', def: 'Grower net on GP schedules (gross − deductions − GST).' },
  { key: 'gp_settlement.gp_paid_amount', def: 'Cash actually paid on GP schedules (gp_payment — the anchor).' },
  { key: 'gp_settlement.gp_paid_schedule_count', def: 'GP schedules with a payment.' },
  { key: 'gp_settlement.gp_unpaid_schedule_count', def: 'GP schedules without a payment (null paid_date, never zero-dated).' },
  { key: 'gp_settlement_load.gp_load_count', def: 'Settled schedule × load rows — settlement at LOAD grain (the lineage NetSuite cannot provide).' },
  { key: 'gp_settlement_load.gp_load_gross_sales', def: 'Grower gross at load grain.' },
  { key: 'gp_settlement_load.gp_load_total_deductions', def: 'GP deductions at load grain (signed).' },
  { key: 'gp_settlement_load.gp_load_net_paid', def: 'Grower net at load grain.' },
  { key: 'retail.observation_count', def: 'Day-grain shelf-price observations (retail price reporter).' },
  { key: 'retail.avg_price', def: 'Average shelf price (AUD), missing prices left out.' },
  { key: 'retail.min_price', def: 'Lowest shelf price observed (AUD).' },
  { key: 'retail.max_price', def: 'Highest shelf price observed (AUD).' },
  { key: 'retail.promo_observations', def: 'Shelf observations on promotion (badge, multibuy or was-price).' },
];

const FREEFORM: FreeForm[] = [
  {
    cat: 'units', title: 'Units of speech', ask:
      'How do you talk about quantities? One phrase per line — write it the way you SAY it, and add "= what it means" if it needs explaining.',
    examples: [
      'carton / box / case — are they the same thing? what is a "ctn"?',
      'do you say pallets, skids, or something else?',
      'bins / megabins / processing bins — when does each come up?',
      '"a load" vs "a semi" vs "a B-double" — how do you size shipments in conversation?',
    ],
  },
  {
    cat: 'time', title: 'Time vocabulary', ask:
      'How do you talk about time? One phrase per line.',
    examples: [
      'when you say "week 31" — pack week, calendar week, or the Coles scan week?',
      'seasons: wet season / peak / flush — what date ranges do you mean?',
      'is "this year" the financial year (Jul–Jun) or the calendar year by default?',
      '"last week\'s numbers" — which week boundary do you mean (Mon–Sun? W/E Tuesday?)',
    ],
  },
  {
    cat: 'roles', title: 'People & roles', ask:
      'Who asks what, and what shorthand do they use? One per line.',
    examples: [
      '"Jon\'s growers" — who is Jon, and which growers does that mean?',
      'who owns which customers (e.g. "Sarah looks after Coles")?',
      'what does the board ask for vs what ops asks for?',
      'any team names / desk names used as shorthand ("the floor", "dispatch")?',
    ],
  },
  {
    cat: 'questions', title: 'THE TOP-20 QUESTIONS', ask:
      'Write the 20 questions you most want answered in plain English — EXACTLY as you\'d say them, one per line. Don\'t translate into data language; that\'s our job.',
    examples: [
      'e.g. "How many cavs did we send Coles Melbourne last week?"',
      'e.g. "What did HOWEE net per carton in week 31 vs the pool?"',
      'e.g. "Are we keeping up with what Coles is actually selling in VIC?"',
      'e.g. "Who still owes us money past 60 days?"',
    ],
  },
  {
    cat: 'general', title: 'General jargon', ask:
      'Anything else you say that an outsider (or an AI) would not understand — one per line, with "= meaning" where useful.',
    examples: [
      '"cavs" = Cavendish bananas?',
      '"the majors" = which retailers exactly?',
      'nicknames for sites ("Truga"?), regions ("the Tableland"?), products',
      'anything from the packhouse floor or market floor that has a special meaning',
    ],
  },
];

function fmtMoney(v: number): string {
  const neg = v < 0;
  const s = '$' + Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: 0 });
  return neg ? '(' + s + ')' : s;
}

/** Compact "retailer/state/method" string from an unknown-shape crosswalk row (to_jsonb). */
function retailGuess(j: Record<string, unknown> | null): string {
  if (!j) return '';
  const picks: string[] = [];
  for (const [k, v] of Object.entries(j)) {
    if (v === null || typeof v === 'object') continue;
    if (/retailer|state|method|group/i.test(k)) picks.push(`${k}=${String(v)}`);
  }
  return picks.length ? `retail guess: ${picks.join(' ')}` : '';
}

async function buildSections(c: PoolClient): Promise<{ sections: Section[]; genNotes: string[] }> {
  const genNotes: string[] = [];
  const sections: Section[] = [];

  // ── PRODUCTS: every dim_product row referenced by hub facts (join check) ────
  const products = (await c.query(
    `with pal as (select product_id, count(*)::int n from raw.ft_pallet where product_id is not null group by 1),
          gp  as (select product_id, count(*)::int n from raw.ft_gp_detail where product_id is not null group by 1),
          oi  as (select product_id, count(*)::int n from core.fact_order_item where product_id is not null group by 1)
     select p.product_id::text as id, p.code, p.name, p.crop_name, p.variety_name, p.pack_type_name,
            p.count, p.net_weight_value::float8 as net_weight, p.net_weight_unit, p.is_organic, p.is_active,
            coalesce(pal.n, 0) as pallets, coalesce(gp.n, 0) as gp_rows, coalesce(oi.n, 0) as order_lines
     from core.dim_product p
     left join pal on pal.product_id = p.product_id
     left join gp  on gp.product_id  = p.product_id
     left join oi  on oi.product_id  = p.product_id
     where pal.n is not null or gp.n is not null or oi.n is not null
     order by coalesce(pal.n, 0) + coalesce(gp.n, 0) + coalesce(oi.n, 0) desc, p.name`)).rows;
  sections.push({
    key: 'products',
    title: `Products (${products.length} in use across dispatch / settlement / orders)`,
    ask: 'What do you CALL this product day-to-day? (aliases, comma-separated — e.g. "13kg cavs, green tips")',
    items: products.map((p) => ({
      t: 'product', k: p.id, c: p.name ?? p.code ?? p.id,
      m: [
        p.code ? `code ${p.code}` : null, p.crop_name, p.variety_name, p.pack_type_name,
        p.count != null ? `${p.count} count` : null,
        p.net_weight != null ? `${p.net_weight}${(p.net_weight_unit ?? 'kg').toLowerCase()}` : null,
        p.is_organic ? 'organic' : null, p.is_active === false ? 'INACTIVE' : null,
      ].filter(Boolean).join(' · '),
      u: `${Number(p.pallets).toLocaleString()} pallets · ${Number(p.gp_rows).toLocaleString()} GP rows · ${Number(p.order_lines).toLocaleString()} order lines`,
    })),
  });

  // ── CUSTOMERS: dim_customer + the 0045 retail crosswalk guess when it exists ──
  const hasXw = (await c.query<{ ok: string | null }>(
    `select to_regclass('core.crosswalk_customer_retail')::text as ok`)).rows[0]!.ok !== null;
  let customers: Record<string, unknown>[] = [];
  const custBase =
    `select c.consignee_id::text as id, c.name, c.entity_code, c.b2b_code, c.is_active,
            coalesce(l.loads, 0) as loads, coalesce(inv.invoices, 0) as invoices__XW_COL__
     from core.dim_customer c
     left join (select consignee_id, count(*)::int loads from raw.ft_dispatch_load group by 1) l
       on l.consignee_id = c.consignee_id
     left join (select consignee_id, count(*)::int invoices from core.fact_customer_invoice group by 1) inv
       on inv.consignee_id = c.consignee_id__XW_JOIN__
     order by coalesce(l.loads, 0) desc, c.name nulls last`;
  if (hasXw) {
    try {
      customers = (await c.query(custBase
        .replace('__XW_COL__', ', to_jsonb(xw) as xw')
        .replace('__XW_JOIN__', '\n     left join core.crosswalk_customer_retail xw on xw.consignee_id = c.consignee_id'))).rows;
    } catch (e) {
      genNotes.push(`crosswalk_customer_retail exists but the join failed (${(e as Error).message}) — customers rendered without the retail guess`);
    }
  } else {
    genNotes.push('core.crosswalk_customer_retail (0045, Part 1) not present yet — customers rendered without the retail guess');
  }
  if (customers.length === 0) {
    customers = (await c.query(custBase.replace('__XW_COL__', '').replace('__XW_JOIN__', ''))).rows;
  }
  sections.push({
    key: 'customers',
    title: `Customers (${customers.length})`,
    ask: 'What do you CALL this customer? (aliases, comma-separated — e.g. "Coles Melbourne, CML")',
    items: customers.map((r) => ({
      t: 'customer', k: String(r.id), c: (r.name as string) ?? (r.entity_code as string) ?? String(r.id),
      m: [
        r.entity_code ? `code ${r.entity_code}` : null,
        r.b2b_code ? `b2b ${r.b2b_code}` : null,
        retailGuess((r.xw as Record<string, unknown>) ?? null) || null,
        r.is_active === false ? 'INACTIVE' : null,
      ].filter(Boolean).join(' · '),
      u: `${Number(r.loads).toLocaleString()} loads · ${Number(r.invoices).toLocaleString()} invoices`,
    })),
  });

  // ── GROWERS: non-test, code + name ───────────────────────────────────────────
  const growers = (await c.query(
    `select g.consignor_id::text as id, g.code, g.org_name, g.is_active,
            coalesce(l.loads, 0) as loads, coalesce(s.schedules, 0) as schedules
     from core.dim_grower g
     left join (select consignor_id, count(*)::int loads from raw.ft_dispatch_load group by 1) l
       on l.consignor_id = g.consignor_id
     left join (select consignor_id, count(*)::int schedules from core.fact_gp_settlement group by 1) s
       on s.consignor_id = g.consignor_id
     where coalesce(g.is_test, false) = false
     order by coalesce(l.loads, 0) desc, g.code`)).rows;
  sections.push({
    key: 'growers',
    title: `Growers (${growers.length}, test sites excluded)`,
    ask: 'What do you CALL this grower? (nicknames, comma-separated — e.g. "the Howes, Howe Farming Tableland")',
    items: growers.map((g) => ({
      t: 'grower', k: g.id, c: g.org_name ?? g.code ?? g.id,
      m: [`code ${g.code}`, g.is_active === false ? 'INACTIVE' : null].filter(Boolean).join(' · '),
      u: `${Number(g.loads).toLocaleString()} loads · ${Number(g.schedules).toLocaleString()} GP schedules`,
    })),
  });

  // ── SHEDS ────────────────────────────────────────────────────────────────────
  const sheds = (await c.query(
    `select shed_id::text as id, shed_name from core.dim_shed order by shed_name`)).rows;
  sections.push({
    key: 'sheds',
    title: `Sheds / packhouses (${sheds.length})`,
    ask: 'What do you CALL this shed? (aliases, comma-separated)',
    items: sheds.map((s) => ({ t: 'shed', k: s.id, c: s.shed_name, m: '', u: '' })),
  });

  // ── SEGMENTS & GEOGRAPHIES: the live scan values (static fallback) ──────────
  const segLabel: Record<string, string> = {
    ALL: 'All bananas (category total)', REGULAR: 'Regular bananas', PRE_PACK: 'Pre-pack bananas',
    LADY_FINGER: 'Lady finger bananas', OTHER: 'Other bananas',
  };
  let segs = (await c.query<{ segment: string; n: string }>(
    `select segment, count(*)::text as n from core.fact_retail_scan
     where segment in ('ALL','REGULAR','PRE_PACK','LADY_FINGER','OTHER') group by 1 order by 1`)).rows;
  if (segs.length === 0) {
    genNotes.push('core.fact_retail_scan carries no rows — segments/geographies rendered from the static 0043 contract');
    segs = Object.keys(segLabel).map((s) => ({ segment: s, n: '0' }));
  }
  sections.push({
    key: 'segments',
    title: `Banana segments (Coles scan, ${segs.length})`,
    ask: 'What do you CALL this segment? (e.g. "clusters" — whatever the business says)',
    items: segs.map((s) => ({
      t: 'segment', k: s.segment, c: segLabel[s.segment] ?? s.segment,
      m: `scan code ${s.segment}`, u: `${Number(s.n).toLocaleString()} scan rows`,
    })),
  });

  const geoLabel: Record<string, string> = {
    AU: 'Australia (Coles national)', 'NSW+ACT': 'NSW + ACT', QLD: 'Queensland',
    'SA+NT': 'SA + NT', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia',
  };
  let geos = (await c.query<{ geography_code: string; n: string }>(
    `select geography_code, count(*)::text as n from core.fact_retail_scan group by 1 order by 1`)).rows;
  if (geos.length === 0) geos = Object.keys(geoLabel).map((g) => ({ geography_code: g, n: '0' }));
  sections.push({
    key: 'geographies',
    title: `Geographies (Coles scan, ${geos.length})`,
    ask: 'What do you CALL this region? (comma-separated)',
    items: geos.map((g) => ({
      t: 'geography', k: g.geography_code, c: geoLabel[g.geography_code] ?? g.geography_code,
      m: `scan code ${g.geography_code}`, u: `${Number(g.n).toLocaleString()} scan rows`,
    })),
  });

  // ── CHARGES: GP + NS categories, then the top charges by dollars ────────────
  const gpCats: Item[] = [
    { t: 'charge_category', k: 'gp:FR', c: 'FR — Freight (GP)', m: 'FreshTrack grower-pool deduction bucket', u: '' },
    { t: 'charge_category', k: 'gp:WH', c: 'WH — Warehouse (GP)', m: 'ripening, handling, storage…', u: '' },
    { t: 'charge_category', k: 'gp:MD', c: 'MD — Market Deductions (GP)', m: 'commission, rebates, levies…', u: '' },
    { t: 'charge_category', k: 'gp:MI', c: 'MI — Misc (GP)', m: '', u: '' },
    { t: 'charge_category', k: 'gp:LA', c: 'LA — Load Adjustment (GP)', m: '⚠ in FreshTrack LA = Load Adjustment (NOT Larapinta)', u: '' },
    { t: 'charge_category', k: 'ns:FR', c: 'FR — Freight (NetSuite)', m: 'RCTI charge items 1xxxxx', u: '' },
    { t: 'charge_category', k: 'ns:WH', c: 'WH — Warehouse (NetSuite)', m: 'RCTI charge items 2xxxxx', u: '' },
    { t: 'charge_category', k: 'ns:MD', c: 'MD — Market Deductions (NetSuite)', m: 'RCTI charge items 3xxxxx', u: '' },
    { t: 'charge_category', k: 'ns:MI', c: 'MI — Misc (NetSuite)', m: 'RCTI charge items 4xxxxx', u: '' },
    { t: 'charge_category', k: 'ns:LA', c: 'LA — Larapinta (NetSuite)', m: '⚠ in NetSuite LA = Larapinta (NOT Load Adjustment)', u: '' },
  ];
  const gpCharges = (await c.query(
    `select dgc.charge_id::text as id, dgc.name, dgc.category, dgc.category_label, dgc.subcategory,
            round(sum(ca.total_amount_value), 2)::float8 as dollars, count(*)::int as n
     from core.dim_gp_charge dgc
     join raw.ft_charge_applied ca on ca.charge_id = dgc.charge_id
     where ca.gp_schedule_id is not null and ca.is_deductible
     group by 1, 2, 3, 4, 5
     order by sum(ca.total_amount_value) desc
     limit 25`)).rows;
  const nsCharges = (await c.query(
    `select d.item_id::text as id, d.itemid, d.displayname, d.category, d.category_label, d.subcategory,
            round(sum(l.foreignamount), 2)::float8 as dollars, count(*)::int as n
     from core.dim_ns_charge d
     join raw.ns_vendor_bill_line l on l.item = d.item_id
     where l.mainline = false and coalesce(l.taxline, false) = false and d.category <> 'PRODUCT'
     group by 1, 2, 3, 4, 5, 6
     order by abs(sum(l.foreignamount)) desc
     limit 25`)).rows;
  sections.push({
    key: 'charges',
    title: `Deductions & charges (${gpCats.length} categories + top ${gpCharges.length} GP / ${nsCharges.length} NetSuite charges by $)`,
    ask: 'What do you call these deductions when you talk about them? (comma-separated)',
    items: [
      ...gpCats,
      ...gpCharges.map((ch) => ({
        t: 'charge_category', k: `gp_charge:${ch.id}`, c: ch.name as string,
        m: `GP · ${ch.category} ${ch.category_label}${ch.subcategory ? ' · ' + ch.subcategory : ''}`,
        u: `${fmtMoney(Number(ch.dollars))} · ${Number(ch.n).toLocaleString()} lines`,
      })),
      ...nsCharges.map((ch) => ({
        t: 'charge_category', k: `ns_item:${ch.itemid}`, c: ch.displayname as string,
        m: `NetSuite · item ${ch.itemid} · ${ch.category} ${ch.category_label}${ch.subcategory ? ' · ' + ch.subcategory : ''}`,
        u: `${fmtMoney(Number(ch.dollars))} · ${Number(ch.n).toLocaleString()} lines`,
      })),
    ],
  });

  // ── METRICS: the seeded 0048 catalog (fallback: embedded list) ───────────────
  let metrics: { key: string; def: string }[] = [];
  const hasBt = (await c.query<{ ok: string | null }>(
    `select to_regclass('core.business_term')::text as ok`)).rows[0]!.ok !== null;
  if (hasBt) {
    metrics = (await c.query<{ key: string; def: string }>(
      `select entity_key as key, coalesce(max(notes), '') as def
       from core.business_term
       where entity_type = 'metric' and source in ('seed', 'derived')
       group by entity_key order by entity_key`)).rows;
  }
  if (metrics.length === 0) {
    genNotes.push('0048 metric seed not found (run `select core.seed_business_terms();`) — metric list rendered from the embedded fallback');
    metrics = METRICS_FALLBACK;
  }
  sections.push({
    key: 'metrics',
    title: `Metrics (${metrics.length} governed measures)`,
    ask: 'What would you ASK FOR to get this number? ("tonnes shipped", "what we cleared", … comma-separated)',
    items: metrics.map((mt) => ({
      t: 'metric', k: mt.key, c: mt.key, m: mt.def, u: '',
    })),
  });

  return { sections, genNotes };
}

export async function buildGlossaryTool(): Promise<string> {
  const pool = makePool();
  const c = await pool.connect();
  try {
    const { sections, genNotes } = await buildSections(c);
    const date = new Date().toISOString().slice(0, 10);
    const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
    const html = TEMPLATE
      .replace('__SECTIONS__', safeJson(sections))
      .replace('__FREEFORM__', safeJson(FREEFORM))
      .replace('__GENNOTES__', safeJson(genNotes))
      .replace(/__DATE__/g, date);
    mkdirSync('reports', { recursive: true });
    const path = `reports/nl_glossary_${date}.html`;
    writeFileSync(path, html, 'utf8');
    const total = sections.reduce((a, s) => a + s.items.length, 0);
    log(`glossary tool written: ${path} (${sections.length} sections, ${total} entities, ${FREEFORM.length} free-form prompts)`);
    for (const n of genNotes) log(`  NOTE ${n}`);
    return path;
  } finally {
    c.release();
    await pool.end();
  }
}

// The page. Embedded script uses NO backticks / NO \${} (kept template-literal-safe).
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mackays vocabulary — what do YOU call things? — __DATE__</title>
<style>
  :root{ --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --bg:#f8fafc; --brand:#0f2b46; --go:#22c55e; }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 "Segoe UI",Arial,sans-serif;color:var(--ink);background:var(--bg)}
  header{background:var(--brand);color:#fff;padding:18px 24px}
  header h1{margin:0 0 6px;font-size:20px}
  header p{margin:4px 0;color:#cbd5e1;max-width:1050px}
  header b{color:#fff}
  .gnote{background:#78350f;color:#fde68a;border-radius:6px;padding:6px 10px;margin-top:8px;font-size:12.5px}
  .wrap{max-width:1240px;margin:0 auto;padding:16px 24px 130px}
  .toolbar{position:sticky;top:0;z-index:20;background:#fff;border:1px solid var(--line);border-radius:8px;
           padding:10px 14px;margin:10px 0;display:flex;gap:14px;align-items:center;flex-wrap:wrap;
           box-shadow:0 2px 6px rgba(0,0,0,.06)}
  .toolbar input[type=search]{flex:1;min-width:220px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px}
  .fbtn{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
  .fbtn.on{background:var(--brand);color:#fff;border-color:var(--brand)}
  .section{background:#fff;border:1px solid var(--line);border-radius:8px;margin:14px 0;overflow:hidden}
  .sech{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#eef2f7;cursor:pointer;flex-wrap:wrap}
  .sech h2{margin:0;font-size:15px}
  .sech .sub{color:var(--muted);font-size:12.5px}
  .sech .prog{margin-left:auto;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
  .sech button{padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-size:12px}
  .ask{padding:8px 14px;border-top:1px solid var(--line);background:#fffbeb;color:#92400e;font-size:12.5px}
  .row{display:flex;align-items:center;gap:12px;padding:8px 14px;border-top:1px solid var(--line);flex-wrap:wrap}
  .row.hidden{display:none}
  .row.done{background:#f0fdf4}
  .row.skip{background:#f9fafb;opacity:.72}
  .row .info{flex:1 1 300px;min-width:260px}
  .row .nm{font-weight:600}
  .row .meta{color:var(--muted);font-size:12px;margin-top:1px}
  .row .use{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .row input[type=text]{padding:6px 9px;border:1px solid var(--line);border-radius:6px;font-size:13px}
  .row .alias{width:290px}
  .row .note{width:220px}
  .row .skipbtn{border:1px solid var(--line);background:#fff;border-radius:12px;padding:4px 10px;cursor:pointer;
                font-size:12px;color:var(--muted);white-space:nowrap}
  .row.skip .skipbtn{background:#6b7280;color:#fff;border-color:#6b7280}
  .ff{padding:10px 14px;border-top:1px solid var(--line)}
  .ff .eg{color:var(--muted);font-size:12.5px;margin:4px 0 8px;padding-left:16px}
  .ff textarea{width:100%;min-height:110px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;
               font:13px/1.5 "Segoe UI",Arial,sans-serif;resize:vertical}
  footer{position:fixed;left:0;right:0;bottom:0;background:var(--brand);color:#fff;padding:10px 24px;z-index:30;
         display:flex;gap:22px;align-items:center;flex-wrap:wrap;box-shadow:0 -3px 8px rgba(0,0,0,.2)}
  footer .stat{font-size:12.5px;color:#cbd5e1}
  footer .stat b{color:#fff;font-size:15px}
  .bar{height:6px;background:#1e3a5f;border-radius:3px;width:200px;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--go);width:0}
  .gen{margin-left:auto;background:var(--go);border:none;color:#04240f;font-weight:700;font-size:15px;
       padding:11px 22px;border-radius:8px;cursor:pointer}
  .gen:hover{background:#4ade80}
  .reset{background:none;border:1px solid #475569;color:#cbd5e1;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>Mackays vocabulary — what do YOU call things?</h1>
  <p>This teaches the data hub to answer questions in <b>your language</b> ("cavs to Coles Melbourne",
     "week 31", "lady fingers"). For each item: type the <b>names you actually use</b>
     (comma-separate several), add a note if useful, or hit <b>no alias</b> if you just call it what
     it's already called. Use the per-section <b>"no alias for the rest"</b> button to fly through.
     Everything saves automatically in this browser — close and come back any time. When done, click
     <b>Generate</b> (bottom right) and send the downloaded JSON file back to Claude.</p>
  <div id="gnotes"></div>
</header>
<div class="wrap">
  <div class="toolbar">
    <input id="q" type="search" placeholder="Search anything — name, code, crop, charge…">
    <button class="fbtn on" data-f="all">All</button>
    <button class="fbtn" data-f="todo">To do</button>
    <button class="fbtn" data-f="done">Done</button>
  </div>
  <div id="sections"></div>
  <div id="freeform"></div>
</div>
<footer>
  <div class="stat">Entities answered<br><b id="pc">0 / 0</b></div>
  <div class="bar"><i id="pb"></i></div>
  <div class="stat">Aliases typed<br><b id="pa">0</b></div>
  <div class="stat">Free-form lines<br><b id="pf">0</b></div>
  <button class="reset" id="reset">Reset all</button>
  <button class="gen" id="gen">⬇ Generate (JSON for Claude)</button>
</footer>
<script>
"use strict";
var SECTIONS = __SECTIONS__;
var FREEFORM = __FREEFORM__;
var GENNOTES = __GENNOTES__;
var LSKEY = "nl_glossary___DATE__";

var state = {};   // rows: {"<t>|<k>": {a: aliases, n: note, s: skipped}}; textareas: {"ff:<cat>": text}
try { state = JSON.parse(localStorage.getItem(LSKEY) || "{}"); } catch (e) { state = {}; }
function save() { localStorage.setItem(LSKEY, JSON.stringify(state)); }
function rowState(key) { return state[key] || {}; }
function answered(key) {
  var st = rowState(key);
  return !!(st.s || (st.a && st.a.trim() !== ""));
}

// generation notes (e.g. crosswalk not landed yet)
(function () {
  var host = document.getElementById("gnotes");
  GENNOTES.forEach(function (n) {
    var d = document.createElement("div");
    d.className = "gnote"; d.textContent = "Note: " + n;
    host.appendChild(d);
  });
})();

var allRows = [];        // {key, el, sec}
var secEls = {};         // section key -> {progEl, items:[keys]}

function paint(row) {
  var st = rowState(row.dataset.key);
  row.querySelector(".alias").value = st.a || "";
  row.querySelector(".note").value = st.n || "";
  row.classList.toggle("skip", !!st.s);
  row.classList.toggle("done", answered(row.dataset.key) && !st.s);
  row.querySelector(".skipbtn").textContent = st.s ? "no alias ✓" : "no alias";
}

function buildRow(item) {
  var key = item.t + "|" + item.k;
  var row = document.createElement("div");
  row.className = "row";
  row.dataset.key = key;
  row.dataset.text = (item.c + " " + item.m + " " + item.k).toLowerCase();

  var info = document.createElement("div"); info.className = "info";
  var nm = document.createElement("div"); nm.className = "nm"; nm.textContent = item.c;
  info.appendChild(nm);
  if (item.m) { var mt = document.createElement("div"); mt.className = "meta"; mt.textContent = item.m; info.appendChild(mt); }
  row.appendChild(info);
  if (item.u) { var use = document.createElement("div"); use.className = "use"; use.textContent = item.u; row.appendChild(use); }

  var alias = document.createElement("input");
  alias.type = "text"; alias.className = "alias"; alias.placeholder = "what you call it (comma-separate)";
  alias.oninput = function () {
    var st = rowState(key); st.a = alias.value; if (alias.value.trim() !== "") st.s = false;
    state[key] = st; save(); paint(row); summary();
  };
  row.appendChild(alias);

  var note = document.createElement("input");
  note.type = "text"; note.className = "note"; note.placeholder = "notes (optional)";
  note.oninput = function () {
    var st = rowState(key); st.n = note.value; state[key] = st; save(); paint(row); summary();
  };
  row.appendChild(note);

  var skip = document.createElement("button");
  skip.className = "skipbtn";
  skip.onclick = function () {
    var st = rowState(key); st.s = !st.s; state[key] = st; save(); paint(row); summary();
  };
  row.appendChild(skip);
  return row;
}

var host = document.getElementById("sections");
SECTIONS.forEach(function (sd) {
  var sec = document.createElement("div"); sec.className = "section";
  var h = document.createElement("div"); h.className = "sech";
  var h2 = document.createElement("h2"); h2.textContent = sd.title; h.appendChild(h2);
  var prog = document.createElement("span"); prog.className = "prog"; h.appendChild(prog);
  var bulk = document.createElement("button");
  bulk.textContent = "no alias for the rest (visible)";
  bulk.onclick = function (e) {
    e.stopPropagation();
    sec.querySelectorAll(".row").forEach(function (r) {
      if (!r.classList.contains("hidden") && !answered(r.dataset.key)) {
        var st = rowState(r.dataset.key); st.s = true; state[r.dataset.key] = st; paint(r);
      }
    });
    save(); summary();
  };
  h.appendChild(bulk);

  var ask = document.createElement("div"); ask.className = "ask"; ask.textContent = sd.ask;
  var body = document.createElement("div");
  h.onclick = function () {
    var hid = body.style.display === "none";
    body.style.display = hid ? "" : "none";
    ask.style.display = hid ? "" : "none";
  };
  var keys = [];
  sd.items.forEach(function (it) {
    var row = buildRow(it);
    row.dataset.sec = sd.key;
    keys.push(row.dataset.key);
    allRows.push(row);
    body.appendChild(row);
    paint(row);
  });
  secEls[sd.key] = { progEl: prog, keys: keys };
  sec.appendChild(h); sec.appendChild(ask); sec.appendChild(body);
  host.appendChild(sec);
});

// free-form guided sections
var ffHost = document.getElementById("freeform");
FREEFORM.forEach(function (ff) {
  var sec = document.createElement("div"); sec.className = "section";
  var h = document.createElement("div"); h.className = "sech";
  var h2 = document.createElement("h2"); h2.textContent = ff.title; h.appendChild(h2);
  var sub = document.createElement("span"); sub.className = "sub"; sub.textContent = "free-form · one per line"; h.appendChild(sub);
  var wrap = document.createElement("div"); wrap.className = "ff";
  var ask = document.createElement("div"); ask.className = "ask"; ask.textContent = ff.ask;
  var eg = document.createElement("ul"); eg.className = "eg";
  ff.examples.forEach(function (x) { var li = document.createElement("li"); li.textContent = x; eg.appendChild(li); });
  var ta = document.createElement("textarea");
  ta.value = state["ff:" + ff.cat] || "";
  ta.oninput = function () { state["ff:" + ff.cat] = ta.value; save(); summary(); };
  h.onclick = function () { wrap.style.display = wrap.style.display === "none" ? "" : "none"; };
  wrap.appendChild(eg); wrap.appendChild(ta);
  sec.appendChild(h); sec.appendChild(ask); sec.appendChild(wrap);
  ffHost.appendChild(sec);
});

var filterMode = "all";
function applyFilter() {
  var q = document.getElementById("q").value.toLowerCase();
  allRows.forEach(function (r) {
    var done = answered(r.dataset.key);
    var vis = (!q || r.dataset.text.indexOf(q) >= 0) &&
              (filterMode === "all" || (filterMode === "done") === done);
    r.classList.toggle("hidden", !vis);
  });
}
document.getElementById("q").oninput = applyFilter;
document.querySelectorAll(".fbtn").forEach(function (b) {
  b.onclick = function () {
    filterMode = b.dataset.f;
    document.querySelectorAll(".fbtn").forEach(function (x) { x.classList.toggle("on", x === b); });
    applyFilter();
  };
});

function ffLines(cat) {
  var v = state["ff:" + cat] || "";
  return v.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
}

function summary() {
  var total = 0, done = 0, aliases = 0;
  SECTIONS.forEach(function (sd) {
    var sdone = 0;
    sd.items.forEach(function (it) {
      total++;
      var key = it.t + "|" + it.k;
      if (answered(key)) { done++; sdone++; }
      var st = rowState(key);
      if (st.a) {
        aliases += st.a.split(",").map(function (s) { return s.trim(); })
                       .filter(function (s) { return s !== ""; }).length;
      }
    });
    secEls[sd.key].progEl.textContent = sdone + " / " + sd.items.length;
  });
  var ff = 0;
  FREEFORM.forEach(function (f) { ff += ffLines(f.cat).length; });
  document.getElementById("pc").textContent = done + " / " + total;
  document.getElementById("pb").style.width = total ? Math.round(100 * done / total) + "%" : "0%";
  document.getElementById("pa").textContent = String(aliases);
  document.getElementById("pf").textContent = String(ff);
}
summary();

document.getElementById("reset").onclick = function () {
  if (confirm("Clear EVERYTHING you have entered on this page?")) {
    state = {}; save();
    allRows.forEach(paint);
    document.querySelectorAll("textarea").forEach(function (t) { t.value = ""; });
    summary();
  }
};

document.getElementById("gen").onclick = function () {
  var terms = [], phrases = [];
  SECTIONS.forEach(function (sd) {
    sd.items.forEach(function (it) {
      var key = it.t + "|" + it.k;
      var st = rowState(key);
      var note = (st.n || "").trim();
      var list = (st.a || "").split(",").map(function (s) { return s.trim(); })
                             .filter(function (s) { return s !== ""; });
      list.forEach(function (alias) {
        terms.push({ entity_type: it.t, entity_key: it.k, canonical_name: it.c,
                     alias: alias, notes: note || null });
      });
      if (list.length === 0 && note !== "") {
        // a note with no alias has no term id — carry it as a general phrase so it is never lost
        phrases.push({ category: "general", phrase: it.c, meaning: note,
                       notes: "note on " + it.t + " " + it.k + " (glossary tool, no alias given)" });
      }
    });
  });
  FREEFORM.forEach(function (f) {
    ffLines(f.cat).forEach(function (line) {
      phrases.push({ category: f.cat, phrase: line });
    });
  });
  if (terms.length === 0 && phrases.length === 0) {
    alert("Nothing to export yet — type at least one alias, note or free-form line first.");
    return;
  }
  var todo = 0;
  SECTIONS.forEach(function (sd) {
    sd.items.forEach(function (it) { if (!answered(it.t + "|" + it.k)) todo++; });
  });
  if (todo > 0 && !confirm(todo + " item(s) are still unanswered (neither an alias nor 'no alias'). " +
      "They simply won't be exported. Generate anyway?")) return;
  var payload = { generated: new Date().toISOString(), tool: "nl_glossary___DATE__",
                  terms: terms, phrases: phrases };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  var aEl = document.createElement("a");
  aEl.href = URL.createObjectURL(blob);
  aEl.download = "nl_glossary_submission___DATE__.json";
  document.body.appendChild(aEl); aEl.click();
  setTimeout(function () { URL.revokeObjectURL(aEl.href); aEl.remove(); }, 500);
};
</script>
</body>
</html>`;

if (isMain(import.meta.url)) {
  try {
    await buildGlossaryTool();
  } catch (e) {
    console.error('nl:tool FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
