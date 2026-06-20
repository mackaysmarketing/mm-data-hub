-- 0005_raw_sync_window — loader bookkeeping. Makes the windowed backfill resumable.
-- A window flips to 'done' only after its upsert commits; the backfill skips 'done'
-- windows on restart. Re-running a non-done window is safe (idempotent upsert on id).

create table if not exists raw.sync_window (
  stream         text        not null,            -- 'dispatch_load' | 'pallet'
  window_start   timestamptz not null,
  window_end     timestamptz not null,
  status         text        not null default 'pending',  -- pending | running | done | error
  rows_seen      integer,
  rows_upserted  integer,
  rows_excluded  integer,                          -- test-consignor drops at pull
  error          text,
  started_at     timestamptz,
  finished_at    timestamptz,
  primary key (stream, window_start)
);

comment on table raw.sync_window is 'Per-window loader state for resumable, idempotent backfill.';
