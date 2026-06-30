-- Weekly Purchase Order Summary (Sales).csv — BLOCKED-NEEDS-TIM evidence.
-- The report's headline qty (960) and price (37.68) are ORDER-LINE DEMAND data that the warehouse
-- does NOT land. They live in FreshTrack source tables order / order_version / order_item, reachable
-- from dispatch_load.order_id. The warehouse only lands dispatch_load + pallet (PACKED, not ordered).

-- (A) Run against FreshTrack read-replica (reconciliation/ftq.ts). Proves qty/price source:
--     po_no 0111142923 v1 -> total_box_count=960 (=report qty), price_value=37.68 (=report price).
select dl.po_no, dl.order_no, ov.version_no,
       oi.proposed_quantity, oi.total_box_count, oi.price_value, oi.total_price_value
from public.dispatch_load dl
join public.order_version ov on ov.order_id = dl.order_id
join public.order_item   oi on oi.order_version_id = ov.id
where dl.po_no = '0111142923'
order by ov.version_no, oi.price_value;

-- (B) Run against the warehouse (reconciliation/q.ts). Confirms ordered qty is NOT in dispatch_load:
--     the matched po_no loads are order_type='B', state Open, stock_boxes=0 (not yet packed).
select d.po_no, d.order_no, d.order_type, d.scheduled_delivery_on::date sched_del,
       d.latest_order_version_no ver, d.stock_boxes, d.reconsigned_boxes, s.name state
from raw.ft_dispatch_load d
left join raw.ft_dispatch_load_state s on s.id = d.state_id
where d.po_no in ('0111142923','0111143332','0111142924','0111172811','0111172817','0111142926')
order by d.po_no;
