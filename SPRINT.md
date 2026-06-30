# Sprint: Fix dispatch.grower_name text=uuid join cast
Date: 2026-06-30
Repo: mm-data-hub

## Scope
The `dispatch` Cube view advertises `grower_name` as a dimension (it is one of the 11 members in the view's `/meta` dimension list), but selecting it raises `operator does not exist: text = uuid`. Root cause: the `dispatch_loads → core.dim_grower` join compares `grower_key` (text) against `dim_grower.consignor_id` (uuid). This sprint fixes that one join so `grower_name` is selectable. Nothing else changes — no other member, no change to the RLS/queryRewrite contract, no change to the `origin_shed_*` dimensions added on the previous branch.

An advertised dimension that errors on select is a trap in a self-serve semantic layer — this is the kind of thing that erodes trust in the organisational brain once other people start querying it. Worth a scoped, surgical pass.

## The fix
Cast **down**: change the join predicate to compare `dim_grower.consignor_id::text = <loads>.grower_key` (cast the uuid to text). Do **not** cast `grower_key::uuid`.

Rationale — confirm against the actual file before editing:
- `grower_key` is the text-typed dimension that flows through `queryRewrite` (it is the RLS anchor) and through every other select on the view. Casting it to uuid risks an invalid-uuid runtime error if any `grower_key` is ever not a clean uuid string. Casting `consignor_id` down to text cannot fail that way.
- `core.dim_grower` is a small dimension table, so a cast inside the join predicate has nil performance cost.
- This deviates from the repo's default "Cube type-cast must be uuid, not text" — that default is for the **RLS security-context anchor**, where a genuine uuid comparison is wanted. This is a **display join**, a different context; casting down to text is correct here. The evaluator must not "correct" this back to `::uuid`.

Find the join first — likely `cube/model/cubes/dispatch_loads.yml`, or wherever `dim_grower` is joined and `grower_name` is defined. Make the smallest possible change.

## Acceptance Criteria
Rows are produced through the governed REST `/load` API with an internal-signed context (`app_metadata.is_internal:true`) — the same mechanism as `npm run cube:reconcile` / `cube:rls` — because the Cube Cloud MCP chat tool is RLS fail-closed and returns 0 rows for **every** query (proven last session with a baseline measure). Do not try to prove data rows through the MCP chat tool.

- [x] **grower_name selectable** — `/load` `{measures:[pallet_count], dimensions:[grower_name]}` returns named rows (MM Larapinta 15152, MM Truganina 8662, MM Ann Road 6729, …), **no `text = uuid`**. The reverted (pre-fix) join reproduced `operator does not exist: text = uuid`; the cast removes it. Evidence: `reports/cube_grower_name_proof_2026-06-30.txt` §1.
- [x] **No row-count regression** — pre-fix vs post-fix on identical current data: `pallet_count` **43754 = 43754**, `load_count` **6189 = 6189**; Σ `pallet_count` by `grower_name` = 43754 (no fan-out). (Both exceed the 2026-06-23 report's 42336/6037 because the Sprint-7 LMB backfill landed 2026-06-29; a type-cast adds no rows.) Evidence: §2.
- [x] **Additive — /meta unchanged** — dispatch view `/meta` = **6 measures** (line_count, load_count, net_weight_capture_rate, net_weight_dispatched, pallet_count, pallets_with_net_weight) + **11 dimensions** (consignee_key, crop, dispatched_on, grower_code, grower_key, grower_name, origin_shed_id, origin_shed_name, pack_week, product, variety), nothing added/removed/renamed. Evidence: §3.
- [x] **queryRewrite anchor unchanged** — `cube.js` untouched (`git diff` empty). `VIEW_GROWER_KEYS.dispatch = 'dispatch.grower_key'` (cube.js:45) is the sole dispatch anchor; the only scope push is on that member (cube.js:104–111); no filter ever pushed onto `grower_name`. *(Deploy-free, source-verified.)*
- [x] **No regression on origin_shed** — `pallet_count` by `origin_shed_name` returns 31 non-null sheds, **LMB = 1554**; uuid filter `origin_shed_id = 0196372c-5cd9-d666-ae1d-b85ad02b6bdd` returns its **single** LMB row (1554). Evidence: §5.

> **Proof mechanism note:** all five ran through the governed REST `/load` + `/meta` API (the same `cube:reconcile`/`cube:rls` mechanism, internal-signed `app_metadata.is_internal:true`). **Proven on PROD** — deployment id 1 (`lime-lamprey.aws-us-west-2.cubecloudapp.dev`), after the fix was deployed 2026-06-30; numbers identical to the earlier local-instance run (43754/6189, LMB=1554, 6+11 `/meta`).

## Definition of Done
- [x] All acceptance criteria checked, each with pasted evidence (`reports/cube_grower_name_proof_2026-06-30.txt`)
- [x] Own branch (`fix/dispatch-grower-name-cast`); not pushed to main
- [x] Independent evaluator session confirms criteria 1–5 (skeptical-senior-engineer prompt + the rubric below) — **APPROVE** (2026-06-30). An independent agent re-ran all five LIVE against prod deployment id 1 (not trusting the transcript): criterion 1 named rows no `text = uuid`; 2 `pallet_count` 43754=43754 / `load_count` 6189=6189, Σ by grower_name = 43754 (no fan-out); 3 `/meta` 6 measures + 11 dimensions unchanged; 4 `cube.js` untouched by the branch (verified via range `168f3e7..747f129`, not a misleading `diff origin/main`), scopes only `grower_key`; 5 `origin_shed` 31 sheds / LMB 1554 / single-row uuid filter. Cast direction confirmed `consignor_id::text` (down), not `grower_key::uuid`. `typecheck` clean, 72/72 tests, proof harness confirmed genuine (real signed JWT → real `/load`+`/meta`, no mocks).
- [x] `/meta` builds clean — local server compiled the model + served `/meta` with no SQL/build errors; the reverted join's `text = uuid` error was reproduced then cleared by the fix
- [x] HANDOFF.md updated and committed
- [x] Working tree clean (local-proof ephemera removed; `cube/node_modules` gitignored)
- [x] Deployed to prod Cube Cloud deployment id 1 (2026-06-30); all 5 criteria re-proven on prod via `npm run cube:grower-name`

## Deploy gate (same fence as the origin_shed sprint)
The MCP can only query **production deployment id 1** ("MM Data Hub") — there is no reachable dev deployment. The `/load` and `/meta` proofs run against the **built** model, so verifying criteria 1, 2, 3, 5 requires the fix deployed to prod, which needs explicit approval. So: build + commit on the branch, verify the deploy-free criterion (4) and the source-level additive diff, then **stop and request approval to deploy**. Report deploy-dependent criteria as PENDING-DEPLOY until approved. Deploy via `cd cube && npx cubejs-cli deploy --token <hex CLI deploy token>` — the hex token from the Deploy-with-CLI page, **not** a JWT query token (the empty-`{}`-payload JWTs are unscoped query tokens and the CLI rejects them).

## Quality Rubric
| Criterion | What to check |
|---|---|
| Cube join correctness | The cast aligns types without changing the join's matched-row set. LEFT JOIN semantics preserved — no rows dropped, no fan-out. |
| Additive contract | No existing measure/dimension changed, removed, or renamed. `grower_key` / `product_id` / `origin_shed_*` text-typing intact. |
| RLS not weakened | `queryRewrite` scopes only `grower_key`. No new anchor. `securityContext` path untouched. No filter pushed onto `grower_name`. |
| Cast direction | `consignor_id::text` (down), not `grower_key::uuid`. The "uuid not text" default does not apply to this display join — do not revert it. |
| No secrets / clean tree | No deploy token or DB URL committed. Working tree clean at handoff. |

## Goal Condition
Adapted from the mm-data-hub "Cube RLS / annotation fix" condition:

```
/goal The dispatch.grower_name text=uuid join is fixed by casting consignor_id::text in the
dispatch_loads -> dim_grower join (NOT grower_key::uuid). Prove via the governed /load API with an
internal-signed context, pasting each result: (1) selecting dispatch.grower_name + pallet_count returns
named rows with no "operator does not exist: text = uuid"; (2) pallet_count/load_count totals are
unchanged vs pre-fix (paste both); (3) the dispatch view /meta member list is unchanged - 6 measures +
11 dimensions, nothing added/removed/renamed; (4) cube.js queryRewrite still scopes only grower_key
(paste the lines); (5) the two origin_shed proofs from the prior sprint still return. Own branch, do not
push to main, do not touch the raw layer or the origin_shed dimensions or the RLS anchor. The deploy
fence applies: only prod deployment 1 is queryable - build+commit, then request deploy approval before
running the /load + /meta proofs; report those as PENDING-DEPLOY until approved. Stop after 20 turns.
```

## Evaluator opener (copy verbatim into the second session)
```
You are a skeptical senior engineer doing QA on a Cube model change that was just written.
Your job is to find everything wrong, incomplete, or inconsistent.

Specifically:
- Read SPRINT.md and HANDOFF.md first.
- Confirm the fix casts consignor_id::text in the dispatch_loads -> dim_grower join, NOT grower_key::uuid.
  If it casts grower_key to uuid, fail it and explain the invalid-uuid risk.
- Re-run the five acceptance criteria yourself through the governed /load API (do NOT trust the transcript,
  and do NOT use the MCP chat tool for data rows — it is RLS fail-closed and returns 0 rows for everything).
- Verify the change is additive against /meta: 6 measures + 11 dimensions, nothing renamed.
- Confirm cube.js queryRewrite scopes only grower_key and the securityContext path is untouched.
- Confirm the two origin_shed proofs still return.
Do not suggest the work is complete unless you have verified all five with your own evidence.
```

## Out of Scope
- The raw layer (`raw.ft_*`)
- `origin_shed_id` / `origin_shed_name` (just added — leave alone)
- The queryRewrite RLS anchor / `securityContext` path
- Repointing the cube at `semantic.grower_dispatch_detail`
- Any `core.*` table change
- Pushing the branch to main / opening the PR (separate decision)