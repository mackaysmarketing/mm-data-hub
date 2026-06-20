// Reconciliation report: per-load pallet box_count vs load stock_boxes (SPEC / SPRINT).
// Reads core.load_box_reconciliation, summarises, flags |delta| > tolerance, and writes a
// markdown report to reports/. box_count is frequently null upstream, so the null rate is
// reported alongside the delta (a null-heavy load is a data quality signal, not a load bug).
import { writeFileSync } from 'node:fs';
import { makePool } from './lib/db.ts';
import { isMain, log } from './lib/util.ts';

const TOLERANCE = Number(process.env.RECONCILE_TOLERANCE ?? '0');

interface Summary {
  loads: number;
  loads_with_pallets: number;
  loads_reconciled: number; // delta within tolerance
  loads_out_of_tolerance: number;
  loads_no_pallets: number;
  total_pallets: number;
  pallets_null_box_count: number;
  load_stock_boxes_sum: number;
  pallet_box_count_sum: number;
}

export async function reconcile(): Promise<{ summary: Summary; reportPath: string }> {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const s = (
      await client.query<Summary>(`
      select
        count(*)::int                                                              as loads,
        count(*) filter (where pallet_count > 0)::int                              as loads_with_pallets,
        count(*) filter (where abs(box_count_delta) <= $1)::int                    as loads_reconciled,
        count(*) filter (where abs(box_count_delta) >  $1)::int                    as loads_out_of_tolerance,
        count(*) filter (where pallet_count = 0)::int                              as loads_no_pallets,
        coalesce(sum(pallet_count),0)::int                                         as total_pallets,
        coalesce(sum(pallets_null_box_count),0)::int                               as pallets_null_box_count,
        coalesce(sum(load_stock_boxes),0)::int                                     as load_stock_boxes_sum,
        coalesce(sum(pallet_box_count_sum),0)::int                                 as pallet_box_count_sum
      from core.load_box_reconciliation`,
        [TOLERANCE],
      )
    ).rows[0] as Summary;

    const worst = (
      await client.query(`
      select load_no, consignor_id, actual_pickup_on, order_type, load_stock_boxes,
             pallet_count, pallets_null_box_count, pallet_box_count_sum, box_count_delta
      from core.load_box_reconciliation
      where abs(box_count_delta) > $1 and pallet_count > 0
      order by abs(box_count_delta) desc
      limit 25`,
        [TOLERANCE],
      )
    ).rows;

    const stamp = new Date().toISOString();
    const date = stamp.slice(0, 10);
    const reportPath = `reports/reconciliation_${date}.md`;
    const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);

    const lines: string[] = [];
    lines.push(`# Reconciliation report — ${stamp}`);
    lines.push('');
    lines.push(`Tolerance: |stock_boxes − Σ box_count| ≤ ${TOLERANCE}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| Loads | ${s.loads} |`);
    lines.push(`| Loads with pallets | ${s.loads_with_pallets} |`);
    lines.push(`| Loads with no pallets | ${s.loads_no_pallets} |`);
    lines.push(`| Loads reconciled (within tolerance) | ${s.loads_reconciled} (${pct(s.loads_reconciled, s.loads)}) |`);
    lines.push(`| Loads out of tolerance | ${s.loads_out_of_tolerance} (${pct(s.loads_out_of_tolerance, s.loads)}) |`);
    lines.push(`| Total pallets | ${s.total_pallets} |`);
    lines.push(`| Pallets with null box_count | ${s.pallets_null_box_count} (${pct(s.pallets_null_box_count, s.total_pallets)}) |`);
    lines.push(`| Σ load stock_boxes | ${s.load_stock_boxes_sum} |`);
    lines.push(`| Σ pallet box_count | ${s.pallet_box_count_sum} |`);
    lines.push('');
    lines.push('> Note: `box_count` is null on many pallets (reconsigned / in-place). A non-zero');
    lines.push('> delta on a null-heavy load reflects upstream nulls, not a load error — see the');
    lines.push('> null column below. `net_weight_value` is never used to reconcile box counts.');
    lines.push('');
    lines.push(`## Top ${worst.length} out-of-tolerance loads`);
    lines.push('');
    lines.push('| Load | Pickup | Type | stock_boxes | pallets | null box | Σ box_count | delta |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|');
    for (const r of worst as Record<string, unknown>[]) {
      const pickup = r.actual_pickup_on ? String(r.actual_pickup_on).slice(0, 10) : '—';
      lines.push(
        `| ${r.load_no} | ${pickup} | ${r.order_type} | ${r.load_stock_boxes} | ${r.pallet_count} | ${r.pallets_null_box_count} | ${r.pallet_box_count_sum} | ${r.box_count_delta} |`,
      );
    }
    lines.push('');

    writeFileSync(reportPath, lines.join('\n'), 'utf8');
    return { summary: s, reportPath };
  } finally {
    client.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  const { summary, reportPath } = await reconcile();
  log(`reconciled=${summary.loads_reconciled}/${summary.loads} out_of_tol=${summary.loads_out_of_tolerance} → ${reportPath}`);
}
