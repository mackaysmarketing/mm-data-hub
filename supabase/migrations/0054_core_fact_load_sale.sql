-- 0054_core_fact_load_sale — FIX 5 + FIX 7.2 of the grower-portal fix pack (2026-07-18):
-- retailer identity on grower-readable sales data (Tim-approved), at LOAD × CUSTOMER grain.
--
-- WHY A CORE FACT (not a runtime join): the sources that know the customer — core.fact_customer_invoice
-- (internal-only, the customer book) and core.crosswalk_customer_retail (internal-only, consignee →
-- retailer group) — must NEVER be readable by a grower token, and every grower surface here is a
-- security_invoker view (the caller's own rights apply to every relation it touches). So the
-- grower-safe projection is DENORMALISED AT BUILD TIME by service_role — exactly the 0020 pattern
-- ("load_no/dispatch_load_id were denormalised at build time") — into a fact that carries only what
-- a grower may see: WHICH RETAILER GROUP each of their loads was invoiced to, and for how much.
-- consignee_name is deliberately NOT carried (customer-book sensitivity, 0040 posture); consignee_id
-- is kept as an opaque grain/join key — the name lives only in internal-only core.dim_customer.
--
-- Grain: (dispatch_load_id, consignee_id) — one row per customer a load was invoiced to (multi-
-- customer loads = one row each, per the FIX 5 spec). consignee_id is null on 141 invoices →
-- the grain guard is UNIQUE NULLS NOT DISTINCT (the 0042 pattern), not a PK.
-- Amounts: coalesce(ns_amount, amount_value) — the AR anchor rule (0040); CN rows subtract
-- (credit notes), PI/SI/DR add (DR = verified positive debit notes, 0047).
-- RLS anchor = the LOAD's consignor (SPEC §9.1 grower attribution), the 7th grower-scoped relation
-- (0026 six + this): mm-hub set policy + additive Auth0 policy (0050) + cube read-all (0012 mirror).
-- rls_posture.ts / rls_multi_farm_proof.ts / auth0_rls_proof.ts pinned sets are extended in the
-- same change (they hard-pin the grower-scoped relation set — that is the point).

create table if not exists core.fact_load_sale (
  consignor_id        uuid,          -- the LOAD's consignor (RLS anchor; SPEC §9.1)
  dispatch_load_id    uuid not null, -- raw.ft_dispatch_load.id
  load_no             text,
  consignee_id        uuid,          -- opaque customer key (name stays internal-only; null on 141 invoices)
  retailer_group      text,          -- woolworths / coles / aldi / other / internal (0045 crosswalk); null = unmapped (surfaced)
  state_code          text,          -- destination state from the crosswalk
  invoice_count       integer,
  gross_amount        numeric,       -- Σ signed coalesce(ns_amount, amount_value); CN negative
  share_of_load_gross numeric,       -- this customer's share of the load total (0..1; null when load total = 0)
  first_invoice_date  date,
  last_invoice_date   date,
  _built_at           timestamptz not null default now()
);
create unique index if not exists ux_fact_load_sale_grain
  on core.fact_load_sale (dispatch_load_id, consignee_id) nulls not distinct;
create index if not exists ix_fact_load_sale_consignor on core.fact_load_sale (consignor_id);
comment on table core.fact_load_sale is
  'Invoiced customer sales per dispatch load × customer (grower-readable retailer projection of the internal AR book). retailer_group via core.crosswalk_customer_retail at BUILD time; consignee_name deliberately not carried. consignor_id = load consignor (RLS anchor). Grower surface: semantic.grower_load_sale (0055).';

-- ── Idempotent rebuild (service_role/owner; run after ar:core + insight:core) ─────────────────
create or replace function core.refresh_fact_load_sale() returns integer
language plpgsql set search_path = '' as $func$
declare n integer;
begin
  delete from core.fact_load_sale;
  insert into core.fact_load_sale (
    consignor_id, dispatch_load_id, load_no, consignee_id, retailer_group, state_code,
    invoice_count, gross_amount, share_of_load_gross, first_invoice_date, last_invoice_date, _built_at
  )
  with cust as (
    select
      d.consignor_id,
      ci.dispatch_load_id,
      max(ci.load_no)        as load_no,
      ci.consignee_id,
      max(cw.retailer_group) as retailer_group,
      max(cw.state_code)     as state_code,
      count(*)::int          as invoice_count,
      sum(case when ci.invoice_type = 'CN' then -1 else 1 end
          * coalesce(ci.ns_amount, ci.amount_value)) as gross_amount,
      min(ci.invoice_date)   as first_invoice_date,
      max(ci.invoice_date)   as last_invoice_date
    from core.fact_customer_invoice ci
    join raw.ft_dispatch_load d on d.id = ci.dispatch_load_id
    left join core.crosswalk_customer_retail cw on cw.consignee_id = ci.consignee_id
    where ci.dispatch_load_id is not null
    group by d.consignor_id, ci.dispatch_load_id, ci.consignee_id
  )
  select
    consignor_id, dispatch_load_id, load_no, consignee_id, retailer_group, state_code,
    invoice_count, round(gross_amount, 2),
    round(gross_amount / nullif(sum(gross_amount) over (partition by dispatch_load_id), 0), 4),
    first_invoice_date, last_invoice_date, now()
  from cust;
  get diagnostics n = row_count;
  return n;
end $func$;
comment on function core.refresh_fact_load_sale() is
  'Idempotent rebuild of core.fact_load_sale from core.fact_customer_invoice × core.crosswalk_customer_retail. Run AFTER ar:core (invoice fact) and insight:core (retailer crosswalk) — wired into ar:core.';
grant execute on function core.refresh_fact_load_sale() to service_role;

-- ── RLS: the standard grower-scoped posture (mm-hub set + additive Auth0 + cube) ──────────────
alter table core.fact_load_sale enable row level security;
grant select on core.fact_load_sale to authenticated, cube_readonly;

drop policy if exists grower_own_load_sale on core.fact_load_sale;
create policy grower_own_load_sale on core.fact_load_sale
  for select to authenticated
  using (consignor_id = any(semantic.current_consignor_ids()) or semantic.is_internal_claim());

drop policy if exists auth0_grower_own_load_sale on core.fact_load_sale;
create policy auth0_grower_own_load_sale on core.fact_load_sale
  for select to authenticated
  using (consignor_id = any(semantic.auth0_consignor_ids()));

drop policy if exists cube_readonly_read_all on core.fact_load_sale;
create policy cube_readonly_read_all on core.fact_load_sale
  for select to cube_readonly using (true);

-- Initial build (fact_customer_invoice + crosswalk_customer_retail are both live).
select core.refresh_fact_load_sale();
