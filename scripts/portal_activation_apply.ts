// ─────────────────────────────────────────────────────────────────────────────
// Apply the hand-curated grower-portal activation list (src/config/portal_activation.ts) to
// core.portal_grower_activation. THE hub is the source of truth for portal access.
//
//   npm run portal:activate              # DRY RUN — prints the diff, writes NOTHING
//   npm run portal:activate -- --apply   # writes
//
// Safe by construction:
//   • dry run is the default; writing needs an explicit --apply
//   • assertHubTarget() before any write (never the wrong project)
//   • every code must resolve to EXACTLY ONE ACTIVE dim_grower row — dim_grower.code is not
//     unique (WADDA is active + inactive), so ambiguity is a hard stop, never a guess
//   • refuses to enable a test / inactive / non-grower consignor
//   • rows are UPDATED to enabled=false, never deleted — the audit trail is the point
//   • post-write read-back asserts the enabled set equals the declared set
//   • reports DRIFT: rows last touched by the grower-portal admin RPC rather than by this file
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { makePool, assertHubTarget } from '../src/lib/db.ts';
import { isMain, log } from '../src/lib/util.ts';
import {
  PORTAL_ACTIVATION, activationCodes, duplicateCodes, entriesMissingNote,
} from '../src/config/portal_activation.ts';

/** Stamped on every row this file writes; anything else in updated_by means the portal UI did it. */
export const HUB_SOURCE = 'mm-data-hub/portal_activation.ts';

interface Resolved { code: string; consignor_id: string; org_name: string }
interface Current { code: string | null; consignor_id: string; enabled: boolean; updated_by: string | null }

/** Resolve declared codes → the single ACTIVE dim_grower row each. Throws on any ambiguity. */
export async function resolveCodes(c: PoolClient, codes: string[]): Promise<Resolved[]> {
  const rows = (await c.query<{ code: string; consignor_id: string; org_name: string; n: string }>(`
    select g.code, min(g.consignor_id::text) consignor_id, min(g.org_name) org_name, count(*)::text n
    from core.dim_grower g
    where g.code = any($1) and g.is_active
      and g.is_grower is true and coalesce(g.is_test, false) = false
    group by g.code`, [codes])).rows;

  const byCode = new Map(rows.map((r) => [r.code, r]));
  const problems: string[] = [];
  for (const code of codes) {
    const r = byCode.get(code);
    if (!r) problems.push(`${code}: no ACTIVE, non-test, is_grower row in core.dim_grower`);
    else if (Number(r.n) !== 1) problems.push(`${code}: resolves to ${r.n} active rows (expected 1)`);
  }
  if (problems.length) {
    throw new Error(`activation list cannot be resolved:\n  - ${problems.join('\n  - ')}`);
  }
  return codes.map((code) => {
    const r = byCode.get(code)!;
    return { code, consignor_id: r.consignor_id, org_name: r.org_name };
  });
}

