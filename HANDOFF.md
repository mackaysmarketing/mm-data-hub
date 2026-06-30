# Handoff (2026-06-30): Sprint 8 Phase B — additive shipped-dispatch CUBE surface (Option C)
Branch: `feat/dispatch-shipped-cube` (NOT pushed to main). Phase B = Cube only (deploy-gated).
Status: **✅ DONE — DEPLOYED + PROVEN ON PROD.** Criteria 8 + 10 proven via the governed REST `/load` + `/meta`
API against prod deployment 1; full evidence in `reports/cube_shipped_check_2026-06-30.txt` (ALL assertions held).

## Phase B RESULT (criteria 8 + 10, governed /load + /meta, internal + 2 growers + NIL + forged)
- **8 RLS** — anchor `dispatch_shipped: 'dispatch_shipped.grower_key'` present; `security_invoker=true` on the new
  view == `grower_dispatch_detail`; internal sees ALL **69** growers; MMTRU scoped to its own **4,498** loads
  (1 grower_key, == DB), MMLAR to its own **2,574** (both strictly < 18,670 internal); MMTRU filtered to MMLAR → **0**;
  no-claim/forged-top-level-is_internal/forged-top-level-consignor → **0**; grower_name grouping does NOT fan out
  (Σ pallet_count_shipped 174,711 == overall). No cross-grower leak.
- **10 additive + parity** — `/meta` shows `dispatch_shipped` with 4 measures (shipped_load_count, boxes_packed,
  pallet_count_shipped, net_weight_shipped) + 7 dims (grower_key, dispatch_state, effective_dispatched_on,
  origin_shed_id/name, grower_code/name); existing `dispatch` `/meta` BYTE-IDENTICAL (6 measures + 11 dims);
  `shipped_load_count` /load = **18,670** == semantic view `count(distinct load_id)` = 18,670 (same session,
  equality-to-source); boxes_packed 11,004,836 == source.

## ⚠️ Deploy incident + recovery (recorded for the log)
The FIRST deploy (`beb6dd0`) FAILED Cube's schema compile — I had named the base cube AND the view both
`dispatch_shipped`, which Cube rejects (`Found conflicting cube and view name`). A failed compile takes the WHOLE
model offline, so for the duration ALL views (dispatch/settlement/gp_*) 500'd on prod. Fix `0a84603` renamed the
base cube to `dispatch_shipped_pallets` (the view keeps the clean name, matching the convention everywhere else:
dispatch_loads/dispatch_pallets→dispatch; settlement_bill→settlement; gp_settlement_load_fact→gp_settlement_load).
Redeploy of `0a84603` restored all 5 views and brought up `dispatch_shipped`. **Lesson:** local typecheck/tests
can't catch a Cube schema-compile error — only a deploy (or a local `cubejs` dev-server compile) does; a global
cube+view name-uniqueness check is now part of the pre-deploy verification.

---

(Original PENDING-DEPLOY notes retained below for context.)

Phase A (the `semantic.grower_dispatch_shipped` view + `core.dim_dispatch_state`, migration `0021`) is
**applied to prod** and complete — see commit `c3c2a77` / `ca8f503` for its full record.

