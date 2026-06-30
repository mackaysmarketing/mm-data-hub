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

- [ ] **grower_name selectable** — a `/load` query selecting `dispatch.grower_name` + `dispatch.pallet_count` returns named rows, no `text = uuid` error. Paste the query and the actual rows.
- [ ] **No row-count regression** — `pallet_count` / `load_count` totals are identical to pre-fix values. The cast aligns types only; it must not change which rows match (LEFT JOIN, no fan-out, no dropped rows). Paste before/after totals.
- [ ] **Additive — /meta unchanged** — the dispatch view `/meta` member list is identical to before: 6 measures + 11 dimensions (including `origin_shed_id`, `origin_shed_name`), nothing added, removed, or renamed. Paste the member list.
- [ ] **queryRewrite anchor unchanged** — `cube.js` still scopes only `dispatch.grower_key` (no new anchor, `securityContext` path untouched, no filter ever pushed onto `grower_name`). Paste the relevant lines. *(Deploy-free — read source.)*
- [ ] **No regression on origin_shed** — re-run the prior sprint's two origin proofs: `pallet_count` by `origin_shed_name` (15 non-null sheds, LMB ≈ 1554) and the uuid filter on `origin_shed_id` returns its single LMB row. Paste both.

## Definition of Done
- [ ] All acceptance criteria checked, each with pasted evidence
- [ ] Own branch (e.g. `fix/dispatch-grower-name-cast`); not pushed to main without approval
- [ ] Independent evaluator session confirms criteria 1–5 (skeptical-senior-engineer prompt + the rubric below)
- [ ] `/meta` builds clean after deploy; no SQL/build errors
- [ ] HANDOFF.md updated and committed
- [ ] Working tree clean

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