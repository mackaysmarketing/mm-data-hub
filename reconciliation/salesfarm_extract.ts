// Sales - by farm.csv — reconcile at LOAD grain by load_no [4] (load-unique), de-fanned.
// Report cols: [4]=load_no [5]=order_no [9]=pickup [13]=box-qty [14]=qty [15]=amount$ [16]=weight
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
const num = (s:string)=> (/^-?\d+(\.\d+)?$/.test((s||'').trim()) ? Number((s||'').trim()) : 0);
const rows = parseCSV(readFileSync('bold/Sales - by farm.csv','utf8'));

const byLoad: Record<string, {qty:number,box:number,wt:number,amt:number}> = {};
let tQty=0,tBox=0,tWt=0,tAmt=0,lines=0,noLoad=0;
for (let i=1;i<rows.length;i++){
  const r=rows[i];
  const loadNo=(r[4]||'').trim();
  const qty=num(r[14]), box=num(r[13]), wt=num(r[16]), amt=num(r[15]);
  tQty+=qty; tBox+=box; tWt+=wt; tAmt+=amt; lines++;
  if (loadNo===''){ noLoad++; continue; }
  const o=byLoad[loadNo] ??= {qty:0,box:0,wt:0,amt:0};
  o.qty+=qty; o.box+=box; o.wt+=wt; o.amt+=amt;
}
const loads=Object.keys(byLoad);
process.stderr.write(`lines=${lines} distinct load_no=${loads.length} noLoad=${noLoad}\n`);
process.stderr.write(`report totals: qty=${tQty} box=${tBox} weight=${tWt.toFixed(2)} amount=${tAmt.toFixed(2)}\n`);

const esc=(s:string)=>s.replace(/'/g,"''");
const vals=loads.map(l=>`('${esc(l)}',${byLoad[l].qty},${byLoad[l].box},${byLoad[l].wt.toFixed(3)})`).join(',');
console.log(`with rpt(load_no,qty,box,wt) as (values ${vals}),
wh as (
  select d.load_no,
         max(d.stock_boxes) stock_boxes,
         max(d.reconsigned_boxes) recon_boxes,
         sum(p.box_count) box_sum,
         sum(p.net_weight_value) netwt
  from raw.ft_dispatch_load d
  left join raw.ft_pallet p on p.dispatch_load_id=d.id
  where d.load_no in (select load_no from rpt)
  group by d.load_no
)
select count(*) rpt_loads,
       sum(rpt.qty) rpt_qty, round(sum(rpt.wt)) rpt_wt,
       count(wh.load_no) matched,
       sum(wh.stock_boxes) wh_stock, sum(wh.recon_boxes) wh_recon,
       sum(wh.stock_boxes)+sum(wh.recon_boxes) wh_stock_plus_recon,
       round(sum(wh.netwt)) wh_netwt,
       sum(case when wh.load_no is null then 1 else 0 end) missing,
       sum(case when (coalesce(wh.stock_boxes,0)+coalesce(wh.recon_boxes,0)) = rpt.qty then 1 else 0 end) qty_eq_stock_plus_recon,
       sum(case when wh.stock_boxes = rpt.qty then 1 else 0 end) qty_eq_stock
from rpt left join wh on wh.load_no = rpt.load_no;`);
