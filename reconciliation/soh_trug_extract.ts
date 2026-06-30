// Extract pallet_no + qty + report-date + grower from SOH Truganina CSV, emit SQL.
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
const rows = parseCSV(readFileSync('bold/SOH-Cons_Summary_Truganina.csv','utf8'));
const pairs: [string,number,string][] = [];
for (let i=1;i<rows.length;i++){ const r=rows[i]; const pn=(r[2]||'').trim(); const qty=(r[9]||'').trim(); const dt=(r[6]||'').trim();
  if (/^\d+$/.test(pn) && /^\d+$/.test(qty)) pairs.push([pn, Number(qty), dt]); }
process.stderr.write(`detail pallets=${pairs.length}\n`);
const vals = pairs.map(([pn,q,dt])=>`('${pn}',${q},'${dt}')`).join(',');
console.log(`with rpt(pallet_no,qty,rptdate) as (values ${vals})
select rpt.rptdate, count(*) rpt_pallets, sum(rpt.qty) rpt_boxes,
       count(p.pallet_no) matched, sum(case when p.pallet_no is null then 1 else 0 end) missing
from rpt left join raw.ft_pallet p on p.pallet_no = rpt.pallet_no
group by rpt.rptdate order by rpt.rptdate;`);
