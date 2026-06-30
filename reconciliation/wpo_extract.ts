// Weekly Purchase Order Summary (Sales).csv extractor.
// Order rows: [3]=po_no, [4]=scheduled_delivery, [5]=latest qty, [6]=price, [7]=version.
// Build (po_no, qty) pairs (order rows only, i.e. [3] populated) and validate vs warehouse po_no.
import { readFileSync } from 'node:fs';
function parseCSV(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const rows: string[][] = []; let f = '', row: string[] = [], q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(f); f=''; }
      else if (c === '\r') {} else if (c === '\n') { row.push(f); rows.push(row); row=[]; f=''; } else f += c; } }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const rows = parseCSV(readFileSync('bold/Weekly Purchase Order Summary (Sales).csv','utf8'));
const orders: [string,number][] = [];
let totalQty = 0;
for (let i=1;i<rows.length;i++){
  const r = rows[i];
  const po = (r[3]||'').trim();
  const qty = (r[5]||'').trim();
  if (po !== '' && /^\d+(\.\d+)?$/.test(qty)) { orders.push([po, Number(qty)]); totalQty += Number(qty); }
}
process.stderr.write(`order rows=${orders.length} total_latest_qty=${totalQty}\n`);
const vals = orders.map(([po,q])=>`('${po.replace(/'/g,"''")}',${q})`).join(',');
console.log(`with rpt(po_no,qty) as (values ${vals})
select count(*) rpt_orders, sum(rpt.qty) rpt_qty,
  count(d.po_no) matched_loads,
  sum(case when d.po_no is not null then 1 else 0 end) present,
  sum(d.stock_boxes) wh_stock_boxes_sum,
  sum(case when d.stock_boxes = rpt.qty then 1 else 0 end) qty_eq_stockboxes
from rpt left join lateral (
  select po_no, stock_boxes from raw.ft_dispatch_load d2 where d2.po_no = rpt.po_no limit 1
) d on true;`);
