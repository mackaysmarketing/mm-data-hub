-- 0007_core_load_box_reconciliation — per-load box reconciliation.
-- Reconciles each load's stock_boxes against the sum of its pallets' box_count, and
-- surfaces the null-box_count rate (box_count is frequently null upstream). reconcile.ts
-- reads this view, flags |delta| > tolerance, and writes a report.

create or replace view core.load_box_reconciliation as
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

comment on view core.load_box_reconciliation is 'Per-load: load.stock_boxes vs sum(pallet.box_count), with null-box_count counts. box_count_delta = stock_boxes - sum(box_count).';
