// Backfill orchestrator. Walks BACKFILL_START→today in WINDOW_DAYS windows, loading
// dispatch loads then their pallets. Resumable: 'done' windows are skipped on restart;
// re-running a non-done window is safe (idempotent upsert on id).
import { makePool, doneWindowStarts, beginWindow, completeWindow, failWindow } from '../lib/db.ts';
import { buildWindows, parseUtcDate } from '../lib/windows.ts';
import { env, KNOWN_TEST_CONSIGNOR_IDS } from '../lib/env.ts';
import { isMain, log } from '../lib/util.ts';
import { loadEntities } from './entities.ts';
import { loadDispatchWindow } from './dispatch.ts';
import { loadPalletsForLoadIds } from './pallets.ts';

export async function runBackfill(): Promise<void> {
  const pool = makePool();
  const client = await pool.connect();
  try {
    log('── entity master ─────────────────────────────');
    const ent = await loadEntities(client);
    const testSet = new Set<string>([...ent.testConsignorIds, ...KNOWN_TEST_CONSIGNOR_IDS]);
    log(`entities=${ent.upserted} dim_grower=${ent.growerRows} test_consignors=${testSet.size}`);

    const start = parseUtcDate(env.backfillStart());
    const end = env.backfillEnd() ? parseUtcDate(env.backfillEnd() as string) : new Date();
    const windows = buildWindows(start, end, env.windowDays());
    log(`── dispatch backfill: ${windows.length} × ${env.windowDays()}d windows ` +
        `(${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}) ──`);

    const done = await doneWindowStarts(client, 'dispatch_load');
    let loads = 0;
    let pallets = 0;
    let excluded = 0;

    for (const w of windows) {
      const key = w.start.toISOString();
      if (done.has(key)) {
        log(`  skip ${key.slice(0, 10)} (done)`);
        continue;
      }
      await beginWindow(client, 'dispatch_load', w.start, w.end);
      try {
        const d = await loadDispatchWindow(client, w, testSet);
        if (d.truncated) {
          log(`  ⚠ window ${key.slice(0, 10)} hit filterLimit (${d.seen}); shrink WINDOW_DAYS`);
        }
        await beginWindow(client, 'pallet', w.start, w.end);
        const p = await loadPalletsForLoadIds(client, d.loadIds);
        await completeWindow(client, 'pallet', w.start, { seen: p.seen, upserted: p.upserted });
        await completeWindow(client, 'dispatch_load', w.start, {
          seen: d.seen,
          upserted: d.upserted,
          excluded: d.excluded,
        });
        loads += d.upserted;
        pallets += p.upserted;
        excluded += d.excluded;
        log(`  ${key.slice(0, 10)}  loads=${d.upserted} (excl ${d.excluded})  pallets=${p.upserted}`);
      } catch (e) {
        await failWindow(client, 'dispatch_load', w.start, String(e));
        throw e;
      }
    }

    log('── done ──────────────────────────────────────');
    log(`loads=${loads}  pallets=${pallets}  excluded(test)=${excluded}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  await runBackfill();
}
