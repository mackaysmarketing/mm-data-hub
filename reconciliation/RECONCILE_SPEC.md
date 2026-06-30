# Reconciliation Spec — Bold Reports vs Supabase/Cube Warehouse

Goal of the run: for every standard FreshTrack **Bold report** provided, reverse-engineer how each figure is derived, then prove the Supabase/Cube warehouse reproduces it. Success = every report categorically aligned (exact, or within tolerance with a documented, proven cause). This is an **unattended overnight run** — work report-by-report, commit progress after each, and never spin on a single report.

## Inputs
- Bold report exports live in `reconciliation/bold/` (PDF / Excel / CSV). If that folder is empty → STOP and report "no reports provided".
- The running ledger is `reconciliation/RECONCILIATION_LEDGER.md` — append to it after every report and commit.
- Before starting, read `HANDOFF.md`, `CLAUDE.md`, the existing loader/ingest scripts, and the existing cube proof scripts to learn the warehouse layout, the established query patterns, and the established ingest patterns. Do not invent new patterns.

## Per-report loop
For each report file, in order:

1. **EXTRACT** — list every headline figure in the report, plus its filters, date window, groupings, and any visible column definitions / units.
2. **HYPOTHESISE** — state explicitly how you believe each figure is derived: which FreshTrack/warehouse tables and fields, which filters (`order_type`, state/`sequence`, `is_test`, the date basis — pickup vs scheduled vs `created_on`), and what grain. Write the hypothesis down before querying.
3. **DATA PRE-CHECK** — confirm the warehouse actually holds the rows and fields the hypothesis needs. If it does not, go to **Ingestion** below.
4. **REPRODUCE** — translate the hypothesis into Supabase SQL and/or governed Cube `/load` queries, and run them.
   - The **Cube MCP chat tool is RLS fail-closed and returns 0 rows for every query** — do NOT use it for data. Use the governed `/load` API with an internal-signed context (the `cube:reconcile` / `cube:rls` mechanism), or query Supabase directly.
5. **COMPARE + ITERATE** — diff the warehouse output against the Bold figure. If it doesn't match, refine the hypothesis (filters, joins, grain, date basis) and re-run.
   - **Bounded:** if a figure won't align after ~6 honest investigation cycles, STOP iterating it. Write a precise gap analysis — what differs, by how much, and the most likely cause — and set the report's status accordingly. Do NOT keep re-running the same query hoping for a different number.
6. **RECORD** — for EVERY figure, paste into the transcript: the Bold value, the exact warehouse query, the query result, and the delta. Save the validated query to `reconciliation/queries/<report-name>.sql` (or `.ts`). Append the report's full entry to the ledger, then **commit** (own branch, no push).

## Success definition (per report)
- **DONE** — every headline figure is either exact, OR within a small tolerance **with a documented, proven cause**: a sync-lag window (the warehouse lands FreshTrack on a schedule, so very recent rows may not be in yet), the known ~0.2% missing-pallet/box noise, or a precise definitional nuance you have identified and explained.
- **RECONCILED-DIFF** — a residual gap remains but is **proven structural and explained**, not hand-waved. Record the exact cause and the magnitude.
- **BLOCKED-NEEDS-TIM** — alignment requires something only Tim can authorise: a schema change, a new migration / any DDL, a Cube model or deploy change, a field the existing loaders don't land, or replica / credential access not available in this session. Write the **exact** change required, then move to the next report.

A residual gap you cannot explain is RECONCILED-DIFF (documented unknown), not an excuse to loop. Match what the data truthfully produces — never bend a query or fabricate a number to force alignment.

## Ingestion (permitted, but bounded)
If a report cannot reconcile because the warehouse is **missing source rows** it needs:
- You MAY backfill — but ONLY by re-running an **existing, proven loader/ingest script already in this repo** (find it; do not hand-write new bulk-write logic), ONLY as **idempotent upserts into the RAW layer**, and you must capture row counts **before and after**.
- You must **NEVER**: create or alter tables, run a new migration or any DDL, deploy Cube, run `DELETE` / `TRUNCATE` / `DROP`, or modify existing rows in a non-idempotent way.
- If reconciliation needs a NEW table, a schema/field change, a new loader, or a Cube change → do NOT do it. Mark the report **BLOCKED-NEEDS-TIM** with the precise change required, and continue.

## Safety
- **FreshTrack is read-only** — compare against it, never write to it.
- Do not touch the existing `dispatch` / `settlement` / `gp_*` surfaces or any existing metric.
- Own branch `reconciliation/bold-vs-warehouse`. Never push to main. Never deploy.
- `.env` holds the credentials and is gitignored — never stage or commit it.

## Terminal condition
Stop only when EVERY report is in a terminal state: **DONE**, **RECONCILED-DIFF**, or **BLOCKED-NEEDS-TIM**. At the end, write a final scoreboard table (every report + status) at the top of the ledger and commit. Backstop: if you reach the turn cap, commit the ledger and stop with a clear "hit turn cap, N reports remaining" note. Never declare overall success unless every report's alignment is proven with pasted evidence in the transcript and a saved validated query.
