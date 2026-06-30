// CSV structure analyzer for Bold/SSRS report exports. Read-only.
// Usage: node --experimental-strip-types analyze.ts "<path-to-csv>"
import { readFileSync } from 'node:fs';

function parseCSV(text: string): string[][] {
  // strip BOM
  text = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const path = process.argv[2];
const rows = parseCSV(readFileSync(path, 'utf8')).filter((r) => r.some((c) => c.trim() !== ''));

// field-count histogram
const hist: Record<number, number> = {};
for (const r of rows) hist[r.length] = (hist[r.length] || 0) + 1;
console.log('FIELD-COUNT HISTOGRAM:', JSON.stringify(hist));
console.log('TOTAL non-empty rows:', rows.length);

const maxLen = Math.max(...rows.map((r) => r.length));
console.log('MAX columns:', maxLen);

// Header = first row
console.log('\nHEADER:', JSON.stringify(rows[0]));

// For each column index, sum numeric values across rows that look like detail rows
// (heuristic: count populated cells; treat as numeric if matches number regex)
const numRe = /^-?\d+(\.\d+)?$/;
console.log('\nPER-COLUMN: populated count + numeric sum (all rows excl header)');
for (let c = 0; c < maxLen; c++) {
  let pop = 0, numCnt = 0, sum = 0;
  for (let i = 1; i < rows.length; i++) {
    const v = (rows[i][c] ?? '').trim();
    if (v !== '') { pop++; if (numRe.test(v)) { numCnt++; sum += Number(v); } }
  }
  const name = rows[0][c] ?? `col${c}`;
  console.log(`  [${c}] ${name.padEnd(28)} pop=${String(pop).padStart(5)} numeric=${String(numCnt).padStart(5)} sum=${numCnt ? sum.toFixed(2) : '-'}`);
}

// Show last 3 rows verbatim (grand totals)
console.log('\nLAST 3 ROWS:');
for (const r of rows.slice(-3)) console.log(' ', JSON.stringify(r));
