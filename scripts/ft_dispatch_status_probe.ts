// Sprint 7 · dispatch-status probe (LOAD-SAFE, read-only). The portal shows a "Status"
// (e.g. "Ready for Payment") on a load whose actual_pickup_on is null. Find the state
// table behind dispatch_load.state_id, enumerate the lifecycle, and see how each state
// correlates with actual_pickup_on / is_complete — to ground a defensible "dispatched"
// definition (vs the current actual_pickup_on IS NOT NULL).
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const LMB_CODES = ['LMBFA', 'LMBBF', 'LMBCO', 'LMBEP'];

function noVerifySsl(c: string): string {
  return /[?&]sslmode=/i.test(c) ? c.replace(/sslmode=[^&]*/i, 'sslmode=no-verify') : c + (c.includes('?') ? '&' : '?') + 'sslmode=no-verify';
}
async function ro(url: string, app: string): Promise<pg.Client> {
  const c = new Client({ connectionString: noVerifySsl(url), ssl: { rejectUnauthorized: false }, application_name: app, connectionTimeoutMillis: 15_000, statement_timeout: 90_000 });
  await c.connect(); await c.query('SET default_transaction_read_only = on'); return c;
}

async function main(): Promise<void> {
  const ft = await ro(process.env.FRESHTRACK_DATABASE_URL!, 'mm ft:dispatch status-probe (ro src)');
  const hub = await ro(process.env.DATABASE_URL!, 'mm ft:dispatch status-probe (ro hub)');
  try {
    // 0) What does dispatch_load.state_id reference?
    const fk = await ft.query<{ referenced: string }>(
      `SELECT confrelid::regclass::text AS referenced
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'public.dispatch_load'::regclass AND c.contype='f' AND a.attname='state_id'`);
    const stateTable = fk.rows[0]?.referenced ?? null;
    console.log(`0) dispatch_load.state_id → ${stateTable ?? '(no FK found)'}`);

    // discover a name column on the state table
    let nameCol = 'name';
    if (stateTable) {
      const cols = await ft.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE (table_schema||'.'||table_name) = $1 ORDER BY ordinal_position`, [stateTable.replace(/^public\./, 'public.')]);
      console.log(`   ${stateTable} columns: ${cols.rows.map((r) => r.column_name).join(', ')}`);
      if (!cols.rows.some((c) => c.column_name === 'name')) {
        nameCol = cols.rows.find((c) => /name|code|label|description/i.test(c.column_name))?.column_name ?? 'id';
      }
    }

    const stExpr = stateTable ? `s.${nameCol}` : `dl.state_id::text`;
    const stJoin = stateTable ? `LEFT JOIN ${stateTable} s ON s.id = dl.state_id` : '';

    // 1) GLOBAL 2026 loads by state — count, % with actual_pickup_on, % complete.
    console.log('\n1) GLOBAL 2026 loads by state (name / loads / %actual_pickup / %complete / max sched):');
    const g = await ft.query(
      `SELECT ${stExpr} AS state, count(*)::int AS loads,
              round(100.0*count(dl.actual_pickup_on)/nullif(count(*),0),1)::text AS pct_actual_pickup,
              round(100.0*count(*) FILTER (WHERE dl.is_complete)/nullif(count(*),0),1)::text AS pct_complete,
              max(dl.scheduled_pickup_on)::text AS max_sched_pickup
         FROM public.dispatch_load dl ${stJoin}
        WHERE dl.created_on >= '2026-01-01'
        GROUP BY ${stExpr} ORDER BY loads DESC`);
    for (const r of g.rows as any[]) console.log(`   ${String(r.state ?? 'NULL').padEnd(22)} loads=${String(r.loads).padStart(5)}  actual_pickup=${String(r.pct_actual_pickup).padStart(5)}%  complete=${String(r.pct_complete).padStart(5)}%  max_sched=${r.max_sched_pickup ?? '—'}`);

    // 2) LMB 2026 loads by state.
    const lmb = await hub.query<{ consignor_id: string }>(`SELECT consignor_id::text AS consignor_id FROM core.dim_grower WHERE code = ANY($1)`, [LMB_CODES]);
    const ids = lmb.rows.map((r) => r.consignor_id);
    console.log('\n2) LMB 2026 loads by state:');
    const l = await ft.query(
      `SELECT ${stExpr} AS state, count(*)::int AS loads,
              count(dl.actual_pickup_on)::int AS with_actual_pickup,
              max(dl.scheduled_pickup_on)::text AS max_sched_pickup
         FROM public.dispatch_load dl ${stJoin}
        WHERE dl.consignor_id = ANY($1::uuid[]) AND dl.created_on >= '2026-01-01'
        GROUP BY ${stExpr} ORDER BY loads DESC`, [ids]);
    for (const r of l.rows as any[]) console.log(`   ${String(r.state ?? 'NULL').padEnd(22)} loads=${String(r.loads).padStart(4)}  with_actual_pickup=${r.with_actual_pickup}  max_sched=${r.max_sched_pickup ?? '—'}`);

    // 3) G5021160's state.
    const one = await ft.query(
      `SELECT ${stExpr} AS state, dl.is_complete, dl.is_locked, dl.scheduled_pickup_on::text AS sched_pickup
         FROM public.dispatch_load dl ${stJoin} WHERE dl.load_no = 'G5021160 - 126'`);
    console.log('\n3) G5021160 state:', JSON.stringify(one.rows[0]));

    // 4) Full state list (id → name) for reference.
    if (stateTable) {
      const all = await ft.query(`SELECT id::text, ${nameCol} AS name FROM ${stateTable} ORDER BY ${nameCol}`);
      console.log(`\n4) ${stateTable} values:`);
      for (const r of all.rows as any[]) console.log(`   ${r.name}`);
    }
  } finally {
    await ft.end().catch(() => {}); await hub.end().catch(() => {});
  }
}
main().catch((e) => { console.error('STATUS-PROBE FAIL:', e instanceof Error ? e.message : e); process.exitCode = 1; });
