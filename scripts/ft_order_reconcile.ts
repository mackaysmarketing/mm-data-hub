// ─────────────────────────────────────────────────────────────────────────────
// Order reconciliation (A7) — header ↔ line ↔ source, report committed to reconciliation/.
//   npm run ft:order:reconcile
//
// The replica has NO order-header dollar total, so the header total is DERIVED from the
// current-version lines. This proves the surface reconciles BOTH to itself and to source:
//   1. dim_order.total_price_value == Σ its own current-version fact_order_item.total_price_value
//      (header ↔ line, by construction — verified)
//   2. that line sum == the NATIVE replica current-version line sum for the same order
//      (source ↔ hub — proves version-selection + landing dropped/duplicated nothing)
//   3. total_box_count reconciles the same way
//   4. native total_price_value == derived extended value (BOX→box×price; drift guard)
//
// Reads the hub (DATABASE_URL) and the FreshTrack replica (FRESHTRACK_DATABASE_URL, read-only).
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { makePool } from '../src/lib/db.ts';
import { connectFreshtrackRead } from '../src/lib/freshtrack_db.ts';
import { isMain, log } from '../src/lib/util.ts';

const SAMPLE = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? '500');
const DATE = process.argv.find((a) => a.startsWith('--date='))?.split('=')[1] ?? '2026-07-01';
const TOL = 0.01;

interface HubRow { order_id: string; header_total: number | null; line_total: number | null; derived_total: number | null; header_boxes: number | null; line_boxes: number | null; }
interface RepRow { order_id: string; native_total: number | null; native_boxes: number | null; }