export async function run(apply: boolean): Promise<number> {
  // ── Validate the file itself before touching the database ────────────────
  const dupes = duplicateCodes();
  if (dupes.length) throw new Error(`duplicate codes in the activation list: ${dupes.join(', ')}`);
  const noNote = entriesMissingNote();
  if (noNote.length) throw new Error(`activation entries missing a mandatory note: ${noNote.join(', ')}`);

  const pool = makePool();
  const c = await pool.connect();
  try {
    await assertHubTarget(pool);
    const declared = await resolveCodes(c, activationCodes());
    const declaredIds = new Set(declared.map((d) => d.consignor_id));

    const current = (await c.query<Current>(`
      select g.code, a.consignor_id::text consignor_id, a.enabled, a.updated_by
      from core.portal_grower_activation a
      left join core.dim_grower g on g.consignor_id = a.consignor_id`)).rows;
    const enabledNow = new Set(current.filter((r) => r.enabled).map((r) => r.consignor_id));

    const toEnable = declared.filter((d) => !enabledNow.has(d.consignor_id));
    const toDisable = current.filter((r) => r.enabled && !declaredIds.has(r.consignor_id));
    const unchanged = declared.length - toEnable.length;

    // Drift = a row whose CURRENT STATE came from outside this file AND disagrees with it.
    // A row that merely carries an older provenance stamp but already agrees is not drift — it is
    // history, and --apply re-stamps it. Only disagreement is worth a human's attention.
    const outside = (r: Current) => !!r.updated_by && r.updated_by !== HUB_SOURCE;
    const drift = [
      ...toDisable.filter(outside),
      ...current.filter((r) => !r.enabled && outside(r) && declaredIds.has(r.consignor_id)),
    ];
    const staleStamp = current.filter((r) => r.enabled && outside(r) && declaredIds.has(r.consignor_id));

    log(`declared: ${declared.length} · currently enabled: ${enabledNow.size}`);
    log(`\n  ENABLE  (${toEnable.length})`);
    for (const d of toEnable) log(`    + ${d.code.padEnd(6)} ${d.org_name}`);
    log(`\n  DISABLE (${toDisable.length})`);
    for (const d of toDisable) log(`    - ${(d.code ?? '(unknown)').padEnd(6)} last set by ${d.updated_by ?? '(null)'}`);
    log(`\n  unchanged: ${unchanged}`);
    if (drift.length) {
      log(`\n  ⚠ DRIFT — ${drift.length} row(s) set OUTSIDE this file and disagreeing with it:`);
      for (const d of drift) log(`      ${(d.code ?? '(unknown)').padEnd(6)} enabled=${d.enabled} by ${d.updated_by}`);
      log('    → this file WINS on --apply. Fold any intentional change into it first, or it is reverted.');
    }
    if (staleStamp.length) {
      log(`\n  ${staleStamp.length} row(s) already agree but carry an older provenance stamp `
        + `(e.g. ${staleStamp[0]!.updated_by}) — --apply re-stamps them, state unchanged.`);
    }

    if (!apply) {
      log(`\nDRY RUN — nothing written. Re-run with --apply to write.`);
      return toEnable.length + toDisable.length;
    }

    await c.query('begin');
    try {
      await c.query(`
        update core.portal_grower_activation
           set enabled = false, updated_at = now(), updated_by = $2
         where enabled and consignor_id <> all($1::uuid[])`,
        [[...declaredIds], HUB_SOURCE]);
      await c.query(`
        insert into core.portal_grower_activation (consignor_id, enabled, updated_at, updated_by)
        select unnest($1::uuid[]), true, now(), $2
        on conflict (consignor_id) do update
          set enabled = true, updated_at = now(), updated_by = excluded.updated_by
          where core.portal_grower_activation.enabled is distinct from true`,
        [[...declaredIds], HUB_SOURCE]);
      // Converge provenance: after an apply, every enabled row is hub-sourced by definition.
      // updated_at is deliberately NOT touched — it records when the STATE last changed.
      await c.query(
        `update core.portal_grower_activation set updated_by = $1
          where enabled and updated_by is distinct from $1`, [HUB_SOURCE]);

      // Read back INSIDE the transaction — roll back rather than leave a wrong set live.
      const after = (await c.query<{ consignor_id: string }>(
        `select consignor_id::text consignor_id from core.portal_grower_activation where enabled`)).rows;
      const afterIds = new Set(after.map((r) => r.consignor_id));
      if (afterIds.size !== declaredIds.size || [...declaredIds].some((id) => !afterIds.has(id))) {
        throw new Error(`post-write enabled set (${afterIds.size}) != declared (${declaredIds.size})`);
      }
      const bad = (await c.query<{ code: string }>(`
        select g.code from core.portal_grower_activation a
        join core.dim_grower g on g.consignor_id = a.consignor_id
        where a.enabled and (coalesce(g.is_test,false) or not g.is_active or g.is_grower is not true)`)).rows;
      if (bad.length) throw new Error(`test/inactive/non-grower enabled: ${bad.map((b) => b.code).join(', ')}`);

      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    }

    log(`\nAPPLIED — ${declared.length} consignors enabled (+${toEnable.length} / -${toDisable.length}).`);
    return toEnable.length + toDisable.length;
  } finally {
    c.release();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  run(apply).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
