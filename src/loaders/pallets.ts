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
}

export async function loadPalletsForLoadIds(
  client: PoolClient,
  loadIds: string[],
  concurrency = 5,
): Promise<PalletLoadResult> {
  const limit = env.filterLimit();
  const perLoad = await mapLimit(loadIds, concurrency, async (id) => {
    const data = await gql<{ pallets: Node[] }>(QUERY, { id, limit });
    return data.pallets;
  });

  let seen = 0;
  let upserted = 0;
  for (const pallets of perLoad) {
    seen += pallets.length;
    upserted += await upsertNodes(client, palletSpec, pallets);
  }
  return { seen, upserted };
}
