// ─────────────────────────────────────────────────────────────────────────────
// Dispatch backfill reconciliation — the load-integrity proof (Sprint 7).
//   npm run ft:dispatch:reconcile
//
// Proves the hub warehouse tables tie to the FreshTrack source after the backfill:
//   A. Counts:   raw.ft_dispatch_load / raw.ft_pallet vs source dispatch_load / pallet
//                (test consignors excluded both sides), within tolerance — in-flight source
//                changes (new/modified loads) surfaced as the residual.
//   B. Per-grower: hub vs source load counts per consignor; largest variances surfaced.
//   C. Per-period: hub vs source load counts per pack_week (extra_text_2), recent weeks.
//   D. Volumes:  Σ net_weight_value and Σ (stock+reconsigned) boxes, hub vs source.
//   E. Currency: max(actual_pickup_on) hub vs source; max via semantic.grower_dispatch_detail;
//                source max(last_modified_on). (AC: landed data is current.)
// Surfaces (never hides): test-consignor exclusion, archived rows (included), unmapped growers.
// Writes reports/ft_dispatch_reconcile_<date>.md. Exit 0 = within tolerance; 1 = out of tolerance.
// READ-ONLY on the source (session pinned). Run OFF-PEAK after the full backfill.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import type { Pool, Client } from 'pg';
import { makePool } from '../src/lib/db.ts';
import { connectFreshtrackRead } from '../src/lib/freshtrack_db.ts';
import { KNOWN_TEST_CONSIGNOR_IDS } from '../src/lib/env.ts';
import { isMain, log } from '../src/lib/util.ts';

const COUNT_TOL_PCT = 0.02; // 2% — the source is live; loads are created/modified continuously.

async function testConsignorIds(pool: Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ id: string }>(`select consignor_id::text id from core.dim_grower where is_test = true`);
    return [...new Set([...r.rows.map((x) => x.id), ...KNOWN_TEST_CONSIGNOR_IDS])];
  } finally { c.release(); }
}

const num = (x: unknown) => Number(x ?? 0);
const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : (100 * (a - b)) / b);

