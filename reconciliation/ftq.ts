// Read-only FreshTrack replica SQL runner (reconciliation use). Pins read-only + statement timeout.
// Usage: node --experimental-strip-types ftq.ts -e "select ..."
import { connectFreshtrackRead } from '../src/lib/freshtrack_db.ts';
const args = process.argv.slice(2);
const ei = args.indexOf('-e');
if (ei < 0) { console.error('need -e <sql>'); process.exit(2); }
const sql = args[ei + 1];
const c = await connectFreshtrackRead();
try {
  const res = await c.query(sql);
  const rows = res.rows;
  if (!rows.length) { console.log('(0 rows)'); }
  else {
    const cols = Object.keys(rows[0]);
    const w = cols.map((k) => Math.max(k.length, ...rows.map((r: any) => String(r[k] ?? '∅').length)));
    const fmt = (v: string[]) => v.map((x, i) => x.padEnd(w[i])).join(' | ');
    console.log(fmt(cols)); console.log(w.map((x) => '-'.repeat(x)).join('-+-'));
    for (const r of rows.slice(0, 100)) console.log(fmt(cols.map((k) => String(r[k] ?? '∅'))));
    if (rows.length > 100) console.log(`... ${rows.length} rows`);
  }
} catch (e) { console.error('ERR:', (e as Error).message); process.exitCode = 1; }
finally { await c.end(); }
