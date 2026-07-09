// ─────────────────────────────────────────────────────────────────────────────
// Revenue-class marking tool generator (SPRINT chunk 1 checkpoint, interactive form).
//   node --experimental-strip-types scripts/revenue_class_marker.ts
//
// Emits reports/revenue_class_marker_<date>.html — a SELF-CONTAINED page (no network, works from
// a double-click) where Tim marks every settled charge with a revenue class and clicks
// "Generate report" to download a CSV that this repo can wire back into
// core.dim_gp_charge.revenue_class (charge rows keyed by charge_id; the no-charge_id applied rows
// keyed by account_code — those become account-code rules, the dim cannot carry them).
// Only ct_scope 'WH - Ripening' is PRE-selected (per SPRINT); nothing else is guessed.
// Progress autosaves to localStorage so the page can be closed and resumed.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { makePool } from '../src/lib/db.ts';
import { isMain, log } from '../src/lib/util.ts';

const RIPENING_ANCHOR = 6379588.03; // ct_scope 'WH - Ripening' settled deductible sum (proof-6 tie)

export async function buildMarker(): Promise<string> {
  const pool = makePool();
  const c = await pool.connect();
  try {
    const charges = (await c.query(
      `select dgc.charge_id, dgc.name, dgc.ct_scope, dgc.ct_code, dgc.account_code,
              dgc.category, dgc.subcategory,
              count(ca.id)::int as applied_rows,
              round(sum(ca.total_amount_value), 2)::float8 as applied_dollars,
              (dgc.ct_scope = 'WH - Ripening') as proposed_ripening
       from core.dim_gp_charge dgc
       join raw.ft_charge_applied ca on ca.charge_id = dgc.charge_id
       where ca.gp_schedule_id is not null and ca.is_deductible
       group by dgc.charge_id, dgc.name, dgc.ct_scope, dgc.ct_code, dgc.account_code,
                dgc.category, dgc.subcategory
       order by dgc.category, sum(ca.total_amount_value) desc`)).rows;

    const accts = (await c.query(
      `select coalesce(nullif(btrim(ca.account_code), ''), '(blank)') as account_code,
              min(ca.text_1) as sample_label,
              count(*)::int as applied_rows,
              round(sum(ca.total_amount_value), 2)::float8 as applied_dollars
       from raw.ft_charge_applied ca
       where ca.gp_schedule_id is not null and ca.is_deductible and ca.charge_id is null
       group by 1 order by sum(ca.total_amount_value) desc`)).rows;

    const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
    const html = TEMPLATE
      .replace('__CHARGES__', safeJson(charges))
      .replace('__ACCTS__', safeJson(accts))
      .replace('__ANCHOR__', String(RIPENING_ANCHOR))
      .replace(/__DATE__/g, new Date().toISOString().slice(0, 10));

    mkdirSync('reports', { recursive: true });
    const path = `reports/revenue_class_marker_${new Date().toISOString().slice(0, 10)}.html`;
    writeFileSync(path, html, 'utf8');
    log(`marker written: ${path} (${charges.length} charges, ${accts.length} account-code groups)`);
    return path;
  } finally {
    c.release();
    await pool.end();
  }
}

