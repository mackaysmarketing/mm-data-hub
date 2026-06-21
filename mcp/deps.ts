// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — real dependency wiring (Cube client + caller-scoped DB + cached catalog).
// Shared by the server and the proof script so both exercise the SAME code paths.
// ─────────────────────────────────────────────────────────────────────────────
import { cubeClient, type CubeClient } from './cube.ts';
import { makeCallerDb } from './db.ts';
import { buildCatalog, type Catalog } from './registry.ts';
import type { CallerIdentity } from './identity.ts';
import type { ToolDeps } from './tools.ts';

/** Cache the (small, stable) catalog after the first successful /meta fetch. */
export function makeCatalogProvider(cube: CubeClient): (id: CallerIdentity) => Promise<Catalog> {
  let cached: Catalog | null = null;
  return async (id: CallerIdentity): Promise<Catalog> => {
    if (cached) return cached;
    cached = buildCatalog(await cube.meta(id));
    return cached;
  };
}

export function makeDeps(): { deps: ToolDeps; close: () => Promise<void> } {
  const db = makeCallerDb();
  const deps: ToolDeps = { cube: cubeClient, db, catalog: makeCatalogProvider(cubeClient) };
  return { deps, close: () => db.end() };
}
