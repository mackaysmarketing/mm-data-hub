-- SOH-Cons_Summary_Truganina.csv — supporting scope queries
-- Report = Stock On Hand, Consignment Summary, for MM Truganina (MMTRU), as of 2026-07-01 10:00.
-- Headline reconciled at pallet grain (see soh-cons-truganina_pallet-validation.sql): 425 pallets / 30957 boxes, all exact.

-- (1) Confirm the report destination "Truganina" = MMTRU; loads carry MMTRU's consignee_id role key.
select id, code, org_name from raw.ft_entity
where consignee_id = '0191f981-c9f7-87de-5ef6-ebcc669bbc96';   -- → MMTRU "MM Truganina"

-- (2) Independent warehouse-side derivation: pallets consigned to MMTRU with a pickup date in the
--     report window, by (frozen) load state. Yields ~1593 pallets — a superset of the 425 "on hand",
--     because "currently held at the DC, not yet dispatched onward" is a LIVE operational state the
--     frozen warehouse snapshot does not model as a single flag. The authoritative reconciliation is
--     therefore the pallet-list validation, which matches all 425 report pallets box-for-box.
select s.name state_name, count(*) pallets, sum(p.box_count) boxes
from raw.ft_pallet p
join raw.ft_dispatch_load d on d.id = p.dispatch_load_id
left join raw.ft_dispatch_load_state s on s.id = d.state_id
where p.consignee_id = '0191f981-c9f7-87de-5ef6-ebcc669bbc96'
  and d.scheduled_pickup_on::date between '2026-06-24' and '2026-06-30'
group by s.name order by pallets desc;
