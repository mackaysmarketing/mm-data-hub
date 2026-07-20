# mm-data-hub → grower-portal: grower directory v2 (parent hierarchy) — response (2026-07-20)

Response to "Ask to mm-data-hub: grower directory v2 — parent hierarchy columns" (Sprint 19,
revised same-day to the FreshTrack-parent-hierarchy design after Tim's live test). Status:
**SHIPPED — migration `0058` live on the hub, all proofs green.** The portal can swap its
grouping source to the directory columns now.

## What shipped — the three columns, names exactly as asked
`semantic.grower_directory` now carries, per row (same rows, same staff-only gate as 0056/0057):

| column | type | note |
|---|---|---|
| `entity_id` | uuid | the consignor's own FreshTrack entity id (100/100 populated) |
| `parent_entity_id` | uuid | null when no parent |
| `parent_name` | text | null when no parent |

Coverage today: **39/100 directory rows carry a parent** (the rest are standalone — surfaced,
not asserted; it moves as FreshTrack parents are fixed).

## One implementation note (same behavior, different plumbing)
The ask said "resolved at view level" — it is resolved at **refresh time onto `core.dim_grower`**
instead, because the directory is a `security_invoker` view and the hierarchy source
(`raw.ft_entity`) is deliberately ungranted (it carries tax numbers; a view-level join would be
permission-denied for every caller). Practical consequence, which matches your "flows through on
sync" expectation: a parent fixed in FreshTrack appears in the directory after the entity sync +
`core.refresh_dim_grower()` — the same cadence every other dim field already follows. No
curation layer, no new tables, no policy changes — as asked.

## Verified live (portal:verify F8, all self-derived — report `reports/grower_portal_fixes_2026-07-20.txt`)
- **Drift guard:** dim parent columns == live recomputation from `raw.ft_entity` (0 mismatches).
- **"Mac Farms" one group:** MACKF's entity parents exactly its 5 farms via a staff token
  (MACBO/MACGT/MACMR/MACRR/MACSD — matches your verification list; MACKF itself has no parent →
  your self-parent merge anchors it).
- **"L & R Collins" one group:** LRCLA + LRCTU share ONE non-null parent, name "L & R Collins"
  (LRCOL) — and LRCOL itself parents up to "Mackays Growers" (MG), so your umbrella-dissolution
  case is present in the data exactly as designed. GJFSD: parent null, as your doc predicted.
- **Gate unchanged:** staff token = 100 rows with all three columns; grower (pair) token = 0
  rows; the full forgery suite re-ran green (`auth0:rls` 188/188, `rls:posture` 104/104).
- Your totals check ("L & R Collins" group == the grower login's 238/104/240) is portal-side;
  the scoped reference pair still proves those exact numbers in F4/F1/F5.

## Answers to the (superseded ask's) open questions, for the record
1. **Natural grouping in `core.dim_grower`?** As of 0058, yes — this change IS it: the entity
   master's `parent_id` (already landed since 0004) denormalized onto the dim. No new table.
2. **Column names:** shipped verbatim — `entity_id`, `parent_entity_id`, `parent_name`.
3. **`is_active` vs `group_enabled`:** moot in v2 (no `group_enabled` exists). `is_active`
   stays consignor-level. One flag for the record: Tim's original direction included "groups
   must be curated + ENABLED before a grower is visible" — in v2 that gating lives entirely in
   the portal UI (your doc: "UX gating, not a security boundary"). If a hub-side enable switch
   is ever wanted (so visibility survives portal rewrites), that's a new ask — it would
   reintroduce a small curation table on top of the hierarchy.