## What was built this phase (purely additive — Option C, not B)
1. **`cube/model/cubes/dispatch_shipped_pallets.yml`** — NEW base cube `dispatch_shipped_pallets`
   (`public: false`; named distinctly from the `dispatch_shipped` VIEW — Cube rejects a cube and view
   sharing a name at compile), reads the governed view
   `semantic.grower_dispatch_shipped` directly. Measures:
   - `shipped_load_count` = `COUNT(DISTINCT load_id)` (= the view's own `count(distinct load_id)`)
   - `boxes_packed` = `SUM(boxes)` (boxes = `stock_boxes + reconsigned_boxes`, computed in the view)
   - `pallet_count_shipped` = `COUNT(pallet)` ; `net_weight_shipped` = `SUM(net_weight)` (nulls excluded)
   Dimensions: `grower_key` (RLS anchor), `dispatch_state`, `effective_dispatched_on` (`coalesce(actual,
   scheduled)`), `origin_shed_id` / `origin_shed_name`; joins `dim_grower` (many_to_one, consignor_id
   unique = 156/156, no fan-out) for `grower_code` / `grower_name`. uuid columns cast `::text` to match
   the grower_key/origin_shed string-dimension pattern.
2. **`cube/model/views/dispatch_shipped.yml`** — NEW governed view (`public: true`) exposing the 4 measures
   + 7 dims. The base cube stays private so the baked-in filters + RLS can't be bypassed.
3. **`cube/cube.js`** — `VIEW_GROWER_KEYS` gains **`dispatch_shipped: 'dispatch_shipped.grower_key'`** — the
   RLS anchor for the new view. **This is the single security-critical line.** `queryRewrite` now scopes the
   new view on the identical app_metadata-only, fail-closed contract as `dispatch`/`settlement` (one-line diff;
   nothing else in cube.js changed).
4. **`scripts/cube_shipped_check.ts`** + `npm run cube:shipped` — the deploy-gated proof for criteria 8 + 10.
5. **`cube/CONTRACTS.md`** — additive section documenting the new surface (existing contracts untouched).

**Untouched (the point of C):** the `dispatch` cube/view YAMLs (`dispatch_loads.yml`, `dispatch_pallets.yml`,
`views/dispatch.yml`), `semantic.grower_dispatch_detail`, and the existing `VIEW_GROWER_KEYS` entries.
`git diff` touches only the single new cube.js line + package.json (new script) — verified.

## Deploy-free verification (done now, before deploy — real evidence pasted in session)
- **(8a) cube.js anchor** — `VIEW_GROWER_KEYS` contains `dispatch_shipped: 'dispatch_shipped.grower_key'`
  (the one security-critical line); existing entries byte-for-byte intact (`git diff cube/cube.js` = +1 line).
- **Existing dispatch surface untouched** — no edit to `dispatch_loads.yml` / `dispatch_pallets.yml` /
  `views/dispatch.yml` (not in `git status`).
- **`npm run typecheck`** clean; **`npm test`** → 72/72 pass.
- **(8b) Semantic RLS posture (live, read-only):** both `grower_dispatch_shipped` and
  `grower_dispatch_detail` are `security_invoker=true` — identical policy. (Re-asserted in the proof.)
- **(10b) Live `dispatch` /meta BASELINE** (governed `/meta`, internal context) = **6 measures**
  (`line_count, load_count, net_weight_capture_rate, net_weight_dispatched, pallet_count,
  pallets_with_net_weight`) + **11 dimensions** (`consignee_key, crop, dispatched_on, grower_code,
  grower_key, grower_name, origin_shed_id, origin_shed_name, pack_week, product, variety`). The post-deploy
  run asserts this is unchanged.
- **(10c) Source target** — `semantic.grower_dispatch_shipped` → `count(distinct load_id) = 18,670`
  (all-time; 69 growers; boxes 11,004,836). The proof asserts `shipped_load_count` (internal `/load`)
  **equals this same-session source count** — equality-to-source, NOT a hard-coded literal (the goal's
  "~8,035" was a stale 2026-only basis).
- **Deploy genuinely required** — a live `/meta` probe confirms the deployment currently exposes only
  `[dispatch, gp_settlement, gp_settlement_load, settlement]`; **`dispatch_shipped` is absent**, so its
  `/load`/`/meta` legs are impossible until the deploy. `.env` (CUBE_API_URL/SECRET + DATABASE_URL) is now in
  place in this checkout, so `npm run cube:shipped` runs end-to-end the instant the model is live.

## Deploy gate (PENDING)
Only prod deployment 1 ("MM Data Hub") is queryable — no reachable dev. Per the gate: built + committed +
verified the deploy-free parts. **Awaiting deploy approval.**
- **Tim deploys himself** and does NOT paste the token into the session:
  `cd cube && npx cubejs-cli deploy --token <hex CLI token>` (hex, not a JWT), then says "deployed."
- After "deployed", run **`npm run cube:shipped`** (needs `CUBE_API_URL` + `CUBE_API_SECRET` + `DATABASE_URL`
  in `.env`) → proves criteria 8 + 10 against prod, writes `reports/cube_shipped_check_<date>.txt`.

## Acceptance criteria — Phase B (proven by `npm run cube:shipped`, post-deploy)
- [ ] **8. RLS (SECURITY-CRITICAL)** — `VIEW_GROWER_KEYS` includes `dispatch_shipped.grower_key` (deploy-free,
      asserted from source); a single-grower `/load` returns ONLY that grower's rows AND strictly fewer loads
      than internal; NIL/no-claim → 0; forged top-level `is_internal`/`consignor_id` → 0; internal returns all
      growers; a filter cannot widen A into B; grower_name grouping does not fan out; `grower_dispatch_shipped`
      has the same `security_invoker` RLS policy as `grower_dispatch_detail`. **PENDING-DEPLOY.**
- [ ] **10. New measures live + additive** — `/meta` shows `dispatch_shipped` with `shipped_load_count` /
      `boxes_packed` / `dispatch_state` / `effective_dispatched_on` (+ rest); the existing `dispatch` `/meta`
      is byte-identical (6 measures + 11 dims); `shipped_load_count` `/load` equals the semantic view's own
      `count(distinct load_id)` in the same run. **PENDING-DEPLOY.**

## Notes
- The `seq >= 5` shipped gate lives in the migration-`0021` view (single ops-tunable line), NOT in the Cube
  model — the cube reads whatever the view defines, so moving the dispatch line stays a one-line edit.
- `dispatch_shipped` is a SEPARATE view by design (not extra members on `dispatch`) so `load_count`
  (actual-pickup basis) and `shipped_load_count` (Shipped-state basis) can't be confused by self-serve users.

## Out of scope (unchanged from Sprint 8)
- Promoting consumers onto the new surface / switching the dashboard/Steep/MCP (waits on ops sign-off that
  `seq >= 5` is the right line + one stock-load portal cross-check).
- Re-baselining the existing `dispatch` metric (that is Option B — a separate, signed-off sprint).
- Pushing to main / opening PRs.