// The page. Embedded script uses NO backticks / NO ${} (kept template-literal-safe).
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mackays revenue classification — __DATE__</title>
<style>
  :root{
    --commission:#1a7f4b; --ripening:#0e7490; --other_service:#1d4ed8;
    --cost_recovery:#b45309; --pass_through:#6b7280; --na:#9ca3af;
    --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --bg:#f8fafc;
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 "Segoe UI",Arial,sans-serif;color:var(--ink);background:var(--bg)}
  header{background:#0f2b46;color:#fff;padding:18px 24px}
  header h1{margin:0 0 6px;font-size:20px}
  header p{margin:4px 0;color:#cbd5e1;max-width:1000px}
  header b{color:#fff}
  .legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .legend span{padding:3px 10px;border-radius:12px;font-size:12px;color:#fff}
  .wrap{max-width:1240px;margin:0 auto;padding:16px 24px 120px}
  .defs{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:14px 0;font-size:13px}
  .defs td{padding:3px 10px 3px 0;vertical-align:top}
  .defs .k{font-weight:600;white-space:nowrap}
  .toolbar{position:sticky;top:0;z-index:20;background:#fff;border:1px solid var(--line);border-radius:8px;
           padding:10px 14px;margin:10px 0;display:flex;gap:14px;align-items:center;flex-wrap:wrap;
           box-shadow:0 2px 6px rgba(0,0,0,.06)}
  .toolbar input[type=search]{flex:1;min-width:220px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px}
  .fbtn{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
  .fbtn.on{background:#0f2b46;color:#fff;border-color:#0f2b46}
  .section{background:#fff;border:1px solid var(--line);border-radius:8px;margin:14px 0;overflow:hidden}
  .sech{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#eef2f7;cursor:pointer;flex-wrap:wrap}
  .sech h2{margin:0;font-size:15px}
  .sech .sub{color:var(--muted);font-size:12.5px}
  .sech select{margin-left:auto;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-size:12.5px}
  .row{display:flex;align-items:center;gap:12px;padding:9px 14px;border-top:1px solid var(--line)}
  .row.hidden{display:none}
  .row .info{flex:1;min-width:280px}
  .row .nm{font-weight:600}
  .row .meta{color:var(--muted);font-size:12px;margin-top:1px}
  .row .num{width:170px;text-align:right;font-variant-numeric:tabular-nums}
  .row .num .d{font-weight:600}
  .row .num .r{color:var(--muted);font-size:12px}
  .chips{display:flex;gap:4px;flex-wrap:nowrap}
  .chip{padding:4px 9px;border-radius:12px;border:1.5px solid var(--line);background:#fff;cursor:pointer;
        font-size:12px;color:var(--muted);white-space:nowrap}
  .chip:hover{border-color:#94a3b8}
  .chip.sel{color:#fff;border-color:transparent}
  .clr{border:none;background:none;color:#cbd5e1;cursor:pointer;font-size:14px;padding:2px 4px}
  .clr:hover{color:#ef4444}
  .pp{font-size:10.5px;background:#ccfbf1;color:#0e7490;border-radius:8px;padding:1px 6px;margin-left:6px}
  footer{position:fixed;left:0;right:0;bottom:0;background:#0f2b46;color:#fff;padding:10px 24px;z-index:30;
         display:flex;gap:22px;align-items:center;flex-wrap:wrap;box-shadow:0 -3px 8px rgba(0,0,0,.2)}
  footer .stat b{font-size:15px}
  footer .stat{font-size:12.5px;color:#cbd5e1}
  footer .stat b{color:#fff}
  .gen{margin-left:auto;background:#22c55e;border:none;color:#04240f;font-weight:700;font-size:15px;
       padding:11px 22px;border-radius:8px;cursor:pointer}
  .gen:hover{background:#4ade80}
  .reset{background:none;border:1px solid #475569;color:#cbd5e1;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}
  .bar{height:6px;background:#1e3a5f;border-radius:3px;width:180px;overflow:hidden}
  .bar i{display:block;height:100%;background:#22c55e;width:0}
  .tie{font-size:12.5px}
  .tie .ok{color:#4ade80;font-weight:700}
  .tie .off{color:#fbbf24;font-weight:700}
</style>
</head>
<body>
<header>
  <h1>Mackays revenue classification — settled grower-pool charges</h1>
  <p>Mark <b>every line</b> with one class. This decides which charges count as <b>Mackays revenue</b>
     (= commission + ripening + other_service) in the data hub. Your choices save automatically in this
     browser — you can close the page and come back. When done, click <b>Generate report</b> (bottom
     right) and send the downloaded CSV file back to Claude to wire it in.</p>
  <div class="legend">
    <span style="background:var(--commission)">commission</span>
    <span style="background:var(--ripening)">ripening</span>
    <span style="background:var(--other_service)">other_service</span>
    <span style="background:var(--cost_recovery)">cost_recovery</span>
    <span style="background:var(--pass_through)">pass_through</span>
    <span style="background:var(--na)">na</span>
  </div>
</header>
<div class="wrap">
  <div class="defs"><table>
    <tr><td class="k" style="color:var(--commission)">commission</td><td>Mackays' selling commission on grower fruit — revenue.</td></tr>
    <tr><td class="k" style="color:var(--ripening)">ripening</td><td>Ripening fees charged by Mackays' own facilities (Truganina, Ann Rd, Larapinta, QPI, Epping, DBM) — revenue. Lines with ct_scope 'WH - Ripening' are pre-selected; change any that shouldn't count.</td></tr>
    <tr><td class="k" style="color:var(--other_service)">other_service</td><td>Other services Mackays performs itself and charges for (e.g. handling, packing, labelling done in-house) — revenue.</td></tr>
    <tr><td class="k" style="color:var(--cost_recovery)">cost_recovery</td><td>Mackays recovering a cost it paid on the grower's behalf (e.g. third-party freight recharged) — not revenue.</td></tr>
    <tr><td class="k" style="color:var(--pass_through)">pass_through</td><td>Third-party charge passed straight to the grower (industry levies, retailer rebates, inspection fees…) — not revenue.</td></tr>
    <tr><td class="k" style="color:var(--na)">na</td><td>Not applicable — adjustments, corrections, anything that isn't a real charge class.</td></tr>
  </table></div>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Search name / scope / account code…">
    <button class="fbtn on" data-f="all">All</button>
    <button class="fbtn" data-f="unmarked">Unmarked</button>
    <button class="fbtn" data-f="marked">Marked</button>
  </div>
  <div id="sections"></div>
</div>
<footer>
  <div class="stat">Charges<br><b id="pc">0 / 0</b></div>
  <div class="stat">Account codes<br><b id="pa">0 / 0</b></div>
  <div class="bar"><i id="pb"></i></div>
  <div class="stat">Mackays revenue (marked)<br><b id="rev">$0</b></div>
  <div class="stat tie">Ripening marked vs 'WH - Ripening' anchor<br><b id="tie">–</b></div>
  <button class="reset" id="reset">Reset all</button>
  <button class="gen" id="gen">⬇ Generate report (CSV)</button>
</footer>
<script>
"use strict";
var CHARGES = __CHARGES__;
var ACCTS = __ACCTS__;
var ANCHOR = __ANCHOR__;
var CLASSES = ["commission","ripening","other_service","cost_recovery","pass_through","na"];
var CATNAMES = {FR:"FR — Freight", WH:"WH — Warehouse", MD:"MD — Market Deductions",
                MI:"MI — Misc", LA:"LA — Load Adjustment", OTHER:"Other / unclassified",
                ACCT:"Account-code-only lines (no charge record — these become account-code rules)"};
var LSKEY = "revclass_marking___DATE__";

var state = {};
try { state = JSON.parse(localStorage.getItem(LSKEY) || "{}"); } catch (e) { state = {}; }
// pre-propose ripening (SPRINT) unless already decided
CHARGES.forEach(function (ch) {
  var k = "charge:" + ch.charge_id;
  if (!(k in state) && ch.proposed_ripening) state[k] = "ripening";
});

function fmt(n) {
  var neg = n < 0, v = Math.abs(n);
  var s = "$" + v.toLocaleString("en-AU", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  return neg ? "(" + s + ")" : s;
}
function save() { localStorage.setItem(LSKEY, JSON.stringify(state)); }

function rowEl(kind, key, title, meta, rows, dollars, preproposed) {
  var row = document.createElement("div");
  row.className = "row";
  row.dataset.key = kind + ":" + key;
  row.dataset.text = (title + " " + meta).toLowerCase();
  var info = document.createElement("div"); info.className = "info";
  var nm = document.createElement("div"); nm.className = "nm"; nm.textContent = title;
  if (preproposed) {
    var t = document.createElement("span"); t.className = "pp"; t.textContent = "pre-proposed: ripening";
    nm.appendChild(t);
  }
  var mt = document.createElement("div"); mt.className = "meta"; mt.textContent = meta;
  info.appendChild(nm); info.appendChild(mt);
  var num = document.createElement("div"); num.className = "num";
  num.innerHTML = "<div class='d'>" + fmt(dollars) + "</div><div class='r'>" +
                  rows.toLocaleString() + " lines</div>";
  var chips = document.createElement("div"); chips.className = "chips";
  CLASSES.forEach(function (cl) {
    var b = document.createElement("button");
    b.className = "chip"; b.dataset.cl = cl; b.textContent = cl;
    b.onclick = function () { state[row.dataset.key] = cl; save(); paint(row); summary(); };
    chips.appendChild(b);
  });
  var clr = document.createElement("button"); clr.className = "clr"; clr.title = "clear"; clr.textContent = "✕";
  clr.onclick = function () { delete state[row.dataset.key]; save(); paint(row); summary(); };
  chips.appendChild(clr);
  row.appendChild(info); row.appendChild(num); row.appendChild(chips);
  return row;
}

function paint(row) {
  var sel = state[row.dataset.key];
  row.querySelectorAll(".chip").forEach(function (b) {
    var on = b.dataset.cl === sel;
    b.classList.toggle("sel", on);
    b.style.background = on ? "var(--" + b.dataset.cl + ")" : "";
  });
}

var secDefs = [];
["FR","WH","MD","MI","LA","OTHER"].forEach(function (cat) {
  var items = CHARGES.filter(function (c) { return c.category === cat; });
  if (items.length) secDefs.push({cat: cat, items: items, kind: "charge"});
});
secDefs.push({cat: "ACCT", items: ACCTS, kind: "acct"});

var host = document.getElementById("sections");
secDefs.forEach(function (sd) {
  var sec = document.createElement("div"); sec.className = "section";
  var h = document.createElement("div"); h.className = "sech";
  var tot = sd.items.reduce(function (a, i) { return a + i.applied_dollars; }, 0);
  h.innerHTML = "<h2>" + CATNAMES[sd.cat] + "</h2><span class='sub'>" + sd.items.length +
                " lines · " + fmt(tot) + "</span>";
  var bulk = document.createElement("select");
  bulk.innerHTML = "<option value=''>Mark all visible unmarked as…</option>" +
    CLASSES.map(function (c) { return "<option>" + c + "</option>"; }).join("");
  bulk.onclick = function (e) { e.stopPropagation(); };
  bulk.onchange = function () {
    if (!bulk.value) return;
    sec.querySelectorAll(".row").forEach(function (r) {
      if (!r.classList.contains("hidden") && !state[r.dataset.key]) {
        state[r.dataset.key] = bulk.value; paint(r);
      }
    });
    save(); summary(); bulk.value = "";
  };
  h.appendChild(bulk);
  var body = document.createElement("div");
  h.onclick = function () { body.style.display = body.style.display === "none" ? "" : "none"; };
  sd.items.forEach(function (it) {
    var row = sd.kind === "charge"
      ? rowEl("charge", it.charge_id, it.name,
              (it.ct_scope || "(no scope)") + " · ct " + (it.ct_code || "–") + " · acct " +
              (it.account_code || "–") + " · " + (it.subcategory || ""),
              it.applied_rows, it.applied_dollars, it.proposed_ripening)
      : rowEl("acct", it.account_code, "Account " + it.account_code,
              "e.g. " + (it.sample_label || ""), it.applied_rows, it.applied_dollars, false);
    paint(row);
    body.appendChild(row);
  });
  sec.appendChild(h); sec.appendChild(body);
  host.appendChild(sec);
});

var filterMode = "all";
function applyFilter() {
  var q = document.getElementById("q").value.toLowerCase();
  document.querySelectorAll(".row").forEach(function (r) {
    var marked = !!state[r.dataset.key];
    var vis = (!q || r.dataset.text.indexOf(q) >= 0) &&
              (filterMode === "all" || (filterMode === "marked") === marked);
    r.classList.toggle("hidden", !vis);
  });
}
document.getElementById("q").oninput = applyFilter;
document.querySelectorAll(".fbtn").forEach(function (b) {
  b.onclick = function () {
    filterMode = b.dataset.f;
    document.querySelectorAll(".fbtn").forEach(function (x) { x.classList.toggle("on", x === b); });
    applyFilter();
  };
});

function summary() {
  var mc = 0, ma = 0, rev = 0, rip = 0;
  CHARGES.forEach(function (ch) {
    var cl = state["charge:" + ch.charge_id];
    if (cl) { mc++; if (cl === "commission" || cl === "ripening" || cl === "other_service") rev += ch.applied_dollars;
              if (cl === "ripening") rip += ch.applied_dollars; }
  });
  ACCTS.forEach(function (a) {
    var cl = state["acct:" + a.account_code];
    if (cl) { ma++; if (cl === "commission" || cl === "ripening" || cl === "other_service") rev += a.applied_dollars;
              if (cl === "ripening") rip += a.applied_dollars; }
  });
  document.getElementById("pc").textContent = mc + " / " + CHARGES.length;
  document.getElementById("pa").textContent = ma + " / " + ACCTS.length;
  document.getElementById("pb").style.width =
    Math.round(100 * (mc + ma) / (CHARGES.length + ACCTS.length)) + "%";
  document.getElementById("rev").textContent = fmt(rev);
  var d = rip - ANCHOR, tie = document.getElementById("tie");
  tie.innerHTML = fmt(rip) + " vs " + fmt(ANCHOR) + " → " +
    (Math.abs(d) < 0.01 ? "<span class='ok'>exact tie ✓</span>"
                        : "<span class='off'>" + (d > 0 ? "+" : "−") + fmt(Math.abs(d)).replace("$","$") + "</span>");
}
summary();

document.getElementById("reset").onclick = function () {
  if (confirm("Clear ALL markings (including the pre-proposed ripening lines)?")) {
    state = {}; save();
    document.querySelectorAll(".row").forEach(paint); summary();
  }
};

function csvCell(v) {
  v = v == null ? "" : String(v);
  return /[",\\n\\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
document.getElementById("gen").onclick = function () {
  var un = (CHARGES.length + ACCTS.length) -
           Object.keys(state).filter(function (k) { return state[k]; }).length;
  if (un > 0 && !confirm(un + " line(s) are still unmarked — they will be exported with an empty " +
      "revenue_class. Generate anyway?")) return;
  var lines = [];
  lines.push("# mm-data-hub revenue_class marking (SPRINT settlement-bridge checkpoint)");
  lines.push("# generated: " + new Date().toISOString());
  lines.push("# feed this file back to Claude to wire core.dim_gp_charge.revenue_class");
  lines.push("record_type,key,name,ct_scope,ct_code,account_code,category,applied_rows,applied_dollars,revenue_class");
  CHARGES.forEach(function (ch) {
    lines.push(["charge", ch.charge_id, ch.name, ch.ct_scope, ch.ct_code, ch.account_code,
                ch.category, ch.applied_rows, ch.applied_dollars,
                state["charge:" + ch.charge_id] || ""].map(csvCell).join(","));
  });
  ACCTS.forEach(function (a) {
    lines.push(["account_code", a.account_code, a.sample_label, "", "", a.account_code,
                "", a.applied_rows, a.applied_dollars,
                state["acct:" + a.account_code] || ""].map(csvCell).join(","));
  });
  var blob = new Blob([lines.join("\\r\\n")], {type: "text/csv;charset=utf-8"});
  var aEl = document.createElement("a");
  aEl.href = URL.createObjectURL(blob);
  aEl.download = "revenue_class_marking___DATE__.csv";
  document.body.appendChild(aEl); aEl.click();
  setTimeout(function () { URL.revokeObjectURL(aEl.href); aEl.remove(); }, 500);
};
</script>
</body>
</html>`;

if (isMain(import.meta.url)) {
  await buildMarker();
}
