import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` is the entrypoint (`node x.ts`). */
export function isMain(metaUrl: string): boolean {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(metaUrl) === argv[1];
  } catch {
    return false;
  }
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
