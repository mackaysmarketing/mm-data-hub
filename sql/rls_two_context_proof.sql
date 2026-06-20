-- RLS isolation proof for semantic.grower_dispatch_detail.
-- Run against the hub as a role that can `set role authenticated` (e.g. postgres/service).
-- Each block is its own transaction; `set local` resets at COMMIT so no role/claim leaks.
--
-- Identity is read from app_metadata (server-controlled; a grower cannot self-set it).
-- Proven 2026-06-20 against data_hub (uqzfkhsdyeokwnkpcxui) with:
--   A = 0191e996-93b7-fcd1-170e-87c6aa517087  (13,281 rows)
--   B = 0191f981-c9dc-4203-4f1b-3e9c5f5758d3  ( 7,631 rows)

-- ── Context A: sees only A's rows, none of B's ───────────────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"role":"authenticated","app_metadata":{"consignor_id":"0191e996-93b7-fcd1-170e-87c6aa517087"}}', true);
  select
    count(*)                                                                      as visible_rows,
    count(distinct grower_key)                                                    as distinct_growers,
    count(*) filter (where grower_key = '0191f981-c9dc-4203-4f1b-3e9c5f5758d3')   as rows_visible_for_B
  from semantic.grower_dispatch_detail;
  -- RESULT: 13281 | 1 | 0
commit;

-- ── Context B: sees only B's rows, none of A's ───────────────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"role":"authenticated","app_metadata":{"consignor_id":"0191f981-c9dc-4203-4f1b-3e9c5f5758d3"}}', true);
  select
    count(*)                                                                      as visible_rows,
    count(distinct grower_key)                                                    as distinct_growers,
    count(*) filter (where grower_key = '0191e996-93b7-fcd1-170e-87c6aa517087')   as rows_visible_for_A
  from semantic.grower_dispatch_detail;
  -- RESULT: 7631 | 1 | 0
commit;

-- ── No claim: sees nothing ───────────────────────────────────────────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  select count(*) as visible_rows from semantic.grower_dispatch_detail;   -- RESULT: 0
commit;

-- ── Legit internal via app_metadata.is_internal: sees everything ─────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"is_internal":true}}', true);
  select count(*) as visible_rows, count(distinct grower_key) as growers
  from semantic.grower_dispatch_detail;   -- RESULT: 38796 | 35
commit;

-- ── ATTACK: forged TOP-LEVEL is_internal + another grower's id → MUST be 0 ────
-- A grower can only ever influence top-level / user_metadata claims, never app_metadata.
-- The claim helpers read app_metadata ONLY, so this self-asserted escalation is ignored.
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"role":"authenticated","consignor_id":"0191f981-c9dc-4203-4f1b-3e9c5f5758d3","is_internal":true}', true);
  select count(*) as visible_rows from semantic.grower_dispatch_detail;   -- RESULT: 0 (was 38796 pre-0010)
commit;

-- ── Malformed app_metadata claim fails CLOSED (0 rows, no 22P02) ─────────────
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"role":"authenticated","app_metadata":{"consignor_id":"not-a-uuid","is_internal":"maybe"}}', true);
  select count(*) as visible_rows from semantic.grower_dispatch_detail;   -- RESULT: 0
commit;
