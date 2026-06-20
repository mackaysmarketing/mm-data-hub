-- RLS two-context isolation proof for semantic.grower_dispatch_detail.
-- Run against the hub as a role that can `set role authenticated` (e.g. postgres/service).
-- Each block is its own transaction; `set local` resets at COMMIT so no role/claim leaks.
--
-- Proven 2026-06-20 against data_hub (uqzfkhsdyeokwnkpcxui) with:
--   A = 0191e996-93b7-fcd1-170e-87c6aa517087  (13,281 rows)
--   B = 0191f981-c9dc-4203-4f1b-3e9c5f5758d3  ( 7,631 rows)
-- (top two growers; substitute any two consignor_ids that have rows.)

-- ── Context A: sees only A's rows, none of B's ───────────────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"role":"authenticated","consignor_id":"0191e996-93b7-fcd1-170e-87c6aa517087"}', true);
  select
    current_user                                                                 as acting_role,
    count(*)                                                                      as visible_rows,
    count(distinct grower_key)                                                    as distinct_growers,
    bool_and(grower_key = '0191e996-93b7-fcd1-170e-87c6aa517087')                 as all_rows_are_A,
    count(*) filter (where grower_key = '0191f981-c9dc-4203-4f1b-3e9c5f5758d3')   as rows_visible_for_B
  from semantic.grower_dispatch_detail;
  -- RESULT: authenticated | 13281 | 1 | true | 0
commit;

-- ── Context B: sees only B's rows, none of A's ───────────────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"role":"authenticated","consignor_id":"0191f981-c9dc-4203-4f1b-3e9c5f5758d3"}', true);
  select
    count(*)                                                                      as visible_rows,
    count(distinct grower_key)                                                    as distinct_growers,
    bool_and(grower_key = '0191f981-c9dc-4203-4f1b-3e9c5f5758d3')                 as all_rows_are_B,
    count(*) filter (where grower_key = '0191e996-93b7-fcd1-170e-87c6aa517087')   as rows_visible_for_A
  from semantic.grower_dispatch_detail;
  -- RESULT: 7631 | 1 | true | 0
commit;

-- ── No consignor_id claim: sees nothing ──────────────────────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  select count(*) as visible_rows from semantic.grower_dispatch_detail;   -- RESULT: 0
commit;

-- ── Internal claim: sees everything (hub staff / service) ─────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims', '{"role":"authenticated","is_internal":true}', true);
  select count(*) as visible_rows, count(distinct grower_key) as growers
  from semantic.grower_dispatch_detail;   -- RESULT: 38796 | 35
commit;