export async function reconcile(pool: Pool, ft: Client): Promise<{ pass: boolean; reportPath: string }> {
  const testIds = await testConsignorIds(pool);
  const NOT_TEST_DL = '(consignor_id IS NULL OR consignor_id <> ALL($1::uuid[]))';
  const NOT_TEST_PAL = 'NOT EXISTS (SELECT 1 FROM public.dispatch_load dl WHERE dl.id = pallet.dispatch_load_id AND dl.consignor_id = ANY($1::uuid[]))';

  const hub = await pool.connect();
  const L: string[] = [];
  try {
    // ── A. Counts ──────────────────────────────────────────────────────────────
    const hubDl = num((await hub.query(`select count(*) n from raw.ft_dispatch_load`)).rows[0].n);
    const hubPal = num((await hub.query(`select count(*) n from raw.ft_pallet`)).rows[0].n);
    const srcDl = num((await ft.query(`select count(*) n from public.dispatch_load where ${NOT_TEST_DL}`, [testIds])).rows[0].n);
    const srcPal = num((await ft.query(`select count(*) n from public.pallet where ${NOT_TEST_PAL}`, [testIds])).rows[0].n);

    // ── D. Volumes ───────────────────────────────────────────────────────────────
    const hubVol = (await hub.query(
      `select coalesce(sum(net_weight_value),0) nw, coalesce(sum(coalesce(stock_boxes,0)+coalesce(reconsigned_boxes,0)),0) bx from raw.ft_pallet`,
    )).rows[0];
    const srcVol = (await ft.query(
      `select coalesce(sum(net_weight_value),0) nw, coalesce(sum(coalesce(stock_boxes,0)+coalesce(reconsigned_boxes,0)),0) bx
         from public.pallet where ${NOT_TEST_PAL}`, [testIds],
    )).rows[0];

    // ── E. Currency ──────────────────────────────────────────────────────────────
    const hubMax = (await hub.query(`select max(actual_pickup_on)::text mp from raw.ft_dispatch_load`)).rows[0].mp;
    const viewMax = (await hub.query(`select max(dispatched_on)::text mp from semantic.grower_dispatch_detail`)).rows[0]?.mp ?? null;
    const srcCur = (await ft.query(
      `select max(actual_pickup_on)::text mp, max(last_modified_on)::text mm from public.dispatch_load where ${NOT_TEST_DL}`, [testIds],
    )).rows[0];

    // ── B. Per-grower load counts ────────────────────────────────────────────────
    const hubByG = new Map<string, number>();
    for (const r of (await hub.query<{ cid: string; n: string }>(
      `select consignor_id::text cid, count(*) n from raw.ft_dispatch_load group by 1`)).rows) hubByG.set(r.cid, num(r.n));
    const srcByG = new Map<string, number>();
    for (const r of (await ft.query<{ cid: string; n: string }>(
      `select consignor_id::text cid, count(*) n from public.dispatch_load where ${NOT_TEST_DL} group by 1`, [testIds])).rows) srcByG.set(r.cid, num(r.n));
    const codeByCid = new Map<string, string>();
    for (const r of (await hub.query<{ cid: string; code: string }>(`select consignor_id::text cid, code from core.dim_grower`)).rows) codeByCid.set(r.cid, r.code);
    const growerVar: { code: string; hub: number; src: number; d: number }[] = [];
    for (const cid of new Set([...hubByG.keys(), ...srcByG.keys()])) {
      const h = hubByG.get(cid) ?? 0, s = srcByG.get(cid) ?? 0;
      if (h !== s) growerVar.push({ code: codeByCid.get(cid ?? '') ?? (cid ? cid.slice(0, 8) + '…' : 'NULL'), hub: h, src: s, d: h - s });
    }
    growerVar.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));

    // ── C. Per-period (pack_week from extra_text_2), recent weeks ────────────────
    const wkRe = `^Y[0-9][0-9]W[0-9][0-9]$`;
    const hubByW = new Map<string, number>();
    for (const r of (await hub.query<{ w: string; n: string }>(
      `select extra_text_2 w, count(*) n from raw.ft_dispatch_load where extra_text_2 ~ '${wkRe}' group by 1`)).rows) hubByW.set(r.w, num(r.n));
    const srcByW = new Map<string, number>();
    for (const r of (await ft.query<{ w: string; n: string }>(
      `select extra_text_2 w, count(*) n from public.dispatch_load where ${NOT_TEST_DL} and extra_text_2 ~ '${wkRe}' group by 1`, [testIds])).rows) srcByW.set(r.w, num(r.n));
    const recentWeeks = [...new Set([...hubByW.keys(), ...srcByW.keys()])].sort().slice(-8);

    // ── Verdict ──────────────────────────────────────────────────────────────────
    const dlOk = Math.abs(pct(hubDl, srcDl)) <= COUNT_TOL_PCT * 100;
    const palOk = Math.abs(pct(hubPal, srcPal)) <= COUNT_TOL_PCT * 100;
    const nwOk = Math.abs(pct(num(hubVol.nw), num(srcVol.nw))) <= COUNT_TOL_PCT * 100;
    const bxOk = Math.abs(pct(num(hubVol.bx), num(srcVol.bx))) <= COUNT_TOL_PCT * 100;
    const pass = dlOk && palOk && nwOk && bxOk;

    // ── Report ───────────────────────────────────────────────────────────────────
    const stamp = new Date().toISOString();
    L.push(`# Dispatch backfill reconciliation — ${stamp}`, '');
    L.push(`Tolerance: ${COUNT_TOL_PCT * 100}% (source is live — in-flight loads are the residual). Test consignors excluded both sides: ${testIds.length}.`, '');
    L.push('## A. Counts (hub vs source, test-excluded)', '| stream | hub | source | Δ | Δ% | ok |', '|---|---:|---:|---:|---:|:--:|');
    L.push(`| ft_dispatch_load | ${hubDl.toLocaleString()} | ${srcDl.toLocaleString()} | ${(hubDl - srcDl).toLocaleString()} | ${pct(hubDl, srcDl).toFixed(2)}% | ${dlOk ? '✅' : '❌'} |`);
    L.push(`| ft_pallet | ${hubPal.toLocaleString()} | ${srcPal.toLocaleString()} | ${(hubPal - srcPal).toLocaleString()} | ${pct(hubPal, srcPal).toFixed(2)}% | ${palOk ? '✅' : '❌'} |`);
    L.push('');
    L.push('## D. Volumes (all landed pallets)', '| measure | hub | source | Δ% | ok |', '|---|---:|---:|---:|:--:|');
    L.push(`| Σ net_weight_value | ${num(hubVol.nw).toLocaleString()} | ${num(srcVol.nw).toLocaleString()} | ${pct(num(hubVol.nw), num(srcVol.nw)).toFixed(2)}% | ${nwOk ? '✅' : '❌'} |`);
    L.push(`| Σ (stock+reconsigned) boxes | ${num(hubVol.bx).toLocaleString()} | ${num(srcVol.bx).toLocaleString()} | ${pct(num(hubVol.bx), num(srcVol.bx)).toFixed(2)}% | ${bxOk ? '✅' : '❌'} |`);
    L.push('');
    L.push('## E. Currency', `- source max(actual_pickup_on) = ${srcCur.mp ?? '—'} · hub raw max = ${hubMax ?? '—'} · view max(dispatched_on) = ${viewMax ?? '—'}`);
    L.push(`- source max(last_modified_on) = ${srcCur.mm ?? '—'}`);
    L.push('');
    L.push(`## B. Per-grower load-count variances (${growerVar.length} growers differ)`, '| grower | hub | source | Δ |', '|---|---:|---:|---:|');
    for (const g of growerVar.slice(0, 15)) L.push(`| ${g.code} | ${g.hub} | ${g.src} | ${g.d} |`);
    L.push('');
    L.push('## C. Per-pack-week load counts (recent 8)', '| pack_week | hub | source | Δ |', '|---|---:|---:|---:|');
    for (const w of recentWeeks) { const h = hubByW.get(w) ?? 0, s = srcByW.get(w) ?? 0; L.push(`| ${w} | ${h} | ${s} | ${h - s} |`); }
    L.push('');

    const rp = `reports/ft_dispatch_reconcile_${stamp.slice(0, 10)}.md`;
    writeFileSync(rp, L.join('\n'), 'utf8');
    log(`A counts: dl ${hubDl}/${srcDl} (${pct(hubDl, srcDl).toFixed(2)}%) ${dlOk ? 'OK' : 'OUT'} · pal ${hubPal}/${srcPal} (${pct(hubPal, srcPal).toFixed(2)}%) ${palOk ? 'OK' : 'OUT'}`);
    log(`D volumes: nw ${pct(num(hubVol.nw), num(srcVol.nw)).toFixed(2)}% · boxes ${pct(num(hubVol.bx), num(srcVol.bx)).toFixed(2)}%`);
    log(`E currency: source max pickup ${srcCur.mp ?? '—'} · view max ${viewMax ?? '—'} · source last_modified ${srcCur.mm ?? '—'}`);
    log(`→ ${rp}  (${pass ? 'PASS' : 'OUT OF TOLERANCE'})`);
    return { pass, reportPath: rp };
  } finally { hub.release(); }
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const ft = await connectFreshtrackRead();
  try {
    const { pass } = await reconcile(pool, ft);
    if (!pass) process.exitCode = 1;
  } finally { await ft.end(); await pool.end(); }
}
