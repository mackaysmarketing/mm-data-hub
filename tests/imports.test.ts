import { test } from 'node:test';

// Regression guard: importing every src module forces `node --experimental-strip-types` to
// PARSE them all, catching non-erasable TypeScript (parameter properties, enums, namespaces)
// that `tsc` accepts but the runtime rejects at load time. The other unit tests don't import
// the loaders/freshtrack client, so a parameter property in freshtrack.ts (fixed 2026-06-20)
// slipped past typecheck + tests until the loader was actually run. This test closes that gap.
// All modules are side-effect-free on import (CLI bodies are guarded by isMain()).
test('every src module loads under --experimental-strip-types', async () => {
  await import('../src/lib/env.ts');
  await import('../src/lib/freshtrack.ts');
  await import('../src/lib/db.ts');
  await import('../src/lib/windows.ts');
  await import('../src/lib/parsers.ts');
  await import('../src/lib/specs.ts');
  await import('../src/lib/util.ts');
  await import('../src/loaders/entities.ts');
  await import('../src/loaders/dispatch.ts');
  await import('../src/loaders/pallets.ts');
  await import('../src/loaders/backfill.ts');
  await import('../src/reconcile.ts');
  await import('../src/schemaDiff.ts');
});
