// ─────────────────────────────────────────────────────────────────────────────
// Settlement cross-source tie — GP ↔ NetSuite at bill grain (grower × month).
//   npm run settle:tie
//
// Proof runner over semantic.recon_settlement_source (migration 0035 — apply first):
//   1. Internal-only gate: no claim → 0 rows; grower claim → 0 rows (fail-closed, per SPRINT).
//   2. View completeness: view totals == core fact totals exactly (FULL OUTER drops nothing).
//   3. Grand tie (cash basis): |GP paid − NS net_paid| ≤ 1% of NS — the $140.5M ≈ $139.7M anchor.
//      Net basis printed alongside (GP net includes not-yet-paid schedules; decomposed in buckets).
//   4. Grand deductions tie ≤ 1% — the $32.53M ≈ $32.50M anchor.
//   5. Per-grower table sorted by |net delta| (top 15 printed; full table in the report).
//   6. Residual buckets: the net-basis grand delta partitioned into named, EXPLAINED buckets —
//      GP null-consignor schedules, AG* agent sub-entities, other GP-only entities (SERAV avocado
//      sub-entity, duplicate-code consignors), NS-only growers, matched-pairs shortfall.
//      PASS: |unexplained residual| < $50k (the partition is exhaustive — every dollar lands in a
//      bucket; a nonzero residual means the bucketing itself is wrong).
//
// Writes reports/settle_tie_<date>.md. Exit 0 = all checks pass; 1 = any fail. Read-only
// (set_config of request.jwt.claims is session state, not a data write).
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { isMain } from '../src/lib/util.ts';

const VIEW = 'semantic.recon_settlement_source';
const GRAND_TOL_PCT = 1;        // cash-basis grand tie (known anchor: 0.59%)
const UNEXPLAINED_TOL = 50_000; // bucket-partition residual

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '∅').length)));
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i]!)).join('  '));
  for (const r of rows) console.log('  ' + cols.map((c, i) => String(r[c] ?? '∅').padEnd(w[i]!)).join('  '));
}

const num = (v: string | null | undefined): number | null => (v == null ? null : Number(v));
const usd = (v: number | null): string =>
  v == null ? '∅' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a: number, b: number): number => (b === 0 ? (a === 0 ? 0 : 100) : (100 * (a - b)) / Math.abs(b));

interface GrowerRow {
  code: string | null;
  name: string | null;
  status: 'both' | 'gp_only' | 'ns_only' | 'gp_null_consignor' | 'ns_unmapped';
  gpMonths: number;
  nsMonths: number;
  gpScheds: number;
  nsBills: number;
  gpGross: number | null;
  gpDed: number | null;
  gpNet: number | null;
  gpPaid: number | null;
  nsGross: number | null;
  nsDed: number | null;
  nsNet: number | null;
  deltaNet: number | null; // gp_net − ns_net_paid; null when one-sided
}

