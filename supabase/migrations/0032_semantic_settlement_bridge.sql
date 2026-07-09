-- 0032_semantic_settlement_bridge — internal bridge surfaces (security_invoker).
--
-- INTERNAL-ONLY, ALL OF THEM: these views carry Mackays selling prices (sell_value), the
-- sell-vs-settlement variance, and Mackays revenue — none of which may enter grower surfaces or the
-- grower MCP. No grower_* prefix, no grower-own policy. security_invoker over
-- core.fact_settlement_bridge / core.fact_revenue_charge, whose RLS is fail-closed to internal
-- (is_internal_claim, 0031): an internal claim sees everything; a grower JWT sees ZERO rows.
-- Names are already denormalised on the facts (raw.ft_entity / core.dim_gp_charge carry no
-- authenticated grant), so no view joins an ungranted table.
--
-- variance on the aggregates = Σ row variance — i.e. computed over MATCHED rows only (rows where
-- both sell_value and grower_gross exist). sell_value / grower_gross sums are whole-population
-- (sum() skips nulls, never coalesces).

-- ── By grower ────────────────────────────────────────────────────────────────
create or replace view semantic.settlement_bridge_by_grower
  with (security_invoker = true) as
select
  consignor_id, grower_code, grower_name,
  count(*)                          as detail_rows,
  count(distinct dispatch_load_id)  as load_count,
  round(sum(box_quantity), 0)       as boxes,
  round(sum(sell_value), 2)         as sell_value,
  round(sum(grower_gross), 2)       as grower_gross,
  round(sum(variance), 2)           as variance,          -- matched rows only
  round(sum(grower_gross) filter (where match_tier = 'product_exact'), 2) as product_exact_gross,
  round(sum(total_deductions), 2)   as total_deductions,
  round(sum(gst_total), 2)          as gst_total,
  round(sum(grower_net), 2)         as grower_net,
  round(sum(mackays_revenue), 2)    as mackays_revenue    -- NULL until the revenue-class checkpoint
from core.fact_settlement_bridge
group by consignor_id, grower_code, grower_name;
grant select on semantic.settlement_bridge_by_grower to authenticated, cube_readonly;
comment on view semantic.settlement_bridge_by_grower is
  'Sell-side vs grower settlement per grower (schedule consignor). INTERNAL-ONLY — selling prices; security_invoker → grower JWT sees 0 rows.';

-- ── By product ───────────────────────────────────────────────────────────────
create or replace view semantic.settlement_bridge_by_product
  with (security_invoker = true) as
select
  product_id,
  count(*)                          as detail_rows,
  count(distinct dispatch_load_id)  as load_count,
  round(sum(box_quantity), 0)       as boxes,
  round(sum(sell_value), 2)         as sell_value,
  round(sum(grower_gross), 2)       as grower_gross,
  round(sum(variance), 2)           as variance,
  round(sum(grower_gross) filter (where match_tier = 'product_exact'), 2) as product_exact_gross,
  round(sum(total_deductions), 2)   as total_deductions,
  round(sum(gst_total), 2)          as gst_total,
  round(sum(grower_net), 2)         as grower_net,
  round(sum(mackays_revenue), 2)    as mackays_revenue
from core.fact_settlement_bridge
group by product_id;
grant select on semantic.settlement_bridge_by_product to authenticated, cube_readonly;
comment on view semantic.settlement_bridge_by_product is
  'Sell-side vs grower settlement per product. INTERNAL-ONLY; security_invoker → grower JWT sees 0 rows.';

-- ── By customer (the settlement detail''s consignee = buyer) ──────────────────
create or replace view semantic.settlement_bridge_by_customer
  with (security_invoker = true) as
select
  consignee_id, consignee_name,
  count(*)                          as detail_rows,
  count(distinct dispatch_load_id)  as load_count,
  round(sum(box_quantity), 0)       as boxes,
  round(sum(sell_value), 2)         as sell_value,
  round(sum(grower_gross), 2)       as grower_gross,
  round(sum(variance), 2)           as variance,
  round(sum(grower_gross) filter (where match_tier = 'product_exact'), 2) as product_exact_gross,
  round(sum(total_deductions), 2)   as total_deductions,
  round(sum(gst_total), 2)          as gst_total,
  round(sum(grower_net), 2)         as grower_net,
  round(sum(mackays_revenue), 2)    as mackays_revenue
from core.fact_settlement_bridge
group by consignee_id, consignee_name;
grant select on semantic.settlement_bridge_by_customer to authenticated, cube_readonly;
comment on view semantic.settlement_bridge_by_customer is
  'Sell-side vs grower settlement per customer (consignee/buyer). INTERNAL-ONLY; security_invoker → grower JWT sees 0 rows.';

-- ── Mackays fresh revenue (streams 1 + 2a) ───────────────────────────────────
-- Named _fresh deliberately: third-party ripening (2b) and value-added (3) join later as separate
-- sources. Grain: month × revenue_class × charge × grower × customer. Product is NOT available at
-- charge grain (a charge applies to a load, not a product line) — product-level Mackays revenue
-- lives on settlement_bridge_by_product. EMPTY until dim_gp_charge.revenue_class is marked
-- (checkpoint) and core.refresh_fact_revenue_charge() re-runs.
create or replace view semantic.mackays_revenue_fresh
  with (security_invoker = true) as
select
  (date_trunc('month', payable_on))::date as month,
  revenue_class,
  charge_name,
  consignor_id, grower_code, grower_name,
  consignee_id as customer_id, consignee_name as customer_name,
  count(*)                as application_count,
  round(sum(amount), 2)   as revenue,
  round(sum(gst), 2)      as gst
from core.fact_revenue_charge
group by 1, 2, 3, 4, 5, 6, 7, 8;
grant select on semantic.mackays_revenue_fresh to authenticated, cube_readonly;
comment on view semantic.mackays_revenue_fresh is
  'Mackays revenue streams 1 (commission) + 2a (ripening on marketed loads) by month/class/charge/grower/customer. EMPTY until the revenue-class checkpoint marking. INTERNAL-ONLY; security_invoker → grower JWT sees 0 rows.';
