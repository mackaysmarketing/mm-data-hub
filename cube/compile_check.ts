// B1 compile gate — compile the WHOLE Cube schema locally (new order cube+view + every existing
// view) and report errors. A name clash / bad reference is what `typecheck`/tests cannot catch but a
// real schema compile does (the Sprint-8 deploy incident). Exits non-zero on any compile error.
//
//   npm run cube:compile   (runs `node --experimental-strip-types cube/compile_check.ts`)
//
// Uses @cubejs-backend/schema-compiler (a transitive cube/ dependency) to run the schema compiler
// over cube/model via a FileRepository. No DB connection is made — a pure compile of the YAML model.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import serverCore from '@cubejs-backend/server-core';
import schemaCompiler from '@cubejs-backend/schema-compiler';

const { FileRepository } = serverCore as unknown as { FileRepository: new (p: string) => unknown };
const { prepareCompiler } = schemaCompiler as unknown as {
  prepareCompiler: (repo: unknown, opts?: unknown) => {
    compiler: { compile: () => Promise<void> };
    cubeEvaluator: { cubeList: Array<{ name: string; isView?: boolean }> };
  };
};

const cubeDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(cubeDir); // so 'model' resolves to cube/model

async function main(): Promise<void> {
  const repo = new FileRepository('model');
  const { compiler, cubeEvaluator } = prepareCompiler(repo, { allowNodeRequire: true });
  await compiler.compile(); // throws on ANY compile error

  const list = cubeEvaluator.cubeList ?? [];
  const cubes = list.filter((m) => !m.isView).map((m) => m.name).sort();
  const views = list.filter((m) => m.isView).map((m) => m.name).sort();

  console.log('=== Cube schema compiled: 0 errors ===');
  console.log(`objects: ${cubes.length + views.length} (cubes: ${cubes.length}, views: ${views.length})`);
  console.log(`cubes: ${cubes.join(', ')}`);
  console.log(`views: ${views.join(', ')}`);

  const hasCube = cubes.includes('order_items');
  const hasView = views.includes('sales_orders');
  if (!hasCube || !hasView) {
    console.error(`FAIL: expected order_items (cube) + sales_orders (view); got cube=${hasCube} view=${hasView}`);
    process.exitCode = 1;
    return;
  }
  console.log('order objects present: order_items (cube) + sales_orders (view) ✓');
}

main().catch((e) => {
  console.error('\n=== Cube COMPILE FAILED ===');
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
