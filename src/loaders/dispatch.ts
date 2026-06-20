// Dispatch-load loader. Windows on actual_pickup_on (filterActualPickupOnStart/End);
// drops test consignors at pull; upserts idempotently on id.
import type { PoolClient } from 'pg';
import { gql } from '../lib/freshtrack.ts';
import { upsertNodes } from '../lib/db.ts';
import { dispatchLoadSpec, fieldSelection } from '../lib/specs.ts';
import { env } from '../lib/env.ts';
import type { Window } from '../lib/windows.ts';

type Node = Record<string, unknown>;

export interface DispatchWindowResult {
  seen: number;
  upserted: number;
  excluded: number;
  loadIds: string[];
  truncated: boolean;
}

const QUERY = `query Loads($start:DateTime,$end:DateTime,$limit:Int){
  dispatchLoads(filterActualPickupOnStart:$start, filterActualPickupOnEnd:$end, filterLimit:$limit){
    ${fieldSelection(dispatchLoadSpec)}
  }
}`;

export async function loadDispatchWindow(
  client: PoolClient,
  window: Window,
  testConsignorIds: Set<string>,
): Promise<DispatchWindowResult> {
  const limit = env.filterLimit();
  const data = await gql<{ dispatchLoads: Node[] }>(QUERY, {
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    limit,
  });
  const all = data.dispatchLoads;
  // A full page means the window may have been truncated — the caller should shrink WINDOW_DAYS.
  const truncated = all.length >= limit;

  const kept = all.filter((n) => !testConsignorIds.has(String(n.consignorId)));
  const upserted = await upsertNodes(client, dispatchLoadSpec, kept);
  const loadIds = kept.map((n) => String(n.id));

  return { seen: all.length, upserted, excluded: all.length - kept.length, loadIds, truncated };
}
