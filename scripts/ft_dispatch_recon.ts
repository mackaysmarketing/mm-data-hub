// ─────────────────────────────────────────────────────────────────────────────
// Sprint 7 · Step-0 discovery — LOAD-SAFE recon of the FreshTrack production
// dispatch source vs the hub target tables the dashboard view reads.
//
// Compares the FreshTrack prod columns (public.dispatch_load, public.pallet) against
// the hub target columns (raw.ft_dispatch_load, raw.ft_pallet) that
// semantic.grower_dispatch_detail consumes, and confirms LMB's dispatch in the source
// is keyed to the LMB consignor_ids (LMBFA/LMBBF/LMBCO/LMBEP).
//
//   npm run ft:dispatch:recon
//
// STRICTLY READ-ONLY on BOTH ends (sessions pinned default_transaction_read_only=on).
// Metadata + row ESTIMATES only (pg_class.reltuples — no full table scan) + ONE tiny
// LMB-scoped aggregate. No sample-row hauling. Writes a markdown report to reports/ and
// prints the same to stdout.  Mirrors the read posture of scripts/ft_db_explore.ts.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const { Client } = pg;
const HUB_REF = 'uqzfkhsdyeokwnkpcxui';
const LMB_CODES = ['LMBFA', 'LMBBF', 'LMBCO', 'LMBEP'];

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

async function connectReadOnly(url: string, app: string): Promise<pg.Client> {
  const client = new Client({
    connectionString: noVerifySsl(url),
    ssl: { rejectUnauthorized: false },
    application_name: app,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
  });
  await client.connect();
  await client.query('SET default_transaction_read_only = on'); // belt-and-braces; never write
  return client;
}

function maskHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host} (user=${u.username.replace(/(.{6}).*/, '$1…')})`;
  } catch {
    return '(unparseable)';
  }
}

interface Col {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  ordinal_position: number;
}

async function columns(c: pg.Client, schema: string, table: string): Promise<Col[]> {
  return (
    await c.query<Col>(
      `SELECT column_name, data_type, udt_name, is_nullable, ordinal_position
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2
        ORDER BY ordinal_position`,
      [schema, table],
    )
  ).rows;
}

function typeOf(c: Col): string {
  return c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
}

async function reltuplesEstimate(c: pg.Client, qualified: string): Promise<string> {
  try {
    const r = await c.query<{ est: string }>(
      `SELECT reltuples::bigint::text AS est FROM pg_class WHERE oid = $1::regclass`,
      [qualified],
    );
    return r.rows[0]?.est ?? '?';
  } catch (e) {
    return `(err: ${e instanceof Error ? e.message : String(e)})`;
  }
}

async function primaryKey(c: pg.Client, qualified: string): Promise<string[]> {
  try {
    const r = await c.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [qualified],
    );
    return r.rows.map((x) => x.attname);
  } catch {
    return [];
  }
}

const out: string[] = [];
function emit(line = ''): void {
  out.push(line);
}

async function main(): Promise<void> {
  const hubUrl = process.env.DATABASE_URL;
  const ftUrl = process.env.FRESHTRACK_DATABASE_URL;
  if (!hubUrl) throw new Error('Missing DATABASE_URL');
  if (!ftUrl) throw new Error('Missing FRESHTRACK_DATABASE_URL');

  const today = new Date().toISOString().slice(0, 10);
  emit(`# Sprint 7 · FreshTrack dispatch recon (Step 0)`);
  emit(`Generated: ${today} · LOAD-SAFE (read-only, metadata + reltuples estimates + 1 LMB aggregate)`);
  emit('');
  emit(`- Hub (target)    : ${maskHost(hubUrl)} — ref-in-conn-string: ${hubUrl.includes(HUB_REF)}`);
  emit(`- FreshTrack (src): ${maskHost(ftUrl)}`);
  emit('');
  if (!hubUrl.includes(HUB_REF)) {
    emit(`> ⚠ DATABASE_URL does not carry the hub ref ${HUB_REF}. Recon only reads, but the loader MUST abort on this.`);
    emit('');
  }

  const ft = await connectReadOnly(ftUrl, 'mm-data-hub ft:dispatch:recon (readonly src)');
  const hub = await connectReadOnly(hubUrl, 'mm-data-hub ft:dispatch:recon (readonly hub)');
  try {
    // ── Source table metadata (estimates only) ──────────────────────────────
    const srcCols: Record<string, Col[]> = {};
    for (const [src, qualified] of [
      ['dispatch_load', 'public.dispatch_load'],
      ['pallet', 'public.pallet'],
    ] as const) {
      const cols = await columns(ft, 'public', src);
      srcCols[src] = cols;
      const est = await reltuplesEstimate(ft, qualified);
      const pk = await primaryKey(ft, qualified);
      emit(`## SOURCE public.${src}`);
      emit(`- row estimate (reltuples): ~${est}`);
      emit(`- primary key: ${pk.join(', ') || '(none found)'}`);
      emit(`- columns (${cols.length}):`);
      for (const col of cols) {
        emit(`    ${col.column_name.padEnd(34)} ${typeOf(col)}${col.is_nullable === 'NO' ? '  NOT NULL' : ''}`);
      }
      emit('');
    }

    // ── Hub target columns (what the loader writes / the view reads) ─────────
    const hubCols: Record<string, Col[]> = {};
    for (const tbl of ['ft_dispatch_load', 'ft_pallet']) {
      hubCols[tbl] = await columns(hub, 'raw', tbl);
    }

    // ── Source→target column map (auto-diff; GP showed snake_case 1:1) ───────
    // For each hub column, does an identically-named source column exist?
    const pairs: Array<[string, string, string]> = [
      ['ft_dispatch_load', 'dispatch_load', 'd'],
      ['ft_pallet', 'pallet', 'p'],
    ];
    const META_COLS = new Set(['_raw', '_synced_at']); // hub-only bookkeeping, not from source
    for (const [hubTbl, src] of pairs) {
      const srcNames = new Set(srcCols[src]!.map((c) => c.column_name));
      emit(`## MAP  raw.${hubTbl}  ←  public.${src}`);
      const missing: string[] = [];
      for (const hc of hubCols[hubTbl]!) {
        if (META_COLS.has(hc.column_name)) {
          emit(`    ${hc.column_name.padEnd(28)} ←  (hub bookkeeping — not from source)`);
          continue;
        }
        const hit = srcNames.has(hc.column_name);
        emit(`    ${hc.column_name.padEnd(28)} ←  ${hit ? `public.${src}.${hc.column_name}` : '‼ NO SAME-NAME SOURCE COLUMN'}`);
        if (!hit) missing.push(hc.column_name);
      }
      if (missing.length) {
        emit('');
        emit(`> ‼ ${hubTbl}: ${missing.length} hub column(s) without a same-name source column → STOP/flag per Step 0: ${missing.join(', ')}`);
      }
      emit('');
    }

    // ── Incremental key + pickup-date detection on the source ───────────────
    for (const src of ['dispatch_load', 'pallet']) {
      const names = srcCols[src]!.map((c) => c.column_name);
      const mod = names.filter((n) => /modified|updated|changed/i.test(n));
      const pick = names.filter((n) => /pickup|dispatch|packed|delivery/i.test(n) && /_on$|_at$|_date$/i.test(n));
      emit(`## KEYS public.${src}`);
      emit(`- incremental-key candidates (modified/updated): ${mod.join(', ') || '(none)'}`);
      emit(`- pickup/date candidates: ${pick.join(', ') || '(none)'}`);
      emit('');
    }

    // ── LMB keying confirmation (the mandatory Step-0 gate) ─────────────────
    emit(`## LMB keying — dispatch source keyed to LMB consignor_ids?`);
    const lmb = await hub.query<{ code: string; consignor_id: string }>(
      `SELECT code, consignor_id::text AS consignor_id
         FROM core.dim_grower WHERE code = ANY($1) ORDER BY code`,
      [LMB_CODES],
    );
    emit(`- hub core.dim_grower LMB rows (${lmb.rows.length}):`);
    for (const r of lmb.rows) emit(`    ${r.code.padEnd(8)} consignor_id=${r.consignor_id}`);
    const lmbIds = lmb.rows.map((r) => r.consignor_id);
    if (lmbIds.length === 0) {
      emit(`> ‼ No LMB rows in core.dim_grower — cannot confirm keying.`);
    } else {
      // ONE scoped aggregate over the source (single scan, 4 ids) — load-safe.
      const agg = await ft.query<{ cid: string; n: string; min_pickup: string; max_pickup: string; non_null_boxes: string }>(
        `SELECT dl.consignor_id::text AS cid,
                count(*)::text AS n,
                min(dl.actual_pickup_on)::text AS min_pickup,
                max(dl.actual_pickup_on)::text AS max_pickup,
                count(*) FILTER (WHERE dl.actual_pickup_on IS NOT NULL)::text AS non_null_boxes
           FROM public.dispatch_load dl
          WHERE dl.consignor_id = ANY($1::uuid[])
          GROUP BY dl.consignor_id`,
        [lmbIds],
      );
      const byId = new Map(agg.rows.map((r) => [r.cid, r]));
      emit(`- source public.dispatch_load rows per LMB consignor_id:`);
      for (const r of lmb.rows) {
        const a = byId.get(r.consignor_id);
        emit(
          a
            ? `    ${r.code.padEnd(8)} loads=${a.n.padStart(6)}  pickup ${a.min_pickup ?? '—'} … ${a.max_pickup ?? '—'}`
            : `    ${r.code.padEnd(8)} loads=     0  (no dispatch_load rows keyed to this consignor_id)`,
        );
      }
      const total = agg.rows.reduce((s, r) => s + Number(r.n), 0);
      const maxPickup = agg.rows.map((r) => r.max_pickup).filter(Boolean).sort().at(-1) ?? '—';
      emit('');
      emit(`- LMB total source loads: ${total} · LMB source max(actual_pickup_on): ${maxPickup}`);
      emit(`- VERDICT: ${total > 0 ? '✅ LMB dispatch IS keyed to LMB consignor_ids in the source' : '❌ LMB NOT keyed — investigate before loader'}`);
    }
    emit('');

    // ── Source overall recency (context for "lands current data") ───────────
    try {
      const r = await ft.query<{ max_pickup: string; max_mod: string }>(
        `SELECT max(actual_pickup_on)::text AS max_pickup,
                max(last_modified_on)::text  AS max_mod
           FROM public.dispatch_load`,
      );
      emit(`## SOURCE recency (public.dispatch_load)`);
      emit(`- max(actual_pickup_on): ${r.rows[0]?.max_pickup ?? '—'}`);
      emit(`- max(last_modified_on): ${r.rows[0]?.max_mod ?? '—'}`);
      emit('');
    } catch (e) {
      emit(`## SOURCE recency — skipped: ${e instanceof Error ? e.message : String(e)}`);
      emit('');
    }

    emit('=== recon done (read-only). ===');
  } finally {
    await ft.end().catch(() => {});
    await hub.end().catch(() => {});
  }

  const report = out.join('\n');
  process.stdout.write(report + '\n');
  const path = `reports/ft_dispatch_recon_${new Date().toISOString().slice(0, 10)}.md`;
  writeFileSync(path, report + '\n');
  process.stdout.write(`\n[written] ${path}\n`);
}

main().catch((e) => {
  console.error('\nRECON FAIL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
