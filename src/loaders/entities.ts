// Entity-master loader → raw.ft_entity, then rebuild core.dim_grower.
// Also resolves the test-consignor IDs excluded at dispatch pull (SPEC §9.6).
import type { PoolClient } from 'pg';
import { gql } from '../lib/freshtrack.ts';
import { upsertNodes, makePool } from '../lib/db.ts';
import { entitySpec, fieldSelection } from '../lib/specs.ts';
import { env, KNOWN_TEST_CONSIGNOR_IDS } from '../lib/env.ts';
import { deriveIsTest } from '../lib/parsers.ts';
import { isMain, log } from '../lib/util.ts';

type Node = Record<string, unknown>;

export interface EntityLoadResult {
  upserted: number;
  growerRows: number;
  testConsignorIds: string[];
}

export async function loadEntities(client: PoolClient): Promise<EntityLoadResult> {
  const query = `query Entities($limit:Int){ entities(filterLimit:$limit){ ${fieldSelection(entitySpec)} } }`;
  const data = await gql<{ entities: Node[] }>(query, { limit: env.filterLimit() });
  const nodes = data.entities;

  const upserted = await upsertNodes(client, entitySpec, nodes);
  const built = await client.query<{ refresh_dim_grower: number }>('select core.refresh_dim_grower()');
  const growerRows = built.rows[0]?.refresh_dim_grower ?? 0;

  const testConsignorIds = Array.from(
    new Set(
      nodes
        .filter((n) => deriveIsTest(n.code as string, n.isActive as boolean) && n.consignorId)
        .map((n) => String(n.consignorId)),
    ),
  );
  return { upserted, growerRows, testConsignorIds };
}

if (isMain(import.meta.url)) {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const r = await loadEntities(client);
    log(`entities upserted=${r.upserted} dim_grower=${r.growerRows} test_consignors=${r.testConsignorIds.length}`);
    log(`test consignor ids: ${[...new Set([...r.testConsignorIds, ...KNOWN_TEST_CONSIGNOR_IDS])].join(', ')}`);
  } finally {
    client.release();
    await pool.end();
  }
}
