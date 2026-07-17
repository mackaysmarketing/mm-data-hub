// ─────────────────────────────────────────────────────────────────────────────
// RLS / grant posture sweep — every relation in raw/core/semantic, asserted
// against an explicit registry. Joins the standing proof suite.
//   npm run rls:posture
//
// Enumerates EVERY relation (tables AND views, incl. the security_invoker flag
// from reloptions) live from pg_catalog and asserts each against the REGISTRY
// below. A relation missing from the registry FAILS the run — the registry must
// stay complete as the warehouse grows. Any posture anomaly FAILS with specifics.
//
// Posture classes (see REGISTRY):
//   grower-scoped          table; RLS on; authenticated policy referencing
//                          semantic.current_consignor_ids() (or the legacy scalar
//                          current_consignor_id()) OR'd with is_internal_claim();
//                          PLUS an additive auth0_grower_own_* policy referencing
//                          semantic.auth0_consignor_ids() with NO internal branch (0050
//                          grower-portal path); cube_readonly read-all policy; grants
//                          authenticated+cube_readonly.
//   internal-only          table; RLS on; authenticated policy = semantic.is_internal_claim();
//                          cube policy; grants authenticated+cube_readonly.
//   shared-reference       table; RLS on; authenticated using(true) policy; cube policy;
//                          grants authenticated+cube_readonly (harmless lookup a
//                          grower-facing view may join — 0030 dim_dispatch_state rationale).
//   cube-only              table; RLS on; cube policy + grant; NO authenticated grant or
//                          policy (internal competitive data, e.g. retail — 0027/0028).
//   etl-only               table; NO authenticated grant or policy; cube grant optional;
//                          RLS optional (service_role/postgres ETL surface only).
//   semantic-invoker       view; security_invoker=true; grants authenticated+cube_readonly —
//                          scope comes from the UNDERLYING tables' RLS (checked separately).
//   shared-reference-view  view; deliberately NOT security_invoker (owner-rights minimal-
//                          disclosure lookup, e.g. core.dim_shed hides raw.ft_entity);
//                          grants authenticated+cube_readonly.
//   ungranted-view         view; NO authenticated grant (fail-closed for JWT callers,
//                          e.g. semantic.retail_prices); cube grant optional.
//
// Registry-independent anomaly scans (each hit FAILS):
//   A1 table with an authenticated grant but RLS off (ungated read).
//   A2 RLS-on table granted to authenticated/cube_readonly with no policy for that
//      role (dead grant — fail-closed, but posture has drifted).
//   A3 policy for a role that holds no grant (dead policy — the 0030
//      dim_gp_charge/dim_ns_charge gap; remediated by migration 0036).
//   A4 any non-SELECT policy (writes go through service_role, which bypasses RLS) — UNLESS the
//      registry entry declares writes:'internal' AND the policy is exactly
//      is_internal_claim()-gated to authenticated (the 0052 grower-register tag tables: the
//      hub's first registered interactive-write surface; mm-hub staff write through
//      security_invoker views).
//   A5 any grantee outside {postgres, authenticated, cube_readonly} (hub_mcp must
//      hold NO standing grants per 0013; anon/PUBLIC must never appear).
//   A6 the app_metadata-only fail-closed helper functions exist.
//
// Entries marked pending:true are objects this sprint adds (C1/C2); absent live
// they are NOTED, present they are asserted. Exit 0 = zero unclassified + zero
// anomalies; 1 otherwise. Read-only (connects as the service pool).
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain, log } from '../src/lib/util.ts';

type PostureClass =
  | 'grower-scoped'
  | 'internal-only'
  | 'shared-reference'
  | 'cube-only'
  | 'etl-only'
  | 'semantic-invoker'
  | 'shared-reference-view'
  | 'ungranted-view';

interface RegistryEntry {
  cls: PostureClass;
  /** for view classes: pin the expected security_invoker flag */
  invoker?: boolean;
  /** object lands later in this sprint (C1/C2) — absence is a note, not a failure */
  pending?: boolean;
  /** DECLARED interactive-write surface: is_internal_claim()-gated INSERT/UPDATE/DELETE policies
   *  for authenticated are required AND are the only legal non-SELECT policies (A4; 0052). */
  writes?: 'internal';
  /** provenance: the migration(s) that declare this posture */
  why: string;
}

