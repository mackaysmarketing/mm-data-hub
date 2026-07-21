-- 0063_portal_activation_remittance_2026 — reset portal activation to the 2026 remittance book
-- (2026-07-22). Tim's rule, verbatim: "The growers that have remittances there are the only ones
-- that should be included in the grower portal", scoped to 2026 ("only use the 2026 files").
--
-- ═══ SOURCE OF TRUTH ══════════════════════════════════════════════════════════════════════════
-- SharePoint, TullyAdmin site:
--   Shared Documents / MBM Admin / 1. New MBM / Remittances / Growers / 2026 / {month} / {pay week}
-- Every one of the 30 pay-week folders in 2026 was enumerated (07.01.2026 → 15.07.2026, Jan–Jul),
-- and every file in them read. One PDF per grower paid that week.
--
-- EXCLUDED as not per-grower remittances: the weekly `Mackays Excel Remittance *.xlsx` working
-- files, the `EXCEL` subfolders, lot/load-adjustment PDFs (e.g. "M5013523 - 467 - LOT ADJUSTMENT
-- BOLINDA.pdf", "RANCH ADJUSTMENT 5011654 - 908.pdf"), and a stray `debug.log`.
-- FOLDED into their farm (separate PDF, same hub consignor — no separate dim_grower row exists):
-- "Rolfe Papaya" → ROLFE, "Mackays Gold Tyne Passionfruit" → MACGT.
--
-- ⚠ The remittance folder is the AUTHORITY here, NOT hub settlement. They agree, which is the
-- point: every borderline name was corroborated independently against core.fact_gp_settlement —
--   SANGH  4 "Sangha Bros" PDFs (18.02, 04.03, 11.03, 18.03) ↔ 4 schedules, last payable 2026-03-18
--   DANDY  1 PDF (08.07.2026)                                ↔ 1 schedule, payable 2026-07-08
--   OBIFW  present Mar/Apr/Jun                               ↔ 7 schedules, last 2026-07-01
--   JUSTE  present Jan–Jul                                   ↔ 11 schedules, last 2026-07-01
--   ALCOC  present Jan–May                                   ↔ 11 schedules, last 2026-05-06
--   LMBBF / GJFLE absent from 2026 entirely                  ↔ 0 schedules in 2026 (last 2025)
-- Plain "Flegler Remittance" resolves to GJFMF: every disambiguated filename says "Mareeba Farm",
-- and GJFMF has 27 schedules in 2026 against GJFLE's 0.
--
-- ═══ THE FOUR PARENTS (Tim's call, 2026-07-22: KEEP ACTIVE) ═══════════════════════════════════
-- MACKF (Mac Farms), LRCOL (L & R Collins), LMBFA (LMB) and GJFLE (G & J Flegler) have NO
-- remittance of their own — settlement lands on their farms — but they are the entities the portal
-- groups by (0058 hierarchy) and logins are often at parent level. Deactivating them would strand
-- a parent-level login while its farms stayed active. They are retained DELIBERATELY as an
-- exception to the rule, not because they were paid.
--
-- ═══ WHAT THIS DOES AND DOES NOT DO ══════════════════════════════════════════════════════════
-- portal_grower_activation feeds exactly ONE display column (semantic.grower_directory.
-- portal_enabled). NO RLS policy anywhere in raw/core/semantic references it. Deactivating a
-- consignor removes it from the portal's directory; it does NOT revoke data access — a token whose
-- Auth0 claim carries that consignor's uuid still reads its dispatch/sales/settlement. Closing that
-- needs the claim-side grower gate in semantic.auth0_consignor_ids() (designed, not built).
--
-- Rows are UPDATED to enabled=false, never deleted — the audit trail (updated_at/updated_by) is
-- the point of the table.

do $$
declare
  v_remittance text[] := array[
    -- the 25 consignors with a 2026 remittance PDF
    'ALCOC','DANDY','GJFMF','JUSTE','LAUGO','LMBCO','LMBEP','LRCLA','LRCTU','MACBO','MACGT',
    'MACRR','MACSD','NOUBC','NOUPA','OBIFW','PRIMO','ROCKR','ROLFE','SANGH','SERAV','SERRA',
    'SLOWE','WADDA','ZONTA'];
  v_parents text[] := array[
    -- retained so parent-level logins / directory grouping keep working (no remittance of their own)
    'GJFLE','LMBFA','LRCOL','MACKF'];
  v_all text[] := v_remittance || v_parents;
  v_code text;
  v_n integer;
  v_enabled integer;
begin
  -- Resolve by CODE, never uuid (the 0059 rule). dim_grower.code is NOT unique — WADDA exists
  -- twice (active "Wadda Plantation" + inactive "Wadda Plantation - Gallaghers") — so every code
  -- must resolve to exactly ONE ACTIVE row, or we stop rather than activate the wrong entity.
  foreach v_code in array v_all loop
    select count(*) into v_n from core.dim_grower g where g.code = v_code and g.is_active;
    if v_n <> 1 then
      raise exception 'code % resolves to % active dim_grower rows (expected exactly 1)', v_code, v_n;
    end if;
  end loop;

  -- Turn OFF everything currently enabled that is not in the target set (keeps the row + trail).
  update core.portal_grower_activation a
     set enabled = false, updated_at = now(), updated_by = 'tim/0063-remittance-2026'
   where a.enabled
     and a.consignor_id not in (
       select g.consignor_id from core.dim_grower g where g.code = any(v_all) and g.is_active);
  get diagnostics v_n = row_count;
  raise notice 'deactivated % consignor(s) with no 2026 remittance', v_n;

  -- Turn ON the target set (insert where absent, re-enable where present).
  insert into core.portal_grower_activation (consignor_id, enabled, updated_at, updated_by)
  select g.consignor_id, true, now(), 'tim/0063-remittance-2026'
  from core.dim_grower g
  where g.code = any(v_all) and g.is_active
  on conflict (consignor_id) do update
    set enabled    = true,
        updated_at = now(),
        updated_by = 'tim/0063-remittance-2026'
    where core.portal_grower_activation.enabled is distinct from true;  -- don't churn unchanged rows

  -- Guard: the enabled set must be exactly the target, no more, no less.
  select count(*) into v_enabled from core.portal_grower_activation where enabled;
  if v_enabled <> array_length(v_all, 1) then
    raise exception 'enabled count % <> target %', v_enabled, array_length(v_all, 1);
  end if;
  if exists (
    select 1 from core.portal_grower_activation a
    join core.dim_grower g on g.consignor_id = a.consignor_id
    where a.enabled and not (g.code = any(v_all) and g.is_active)
  ) then
    raise exception 'an enabled consignor is outside the target set';
  end if;
  -- Nothing test or inactive may ever be portal-enabled.
  if exists (
    select 1 from core.portal_grower_activation a
    join core.dim_grower g on g.consignor_id = a.consignor_id
    where a.enabled and (coalesce(g.is_test, false) or not g.is_active)
  ) then
    raise exception 'a test or inactive consignor is portal-enabled';
  end if;

  raise notice 'portal activation set to % consignors (% with 2026 remittances + % retained parents)',
    v_enabled, array_length(v_remittance, 1), array_length(v_parents, 1);
end $$;

comment on table core.portal_grower_activation is
  'Portal activation per consignor (0059). Curated by internal admins via semantic.set_grower_portal_enabled(); read through semantic.grower_directory.portal_enabled. SEPARATE from core.dim_grower deliberately — dim_grower is rebuilt by refresh_dim_grower() and curated state on a rebuilt dim gets silently reset (the dim_gp_charge.revenue_class lesson). Absence of a row = not activated. 0063: the set is now the 25 consignors with a 2026 remittance in SharePoint TullyAdmin/.../Remittances/Growers/2026 PLUS 4 parent entities (MACKF/LRCOL/LMBFA/GJFLE) retained so parent-level logins keep working.';