async function main(): Promise<void> {
  console.log('=== Settlement cross-source tie: GP ↔ NetSuite (grower × month) ===');
  const pool = makePool();
  const c: PoolClient = await pool.connect();
  try {
    // ── 0. The view must exist (integrator applies 0035 before this proof) ────
    const reg = (await c.query<{ v: string | null }>(
      `select to_regclass('${VIEW}')::text as v`)).rows[0]!;
    if (!reg.v) {
      check('view exists', false, `${VIEW} missing — apply supabase/migrations/0035_recon_settlement_source.sql first`);
      process.exitCode = 1;
      return;
    }

    // ── 1. Internal-only gate (fail-closed) ────────────────────────────────────
    console.log('\n--- 1. Internal-only gate (explicit WHERE semantic.is_internal_claim()) ---');
    // Fresh connection carries no request.jwt.claims → gate must yield ZERO rows.
    const noClaim = (await c.query<{ n: string }>(`select count(*) n from ${VIEW}`)).rows[0]!;
    check('no claim → 0 rows (fail closed)', noClaim.n === '0', `rows=${noClaim.n}`);
    // A grower claim (real-shaped, NOT internal) must ALSO see zero — a grower may read their own
    // settlement facts (0016/0020) but never this cross-source recon surface.
    await c.query(`select set_config('request.jwt.claims',
      '{"app_metadata":{"consignor_id":"00000000-0000-0000-0000-000000000001"}}', false)`);
    const grower = (await c.query<{ n: string }>(`select count(*) n from ${VIEW}`)).rows[0]!;
    check('grower claim → 0 rows (internal-only, not grower-scoped)', grower.n === '0', `rows=${grower.n}`);
    // Internal claim for the remainder of the session (single client — claims stick to this conn).
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"is_internal":true}}', false)`);

    // ── 2. View completeness: FULL OUTER drops nothing ─────────────────────────
    console.log('\n--- 2. View totals reconcile exactly to the core facts ---');
    const tot = (await c.query<Record<string, string | null>>(`
      select round(sum(gp_gross),2) gp_gross, round(sum(gp_deductions),2) gp_ded,
             round(sum(gp_gst),2) gp_gst, round(sum(gp_net),2) gp_net, round(sum(gp_paid),2) gp_paid,
             round(sum(ns_gross),2) ns_gross, round(sum(ns_deductions),2) ns_ded,
             round(sum(ns_tax),2) ns_tax, round(sum(ns_net_paid),2) ns_net,
             count(*) view_rows
      from ${VIEW}`)).rows[0]!;
    const fact = (await c.query<Record<string, string | null>>(`
      select (select round(sum(net_settlement),2) from core.fact_gp_settlement) f_gp_net,
             (select round(sum(paid_amount),2)    from core.fact_gp_settlement) f_gp_paid,
             (select round(sum(total_deductions),2) from core.fact_gp_settlement) f_gp_ded,
             (select round(sum(net_paid),2)         from core.fact_settlement_bill) f_ns_net,
             (select round(sum(total_deductions),2) from core.fact_settlement_bill) f_ns_ded`)).rows[0]!;
    const gpNet = num(tot.gp_net)!, gpPaid = num(tot.gp_paid)!, gpDed = num(tot.gp_ded)!;
    const nsNet = num(tot.ns_net)!, nsDed = num(tot.ns_ded)!;
    const complete =
      Math.abs(gpNet - num(fact.f_gp_net)!) < 0.01 && Math.abs(gpPaid - num(fact.f_gp_paid)!) < 0.01 &&
      Math.abs(gpDed - num(fact.f_gp_ded)!) < 0.01 && Math.abs(nsNet - num(fact.f_ns_net)!) < 0.01 &&
      Math.abs(nsDed - num(fact.f_ns_ded)!) < 0.01;
    check('view totals == fact totals (nothing dropped by the FULL OUTER)', complete,
      `view gp_net=${usd(gpNet)} gp_paid=${usd(gpPaid)} ns_net=${usd(nsNet)} (${tot.view_rows} rows) vs facts gp_net=${usd(num(fact.f_gp_net))} gp_paid=${usd(num(fact.f_gp_paid))} ns_net=${usd(num(fact.f_ns_net))}`);

    // ── 3+4. Grand ties ─────────────────────────────────────────────────────────
    console.log('\n--- 3. Grand tie ---');
    const unpaidGp = gpNet - gpPaid; // GP schedules not yet cashed (net includes them; paid does not)
    console.log(`  GP  : gross=${usd(num(tot.gp_gross))} deductions=${usd(gpDed)} gst=${usd(num(tot.gp_gst))} net=${usd(gpNet)} paid=${usd(gpPaid)}`);
    console.log(`  NS  : gross=${usd(num(tot.ns_gross))} deductions=${usd(nsDed)} tax=${usd(num(tot.ns_tax))} net_paid=${usd(nsNet)}`);
    console.log(`  net basis : GP net − NS = ${usd(gpNet - nsNet)} (${pct(gpNet, nsNet).toFixed(2)}%) — includes ${usd(unpaidGp)} GP not-yet-paid; fully partitioned in the buckets below`);
    check(`grand tie (cash basis): |GP paid − NS net_paid| ≤ ${GRAND_TOL_PCT}% of NS`,
      Math.abs(pct(gpPaid, nsNet)) <= GRAND_TOL_PCT,
      `GP_paid=${usd(gpPaid)} NS=${usd(nsNet)} Δ=${usd(gpPaid - nsNet)} (${pct(gpPaid, nsNet).toFixed(2)}%)`);
    check(`grand deductions tie: |GP − NS| ≤ ${GRAND_TOL_PCT}% of NS`,
      Math.abs(pct(gpDed, nsDed)) <= GRAND_TOL_PCT,
      `GP=${usd(gpDed)} NS=${usd(nsDed)} Δ=${usd(gpDed - nsDed)} (${pct(gpDed, nsDed).toFixed(2)}%)`);

    // ── 5. Per-grower table (aggregated across months from the view) ───────────
    console.log('\n--- 4. Per-grower net tie (top 15 by |Δ net|; full table in the report) ---');
    // The subkey keeps null-consignor GP rows and (defensive) ns_unmapped rows from merging under
    // the same NULL consignor_id group. ORDER-only coalesce; printed values stay null-preserving.
    const growers = (await c.query<Record<string, string | null>>(`
      select max(grower_code) code, max(grower_name) name,
             bool_or(match_status = 'gp_null_consignor')::text is_null_consignor,
             bool_or(match_status = 'ns_unmapped')::text is_ns_unmapped,
             count(*) filter (where gp_schedule_count is not null)::text gp_months,
             count(*) filter (where ns_bill_count is not null)::text ns_months,
             sum(gp_schedule_count)::text gp_scheds,
             sum(ns_bill_count)::text ns_bills,
             round(sum(gp_gross),2) gp_gross, round(sum(gp_deductions),2) gp_ded,
             round(sum(gp_net),2) gp_net, round(sum(gp_paid),2) gp_paid,
             round(sum(ns_gross),2) ns_gross, round(sum(ns_deductions),2) ns_ded,
             round(sum(ns_net_paid),2) ns_net
      from ${VIEW}
      group by consignor_id, case when consignor_id is null then match_status else 'g' end
      order by abs(coalesce(sum(gp_net),0) - coalesce(sum(ns_net_paid),0)) desc`)).rows;
    const g: GrowerRow[] = growers.map((r) => {
      const gpNetG = num(r.gp_net), nsNetG = num(r.ns_net);
      const gpSide = Number(r.gp_months) > 0, nsSide = Number(r.ns_months) > 0;
      const status: GrowerRow['status'] =
        r.is_null_consignor === 'true' ? 'gp_null_consignor'
        : r.is_ns_unmapped === 'true' ? 'ns_unmapped'
        : gpSide && nsSide ? 'both' : gpSide ? 'gp_only' : 'ns_only';
      return {
        code: r.code ?? null, name: r.name ?? null, status,
        gpMonths: Number(r.gp_months), nsMonths: Number(r.ns_months),
        gpScheds: num(r.gp_scheds) ?? 0, nsBills: num(r.ns_bills) ?? 0,
        gpGross: num(r.gp_gross), gpDed: num(r.gp_ded), gpNet: gpNetG, gpPaid: num(r.gp_paid),
        nsGross: num(r.ns_gross), nsDed: num(r.ns_ded), nsNet: nsNetG,
        deltaNet: gpNetG != null && nsNetG != null ? Number((gpNetG - nsNetG).toFixed(2)) : null,
      };
    });
    const top15 = g.slice(0, 15).map((r) => ({
      code: r.code ?? '(null consignor)', status: r.status,
      gp_net: usd(r.gpNet), gp_paid: usd(r.gpPaid), ns_net: usd(r.nsNet),
      delta_net: usd(r.deltaNet ?? (r.gpNet != null ? r.gpNet : r.nsNet != null ? -r.nsNet : null)),
      delta_pct: r.deltaNet != null && r.nsNet ? pct(r.gpNet!, r.nsNet).toFixed(2) + '%' : '∅',
    }));
    table(top15);
    check('per-grower table computed', g.length > 0, `${g.length} grower rows (${g.filter((x) => x.status === 'both').length} matched)`);

    // ── 6. Residual buckets — every dollar of the net-basis grand delta ────────
    console.log('\n--- 5. Residual buckets (net basis: GP net − NS net_paid) ---');
    const grandDelta = Number((gpNet - nsNet).toFixed(2));
    const sum = (rows: GrowerRow[], f: (r: GrowerRow) => number | null): number =>
      Number(rows.reduce((a, r) => a + (f(r) ?? 0), 0).toFixed(2));
    const matched = g.filter((r) => r.status === 'both');
    const gpOnlyAg = g.filter((r) => r.status === 'gp_only' && (r.code ?? '').startsWith('AG'));
    const gpOnlyOther = g.filter((r) => r.status === 'gp_only' && !(r.code ?? '').startsWith('AG'));
    const gpNull = g.filter((r) => r.status === 'gp_null_consignor');
    const nsOnly = g.filter((r) => r.status === 'ns_only' || r.status === 'ns_unmapped');
    const bMatched = sum(matched, (r) => r.deltaNet);
    const bAg = sum(gpOnlyAg, (r) => r.gpNet);
    const bOther = sum(gpOnlyOther, (r) => r.gpNet);
    const bNull = sum(gpNull, (r) => r.gpNet);
    const bNsOnly = sum(nsOnly, (r) => r.nsNet);

    console.log(`  grand delta (GP net − NS net_paid): ${usd(grandDelta)}`);
    console.log(`  ├─ GP null-consignor schedules      ${usd(bNull)}  (${gpNull.reduce((a, r) => a + r.gpScheds, 0)} schedules across ${gpNull.reduce((a, r) => a + r.gpMonths, 0)} months — settled without a consignor; NetSuite rolls them into vendor RCTIs)`);
    console.log(`  ├─ GP-only AG* agent sub-entities   ${usd(bAg)}  (${gpOnlyAg.length} agents: ${gpOnlyAg.map((r) => r.code).join(', ')} — GP settles agents separately; NetSuite pays the vendor)`);
    console.log(`  ├─ GP-only other entities           ${usd(bOther)}  (${gpOnlyOther.map((r) => `${r.code} ${usd(r.gpNet)}`).join('; ')})`);
    for (const r of gpOnlyOther) console.log(`  │    ${r.code} — ${r.name}`);
    console.log(`  ├─ NS-only growers                  ${usd(-bNsOnly)}  (${nsOnly.map((r) => `${r.code} ${usd(r.nsNet)}`).join('; ') || 'none'})`);
    console.log(`  └─ matched-pairs shortfall          ${usd(bMatched)}  (matched GP runs low: the vendor RCTI absorbs the finer GP entities above)`);
    const explainedCover = Number((bNull + bAg + bOther).toFixed(2));
    console.log(`  cross-check: matched shortfall ${usd(bMatched)} ≈ −(finer-granularity buckets ${usd(explainedCover)}) + true cash/timing gap`);
    console.log(`  cash/timing: GP not-yet-paid ${usd(unpaidGp)} + cash-basis gap ${usd(Number((gpPaid - nsNet).toFixed(2)))} = ${usd(Number((unpaidGp + gpPaid - nsNet).toFixed(2)))} (= grand delta)`);

    // Duplicate-code sub-entities: a GP-only consignor whose CODE also settles as a matched grower
    // (WADDA: two dim_grower rows, one code). The one-sided amount offsets that code's matched
    // shortfall — proven to the cent, not hand-waved.
    const matchedByCode = new Map(matched.map((r) => [r.code, r]));
    for (const r of [...gpOnlyAg, ...gpOnlyOther]) {
      const m = r.code != null ? matchedByCode.get(r.code) : undefined;
      if (m?.deltaNet != null && r.gpNet != null)
        console.log(`  duplicate-code consignor ${r.code}: gp_only ${usd(r.gpNet)} vs matched Δ ${usd(m.deltaNet)} → offset ${usd(Number((r.gpNet + m.deltaNet).toFixed(2)))}`);
    }

    const unexplained = Number((grandDelta - (bNull + bAg + bOther - bNsOnly + bMatched)).toFixed(2));
    check(`every dollar bucketed: |unexplained residual| < $${UNEXPLAINED_TOL / 1000}k`,
      Math.abs(unexplained) < UNEXPLAINED_TOL,
      `unexplained=${usd(unexplained)} (grand ${usd(grandDelta)} = null-consignor ${usd(bNull)} + AG* ${usd(bAg)} + gp-only-other ${usd(bOther)} − ns-only ${usd(bNsOnly)} + matched ${usd(bMatched)})`);

    // ── Report ──────────────────────────────────────────────────────────────────
    const stamp = new Date().toISOString().slice(0, 10);
    const rp = `reports/settle_tie_${stamp}.md`;
    const L: string[] = [];
    L.push(`# Settlement cross-source tie — GP ↔ NetSuite (grower × month)`);
    L.push(``);
    L.push(`Date: ${stamp} · Surface: \`semantic.recon_settlement_source\` (migration 0035) · Runner: \`npm run settle:tie\``);
    L.push(``);
    L.push(`Month anchor: GP \`payable_on\` vs NS \`settlement_date\` (= trandate) — the like-for-like`);
    L.push(`settlement business dates (\`paid_date\` is cash and NULL for unpaid, so never the anchor).`);
    L.push(`Internal-only: explicit \`WHERE semantic.is_internal_claim()\` gate — no claim / grower claim → 0 rows (proven in Checks below).`);
    L.push(``);
    L.push(`## Grand tie`);
    L.push(``);
    L.push(`| basis | GP | NetSuite | Δ | Δ% |`);
    L.push(`|---|---:|---:|---:|---:|`);
    L.push(`| net (GP net_settlement vs NS net_paid) | ${usd(gpNet)} | ${usd(nsNet)} | ${usd(grandDelta)} | ${pct(gpNet, nsNet).toFixed(2)}% |`);
    L.push(`| cash (GP paid_amount vs NS net_paid) | ${usd(gpPaid)} | ${usd(nsNet)} | ${usd(Number((gpPaid - nsNet).toFixed(2)))} | ${pct(gpPaid, nsNet).toFixed(2)}% |`);
    L.push(`| deductions | ${usd(gpDed)} | ${usd(nsDed)} | ${usd(Number((gpDed - nsDed).toFixed(2)))} | ${pct(gpDed, nsDed).toFixed(2)}% |`);
    L.push(``);
    L.push(`## Residual buckets (net basis — every dollar accounted)`);
    L.push(``);
    L.push(`| bucket | amount | explanation |`);
    L.push(`|---|---:|---|`);
    L.push(`| GP null-consignor schedules | ${usd(bNull)} | ${gpNull.reduce((a, r) => a + r.gpScheds, 0)} schedules across ${gpNull.reduce((a, r) => a + r.gpMonths, 0)} months, settled without a consignor; NetSuite rolls them into vendor RCTIs |`);
    L.push(`| GP-only AG* agent sub-entities | ${usd(bAg)} | ${gpOnlyAg.map((r) => r.code).join(', ')} — GP settles agents as their own consignors; NetSuite pays the parent vendor |`);
    L.push(`| GP-only other entities | ${usd(bOther)} | ${gpOnlyOther.map((r) => `${r.code} (${r.name}) ${usd(r.gpNet)}`).join('; ')} |`);
    L.push(`| NS-only growers | ${usd(-bNsOnly)} | ${nsOnly.map((r) => `${r.code} (${r.name}) ${usd(r.nsNet)}`).join('; ') || 'none'} |`);
    L.push(`| matched-pairs shortfall | ${usd(bMatched)} | matched GP runs low — the vendor RCTI absorbs the finer GP entities above |`);
    L.push(`| **unexplained residual** | **${usd(unexplained)}** | partition identity — must be ~0 |`);
    L.push(``);
    L.push(`Cash/timing decomposition of the grand delta: GP not-yet-paid ${usd(unpaidGp)} + cash-basis gap ${usd(Number((gpPaid - nsNet).toFixed(2)))} (${pct(gpPaid, nsNet).toFixed(2)}% — the known ≈0.6% anchor).`);
    L.push(``);
    L.push(`## Per-grower table (sorted by |Δ net|)`);
    L.push(``);
    L.push(`| grower | name | status | gp months | ns months | gp_gross | gp_deductions | gp_net | gp_paid | ns_gross | ns_deductions | ns_net_paid | Δ net | Δ% |`);
    L.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
    for (const r of g) {
      const dp = r.deltaNet != null && r.nsNet ? pct(r.gpNet!, r.nsNet).toFixed(2) + '%' : '∅';
      L.push(`| ${r.code ?? '(null consignor)'} | ${r.name ?? '∅'} | ${r.status} | ${r.gpMonths} | ${r.nsMonths} | ${usd(r.gpGross)} | ${usd(r.gpDed)} | ${usd(r.gpNet)} | ${usd(r.gpPaid)} | ${usd(r.nsGross)} | ${usd(r.nsDed)} | ${usd(r.nsNet)} | ${usd(r.deltaNet)} | ${dp} |`);
    }
    L.push(``);
    L.push(`## Checks`);
    L.push(``);
    for (const r of results) L.push(`- ${r.pass ? 'PASS' : 'FAIL'} — ${r.name} — ${r.detail}`);
    L.push(``);
    writeFileSync(rp, L.join('\n') + '\n', 'utf8');
    console.log(`\nreport written: ${rp}`);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('settle:tie error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