// ── THE REGISTRY — every relation in raw/core/semantic, classified from its
//    migration provenance. Adding a relation to the hub REQUIRES adding it here.
const REGISTRY: Record<string, RegistryEntry> = {
  // ── raw: FreshTrack dispatch ───────────────────────────────────────────────
  'raw.ft_dispatch_load':        { cls: 'grower-scoped', why: '0002 landing; RLS 0008/0010/0026 (consignor set)' },
  'raw.ft_pallet':               { cls: 'grower-scoped', why: '0003 landing; RLS 0008/0010/0026 (scope via load consignor subquery)' },
  'raw.ft_dispatch_load_state':  { cls: 'etl-only',      why: '0021 state lookup landing; cube grant only' },
  'raw.ft_entity':               { cls: 'etl-only',      why: '0004 entity master; carries org_tax_no — never granted; exposed only via core.dim_shed' },
  'raw.sync_window':             { cls: 'etl-only',      why: '0005 loader bookkeeping' },
  // ── raw: FreshTrack GP settlement (replica) ────────────────────────────────
  'raw.ft_gp_schedule':          { cls: 'etl-only',      why: '0017 GP landing; grower surface is semantic.grower_gp_settlement*' },
  'raw.ft_gp_detail':            { cls: 'etl-only',      why: '0017 GP landing' },
  'raw.ft_gp_payment':           { cls: 'etl-only',      why: '0017 GP landing' },
  'raw.ft_gp_status':            { cls: 'etl-only',      why: '0017 GP landing' },
  'raw.ft_charge':               { cls: 'etl-only',      why: '0018 charge rate card landing' },
  'raw.ft_charge_type':          { cls: 'etl-only',      why: '0018 charge type landing' },
  'raw.ft_charge_applied':       { cls: 'etl-only',      why: '0018 deduction ledger landing' },
  // ── raw: FreshTrack orders ─────────────────────────────────────────────────
  'raw.ft_order':                { cls: 'internal-only', why: '0023 order book (customer pricing — internal)' },
  'raw.ft_order_version':        { cls: 'internal-only', why: '0023' },
  'raw.ft_order_item':           { cls: 'internal-only', why: '0023' },
  // ── raw: NetSuite RCTIs ────────────────────────────────────────────────────
  'raw.ns_vendor':               { cls: 'etl-only',      why: '0014 NetSuite landing; grower surface is semantic.grower_settlement' },
  'raw.ns_vendor_bill':          { cls: 'etl-only',      why: '0014' },
  'raw.ns_vendor_bill_line':     { cls: 'etl-only',      why: '0014' },
  'raw.ns_vendor_payment':       { cls: 'etl-only',      why: '0014' },
  'raw.ns_bill_payment_link':    { cls: 'etl-only',      why: '0014' },
  'raw.ns_item':                 { cls: 'etl-only',      why: '0014' },
  // ── raw: retail (price-reporter) ───────────────────────────────────────────
  'raw.retail_prices':           { cls: 'cube-only',     why: '0027 — competitor pricing, never grower-visible; cube policy only' },
  // ── raw: reference landings added by this sprint (C1) ──────────────────────
  'raw.ft_consignee':            { cls: 'etl-only', pending: true, why: 'SPRINT C1 consignee/entity widening' },
  'raw.ft_product':              { cls: 'etl-only', pending: true, why: 'SPRINT C1 product reference landing' },
  'raw.ft_crop':                 { cls: 'etl-only', pending: true, why: 'SPRINT C1' },
  'raw.ft_variety':              { cls: 'etl-only', pending: true, why: 'SPRINT C1' },
  'raw.ft_pack_type':            { cls: 'etl-only', pending: true, why: 'SPRINT C1' },
  // ── raw: AR landings (accounts-receivable sprint) ──────────────────────────
  'raw.ft_invoice':              { cls: 'etl-only', why: 'AR 0037 — customer invoice origin (FreshTrack)' },
  'raw.ft_dispatch_load_invoice':{ cls: 'etl-only', why: 'AR 0037 — invoice↔dispatch junction' },
  'raw.ns_customer':             { cls: 'etl-only', why: 'AR 0038 — NetSuite customer master' },
  'raw.ns_customer_invoice':     { cls: 'etl-only', why: 'AR 0038 — CustInvc (externalid=FT no crosswalk)' },
  'raw.ns_customer_invoice_line':{ cls: 'etl-only', why: 'AR 0038' },
  'raw.ns_customer_payment':     { cls: 'etl-only', why: 'AR 0038 — CustPymt (paid dates)' },
  'raw.ns_customer_credit':      { cls: 'etl-only', why: 'AR 0038 — CustCred' },
  'raw.ns_ar_apply_link':        { cls: 'etl-only', why: 'AR 0038 — PTLL invoice↔payment apply map' },
  'raw.remittance':              { cls: 'etl-only', why: 'AR 0039 — parsed remittance header' },
  'raw.remittance_line':         { cls: 'etl-only', why: 'AR 0039 — parsed remittance lines' },
  'raw.retail_scan':             { cls: 'etl-only', why: 'Scan 0042 — Coles Circana sell-through landing' },
  'raw.wow_scan_loads':          { cls: 'etl-only', why: 'WOW 0049 — Q.Checkout load ledger (sidecar)' },
  'raw.wow_scan_export':         { cls: 'etl-only', why: 'WOW 0049 — verbatim clean-CSV landing' },

  // ── core: dimensions ───────────────────────────────────────────────────────
  'core.dim_grower':             { cls: 'grower-scoped',    why: '0006; RLS 0008/0010/0026' },
  'core.dim_dispatch_state':     { cls: 'shared-reference', why: '0021; RLS 0030 — grower_dispatch_shipped inner-joins it' },
  'core.dim_gp_charge':          { cls: 'internal-only',    why: '0019; RLS 0030 (fee structure); authenticated grant remediated in 0036 (0030 policy was dead without it)' },
  'core.dim_ns_charge':          { cls: 'internal-only',    why: '0015; RLS 0030; authenticated grant remediated in 0036' },
  'core.dim_order':              { cls: 'internal-only',    why: '0024 (customer pricing)' },
  'core.dim_retail_product':     { cls: 'cube-only',        why: '0028 — retail watchlist, internal competitive data' },
  'core.dim_shed':               { cls: 'shared-reference-view', invoker: false,
    why: '0022 owner-rights lookup (hides raw.ft_entity, exposes shed_id+name only); LEFT-JOINed by grower-facing invoker views 0021/0022 so the authenticated grant is load-bearing; posture documented in 0036' },
  // ── core: facts ────────────────────────────────────────────────────────────
  'core.fact_settlement_bill':   { cls: 'grower-scoped', why: '0015; RLS 0016/0026' },
  'core.fact_gp_settlement':     { cls: 'grower-scoped', why: '0019; RLS 0020/0026' },
  'core.fact_gp_settlement_load':{ cls: 'grower-scoped', why: '0019; RLS 0020/0026' },
  'core.fact_order_item':        { cls: 'internal-only', why: '0024' },
  'core.fact_settlement_bridge': { cls: 'internal-only', why: '0031' },
  'core.fact_revenue_charge':    { cls: 'internal-only', why: '0031' },
  'core.fact_customer_invoice':  { cls: 'internal-only', why: 'AR 0040 — customer book (internal); RLS fail-closed to internal' },
  'core.fact_load_sale':         { cls: 'grower-scoped', why: 'grower-portal fix pack 0054 — retailer projection of the AR book at load×customer grain (consignee_name NOT carried); the 7th grower-scoped relation (0026 six + this)' },
  'core.fact_remittance_line':   { cls: 'internal-only', why: 'AR 0040 — remittance reconciliation (internal)' },
  'core.fact_retail_scan':       { cls: 'internal-only', why: 'Scan 0043 — retailer sell-through (internal)' },
  'core.wow_scan_weekly':        { cls: 'internal-only', why: 'WOW 0049 — Woolworths sell-through (internal)' },
  // ── core: views ────────────────────────────────────────────────────────────
  'core.load_box_reconciliation':{ cls: 'ungranted-view', invoker: true,  why: '0007 recon surface; cube grant only' },
  'core.crosswalk_ns_grower':    { cls: 'ungranted-view', invoker: false, why: '0015 owner-rights crosswalk; cube grant only' },
  'core.crosswalk_gp_grower':    { cls: 'ungranted-view', invoker: false, why: '0019 owner-rights crosswalk; cube grant only' },
  // ── core: conformed dims added by this sprint (C1) ─────────────────────────
  'core.dim_customer':           { cls: 'internal-only',    pending: true, why: 'SPRINT C1 — customer list is internal; no grower view joins it' },
  'core.dim_product':            { cls: 'shared-reference', pending: true, why: 'SPRINT C1 — harmless lookup, dim_dispatch_state rationale (0030)' },
  'core.dim_date':               { cls: 'shared-reference', pending: true, why: 'SPRINT C1 — calendar/pack-week lookup' },
  // ── core: insight-layer crosswalks + mart (Insight sprint 2026-07-12, 0045/0046) ──
  'core.crosswalk_customer_retail': { cls: 'internal-only', pending: true, why: 'Insight 0045 — consignee→retailer/state map (customer-book sensitivity; 0040 posture)' },
  'core.crosswalk_product_segment': { cls: 'internal-only', pending: true, why: 'Insight 0045 — product→scan segment map (serves internal-only scan surfaces; 0040 posture)' },
  'core.fact_market_week':          { cls: 'internal-only', pending: true, why: 'Insight 0046 — scan demand × our supply × farm gate mart (internal-grade throughout)' },
  // ── core: NL glossary (insight/NL sprint, 0048) ────────────────────────────
  'core.business_term':          { cls: 'internal-only', pending: true, why: 'NL 0048 — business vocabulary → hub entities (names customers/metrics; internal)' },
  'core.nl_phrase':              { cls: 'internal-only', pending: true, why: 'NL 0048 — free-form phrase → meaning/mapping (internal)' },
  // ── grower register (spatial + tagging; landed 2026-07-13/14 OUTSIDE this repo; posture 0052,
  //    anon stripped 0051 after the anon-REST incident). Staff feature behind mm-hub's gr_*
  //    security_invoker views — no grower-facing view joins these, hence internal-only.
  'raw.atcm_crop_blocks_fnq':    { cls: 'internal-only', why: 'register spatial landing (ATCM public dataset, FNQ); 0052' },
  'raw.qscf_lots_banana_belt':   { cls: 'internal-only', why: 'register spatial landing (QLD cadastre, banana belt); 0052' },
  'core.crop_block_parcel':      { cls: 'internal-only', why: 'register block×parcel overlap (derived, no grower info); 0052' },
  'core.block_grower_tag':       { cls: 'internal-only', writes: 'internal',
    why: 'register grower-attribution tags — staff read+WRITE via mm-hub public.gr_block_tags (invoker, auto-updatable); first registered interactive-write surface (0052)' },
  'core.parcel_grower_tag':      { cls: 'internal-only', writes: 'internal',
    why: 'register parcel tags — staff read+write via mm-hub public.gr_grower_tags; 0052' },

  // ── semantic ───────────────────────────────────────────────────────────────
  'semantic.grower_dispatch_detail':        { cls: 'semantic-invoker', invoker: true, why: '0008/0022; scope = raw dispatch/pallet + dim_grower RLS; 0055 cleans product (+product_raw)' },
  'semantic.grower_dispatch_shipped':       { cls: 'semantic-invoker', invoker: true, why: '0021; 0055 cleans product (+product_raw)' },
  'semantic.grower_dispatch_load':          { cls: 'semantic-invoker', invoker: true, why: '0055 load-grain dispatch + consignment_status (fix pack FIX 4+6); scope = shipped view chain + grower-scoped facts' },
  'semantic.grower_load_sale':              { cls: 'semantic-invoker', invoker: true, why: '0055 retailer/sales per load (fix pack FIX 5+7); scope = fact_load_sale RLS (0054)' },
  'semantic.grower_settlement':             { cls: 'semantic-invoker', invoker: true, why: '0016; scope = fact_settlement_bill RLS' },
  'semantic.grower_gp_settlement':          { cls: 'semantic-invoker', invoker: true, why: '0020' },
  'semantic.grower_gp_settlement_load':     { cls: 'semantic-invoker', invoker: true, why: '0020' },
  'semantic.order_headers':                 { cls: 'semantic-invoker', invoker: true, why: '0025; internal gate = raw.ft_order* RLS' },
  'semantic.order_detail':                  { cls: 'semantic-invoker', invoker: true, why: '0025' },
  'semantic.order_sales':                   { cls: 'semantic-invoker', invoker: true, why: '0025' },
  'semantic.settlement_bridge_by_grower':   { cls: 'semantic-invoker', invoker: true, why: '0032; internal gate = fact_settlement_bridge RLS' },
  'semantic.settlement_bridge_by_product':  { cls: 'semantic-invoker', invoker: true, why: '0032' },
  'semantic.settlement_bridge_by_customer': { cls: 'semantic-invoker', invoker: true, why: '0032' },
  'semantic.mackays_revenue_fresh':         { cls: 'semantic-invoker', invoker: true, why: '0032' },
  'semantic.retail_prices':                 { cls: 'ungranted-view',   invoker: true, why: '0029 — deliberately NO authenticated grant (fail-closed); cube-only door' },
  'semantic.recon_settlement_source':       { cls: 'semantic-invoker', invoker: true, pending: true,
    why: 'SPRINT C2 (0035) GP↔NetSuite tie surface — internal gate = underlying facts RLS via security_invoker' },
  'semantic.ar_customer_invoice':           { cls: 'semantic-invoker', invoker: true, why: 'AR 0041; internal gate = fact_customer_invoice RLS' },
  'semantic.ar_debtor_open':                { cls: 'semantic-invoker', invoker: true, why: 'AR 0041' },
  'semantic.ar_remittance_reconciliation':  { cls: 'semantic-invoker', invoker: true, why: 'AR 0041' },
  'semantic.retail_scan':                   { cls: 'semantic-invoker', invoker: true, why: 'Scan 0044; internal gate = fact_retail_scan RLS' },
  'semantic.v_wow_scan_national':           { cls: 'semantic-invoker', invoker: true, why: 'WOW 0049; internal gate = wow_scan_weekly RLS' },
  'semantic.v_wow_scan_promo':              { cls: 'semantic-invoker', invoker: true, why: 'WOW 0049' },
  'semantic.v_scan_cross_retailer':         { cls: 'semantic-invoker', invoker: true, why: 'WOW 0049 — WOW ∪ Coles national weekly spine' },
  'semantic.market_week':                   { cls: 'semantic-invoker', invoker: true, pending: true,
    why: 'Insight 0047; internal gate = fact_market_week RLS via security_invoker' },
  'semantic.customer_margin':               { cls: 'semantic-invoker', invoker: true, pending: true,
    why: 'Insight 0047; internal gate = fact_customer_invoice + fact_settlement_bridge RLS' },
  'semantic.grower_scorecard':              { cls: 'semantic-invoker', invoker: true, pending: true,
    why: 'Insight 0047; STRICT internal via explicit is_internal_claim() WHERE gate (pool comparisons; 0035 rationale) on top of invoker RLS' },
  'semantic.retail_supplier_share':         { cls: 'semantic-invoker', invoker: true, pending: true,
    why: 'Insight 0047; internal gate = fact_retail_scan RLS' },
  'semantic.business_glossary':             { cls: 'semantic-invoker', invoker: true, pending: true,
    why: 'NL 0048 agent catalog; internal gate = business_term/nl_phrase RLS via security_invoker' },
  'semantic.grower_crop_area':              { cls: 'semantic-invoker', invoker: true,
    why: 'register grower × crop area rollup; invoker over internal-only tag tables (0052 — was owner-rights, the 0051 anon-REST incident); wrapped by mm-hub public.gr_grower_crop_area' },
};

