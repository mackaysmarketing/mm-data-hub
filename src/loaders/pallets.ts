// Pallet loader. Fetches pallets per dispatch load (filterDispatchLoadId) so every pallet
// is correctly attributed to a loaded, non-test load. Upserts idempotently on id.
import type { PoolClient } from 'pg';
import { gql } from '../lib/freshtrack.ts';
import { upsertNodes } from '../lib/db.ts';
import { palletSpec, fieldSelection } from '../lib/specs.ts';
import { env } from '../lib/env.ts';
import { mapLimit } from '../lib/util.ts';

type Node = Record<string, unknown>;

const QUERY = `query Pallets($id:UUID,$limit:Int){
  pallets(filterDispatchLoadId:$id, filterLimit:$limit){
    ${fieldSelection(palletSpec)}
  }
}`;

export interface PalletLoadResult {
  seen: number;
  upserted: number;
  /** A load returned a full page — pallets may have been dropped (no cursor to recover). */
  truncatedLoadIds: string[];
}

export async function loadPalletsForLoadIds(
  client: PoolClient,
  loadIds: string[],
  concurrency = 5,
): Promise<PalletLoadResult> {
  const limit = env.filterLimit();
  const perLoad = await mapLimit(loadIds, concurrency, async (id) => {
    const data = await gql<{ pallets: Node[] }>(QUERY, { id, limit });
    return { id, pallets: data.pallets };
  });

  let seen = 0;
  let upserted = 0;
  const truncatedLoadIds: string[] = [];
  for (const { id, pallets } of perLoad) {
    seen += pallets.length;
    // Mirror the dispatch loader's guard: a full page means the per-load query may have
    // truncated (the pallets API is filterLimit-only, no cursor).
    if (pallets.length >= limit) truncatedLoadIds.push(id);
    upserted += await upsertNodes(client, palletSpec, pallets);
  }
  return { seen, upserted, truncatedLoadIds };
}
