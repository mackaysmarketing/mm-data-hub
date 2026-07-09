// ─────────────────────────────────────────────────────────────────────────────
// Revenue-class checkpoint artifact (SPRINT chunk 1) — the FULL charge list for Tim to mark.
//   node --experimental-strip-types scripts/revenue_class_checkpoint.ts
//
// Emits reports/revenue_class_checkpoint_<date>.md: every charge seen in SETTLED, DEDUCTIBLE
// applications (name, ct_scope, ct_code, account_code, existing category, applied rows/dollars),
// pre-tagged with a PROPOSED revenue_class per the SPRINT rule — ct_scope 'WH - Ripening' →
// ripening; EVERYTHING ELSE UNPROPOSED (the build must not guess). Also surfaces:
//   • the ~5k settled applied rows with NO charge_id (classifiable by account_code only — they
//     cannot carry a revenue_class, which lives on the charge dim)
//   • the ripening ct_scope raw sum (the proof-6 tie anchor)
// Tim marks the list; only then is revenue_class wired into src/lib/ft_gp_charges.ts + the dim
// build and the refreshes re-run. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { makePool } from '../src/lib/db.ts';
import { isMain, log } from '../src/lib/util.ts';

export async function buildCheckpoint(): Promise<string> {
  const pool = makePool();
  const c = await pool.connect();
  try {
    const charges = (await c.query(
      `select dgc.name, dgc.ct_scope, dgc.ct_code, dgc.account_code, dgc.category,
              dgc.subcategory, dgc.revenue_class,
              count(ca.id) as applied_rows,
              round(sum(ca.total_amount_value), 2) as applied_dollars,
              case when dgc.ct_scope = 'WH - Ripening' then 'ripening' else '' end as proposed
       from core.dim_gp_charge dgc
       join raw.ft_charge_applied ca on ca.charge_id = dgc.charge_id
       where ca.gp_schedule_id is not null and ca.is_deductible
       group by dgc.charge_id, dgc.name, dgc.ct_scope, dgc.ct_code, dgc.account_code,
                dgc.category, dgc.subcategory, dgc.revenue_class
       order by dgc.category, sum(ca.total_amount_value) desc`)).rows;

    const noCharge = (await c.query(
      `select coalesce(nullif(btrim(ca.account_code), ''), '(blank)') as account_code,
              min(ca.text_1) as sample_label,
              count(*) as applied_rows,
              round(sum(ca.total_amount_value), 2) as applied_dollars
       from raw.ft_charge_applied ca
       where ca.gp_schedule_id is not null and ca.is_deductible and ca.charge_id is null
       group by 1 order by sum(ca.total_amount_value) desc`)).rows;

    const anchor = (await c.query(
      `select count(*) as rows, round(sum(ca.total_amount_value), 2) as dollars
       from raw.ft_charge_applied ca
       join core.dim_gp_charge dgc on dgc.charge_id = ca.charge_id
       where ca.gp_schedule_id is not null and ca.is_deductible
         and dgc.ct_scope = 'WH - Ripening'`)).rows[0]!;

    const esc = (v: unknown) => String(v ?? '∅').replace(/\|/g, '\\|');
    const lines: string[] = [];
    lines.push('# Revenue-class checkpoint — full settled charge list (SPRINT chunk 1)');
    lines.push('');
    lines.push(`Generated from the hub (settled = \`gp_schedule_id IS NOT NULL\`, deductible only).`);
    lines.push('');
    lines.push('**Mark each charge** with one of: `commission` / `ripening` / `other_service` /');
    lines.push('`cost_recovery` / `pass_through` / `na`. Only `ct_scope = \'WH - Ripening\'` is');
    lines.push('PRE-PROPOSED (per SPRINT); everything else is deliberately unproposed — nothing was guessed.');
    lines.push('Mackays revenue = classes {commission, ripening, other_service}.');
    lines.push('');
    lines.push(`Ripening tie anchor: ct_scope 'WH - Ripening' settled deductible sum = **$${anchor.dollars}** across ${anchor.rows} applied rows.`);
    lines.push('');
    lines.push('| # | charge name | ct_scope | ct_code | account_code | category | subcategory | applied rows | applied $ | PROPOSED | **TIM: revenue_class** |');
    lines.push('|---|---|---|---|---|---|---|---:|---:|---|---|');
    charges.forEach((r, i) => {
      lines.push(`| ${i + 1} | ${esc(r.name)} | ${esc(r.ct_scope)} | ${esc(r.ct_code)} | ${esc(r.account_code)} | ${esc(r.category)} | ${esc(r.subcategory)} | ${r.applied_rows} | ${r.applied_dollars} | ${r.proposed} | |`);
    });
    lines.push('');
    lines.push('## Settled applied rows with NO charge_id (cannot carry revenue_class — it lives on the charge dim)');
    lines.push('');
    lines.push('These classify by line account_code only. If any must count as Mackays revenue,');
    lines.push('that needs a separate account-code rule — flag it in the marking.');
    lines.push('');
    lines.push('| account_code | sample label | applied rows | applied $ |');
    lines.push('|---|---|---:|---:|');
    for (const r of noCharge) {
      lines.push(`| ${esc(r.account_code)} | ${esc(r.sample_label)} | ${r.applied_rows} | ${r.applied_dollars} |`);
    }
    lines.push('');

    mkdirSync('reports', { recursive: true });
    const path = `reports/revenue_class_checkpoint_${new Date().toISOString().slice(0, 10)}.md`;
    writeFileSync(path, lines.join('\n'), 'utf8');
    log(`checkpoint artifact written: ${path} (${charges.length} charges, ${noCharge.length} account-code-only groups)`);
    return path;
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  await buildCheckpoint();
}