const ALLOWED_GRANTEES = new Set(['postgres', 'authenticated', 'cube_readonly']);

interface Rel { rel: string; kind: string; rls: boolean; invoker: boolean; }
interface Pol { rel: string; name: string; roles: string[]; cmd: string; qual: string | null; check: string | null; }

const problems: string[] = [];
const notes: string[] = [];
function fail(msg: string): void { problems.push(msg); }

function hasCubePolicy(pols: Pol[]): boolean {
  return pols.some((p) => p.roles.includes('cube_readonly') && (p.qual ?? '').trim() === 'true' && p.cmd === 'SELECT');
}
function authPolicies(pols: Pol[]): Pol[] {
  return pols.filter((p) => p.roles.includes('authenticated'));
}

/** Assert one live relation against its registry class; returns '' when clean. */
function assertPosture(r: Rel, e: RegistryEntry, grants: Set<string>, pols: Pol[]): string {
  const errs: string[] = [];
  const isTable = r.kind === 'r' || r.kind === 'p';
  const auth = grants.has('authenticated');
  const cube = grants.has('cube_readonly');
  const ap = authPolicies(pols);
  const apQual = ap.map((p) => (p.qual ?? '').replace(/\s+/g, ' ').trim());

  const wantTable = ['grower-scoped', 'internal-only', 'shared-reference', 'cube-only', 'etl-only'].includes(e.cls);
  if (wantTable && !isTable) errs.push(`expected a table for class ${e.cls}, found relkind=${r.kind}`);
  if (!wantTable && isTable) errs.push(`expected a view for class ${e.cls}, found a table`);
  if (errs.length) return errs.join('; ');

  switch (e.cls) {
    case 'grower-scoped': {
      if (!r.rls) errs.push('RLS is OFF');
      if (!auth) errs.push('missing authenticated grant');
      if (!cube) errs.push('missing cube_readonly grant');
      if (!hasCubePolicy(pols)) errs.push('missing cube_readonly read-all policy');
      const ok = apQual.some((q) =>
        (q.includes('current_consignor_ids()') || q.includes('current_consignor_id()')) && q.includes('is_internal_claim()'));
      if (!ok) errs.push(`no authenticated policy referencing current_consignor_ids()/current_consignor_id() OR is_internal_claim() (found: ${apQual.join(' | ') || 'none'})`);
      // 0050: the additive Auth0 (grower-portal) path — issuer-pinned helper, no internal branch.
      const auth0Ok = apQual.some((q) => q.includes('auth0_consignor_ids()') && !q.includes('is_internal_claim()'));
      if (!auth0Ok) errs.push(`no additive auth0_grower policy referencing auth0_consignor_ids() without an internal branch (0050; found: ${apQual.join(' | ') || 'none'})`);
      break;
    }
    case 'internal-only': {
      if (!r.rls) errs.push('RLS is OFF');
      if (!auth) errs.push('missing authenticated grant (internal-only policy is dead without it)');
      if (!cube) errs.push('missing cube_readonly grant');
      if (!hasCubePolicy(pols)) errs.push('missing cube_readonly read-all policy');
      if (!apQual.some((q) => q === 'semantic.is_internal_claim()'))
        errs.push(`no authenticated is_internal_claim() policy (found: ${apQual.join(' | ') || 'none'})`);
      if (apQual.some((q) => q === 'true')) errs.push('has an authenticated using(true) policy — wrong flavor (that is shared-reference)');
      break;
    }
    case 'shared-reference': {
      if (!r.rls) errs.push('RLS is OFF');
      if (!auth) errs.push('missing authenticated grant');
      if (!cube) errs.push('missing cube_readonly grant');
      if (!hasCubePolicy(pols)) errs.push('missing cube_readonly read-all policy');
      if (!apQual.some((q) => q === 'true'))
        errs.push(`no authenticated using(true) policy (found: ${apQual.join(' | ') || 'none'})`);
      break;
    }
    case 'cube-only': {
      if (!r.rls) errs.push('RLS is OFF');
      if (auth) errs.push('has an authenticated grant — must be cube-only');
      if (ap.length) errs.push('has an authenticated policy — must be cube-only');
      if (!cube) errs.push('missing cube_readonly grant');
      if (!hasCubePolicy(pols)) errs.push('missing cube_readonly read-all policy');
      break;
    }
    case 'etl-only': {
      if (auth) errs.push('has an authenticated grant — etl-only must have none');
      if (ap.length) errs.push('has an authenticated policy — etl-only must have none');
      if (r.rls && cube && !hasCubePolicy(pols)) errs.push('RLS on + cube grant but no cube policy (Cube reads 0 rows)');
      break;
    }
    case 'semantic-invoker': {
      if (!r.invoker) errs.push('security_invoker is NOT set — an owner-rights view here would bypass base-table RLS');
      if (!auth) errs.push('missing authenticated grant');
      if (!cube) errs.push('missing cube_readonly grant');
      break;
    }
    case 'shared-reference-view': {
      if (r.invoker !== (e.invoker ?? false)) errs.push(`security_invoker=${r.invoker}, expected ${e.invoker ?? false} (owner-rights lookup by design)`);
      if (!auth) errs.push('missing authenticated grant (grower-facing invoker views join it — permission denied would break them)');
      if (!cube) errs.push('missing cube_readonly grant');
      break;
    }
    case 'ungranted-view': {
      if (auth) errs.push('has an authenticated grant — must stay fail-closed');
      if (e.invoker !== undefined && r.invoker !== e.invoker) errs.push(`security_invoker=${r.invoker}, expected ${e.invoker}`);
      break;
    }
  }
  return errs.join('; ');
}

