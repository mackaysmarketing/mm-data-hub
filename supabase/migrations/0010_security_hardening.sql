-- 0010_security_hardening — close the adversarial-audit findings.
--
-- (1) RLS claim source: read consignor_id / is_internal from `app_metadata`, the
--     SERVER-controlled JWT namespace a grower cannot self-set (Supabase only lets users
--     edit user_metadata, never app_metadata or top-level claims). Previously these read
--     top-level claims, which a misconfigured upstream signer could let a grower forge —
--     a forged is_internal would OR past all tenant scoping (audit: HIGH).
-- (2) Safe casts: a malformed consignor_id / is_internal no longer raises 22P02 and aborts
--     the grower's query; it fails CLOSED to null/false (audit: low / availability).
-- (3) core.load_box_reconciliation gets security_invoker so it stays RLS-safe even if it is
--     ever granted to authenticated (audit: low / latent).

-- ── Claim helpers (app_metadata, fail-closed) ────────────────────────────────
create or replace function semantic.current_consignor_id() returns uuid
language plpgsql stable set search_path = '' as $func$
declare claims text; val text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return null; end if;
  val := nullif(claims::jsonb -> 'app_metadata' ->> 'consignor_id', '');
  if val is null then return null; end if;
  begin
    return val::uuid;            -- malformed uuid -> null (fail closed), never 22P02
  exception when others then
    return null;
  end;
end $func$;

create or replace function semantic.is_internal_claim() returns boolean
language plpgsql stable set search_path = '' as $func$
declare claims text; val text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return false; end if;
  val := lower(nullif(claims::jsonb -> 'app_metadata' ->> 'is_internal', ''));
  return val in ('true', 't', '1', 'yes');   -- only explicit truthy app_metadata flag; else false
end $func$;

comment on function semantic.current_consignor_id() is 'Grower identity from JWT claim app_metadata.consignor_id (server-controlled; fail-closed).';
comment on function semantic.is_internal_claim() is 'True only when app_metadata.is_internal is truthy (server-controlled; grower cannot self-assert).';

-- ── Reconciliation view: RLS-safe even if granted to authenticated later ─────
create or replace view core.load_box_reconciliation
  with (security_invoker = true) as
select
  d.id                                                   as dispatch_load_id,
  d.load_no,
  d.consignor_id,
  d.actual_pickup_on,
  d.order_type,
  d.stock_boxes                                          as load_stock_boxes,
  count(p.id)                                            as pallet_count,
  count(p.box_count)                                     as pallets_with_box_count,
  count(*) filter (where p.id is not null
                     and p.box_count is null)            as pallets_null_box_count,
  coalesce(sum(p.box_count), 0)                          as pallet_box_count_sum,
  coalesce(sum(p.expected_box_count), 0)                 as pallet_expected_box_sum,
  d.stock_boxes - coalesce(sum(p.box_count), 0)          as box_count_delta
from raw.ft_dispatch_load d
left join raw.ft_pallet p on p.dispatch_load_id = d.id
group by d.id, d.load_no, d.consignor_id, d.actual_pickup_on, d.order_type, d.stock_boxes;

comment on view core.load_box_reconciliation is 'Per-load: load.stock_boxes vs sum(pallet.box_count), with null-box_count counts. security_invoker.';
