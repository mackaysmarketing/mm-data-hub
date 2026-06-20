-- Idempotency + window-resume proof for the loaders.
-- Proven 2026-06-20 against data_hub (uqzfkhsdyeokwnkpcxui).
--
-- The committed loader (src/loaders/*) upserts on id and records each window in
-- raw.sync_window. The session backfill used equivalent server-side functions
-- (ingest_tmp.*) over the http extension; both share the same upsert + bookkeeping logic.

-- ── 1. Idempotency: re-running a completed window adds 0 net new rows ─────────
-- Baseline: raw.ft_dispatch_load = 5926, raw.ft_pallet = 38796.
-- Re-run the first weekly window (2025-07-01 → 2025-07-08) for both streams:
--   dispatch: seen 69, kept 69   (all UPDATEs, not INSERTs)
--   pallet:   seen 2691, kept 547
-- Then:
select
  (select count(*) from raw.ft_dispatch_load) as dispatch_loads,  -- 5926 (unchanged)
  (select count(*) from raw.ft_pallet)         as pallets;          -- 38796 (unchanged)

-- ── 2. Resume: an interrupted backfill reprocesses only the incomplete window ─
-- This block is wrapped in a transaction that ROLLS BACK, so the script is self-restoring
-- and re-runnable: it demonstrates the resume decision WITHOUT leaving sync_window dirty.
begin;
  -- Simulate a crash by leaving one window incomplete:
  update raw.sync_window sw set status='pending', rows_upserted=null, finished_at=null
  where sw.stream='dispatch_load' and sw.window_start = (
    select window_start from raw.sync_window where stream='dispatch_load'
    order by window_start limit 1 offset 26);

  -- The loader's resume decision (db.ts doneWindowStarts skips status='done'):
  select
    count(*) filter (where status='done')   as windows_would_skip,       -- 53
    count(*) filter (where status<>'done')  as windows_would_reprocess    -- 1
  from raw.sync_window where stream='dispatch_load';
rollback;  -- restore the original all-'done' state

-- Live re-run evidence (executed 2026-06-20): reprocessing only the pending window left
--   loads_after_resume = 5926, windows_done = 54  → no duplication.