export async function sweep(c: PoolClient): Promise<boolean> {
  log('=== RLS / grant posture sweep (raw, core, semantic) ===');

  const rels: Rel[] = (await c.query<{ rel: string; kind: string; rls: boolean; opts: string | null }>(
    `select n.nspname || '.' || c.relname as rel, c.relkind as kind, c.relrowsecurity as rls,
            c.reloptions::text as opts
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('raw', 'core', 'semantic')
        and c.relkind in ('r', 'v', 'm', 'p', 'f')
      order by 1`,
  )).rows.map((r) => ({ rel: r.rel, kind: r.kind, rls: r.rls, invoker: (r.opts ?? '').includes('security_invoker=true') }));

  const grantRows = (await c.query<{ rel: string; grantee: string }>(
    `select table_schema || '.' || table_name as rel, grantee
       from information_schema.role_table_grants
      where table_schema in ('raw', 'core', 'semantic') and privilege_type = 'SELECT'
      group by 1, 2`,
  )).rows;
  const grantsByRel = new Map<string, Set<string>>();
  for (const g of grantRows) {
    const s = grantsByRel.get(g.rel) ?? new Set<string>();
    s.add(g.grantee);
    grantsByRel.set(g.rel, s);
  }

  const pols: Pol[] = (await c.query<{ rel: string; name: string; roles: string[]; cmd: string; qual: string | null; check: string | null }>(
    `select schemaname || '.' || tablename as rel, policyname as name,
            roles::text[] as roles, cmd, qual, with_check as check
       from pg_policies
      where schemaname in ('raw', 'core', 'semantic')
      order by 1, 2`,
  )).rows;
  const polsByRel = new Map<string, Pol[]>();
  for (const p of pols) {
    const a = polsByRel.get(p.rel) ?? [];
    a.push(p);
    polsByRel.set(p.rel, a);
  }

  // ── A6 preflight: the fail-closed helpers must exist ────────────────────────
  const helpers = (await c.query(
    `select to_regprocedure('semantic.current_consignor_ids()')::text as ids,
            to_regprocedure('semantic.is_internal_claim()')::text     as internal,
            to_regprocedure('semantic.auth0_consignor_ids()')::text   as auth0`,
  )).rows[0]!;
  if (!helpers.ids || !helpers.internal || !helpers.auth0)
    fail(`A6 helper functions missing: current_consignor_ids=${helpers.ids} is_internal_claim=${helpers.internal} auth0_consignor_ids=${helpers.auth0}`);

  // ── Registry sweep ──────────────────────────────────────────────────────────
  log(`\nlive relations: ${rels.length} · registry entries: ${Object.keys(REGISTRY).length}`);
  log('\n--- Per-relation posture ---');
  const liveSet = new Set(rels.map((r) => r.rel));
  let okCount = 0;
  for (const r of rels) {
    const e = REGISTRY[r.rel];
    const kind = r.kind === 'v' ? (r.invoker ? 'view(invoker)' : 'view(owner)') : 'table';
    if (!e) {
      fail(`UNCLASSIFIED relation ${r.rel} (${kind}) — add it to the REGISTRY in scripts/rls_posture.ts with a declared posture`);
      log(`FAIL  ${r.rel.padEnd(45)} ${kind.padEnd(14)} UNCLASSIFIED — not in registry`);
      continue;
    }
    const err = assertPosture(r, e, grantsByRel.get(r.rel) ?? new Set(), polsByRel.get(r.rel) ?? []);
    if (err) {
      fail(`${r.rel} [${e.cls}]: ${err}`);
      log(`FAIL  ${r.rel.padEnd(45)} ${kind.padEnd(14)} ${e.cls} — ${err}`);
    } else {
      okCount++;
      log(`PASS  ${r.rel.padEnd(45)} ${kind.padEnd(14)} ${e.cls}`);
    }
  }
  for (const [rel, e] of Object.entries(REGISTRY)) {
    if (liveSet.has(rel)) continue;
    if (e.pending) notes.push(`PENDING ${rel} [${e.cls}] — expected after this sprint integrates (${e.why})`);
    else fail(`registry relation ${rel} [${e.cls}] is MISSING live — dropped without updating the registry?`);
  }

  // ── Registry-independent anomaly scans ──────────────────────────────────────
  log('\n--- Anomaly scans (registry-independent) ---');
  for (const r of rels) {
    const grants = grantsByRel.get(r.rel) ?? new Set<string>();
    const rp = polsByRel.get(r.rel) ?? [];
    const isTable = r.kind === 'r' || r.kind === 'p';
    // A1: authenticated grant on an RLS-off table = ungated read
    if (isTable && !r.rls && grants.has('authenticated'))
      fail(`A1 ${r.rel}: authenticated grant on an RLS-OFF table (ungated read)`);
    // A2: dead grants on RLS-on tables
    if (isTable && r.rls) {
      if (grants.has('authenticated') && authPolicies(rp).length === 0)
        fail(`A2 ${r.rel}: authenticated grant but NO authenticated policy (dead grant — posture drift)`);
      if (grants.has('cube_readonly') && !rp.some((p) => p.roles.includes('cube_readonly')))
        fail(`A2 ${r.rel}: cube_readonly grant but NO cube policy (Cube reads 0 rows)`);
    }
    // A3: dead policies (role has a policy but no grant)
    for (const p of rp) {
      for (const role of p.roles) {
        if ((role === 'authenticated' || role === 'cube_readonly') && !grants.has(role))
          fail(`A3 ${r.rel}: policy "${p.name}" targets ${role} but ${role} holds no SELECT grant (dead policy)`);
      }
    }
    // A4: non-SELECT policies — forbidden UNLESS the registry declares writes:'internal' and the
    // policy is exactly is_internal_claim()-gated to authenticated (0052 register tag tables).
    const entry = REGISTRY[r.rel];
    const GATE = 'semantic.is_internal_claim()';
    for (const p of rp) {
      if (p.cmd === 'SELECT') continue;
      const qual = (p.qual ?? '').replace(/\s+/g, ' ').trim();
      const chk = (p.check ?? '').replace(/\s+/g, ' ').trim();
      const okWrite = entry?.writes === 'internal'
        && p.roles.length === 1 && p.roles[0] === 'authenticated'
        && ((p.cmd === 'INSERT' && chk === GATE)
          || (p.cmd === 'UPDATE' && qual === GATE && chk === GATE)
          || (p.cmd === 'DELETE' && qual === GATE));
      if (!okWrite) {
        fail(`A4 ${r.rel}: non-SELECT policy "${p.name}" (cmd=${p.cmd})` +
          (entry?.writes === 'internal'
            ? ` — declared writes:internal but the policy is not exactly is_internal_claim()-gated to authenticated (qual=${qual || 'null'} check=${chk || 'null'})`
            : ''));
      }
    }
    // A4b: a declared writes:'internal' surface must actually carry all three gated write
    // policies — a missing one is a silently-broken write path (staff edits would 42501).
    if (entry?.writes === 'internal') {
      for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
        if (!rp.some((p) => p.cmd === cmd && p.roles.includes('authenticated')))
          fail(`A4b ${r.rel}: writes:'internal' declared but no authenticated ${cmd} policy exists`);
      }
    }
    // A5: unexpected grantees
    for (const g of grants) if (!ALLOWED_GRANTEES.has(g)) fail(`A5 ${r.rel}: unexpected grantee "${g}" (allowed: postgres, authenticated, cube_readonly)`);
  }

  // A6: sequences (relkind 'S') sit OUTSIDE the relation sweep (no RLS, not in the registry), so a
  // grant on one would be invisible above. They are ETL-owned identity generators — assert none is
  // reachable by authenticated (a granted sequence leaks nextval/last_value and row-count signal).
  const seqGrants = (await c.query<{ rel: string; grantee: string; priv: string }>(
    `select n.nspname || '.' || c.relname as rel, a.grantee::regrole::text as grantee, a.privilege_type as priv
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
      where c.relkind = 'S' and n.nspname in ('raw', 'core', 'semantic')
        and a.grantee <> c.relowner`,
  )).rows;
  for (const s of seqGrants) {
    if (s.grantee === 'authenticated')
      fail(`A6 ${s.rel}: sequence granted ${s.priv} to authenticated (identity sequences must stay ETL/owner-only)`);
    else if (!ALLOWED_GRANTEES.has(s.grantee))
      fail(`A6 ${s.rel}: sequence granted ${s.priv} to unexpected grantee "${s.grantee}"`);
  }
  log(problems.some((p) => p.startsWith('A')) ? '  anomalies found (listed below)' : `  no anomalies (incl. ${seqGrants.length} sequence grant(s) checked)`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  log('\n--- Summary ---');
  for (const n of notes) log(`NOTE  ${n}`);
  if (problems.length) {
    log(`\n${problems.length} problem(s):`);
    for (const p of problems) log(`FAIL  ${p}`);
    if (problems.some((p) => p.includes('dim_gp_charge') || p.includes('dim_ns_charge')))
      log('\nhint: the dim_gp_charge / dim_ns_charge dead-policy anomalies are remediated by supabase/migrations/0036_rls_posture_remediation.sql — apply it and re-run.');
  }
  log(`\n=== ${okCount}/${rels.length} relations conform · ${problems.length} problem(s) · ${notes.length} pending ===`);
  return problems.length === 0;
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const pass = await sweep(client);
    if (!pass) process.exitCode = 1;
  } catch (e) {
    console.error('rls:posture error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
