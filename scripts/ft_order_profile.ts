// ─────────────────────────────────────────────────────────────────────────────
// FreshTrack read-replica ORDER-domain PROFILE + A0 schema snapshot (build gate).
//   npm run ft:order:profile
//
// STRICTLY READ-ONLY against the replica. Writes the committed A0 schema snapshot to
// reconciliation/replica_order_schema_<date>.md and prints the profiling that the order
// core model / reconciliation rests on:
//   • full column lists (name / type / nullable) for order, order_version, order_item
//   • row counts
//   • order.type distribution (B/S) and order_item.price_currency / price_per distribution
//   • versioning integrity (max version_no per order; do all order_item rows resolve a version?)
//   • the header↔line reconciliation identity (there is NO order.total_price_value on the replica —
//     the header dollar total is DERIVED from the current-version line total_price_value)
//   • test-entity presence (entities whose code ends in TEST)
// The snapshot date is passed in (Date.now is avoided in some harnesses); default 2026-07-01.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;
const TABLES = ['order', 'order_version', 'order_item'] as const;
const SNAP_DATE = process.argv.find((a) => a.startsWith('--date='))?.split('=')[1] ?? '2026-07-01';

function noVerifySsl(connStr: string): string {
  return /[?&]sslmode=/i.test(connStr)
    ? connStr.replace(/sslmode=[^&]*/i, 'sslmode=no-verify')
    : connStr + (connStr.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}

interface Col { column_name: string; data_type: string; udt_name: string; is_nullable: string }

async function main(): Promise<void> {
  const url = process.env.FRESHTRACK_DATABASE_URL;
  if (!url || url.trim() === '') throw new Error('Missing FRESHTRACK_DATABASE_URL in .env');
  const client = new Client({
    connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false },
    application_name: 'mm-data-hub ft:order:profile (readonly)', connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
  });
  await client.connect();
  const out: string[] = [];
  const emit = (s = '') => { out.push(s); console.log(s); };
  try {
    await client.query('SET default_transaction_read_only = on');
    emit(`# Replica ORDER-domain schema snapshot (A0) — ${SNAP_DATE}`);
    emit(`Source: FreshTrack read-replica (public.order / order_version / order_item). READ-ONLY.`);
    emit('');

    for (const t of TABLES) {
      const cnt = (await client.query<{ n: string }>(`SELECT count(*)::text n FROM public."${t}"`)).rows[0]?.n;
      const cols = (await client.query<Col>(
        `SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows;
      emit(`## public.${t} — ${cnt} rows, ${cols.length} columns`);
      emit('```');
      for (const c of cols) {
        const ty = c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
        emit(`  ${c.column_name.padEnd(30)} ${ty}${c.is_nullable === 'NO' ? '  NOT NULL' : ''}`);
      }
      emit('```');
      emit('');
    }

    // A0 depended-on columns present?
    emit('## A0 depended-on columns');
    const present = async (t: string, c: string): Promise<boolean> => (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [t, c])).rowCount === 1;
    for (const [t, c] of [['order_item', 'total_box_count'], ['order_item', 'price_value'], ['order_item', 'price_currency'],
      ['order_item', 'price_per'], ['order_item', 'total_price_value'], ['order', 'total_price_value'],
      ['order', 'latest_version_no'], ['order', 'total_ordered'], ['order', 'last_modified_on'],
      ['order_version', 'last_modified_on'], ['order_item', 'last_modified_on'], ['order_item', 'dispatch_load_id'],
      ['order_version', 'version_no'], ['order_version', 'order_id']] as const) {
      emit(`  ${(t + '.' + c).padEnd(34)} ${(await present(t, c)) ? 'PRESENT' : '**ABSENT**'}`);
    }
    emit('');

    // Distributions
    emit('## order.type distribution');
    for (const r of (await client.query<{ type: string; n: string }>(
      `SELECT type, count(*)::text n FROM public."order" GROUP BY type ORDER BY n DESC`)).rows) emit(`  ${r.type}: ${r.n}`);
    emit('');
    emit('## order_item.price_currency distribution');
    for (const r of (await client.query<{ price_currency: string; n: string }>(
      `SELECT price_currency, count(*)::text n FROM public.order_item GROUP BY price_currency ORDER BY n DESC`)).rows)
      emit(`  ${r.price_currency}: ${r.n}`);
    emit('');
    emit('## order_item.price_per distribution');
    for (const r of (await client.query<{ price_per: string; n: string }>(
      `SELECT price_per, count(*)::text n FROM public.order_item GROUP BY price_per ORDER BY n DESC`)).rows)
      emit(`  ${r.price_per}: ${r.n}`);
    emit('');

    // Versioning integrity
    emit('## versioning');
    const vmax = (await client.query<{ orders: string; multi: string; maxv: string }>(
      `SELECT count(*)::text orders, count(*) filter (where nv>1)::text multi, max(nv)::text maxv
         FROM (SELECT order_id, count(*) nv FROM public.order_version GROUP BY order_id) q`)).rows[0];
    emit(`  orders with versions: ${vmax?.orders}; with >1 version: ${vmax?.multi}; max versions on one order: ${vmax?.maxv}`);
    const orphan = (await client.query<{ n: string }>(
      `SELECT count(*)::text n FROM public.order_item oi
        LEFT JOIN public.order_version ov ON ov.id = oi.order_version_id WHERE ov.id IS NULL`)).rows[0]?.n;
    emit(`  order_item rows with no resolvable order_version: ${orphan}`);
    const superseded = (await client.query<{ total: string; latest: string }>(
      `WITH latest AS (SELECT order_id, max(version_no) mv FROM public.order_version GROUP BY order_id)
       SELECT count(*)::text total,
              count(*) filter (where ov.version_no = l.mv)::text latest
         FROM public.order_item oi
         JOIN public.order_version ov ON ov.id = oi.order_version_id
         JOIN latest l ON l.order_id = ov.order_id`)).rows[0];
    emit(`  order_item lines: ${superseded?.total} total; ${superseded?.latest} on the latest version (rest superseded)`);
    emit('');

    // Reconciliation identity — header total is DERIVED from current-version lines (no order.total_price_value).
    emit('## reconciliation identity (current-version line rollup; N=200 sample sell orders)');
    const recon = (await client.query<{
      orders: string; boxes: string; native: string; derived: string; box_match: string; native_match: string;
    }>(
      `WITH latest AS (SELECT order_id, max(version_no) mv FROM public.order_version GROUP BY order_id),
       cur AS (
         SELECT o.id order_id, oi.total_box_count, oi.total_price_value, oi.price_value, oi.price_per,
                oi.pallet_count, oi.boxes_per_pallet
           FROM public."order" o
           JOIN latest l ON l.order_id = o.id
           JOIN public.order_version ov ON ov.order_id = o.id AND ov.version_no = l.mv
           JOIN public.order_item oi ON oi.order_version_id = ov.id
          WHERE o.type='S'
       ),
       per_order AS (
         SELECT order_id,
                sum(total_box_count) boxes,
                sum(total_price_value) native_total,
                sum(case when price_per='BOX' then total_box_count*price_value
                         when price_per='PALLET' then pallet_count*price_value
                         else total_price_value end) derived_total
           FROM cur GROUP BY order_id
       ),
       samp AS (SELECT * FROM per_order ORDER BY order_id LIMIT 200)
       SELECT count(*)::text orders,
              coalesce(sum(boxes),0)::text boxes,
              round(coalesce(sum(native_total),0),2)::text native,
              round(coalesce(sum(derived_total),0),2)::text derived,
              count(*) filter (where boxes is not null)::text box_match,
              count(*) filter (where abs(coalesce(native_total,0)-coalesce(derived_total,0))<0.01)::text native_match
         FROM samp`)).rows[0];
    emit(`  sample orders: ${recon?.orders}`);
    emit(`  Σ total_box_count: ${recon?.boxes}`);
    emit(`  Σ native line total_price_value: ${recon?.native}`);
    emit(`  Σ derived (BOX→boxes×price, PALLET→pallets×price, else native): ${recon?.derived}`);
    emit(`  orders where derived == native (±0.01): ${recon?.native_match}/${recon?.orders}`);
    emit('');

    // Non-AUD flag
    const nonAud = (await client.query<{ n: string }>(
      `SELECT count(*)::text n FROM public.order_item WHERE price_currency IS NOT NULL AND price_currency <> 'AUD'`)).rows[0]?.n;
    emit(`## non-AUD order_item price rows: ${nonAud}`);
    emit('');

    // Test entities on the replica
    emit('## test entities on replica (code ILIKE %TEST)');
    for (const r of (await client.query<{ code: string; is_active: boolean; consignor_id: string | null; consignee_id: string | null; marketer_id: string | null }>(
      `SELECT code, is_active, consignor_id, consignee_id, marketer_id FROM public.entity WHERE code ILIKE '%TEST' ORDER BY code`)).rows)
      emit(`  ${r.code} active=${r.is_active} consignor=${r.consignor_id ?? '∅'} consignee=${r.consignee_id ?? '∅'} marketer=${r.marketer_id ?? '∅'}`);
    emit('');

    const path = `reconciliation/replica_order_schema_${SNAP_DATE}.md`;
    writeFileSync(path, out.join('\n') + '\n', 'utf8');
    console.log(`\n=== snapshot written: ${path} ===`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('\nPROFILE FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
