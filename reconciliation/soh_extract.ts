// Stock On Hand.csv — pallet-level (14-column) table: [6]=pallet_no, [7]=status, [9]=box_count.
// pallet_no is non-unique in ft_pallet (a phantom duplicate row may carry null box_count), so
// reconcile with EXISTS scoped to consignee = MM Larapinta and box_count = report box.
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
const rows = parseCSV(readFileSync('bold/Stock On Hand.csv','utf8'));
const pairs: [string,number][] = [];
for (const r of rows) {
  if (r.length !== 14) continue;
  const pn = (r[6]||'').trim();
  const box = (r[9]||'').trim();
  if (/^\d+$/.test(pn) && /^\d+(\.\d+)?$/.test(box)) pairs.push([pn, Number(box)]);
}
const total = pairs.reduce((s,[,b])=>s+b,0);
process.stderr.write(`pallet-detail rows=${pairs.length} total_box=${total}\n`);
const vals = pairs.map(([pn,b])=>`('${pn}',${b})`).join(',');
const MMLAR = '0191e996-93b9-a95a-8b44-4a8f8182781e';
console.log(`with rpt(pallet_no,box) as (values ${vals}),
m as (
  select rpt.pallet_no, rpt.box,
    exists(select 1 from raw.ft_pallet p where p.pallet_no=rpt.pallet_no and p.consignee_id='${MMLAR}') present,
    exists(select 1 from raw.ft_pallet p where p.pallet_no=rpt.pallet_no and p.consignee_id='${MMLAR}' and p.box_count=rpt.box) box_ok
  from rpt
)
select count(*) rpt_pallets, sum(box) rpt_boxes,
  sum(case when present then 1 else 0 end) present_in_wh,
  sum(case when box_ok then 1 else 0 end) box_exact_match,
  sum(case when box_ok then box else 0 end) box_exact_sum,
  sum(case when not present then 1 else 0 end) missing
from m;`);