async function main(): Promise<void> {
  const pool = makePool();
  const ft = await connectFreshtrackRead();
  const out: string[] = [];
  const emit = (s = '') => { out.push(s); log(s); };
  try {
    const c = await pool.connect();
    let hub: HubRow[];
    try {
      hub = (await c.query<HubRow>(
        `with samp as (
           select order_id from core.dim_order
            where type='S' and line_count > 0 and total_price_value is not null
            order by order_id limit $1)
         select d.order_id::text order_id,
                d.total_price_value::float8 header_total,
                l.line_total::float8 line_total,
                d.derived_price_value::float8 derived_total,
                d.total_box_count::float8 header_boxes,
                l.line_boxes::float8 line_boxes
           from core.dim_order d
           join samp on samp.order_id = d.order_id
           left join (select order_id, sum(total_price_value) line_total, sum(total_box_count) line_boxes
                        from core.fact_order_item group by order_id) l on l.order_id = d.order_id`,
        [SAMPLE])).rows;
    } finally { c.release(); }

    const ids = hub.map((h) => h.order_id);
    // Native replica: sum the CURRENT-version (max version_no) lines for the same orders.
    const rep = (await ft.query<RepRow>(
      `with latest as (select order_id, max(version_no) mv from public.order_version group by order_id)
       select o.id::text order_id,
              sum(oi.total_price_value)::float8 native_total,
              sum(oi.total_box_count)::float8 native_boxes
         from public."order" o
         join latest l on l.order_id = o.id
         join public.order_version ov on ov.order_id = o.id and ov.version_no = l.mv
         join public.order_item oi on oi.order_version_id = ov.id
        where o.id = ANY($1::uuid[])
        group by o.id`, [ids])).rows;
    const repMap = new Map(rep.map((r) => [r.order_id, r]));

    const near = (a: number | null, b: number | null): boolean => {
      if (a == null && b == null) return true;
      if (a == null || b == null) return false;
      return Math.abs(a - b) < TOL;
    };

    let headerEqLine = 0, lineEqNative = 0, boxEqNative = 0, nativeEqDerived = 0, missing = 0;
    const mismatches: string[] = [];
    for (const h of hub) {
      const r = repMap.get(h.order_id);
      if (!r) { missing++; continue; }
      const c1 = near(h.header_total, h.line_total);
      const c2 = near(h.line_total, r.native_total);
      const c3 = near(h.header_boxes, r.native_boxes) && near(h.line_boxes, r.native_boxes);
      const c4 = near(r.native_total, h.derived_total);
      if (c1) headerEqLine++;
      if (c2) lineEqNative++;
      if (c3) boxEqNative++;
      if (c4) nativeEqDerived++;
      if ((!c1 || !c2 || !c3 || !c4) && mismatches.length < 15) {
        mismatches.push(`  ${h.order_id} header=${h.header_total} line=${h.line_total} native=${r.native_total} derived=${h.derived_total} | hb=${h.header_boxes} lb=${h.line_boxes} nb=${r.native_boxes}`);
      }
    }

    // Null integrity — orders whose current-version lines are all unpriced keep NULL, never 0.
    const cn = await pool.connect();
    let nullOrders = 0, totalOrders = 0;
    try {
      const nr = (await cn.query<{ nulls: string; total: string }>(
        `select count(*) filter (where type='S' and line_count>0 and total_price_value is null) nulls,
                count(*) filter (where type='S') total from core.dim_order`)).rows[0]!;
      nullOrders = Number(nr.nulls); totalOrders = Number(nr.total);
    } finally { cn.release(); }

    const n = hub.length;
    emit(`# Order reconciliation — header ↔ line ↔ source (A7)`);
    emit('');
    emit(`Date: ${DATE} · Project: data_hub (uqzfkhsdyeokwnkpcxui) · Source: FreshTrack read-replica`);
    emit(`Sample: ${n} PRICED sell orders (type=S, non-null header total, ≥1 current-version line). Tolerance: ±${TOL}.`);
    emit('');
    emit(`Null integrity (SPEC §9.3): ${nullOrders} of ${totalOrders} sell orders with lines are entirely`);
    emit(`UNPRICED (quote/pending) and keep a NULL total_price_value — never coalesced to 0 — faithful to`);
    emit(`the source (only ~47% of replica current-version lines carry total_price_value).`);
    emit('');
    emit(`The replica has NO order-header dollar total — the header total is DERIVED from the`);
    emit(`current-version lines. This report reconciles the derived header to its own lines AND to the`);
    emit(`native replica current-version line sum for the same orders.`);
    emit('');
    emit('| Check | Pass / Sample |');
    emit('|---|---|');
    emit(`| 1. dim_order.total_price_value == Σ current-version fact_order_item.total_price_value | ${headerEqLine}/${n} |`);
    emit(`| 2. hub line sum == NATIVE replica current-version line sum | ${lineEqNative}/${n} |`);
    emit(`| 3. total_box_count (header==native AND line==native) | ${boxEqNative}/${n} |`);
    emit(`| 4. native total_price_value == derived extended value (BOX→box×price) | ${nativeEqDerived}/${n} |`);
    emit(`| orders not found on replica (should be 0) | ${missing} |`);
    emit('');
    if (mismatches.length) {
      emit('## First mismatches');
      emit('```');
      for (const m of mismatches) emit(m);
      emit('```');
    } else {
      emit('## Variances');
      emit('None — every sampled order reconciled on all four checks (header↔line↔source, native↔derived).');
    }
    emit('');
    emit(`Derived extended-line-value rule (per price_per): BOX → total_box_count × price_value;`);
    emit(`PALLET → pallet_count × price_value; WEIGHT_UNIT/other → defer to native total_price_value.`);

    const path = `reconciliation/order_reconciliation_${DATE}.md`;
    writeFileSync(path, out.join('\n') + '\n', 'utf8');
    log(`\n=== report written: ${path} ===`);

    const allPass = headerEqLine === n && lineEqNative === n && boxEqNative === n && nativeEqDerived === n && missing === 0;
    if (!allPass) process.exitCode = 1;
  } finally {
    await ft.end();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error('RECONCILE FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
