let DATA = null;
let activeTab = "overview";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n === null || n === undefined || n === "" ? "—" : `$${Number(n).toFixed(2)}`);
const CURRENCY_SYMBOLS = { DOP: "RD$", USD: "US$", EUR: "€" };
// An amount in a stated currency. No currency = the account's own, shown as before.
// The amount of an expense in the account's own currency, or null when it is in
// another currency and was not converted -- those are listed, never netted.
const inAccountCurrency = (x) => {
  // Untagged expenses predate currency tracking and are in the account's currency.
  // A tagged one is only netted when WCurrency confirms it matches -- an unknown
  // account currency never lets RD$ be subtracted from dollars.
  if (!x.currency || x.currency === DATA.accountCurrency) return Number(x.amount) || 0;
  return x.convertedAmount ? Number(x.convertedAmount) : null;
};
const moneyIn = (n, cur) => {
  if (n === null || n === undefined || n === "") return "—";
  if (!cur) return money(n);
  return `${CURRENCY_SYMBOLS[cur] || cur + " "}${Number(n).toFixed(2)}`;
};
const dash = (v) => (v === null || v === undefined || v === "" ? "—" : esc(v));
const dateFmt = (v) => (v ? new Date(v).toLocaleDateString() : "—");

// Per-tenant color theming: each client's KV entry can set branding.primary;
// tenants without one get the platform default (set server-side). Deriving a
// light "weak" tint from the single primary color keeps client setup to one
// hex value -- matches the "colors only" scope, no logo/font system.
function hexToRgb(hex) {
  const clean = (hex || "").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return [2, 132, 118]; // fallback: HOMS default teal
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function applyBranding(branding) {
  const primary = (branding && branding.primary) || "#028476";
  const [r, g, b] = hexToRgb(primary);
  document.documentElement.style.setProperty("--accent", primary);
  document.documentElement.style.setProperty("--accent-weak", `rgba(${r}, ${g}, ${b}, 0.10)`);
}

function badge(text, tone) {
  if (!text) return `<span class="badge neutral">—</span>`;
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

function paymentBadge(status) {
  if (status === "paid") return badge("Paid", "good");
  if (status === "pending") return badge("Pending", "warn");
  if (status === "failed" || status === "refunded") return badge(status, "bad");
  return badge(status, "neutral");
}

function syncBadge(status) {
  if (status === "connected") return badge("Connected", "good");
  if (status === "disconnected" || status === "error") return badge(status, "bad");
  return badge(status, "neutral");
}

function checklistBadge(status) {
  if (status === "pass__guest_ready") return badge("Pass — Guest Ready", "good");
  if (status === "needs_followup") return badge("Needs Follow-up", "warn");
  if (status === "failed_inspection") return badge("Failed Inspection", "bad");
  return badge(status, "neutral");
}

// ---------- Filters (multi-condition, per tab) ----------
const filterState = { properties: {}, ota: {}, transactions: {}, checklists: {}, expenses: {}, inventory: {} };

function distinct(list, key) {
  const seen = new Map();
  list.forEach((r) => {
    const v = r[key];
    if (v !== null && v !== undefined && v !== "") seen.set(String(v), v);
  });
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function distinctPairs(list, idKey, nameKey) {
  const seen = new Map();
  list.forEach((r) => {
    const id = r[idKey];
    if (id) seen.set(id, r[nameKey] || id);
  });
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function matchesFilters(record, tabKey, dateField) {
  const f = filterState[tabKey];
  for (const [key, val] of Object.entries(f)) {
    if (!val) continue;
    if (key === "__year") {
      if (!record[dateField] || record[dateField].slice(0, 4) !== val) return false;
      continue;
    }
    if (key === "__month") {
      if (!record[dateField] || record[dateField].slice(5, 7) !== val) return false;
      continue;
    }
    if (String(record[key] ?? "") !== String(val)) return false;
  }
  return true;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function renderFilterBar(tabKey, defs, dateField, list) {
  const state = filterState[tabKey];
  const hasActive = Object.values(state).some(Boolean);
  let html = '<div class="filter-bar">';
  for (const def of defs) {
    html += `<select class="filter-select" data-tab="${tabKey}" data-field="${def.key}">
      <option value="">${esc(def.label)}: All</option>
      ${def.options.map((o) => `<option value="${esc(o.value)}" ${String(state[def.key] ?? "") === String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
    </select>`;
  }
  if (dateField) {
    const years = [...new Set(list.map((r) => r[dateField]).filter(Boolean).map((v) => v.slice(0, 4)))].sort().reverse();
    html += `<select class="filter-select" data-tab="${tabKey}" data-field="__year">
      <option value="">Year: All</option>
      ${years.map((y) => `<option value="${y}" ${state.__year === y ? "selected" : ""}>${y}</option>`).join("")}
    </select>`;
    html += `<select class="filter-select" data-tab="${tabKey}" data-field="__month">
      <option value="">Month: All</option>
      ${MONTH_NAMES.map((name, i) => {
        const val = String(i + 1).padStart(2, "0");
        return `<option value="${val}" ${state.__month === val ? "selected" : ""}>${name}</option>`;
      }).join("")}
    </select>`;
  }
  if (hasActive) html += `<button class="btn filter-clear" data-tab="${tabKey}">Clear filters</button>`;
  html += "</div>";
  return html;
}

function renderFilterableTab({ tabKey, panelId, list, filterDefs, dateField, headers, rowFn, colspan, emptyLabel, extraToolbarHtml = "" }) {
  const filtered = list.filter((r) => matchesFilters(r, tabKey, dateField));
  const rowsHtml = filtered.map(rowFn).join("") ||
    emptyRow(colspan, list.length > 0 ? `No ${emptyLabel} match these filters` : `No ${emptyLabel} yet`);
  $(panelId).innerHTML = extraToolbarHtml + renderFilterBar(tabKey, filterDefs, dateField, list) + table(headers, rowsHtml, filtered.length);
}

function getLocationId() {
  const fromUrl = new URLSearchParams(location.search).get("locationId");
  if (fromUrl) {
    localStorage.setItem("homs_admin_locationId", fromUrl);
    return fromUrl;
  }
  return localStorage.getItem("homs_admin_locationId");
}

// --- Auth -------------------------------------------------------------------
// Every /api route now requires an admin key. The key is exchanged once for an
// HttpOnly cookie via POST /api/login, so it never lives in JS, in localStorage,
// or in a URL. credentials:"include" is required on every call because GHL frames
// this dashboard cross-origin.
//
// The key is collected with an inline form rather than window.prompt(), which
// browsers block inside cross-origin iframes -- i.e. exactly where this runs.

function promptForKey() {
  return new Promise((resolve) => {
    const host = $("#error");
    host.hidden = false;
    host.innerHTML =
      '<div class="auth-gate">' +
      "<p><strong>Admin key required</strong></p>" +
      '<input id="adminKeyInput" type="password" placeholder="Admin key" autocomplete="current-password" />' +
      '<button id="adminKeySubmit" class="btn">Unlock</button>' +
      '<span id="adminKeyMsg" class="auth-msg"></span>' +
      "</div>";

    const submit = async () => {
      const key = $("#adminKeyInput").value;
      if (!key) return;
      const msg = $("#adminKeyMsg");
      msg.textContent = "Checking…";
      try {
        const r = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ key }),
        });
        if (r.ok) {
          host.hidden = true;
          host.innerHTML = "";
          resolve(true);
          return;
        }
        msg.textContent = "Not accepted.";
      } catch {
        msg.textContent = "Couldn't reach the server.";
      }
    };

    $("#adminKeySubmit").addEventListener("click", submit);
    $("#adminKeyInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    $("#adminKeyInput").focus();
  });
}

async function apiFetch(url, opts = {}, allowPrompt = true) {
  const res = await fetch(url, { ...opts, credentials: "include" });
  if (res.status !== 401 || !allowPrompt) return res;
  await promptForKey();
  return apiFetch(url, opts, false);
}

async function loadData() {
  $("#loading").hidden = false;
  $("#error").hidden = true;

  const locationId = getLocationId();
  if (!locationId) {
    $("#loading").hidden = true;
    $("#error").hidden = false;
    $("#error").innerHTML =
      "No location specified. Open this dashboard via its GHL Custom Menu Link " +
      "(URL should end in <code>?locationId={{location.id}}</code>), or append " +
      "<code>?locationId=YOUR_LOCATION_ID</code> manually for testing.";
    return;
  }

  try {
    const res = await apiFetch("/api/data?locationId=" + encodeURIComponent(locationId));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load data");
    DATA = json;
    applyBranding(json.branding);
    $("#fetchedAt").textContent = "Updated " + new Date(json.fetchedAt).toLocaleTimeString();
    // The header used to carry a hardcoded "DEMO" pill from when this only ran
    // against DEMO-HOMS -- it showed on every tenant regardless of account.
    const label = $("#tenantLabel");
    if (label) label.textContent = json.tenantLabel || "Admin Dashboard";
    renderAll();
  } catch (err) {
    $("#error").hidden = false;
    $("#error").textContent = "Couldn't load data: " + err.message;
  } finally {
    $("#loading").hidden = true;
  }
}

function renderTab(tabKey) {
  const fn = { properties: renderProperties, ota: renderOta, transactions: renderTransactions, checklists: renderChecklists, expenses: renderExpenses, inventory: renderInventory }[tabKey];
  if (fn) fn();
}

function renderAll() {
  // A vendor tenant (HOMS itself) is its own book, not a client account. Nothing
  // below applies to it -- no properties, no bookings, no guests.
  if (DATA.kind === "vendor") return renderVendor();
  renderOverview();
  renderProperties();
  renderOta();
  renderTransactions();
  renderChecklists();
  renderExpenses();
  renderInventory();
  renderReports();
  renderStatement();
}

// ---------- Vendor P&L (own book) ----------
// Separate render path, not a variant of the client dashboard. Serves both HOMS
// (the product) and DTCS (the entity); which one is loaded is stated on the page.
//
// Revenue has two sources and they are always shown separately: what GHL
// processed, and what was recorded from outside GHL (Upwork, partner earnings).
// Reading GHL alone reported $0 for a year that actually earned ~$20k.

const CATEGORY_LABELS = {
  platform: "Platform",
  infrastructure: "Infrastructure",
  office: "Office",
  telecom: "Telecom",
  contractors: "Contractors & professional",
  marketing: "Marketing",
  payment_fees: "Payment fees",
  software: "Software",
  other: "Other",
};

const RECURRENCE_LABELS = { one_off: "One-off", monthly: "Monthly", annual: "Annual" };

const SOURCE_LABELS = {
  upwork: "Upwork",
  fableforge: "FableForge (partner)",
  ghl: "GHL payments",
  direct: "Direct / bank transfer",
  other: "Other",
};

// money() prints "$-76.06"; financial statements want "-$76.06".
function usd(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
}

function signedMoney(n) {
  const v = Number(n) || 0;
  const cls = v < 0 ? "bad" : v > 0 ? "good" : "neutral";
  return `<span class="badge ${cls}">${usd(v)}</span>`;
}

const GHL_COLLECTED = (t) => t.liveMode && /succeeded|paid|completed/i.test(t.status || "");

// Income statement for one calendar year. Pure: reads DATA, returns numbers.
// Cash basis -- an expense counts in the year it was PAID, revenue in the year it
// was RECEIVED. Anything without a date can't be placed in a year and is reported
// as excluded rather than quietly dropped into the wrong one.
//
// Platform fees are shown as a deduction from gross revenue (gross -> net), not
// buried in operating expenses: they are the cost of the channel, and Yari chose
// gross-with-fees-broken-out specifically so this line stays visible.
function plStatementFor(year) {
  const y = String(year);
  const inYear = (d) => d && String(d).slice(0, 4) === y;

  const expensesInYear = (DATA.expenses || []).filter((e) => inYear(e.paidOn));
  const ghlInYear = (DATA.transactions || []).filter((t) => GHL_COLLECTED(t) && inYear(t.paidAt));
  const recordedInYear = (DATA.revenue || []).filter((r) => inYear(r.receivedOn));

  const bySource = {};
  for (const r of recordedInYear) {
    if (!bySource[r.source]) bySource[r.source] = { gross: 0, fees: 0, net: 0, count: 0 };
    bySource[r.source].gross += r.gross;
    bySource[r.source].fees += r.fees;
    bySource[r.source].net += r.net;
    bySource[r.source].count += 1;
  }
  const ghlTotal = ghlInYear.reduce((s, t) => s + t.amount, 0);
  if (ghlTotal) bySource.ghl = { gross: ghlTotal, fees: 0, net: ghlTotal, count: ghlInYear.length };

  const grossRevenue = Object.values(bySource).reduce((s, v) => s + v.gross, 0);
  const platformFees = Object.values(bySource).reduce((s, v) => s + v.fees, 0);
  const netRevenue = grossRevenue - platformFees;

  const byCategory = {};
  for (const e of expensesInYear) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  const totalExpense = expensesInYear.reduce((s, e) => s + e.amount, 0);

  return {
    year: y,
    bySource,
    grossRevenue,
    platformFees,
    netRevenue,
    byCategory,
    totalExpense,
    net: netRevenue - totalExpense,
    expenseCount: expensesInYear.length,
    revenueCount: recordedInYear.length + ghlInYear.length,
    excludedExpenses: (DATA.expenses || []).filter((e) => !e.paidOn || !e.amount),
    undatedRevenue: (DATA.revenue || []).filter((r) => !r.receivedOn),
  };
}

function statementYears() {
  const ys = new Set();
  for (const e of DATA.expenses || []) if (e.paidOn) ys.add(String(e.paidOn).slice(0, 4));
  for (const t of DATA.transactions || []) if (t.paidAt && GHL_COLLECTED(t)) ys.add(String(t.paidAt).slice(0, 4));
  for (const r of DATA.revenue || []) if (r.receivedOn) ys.add(String(r.receivedOn).slice(0, 4));
  ys.add(String(new Date().getFullYear()));
  return [...ys].sort().reverse();
}

function statementCsv(st) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const n = (v) => (Number(v) || 0).toFixed(2);
  const rows = [
    [q(DATA.tenantLabel || "Account"), "", ""],
    [q("Profit & Loss - cash basis"), "", ""],
    [q(`For the year ended December 31, ${st.year}`), "", ""],
    [q(`Prepared ${new Date().toISOString().slice(0, 10)}`), "", ""],
    [],
    [q("REVENUE"), "", ""],
    ...Object.entries(st.bySource)
      .sort((a, b) => b[1].gross - a[1].gross)
      .map(([k, v]) => [q(SOURCE_LABELS[k] || k), n(v.gross), q(`${v.count} entr${v.count === 1 ? "y" : "ies"}`)]),
    [q("Gross revenue"), n(st.grossRevenue), ""],
    [q("Less platform fees"), n(-st.platformFees), ""],
    [q("Net revenue"), n(st.netRevenue), ""],
    [],
    [q("OPERATING EXPENSES"), "", ""],
    ...Object.entries(st.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [q(CATEGORY_LABELS[k] || k), n(v), ""]),
    [q("Total operating expenses"), n(st.totalExpense), q(`${st.expenseCount} record(s)`)],
    [],
    [q(st.net < 0 ? "NET LOSS" : "NET INCOME"), n(st.net), ""],
  ];
  if (st.excludedExpenses.length || st.undatedRevenue.length) {
    rows.push([], [q("EXCLUDED - no date, so not counted in any year"), "", ""]);
    for (const e of st.excludedExpenses) rows.push([q(`Expense: ${e.name}`), n(e.amount), q("no paid date")]);
    for (const r of st.undatedRevenue) rows.push([q(`Revenue: ${r.name}`), n(r.net), q("no received date")]);
  }
  return rows.map((r) => r.join(",")).join("\r\n");
}

function downloadCsvText(filename, csv) {
  // BOM so Excel opens UTF-8 correctly rather than mangling it.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderStatementSection(year) {
  const st = plStatementFor(year);
  const years = statementYears();

  const sourceRows =
    Object.entries(st.bySource)
      .sort((a, b) => b[1].gross - a[1].gross)
      .map(([k, v]) => `<tr><td>${esc(SOURCE_LABELS[k] || k)}</td><td>${usd(v.gross)}</td></tr>`)
      .join("") || `<tr><td colspan="2" class="muted">No revenue dated in ${esc(st.year)}</td></tr>`;

  const catRows =
    Object.entries(st.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${esc(CATEGORY_LABELS[k] || k)}</td><td>${usd(v)}</td></tr>`)
      .join("") || `<tr><td colspan="2" class="muted">No expenses dated in ${esc(st.year)}</td></tr>`;

  const excludedCount = st.excludedExpenses.length + st.undatedRevenue.length;
  const excludedNote = excludedCount
    ? `<p class="note error"><strong>${excludedCount} record${excludedCount === 1 ? "" : "s"} excluded</strong> — no date, so ${
        excludedCount === 1 ? "it belongs" : "they belong"
      } to no year: ${[...st.excludedExpenses, ...st.undatedRevenue].map((e) => esc(e.name)).join(", ")}</p>`
    : "";

  return `
    <div class="stmt-controls">
      <label>Year
        <select id="stmtYear" class="filter-select">
          ${years.map((y) => `<option value="${y}" ${y === st.year ? "selected" : ""}>${y}</option>`).join("")}
        </select>
      </label>
      <button id="stmtCsv" class="btn">Download CSV</button>
      <button id="stmtPrint" class="btn">Print / Save as PDF</button>
    </div>
    <div id="stmtDoc" class="stmt-doc">
      <h2>${esc(DATA.tenantLabel || "Account")}</h2>
      <p><strong>Profit &amp; Loss</strong> — cash basis<br>
         For the year ended December 31, ${esc(st.year)}<br>
         <small class="muted">Prepared ${new Date().toLocaleDateString()}</small></p>
      <h4>Revenue</h4>
      <table><tbody>
        ${sourceRows}
        <tr class="stmt-total"><td>Gross revenue</td><td>${usd(st.grossRevenue)}</td></tr>
        <tr><td>Less platform fees</td><td>${usd(-st.platformFees)}</td></tr>
        <tr class="stmt-total"><td><strong>Net revenue</strong></td><td><strong>${usd(st.netRevenue)}</strong></td></tr>
      </tbody></table>
      <h4>Operating expenses</h4>
      <table><tbody>
        ${catRows}
        <tr class="stmt-total"><td><strong>Total operating expenses</strong></td><td><strong>${usd(st.totalExpense)}</strong></td></tr>
      </tbody></table>
      <table><tbody>
        <tr class="stmt-net"><td><strong>${st.net < 0 ? "Net loss" : "Net income"}</strong></td><td><strong>${signedMoney(st.net)}</strong></td></tr>
      </tbody></table>
      ${excludedNote}
      <p class="note"><small>Cash basis: an expense counts in the year it was paid, revenue in the year it was received. Platform fees are deducted from gross revenue rather than listed as an operating expense.</small></p>
    </div>`;
}

function wireStatement() {
  const yearSel = $("#stmtYear");
  if (!yearSel) return;
  const host = $("#stmtSection");
  yearSel.addEventListener("change", (e) => {
    host.innerHTML = renderStatementSection(e.target.value);
    wireStatement();
  });
  $("#stmtCsv").addEventListener("click", () => {
    const y = $("#stmtYear").value;
    const who = (DATA.tenantLabel || "Account").replace(/[^A-Za-z0-9]+/g, "-");
    downloadCsvText(`${who}-P&L-${y}.csv`, statementCsv(plStatementFor(y)));
  });
  $("#stmtPrint").addEventListener("click", () => window.print());
}

function renderVendor() {
  const { pl, expenses, transactions, subscriptions, warnings = [] } = DATA;
  const revenue = DATA.revenue || [];

  // Remove the client tab buttons outright rather than hiding them. Hidden
  // buttons are still in the DOM and their click handler calls showTab(), which
  // un-hides client panels on an account that has no client data.
  const tabs = $("#tabs");
  if (tabs) {
    tabs.innerHTML = "";
    tabs.hidden = true;
  }
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  $("#searchResults").hidden = true;
  const search = $("#search");
  if (search) search.placeholder = "Search expenses and revenue by name, vendor, payer or category…";
  const host = $("#panel-overview");
  host.hidden = false;

  // Current-year figures lead. All-time totals mix years and hide trend; the
  // statement section below covers any other year.
  const thisYear = String(new Date().getFullYear());
  const fy = plStatementFor(thisYear);

  // Which account this is, stated on the page. getLocationId() falls back to
  // localStorage, so a bare URL silently shows whichever account was opened last.
  const whoami = `<p class="note banner"><strong>${esc(DATA.tenantLabel || "Account")}</strong> — own book.
    Location <code>${esc(DATA.locationId)}</code>.
    ${DATA.revenueTracked === false ? "Revenue here comes from GHL payments only." : "Revenue combines GHL payments with recorded entries (Upwork, partner earnings)."}</p>`;

  // "Unavailable" and "zero" must not look the same. A failed read is stated.
  const warnHtml = warnings.length
    ? warnings
        .map((w) => `<p class="note error"><strong>${esc(w.source)}</strong> could not be read (${esc(String(w.status))}). ${esc(w.impact)}</p>`)
        .join("")
    : "";

  const kpis = `
    <div class="card-grid">
      <div class="stat-card"><div class="num">${usd(fy.netRevenue)}</div><div class="label">Net revenue ${thisYear}</div></div>
      <div class="stat-card"><div class="num">${usd(fy.totalExpense)}</div><div class="label">Expenses ${thisYear}</div></div>
      <div class="stat-card"><div class="num">${usd(fy.net)}</div><div class="label">${fy.net < 0 ? "Net loss" : "Net income"} ${thisYear}</div></div>
      <div class="stat-card"><div class="num">${usd(pl.cost.monthlyBurn)}</div><div class="label">Fixed monthly burn</div></div>
      <div class="stat-card"><div class="num">${usd(pl.revenue.mrr)}</div><div class="label">MRR (GHL subscriptions)</div></div>
    </div>`;

  const incompleteNote = pl.incompleteRecords.length
    ? `<p class="note error"><strong>${pl.incompleteRecords.length} expense${
        pl.incompleteRecords.length === 1 ? "" : "s"
      } missing an amount or paid date</strong> — excluded from monthly figures: ${pl.incompleteRecords.map((r) => esc(r.name)).join(", ")}</p>`
    : "";

  // ---- Revenue ----
  const R = pl.revenue;
  const payerRows =
    Object.entries(R.byPayer || {})
      .sort((a, b) => b[1].net - a[1].net)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.count}</td><td>${usd(v.gross)}</td><td>${usd(v.net)}</td></tr>`)
      .join("") || emptyRow(4, "No recorded revenue");

  const sourceEntries = Object.entries(R.bySource || {});
  const sourceRows =
    sourceEntries
      .sort((a, b) => b[1].gross - a[1].gross)
      .map(([k, v]) => `<tr><td>${esc(SOURCE_LABELS[k] || k)}</td><td>${usd(v.gross)}</td><td>${usd(-v.fees)}</td><td>${usd(v.net)}</td></tr>`)
      .join("") || emptyRow(4, "No revenue yet");

  const revenueSection = `
    <h3>Revenue — all time</h3>
    <p class="note">Gross ${usd(R.grossRevenue)} · platform fees ${usd(-R.recordedFees)} · net ${usd(R.netRevenue)}.
      GHL-processed ${usd(R.totalCollected)}, recorded outside GHL ${usd(R.recordedGross)} gross.</p>
    <div class="rev-split">
      <div>
        <h4>By source</h4>
        ${table(["Source", "Gross", "Fees", "Net"], sourceRows, sourceEntries.length)}
      </div>
      <div>
        <h4>By payer</h4>
        ${table(["Payer", "Entries", "Gross", "Net"], payerRows, Object.keys(R.byPayer || {}).length)}
      </div>
    </div>`;

  const monthRows =
    pl.timeline
      .slice()
      .reverse()
      .map((m) => `<tr><td>${esc(m.month)}</td><td>${usd(m.revenue)}</td><td>${usd(m.expense)}</td><td>${signedMoney(m.net)}</td></tr>`)
      .join("") || emptyRow(4, "No dated activity yet");

  const burnRows =
    pl.cost.burnLines
      .map(
        (l) => `<tr>
          <td>${esc(l.name)}</td><td>${dash(l.vendor)}</td>
          <td>${esc(CATEGORY_LABELS[l.category] || l.category)}</td>
          <td>${esc(RECURRENCE_LABELS[l.recurrence] || l.recurrence)}</td>
          <td>${dateFmt(l.asOf)}</td><td>${usd(l.monthly)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No recurring costs recorded");

  const catRows =
    Object.entries(pl.byCategory)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => `<tr><td>${esc(CATEGORY_LABELS[k] || k)}</td><td>${v.count}</td><td>${usd(v.monthly)}</td><td>${usd(v.total)}</td></tr>`)
      .join("") || emptyRow(4, "No expenses recorded");

  const revenueRows =
    revenue
      .slice()
      .sort((a, b) => String(b.receivedOn || "").localeCompare(String(a.receivedOn || "")))
      .map(
        (r) => `<tr>
          <td>${esc(r.name)}${r.entryType === "adjustment" ? ' <span class="badge bad">adjustment</span>' : ""}</td>
          <td>${dash(r.payer)}</td>
          <td>${esc(SOURCE_LABELS[r.source] || r.source)}</td>
          <td>${dateFmt(r.receivedOn)}</td>
          <td>${usd(r.gross)}</td><td>${usd(r.net)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No recorded revenue");

  const expenseRows =
    expenses
      .slice()
      .sort((a, b) => String(b.paidOn || "").localeCompare(String(a.paidOn || "")))
      .map(
        (e) => `<tr>
          <td>${esc(e.name)}${e.incomplete ? ' <span class="badge warn">incomplete</span>' : ""}</td>
          <td>${dash(e.vendor)}</td>
          <td>${esc(CATEGORY_LABELS[e.category] || e.category)}</td>
          <td>${esc(RECURRENCE_LABELS[e.recurrence] || e.recurrence)}</td>
          <td>${dateFmt(e.paidOn)}</td><td>${usd(e.amount)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No expenses yet");

  const ghlRows =
    transactions
      .filter(GHL_COLLECTED)
      .map((t) => `<tr><td>${dash(t.contactName)}</td><td>${dash(t.source)}</td><td>${dateFmt(t.paidAt)}</td><td>${usd(t.amount)}</td></tr>`)
      .join("") || emptyRow(4, "No collected GHL payments");

  host.innerHTML = `
    ${whoami}
    ${warnHtml}
    ${kpis}
    ${incompleteNote}
    ${revenueSection}
    <h3>Month by month</h3>
    <p class="note">Net revenue in, expenses out, by the month money actually moved.</p>
    ${table(["Month", "Revenue", "Expense", "Net"], monthRows, pl.timeline.length)}
    <h3>Fixed monthly burn</h3>
    <p class="note">One line per subscription, valued at its most recent charge — not the sum of every recorded month.</p>
    ${table(["Line", "Vendor", "Category", "Recurrence", "As of", "Per month"], burnRows, pl.cost.burnLines.length)}
    <h3>Expenses by category</h3>
    ${table(["Category", "Records", "Per month", "Total recorded"], catRows, Object.keys(pl.byCategory).length)}
    <h3>Year-end P&amp;L statement</h3>
    <div id="stmtSection">${renderStatementSection(thisYear)}</div>
    <h3>Recorded revenue</h3>
    ${table(["Entry", "Payer", "Source", "Received", "Gross", "Net"], revenueRows, revenue.length)}
    <h3>GHL payments collected</h3>
    ${table(["Contact", "Source", "Date", "Amount"], ghlRows, transactions.filter(GHL_COLLECTED).length)}
    <h3>All expenses</h3>
    ${table(["Expense", "Vendor", "Category", "Recurrence", "Paid on", "Amount"], expenseRows, expenses.length)}
  `;

  wireStatement();
}

// ---------- Overview ----------
function renderOverview() {
  const { properties, otaChannels, transactions, checklists, inventoryItems, contacts } = DATA;
  const flaggedTx = transactions.filter((t) => !t.propertyId || !t.otaChannelId || t.paymentStatus === "failed");
  const flaggedChecklists = checklists.filter((c) => c.overallStatus === "needs_followup" || c.overallStatus === "failed_inspection");
  const flaggedOta = otaChannels.filter((o) => o.syncStatus === "disconnected" || o.syncStatus === "error");
  const flaggedInventory = inventoryItems.filter((i) => i.conditionKey === "needs_replacement" || i.conditionKey === "missing");

  $("#panel-overview").innerHTML = `
    <div class="card-grid">
      <div class="stat-card"><div class="num">${properties.length}</div><div class="label">Properties</div></div>
      <div class="stat-card"><div class="num">${otaChannels.length}</div><div class="label">OTA Channels</div></div>
      <div class="stat-card"><div class="num">${transactions.length}</div><div class="label">Transactions</div></div>
      <div class="stat-card"><div class="num">${checklists.length}</div><div class="label">Cleaning Checklists</div></div>
      <div class="stat-card"><div class="num">${inventoryItems.length}</div><div class="label">Inventory Items</div></div>
      <div class="stat-card"><div class="num">${contacts.length}</div><div class="label">Contacts</div></div>
    </div>
    <div class="section-title">Needs attention</div>
    <div class="card-grid">
      <div class="stat-card"><div class="num">${flaggedTx.length}</div><div class="label">Transactions missing links / failed payment</div></div>
      <div class="stat-card"><div class="num">${flaggedChecklists.length}</div><div class="label">Checklists needing follow-up or failed</div></div>
      <div class="stat-card"><div class="num">${flaggedOta.length}</div><div class="label">OTA channels disconnected / erroring</div></div>
      <div class="stat-card"><div class="num">${flaggedInventory.length}</div><div class="label">Inventory needing replacement / missing</div></div>
    </div>
    ${DATA.transactions.length === 0 && DATA.properties.length <= 1 ? `
      <div class="section-title">Note</div>
      <p style="color:var(--muted); font-size:13px; max-width:640px;">
        This demo location currently has minimal seed data (schema and associations are wired and confirmed working —
        this dashboard reads them live). Add more Property / OTA Channel / Transaction / Cleaning Checklist records
        to see the full search, audit, and report views populated.
      </p>` : ""}
  `;
}

// ---------- Properties ----------
function renderProperties() {
  renderFilterableTab({
    tabKey: "properties", panelId: "#panel-properties", list: DATA.properties,
    filterDefs: [
      { key: "status", label: "Status", options: distinct(DATA.properties, "status") },
      { key: "propertyType", label: "Type", options: distinct(DATA.properties, "propertyType") },
      { key: "ownerContactName", label: "Owner", options: distinct(DATA.properties, "ownerContactName") },
    ],
    dateField: null,
    headers: ["Name", "Owner", "Status", "Type", "Address", "Bed/Bath", "Nightly Rate", "OTA Channels", "Bookings"],
    colspan: 9, emptyLabel: "properties",
    rowFn: (p) => `
    <tr data-kind="property" data-id="${p.id}">
      <td>${dash(p.name)}</td>
      <td>${dash(p.ownerContactName)}</td>
      <td>${badge(p.status, p.status === "active" ? "good" : p.status === "inactive" ? "bad" : "neutral")}</td>
      <td>${dash(p.propertyType)}</td>
      <td>${dash(p.address)}</td>
      <td>${p.bedrooms ?? "—"} / ${p.bathrooms ?? "—"}</td>
      <td>${money(p.baseNightlyRate)}</td>
      <td>${p.otaChannelNames.length ? esc(p.otaChannelNames.join(", ")) : "—"}</td>
      <td>${p.transactionCount}</td>
    </tr>`,
  });
}

// ---------- OTA Channels ----------
function renderOta() {
  renderFilterableTab({
    tabKey: "ota", panelId: "#panel-ota", list: DATA.otaChannels,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.otaChannels, "propertyId", "propertyName") },
      { key: "syncStatus", label: "Sync Status", options: distinct(DATA.otaChannels, "syncStatus") },
    ],
    dateField: "lastSynced",
    headers: ["Channel", "Property", "Listing ID", "Sync Status", "Commission", "Last Synced"],
    colspan: 6, emptyLabel: "OTA channels",
    rowFn: (o) => `
    <tr data-kind="ota_channel" data-id="${o.id}">
      <td>${dash(o.name)}</td>
      <td>${dash(o.propertyName)}</td>
      <td>${dash(o.externalListingId)}</td>
      <td>${syncBadge(o.syncStatus)}</td>
      <td>${o.commissionRate !== null ? o.commissionRate + "%" : "—"}</td>
      <td>${dateFmt(o.lastSynced)}</td>
    </tr>`,
  });
}

// ---------- Transactions ----------
function renderTransactions() {
  renderFilterableTab({
    tabKey: "transactions", panelId: "#panel-transactions", list: DATA.transactions,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.transactions, "propertyId", "propertyName") },
      { key: "otaChannelId", label: "OTA Channel", options: distinctPairs(DATA.transactions, "otaChannelId", "otaChannelName") },
      { key: "paymentStatus", label: "Payment", options: distinct(DATA.transactions, "paymentStatus") },
    ],
    dateField: "checkinDate",
    headers: ["Transaction", "Guest", "Property", "OTA Channel", "Booking Ref", "Stay Dates", "Total", "Payment"],
    colspan: 8, emptyLabel: "transactions",
    rowFn: (t) => `
    <tr data-kind="transaction" data-id="${t.id}">
      <td>${dash(t.name)}</td>
      <td>${dash(t.guestName)}</td>
      <td>${dash(t.propertyName)}</td>
      <td>${dash(t.otaChannelName)}</td>
      <td>${dash(t.bookingReference)}</td>
      <td>${dateFmt(t.checkinDate)} → ${dateFmt(t.checkoutDate)}</td>
      <td>${money(t.bookingTotal)}</td>
      <td>${paymentBadge(t.paymentStatus)}</td>
    </tr>`,
  });
}

// ---------- Checklists ----------
function renderChecklists() {
  renderFilterableTab({
    tabKey: "checklists", panelId: "#panel-checklists", list: DATA.checklists,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.checklists, "propertyId", "propertyName") },
      { key: "turnoverType", label: "Turnover Type", options: distinct(DATA.checklists, "turnoverType") },
      { key: "overallStatus", label: "Status", options: distinct(DATA.checklists, "overallStatus") },
      { key: "cleanerContactId", label: "Cleaner", options: distinctPairs(DATA.checklists, "cleanerContactId", "cleanerContactName") },
    ],
    dateField: "completionDate",
    headers: ["Job", "Property", "Booking Ref", "Cleaner", "Turnover Type", "Date Cleaned", "Status"],
    colspan: 7, emptyLabel: "cleaning checklists",
    rowFn: (c) => `
    <tr data-kind="checklist" data-id="${c.id}">
      <td>${dash(c.name)}</td>
      <td>${dash(c.propertyName)}</td>
      <td>${dash(c.bookingReference)}</td>
      <td>${dash(c.cleanerContactName || c.cleanerNameService)}</td>
      <td>${dash(c.turnoverType)}</td>
      <td>${dateFmt(c.completionDate)}</td>
      <td>${checklistBadge(c.overallStatus)}</td>
    </tr>`,
  });
}

// ---------- Expenses ----------
function reviewBadge(status) {
  if (status === "Approved") return badge("Approved", "good");
  if (status === "Needs Review") return badge("Needs Review", "warn");
  return badge(status, "neutral");
}

// Mirrors src/normalize.js EXPENSE_CATEGORY_LABELS -- kept in sync manually,
// same duplication pattern as the Owner Statement's i18n category map.
const EXPENSE_CATEGORY_OPTIONS = [
  ["maintenance_repairs", "Maintenance & Repairs"],
  ["cleaning_supplies", "Cleaning Supplies"],
  ["utilities", "Utilities"],
  ["pest_control", "Pest Control"],
  ["landscaping", "Landscaping"],
  ["insurance", "Insurance"],
  ["property_tax", "Property Tax"],
  ["management_fee", "Management Fee"],
  ["miscellaneous", "Miscellaneous Expenses"],
  ["other", "Other"],
];

function openAddExpenseModal() {
  const propSelect = $("#aeProperty");
  propSelect.innerHTML =
    `<option value="">— None —</option>` +
    DATA.properties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");

  const catSelect = $("#aeCategory");
  catSelect.innerHTML = EXPENSE_CATEGORY_OPTIONS.map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join("");

  $("#addExpenseForm").reset();
  $("#aePaidOn").value = new Date().toISOString().slice(0, 10);
  $("#aeError").hidden = true;
  $("#aeError").textContent = "";
  $("#aeSubmit").disabled = false;
  $("#aeSubmit").textContent = "Submit Expense";
  $("#addExpenseOverlay").hidden = false;
}

async function submitAddExpense(e) {
  e.preventDefault();
  const propertyId = $("#aeProperty").value || null;
  const property = propertyId ? DATA.properties.find((p) => p.id === propertyId) : null;

  const payload = {
    locationId: getLocationId(),
    propertyId,
    ownerContactId: property?.ownerContactId || null,
    name: EXPENSE_CATEGORY_OPTIONS.find(([key]) => key === $("#aeCategory").value)?.[1] || "Expense",
    paidOn: $("#aePaidOn").value || null,
    categoryKey: $("#aeCategory").value,
    lineItemDescription: $("#aeDescription").value.trim(),
    amount: $("#aeAmount").value,
  };

  const errBox = $("#aeError");
  errBox.hidden = true;
  const submitBtn = $("#aeSubmit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    const res = await apiFetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to create expense");

    $("#addExpenseOverlay").hidden = true;
    await loadData();
    showTab("expenses");
  } catch (err) {
    errBox.textContent = "Couldn't save expense: " + err.message;
    errBox.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Expense";
  }
}

function renderExpenses() {
  renderFilterableTab({
    tabKey: "expenses", panelId: "#panel-expenses", list: DATA.expenses,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.expenses, "propertyId", "propertyName") },
      { key: "category", label: "Category", options: distinct(DATA.expenses, "category") },
      { key: "reviewStatus", label: "Review Status", options: distinct(DATA.expenses, "reviewStatus") },
      { key: "ownerContactId", label: "Owner", options: distinctPairs(DATA.expenses, "ownerContactId", "ownerContactName") },
    ],
    dateField: "paidOn",
    headers: ["Expense", "Paid On", "Category", "Property", "Owner", "Amount", "Converted", "Review Status"],
    colspan: 8, emptyLabel: "expenses",
    extraToolbarHtml: `<div class="toolbar" style="margin-bottom:12px"><button class="btn btn-primary" id="openAddExpense">+ Add Expense</button></div>`,
    rowFn: (e) => `
    <tr data-kind="expense" data-id="${e.id}">
      <td>${dash(e.name)}</td>
      <td>${dateFmt(e.paidOn)}</td>
      <td>${dash(e.category)}</td>
      <td>${dash(e.propertyName)}</td>
      <td>${dash(e.ownerContactName)}</td>
      <td>${moneyIn(e.amount, e.currency)}</td>
      <td${e.rateSource ? ` title="${esc(e.rateSource)}"` : ""}>${e.convertedAmount ? money(e.convertedAmount) : "—"}</td>
      <td>${reviewBadge(e.reviewStatus)}</td>
    </tr>`,
  });
}

// ---------- Property Inventory ----------
function conditionBadge(condition) {
  if (condition === "New" || condition === "Good") return badge(condition, "good");
  if (condition === "Fair") return badge(condition, "warn");
  if (condition === "Needs Replacement" || condition === "Missing") return badge(condition, "bad");
  return badge(condition, "neutral");
}

function renderInventory() {
  renderFilterableTab({
    tabKey: "inventory", panelId: "#panel-inventory", list: DATA.inventoryItems,
    filterDefs: [
      { key: "propertyId", label: "Property", options: distinctPairs(DATA.inventoryItems, "propertyId", "propertyName") },
      { key: "category", label: "Category", options: distinct(DATA.inventoryItems, "category") },
      { key: "condition", label: "Condition", options: distinct(DATA.inventoryItems, "condition") },
    ],
    dateField: "lastVerifiedDate",
    headers: ["Item", "Property", "Category", "Qty", "Condition", "Location", "Last Verified"],
    colspan: 7, emptyLabel: "inventory items",
    rowFn: (i) => `
    <tr data-kind="inventory_item" data-id="${i.id}">
      <td>${dash(i.name)}</td>
      <td>${dash(i.propertyName)}</td>
      <td>${dash(i.category)}</td>
      <td>${i.quantity ?? "—"}</td>
      <td>${conditionBadge(i.condition)}</td>
      <td>${dash(i.locationInProperty)}</td>
      <td>${dateFmt(i.lastVerifiedDate)}</td>
    </tr>`,
  });
}

// ---------- Reports ----------
function renderReports() {
  const { properties, otaChannels, transactions, checklists } = DATA;

  const revenueByProperty = properties.map((p) => {
    const txs = transactions.filter((t) => t.propertyId === p.id);
    const total = txs.reduce((sum, t) => sum + (Number(t.bookingTotal) || 0), 0);
    const payout = txs.reduce((sum, t) => sum + (Number(t.netPayout) || 0), 0);
    return { name: p.name, bookings: txs.length, total, payout };
  }).sort((a, b) => b.total - a.total);

  const byPaymentStatus = {};
  for (const t of transactions) {
    const k = t.paymentStatus || "unset";
    byPaymentStatus[k] = (byPaymentStatus[k] || 0) + 1;
  }

  const byOta = otaChannels.map((o) => {
    const txs = transactions.filter((t) => t.otaChannelId === o.id);
    const total = txs.reduce((sum, t) => sum + (Number(t.bookingTotal) || 0), 0);
    return { name: o.name, bookings: txs.length, total, commissionRate: o.commissionRate };
  }).sort((a, b) => b.bookings - a.bookings);

  const byChecklistStatus = {};
  for (const c of checklists) {
    const k = c.overallStatus || "unset";
    byChecklistStatus[k] = (byChecklistStatus[k] || 0) + 1;
  }

  $("#panel-reports").innerHTML = `
    <div class="toolbar"><div class="section-title" style="margin:0">Revenue by property</div>
      <button class="btn export-btn" data-export="revenue-by-property">Export CSV</button></div>
    ${table(["Property", "Bookings", "Booking Total", "Net Payout"],
      revenueByProperty.map((r) => `<tr><td>${dash(r.name)}</td><td>${r.bookings}</td><td>${money(r.total)}</td><td>${money(r.payout)}</td></tr>`).join("") || emptyRow(4, "No data"),
      null)}

    <div class="toolbar"><div class="section-title" style="margin:0">Bookings by OTA channel</div>
      <button class="btn export-btn" data-export="bookings-by-ota">Export CSV</button></div>
    ${table(["Channel", "Bookings", "Booking Total", "Commission Rate"],
      byOta.map((r) => `<tr><td>${dash(r.name)}</td><td>${r.bookings}</td><td>${money(r.total)}</td><td>${r.commissionRate ?? "—"}${r.commissionRate !== null ? "%" : ""}</td></tr>`).join("") || emptyRow(4, "No data"),
      null)}

    <div class="section-title">Transactions by payment status</div>
    <div class="card-grid">
      ${Object.entries(byPaymentStatus).map(([k, v]) => `<div class="stat-card"><div class="num">${v}</div><div class="label">${esc(k)}</div></div>`).join("") || "<p style='color:var(--muted)'>No transactions yet</p>"}
    </div>

    <div class="section-title">Cleaning checklists by status</div>
    <div class="card-grid">
      ${Object.entries(byChecklistStatus).map(([k, v]) => `<div class="stat-card"><div class="num">${v}</div><div class="label">${esc(k)}</div></div>`).join("") || "<p style='color:var(--muted)'>No checklists yet</p>"}
    </div>
  `;

  $("#panel-reports").dataset.revenueByProperty = JSON.stringify(revenueByProperty);
  $("#panel-reports").dataset.bookingsByOta = JSON.stringify(byOta);
}

// ---------- Owner Statement ----------
const STATEMENT_I18N = {
  en: {
    selectProperty: "Select property", selectMonth: "Select month",
    statementFor: "Statement for", owner: "Owner", noOwnerOnFile: "(no owner on file)",
    grossIncome: "Gross Income", managementCommission: "Management Commission",
    otherExpenses: "Other Owner Expenses", netIncome: "Net Income",
    notNetted: "Paid in another currency, not included in the totals above",
    reservations: "Reservations", resName: "Reservation", guest: "Guest",
    checkIn: "Check-in", checkOut: "Check-out", nights: "Nights", grossRent: "Gross Rent",
    total: "Total", expensesTitle: "Owner Expenses", paidOn: "Paid On", category: "Category",
    description: "Description", amount: "Amount", noReservations: "No reservations in this period",
    noExpenses: "No expenses in this period", print: "Print / Save as PDF", exportCsv: "Export CSV",
    language: "Language", noData: "No properties yet — add one to generate a statement.",
  },
  es: {
    selectProperty: "Seleccionar propiedad", selectMonth: "Seleccionar mes",
    statementFor: "Estado de cuenta de", owner: "Propietario", noOwnerOnFile: "(sin propietario registrado)",
    grossIncome: "Ingreso Bruto", managementCommission: "Comisión de Administración",
    otherExpenses: "Otros Gastos del Propietario", netIncome: "Ingreso Neto",
    notNetted: "Pagado en otra moneda, no incluido en los totales anteriores",
    reservations: "Reservaciones", resName: "Reservación", guest: "Huésped",
    checkIn: "Entrada", checkOut: "Salida", nights: "Noches", grossRent: "Renta Bruta",
    total: "Total", expensesTitle: "Gastos del Propietario", paidOn: "Fecha de Pago", category: "Categoría",
    description: "Descripción", amount: "Monto", noReservations: "Sin reservaciones en este período",
    noExpenses: "Sin gastos en este período", print: "Imprimir / Guardar como PDF", exportCsv: "Exportar CSV",
    language: "Idioma", noData: "Aún no hay propiedades — agregue una para generar un estado de cuenta.",
  },
};

const EXPENSE_CATEGORY_ES = {
  maintenance_repairs: "Mantenimiento y Reparaciones",
  cleaning_supplies: "Insumos de Limpieza",
  utilities: "Servicios Públicos",
  pest_control: "Control de Plagas",
  landscaping: "Jardinería",
  insurance: "Seguro",
  property_tax: "Impuesto a la Propiedad",
  management_fee: "Comisión de Administración",
  miscellaneous: "Gastos Varios",
  other: "Otro",
};

let statementState = { propertyId: null, month: null, lang: "en" };

function t(key) {
  return STATEMENT_I18N[statementState.lang][key] || STATEMENT_I18N.en[key] || key;
}

function categoryLabel(categoryKey, fallbackLabel) {
  if (statementState.lang === "es" && categoryKey && EXPENSE_CATEGORY_ES[categoryKey]) {
    return EXPENSE_CATEGORY_ES[categoryKey];
  }
  return fallbackLabel;
}

function monthLabel(ym) {
  const [y, m] = ym.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(statementState.lang === "es" ? "es-ES" : "en-US", { month: "long", year: "numeric" });
}

function renderStatement() {
  const panel = $("#panel-statement");
  const { properties } = DATA;

  if (!properties.length) {
    panel.innerHTML = `<div class="state-msg">${t("noData")}</div>`;
    return;
  }

  if (!statementState.propertyId || !properties.some((p) => p.id === statementState.propertyId)) {
    statementState.propertyId = properties[0].id;
  }
  const property = properties.find((p) => p.id === statementState.propertyId);

  const propTx = DATA.transactions.filter((x) => x.propertyId === property.id);
  const propEx = DATA.expenses.filter((x) => x.propertyId === property.id);

  const months = new Set();
  propTx.forEach((x) => x.checkinDate && months.add(x.checkinDate.slice(0, 7)));
  propEx.forEach((x) => x.paidOn && months.add(x.paidOn.slice(0, 7)));
  const sortedMonths = [...months].sort().reverse();
  if (!statementState.month || !sortedMonths.includes(statementState.month)) {
    statementState.month = sortedMonths[0] || null;
  }

  const monthTx = statementState.month
    ? propTx.filter((x) => (x.checkinDate || "").slice(0, 7) === statementState.month)
    : [];
  const monthEx = statementState.month
    ? propEx.filter((x) => (x.paidOn || "").slice(0, 7) === statementState.month)
    : [];

  const grossIncome = monthTx.reduce((sum, x) => sum + (Number(x.bookingTotal) || 0), 0);
  const managementEx = monthEx.filter((x) => x.categoryKey === "management_fee");
  const otherEx = monthEx.filter((x) => x.categoryKey !== "management_fee");
  const managementCommission = managementEx.reduce((sum, x) => sum + (inAccountCurrency(x) || 0), 0);
  const otherExpensesTotal = otherEx.reduce((sum, x) => sum + (inAccountCurrency(x) || 0), 0);
  // Per-currency subtotals of what could not be netted (e.g. RD$ costs, no conversion).
  const notNetted = {};
  for (const x of monthEx) {
    if (inAccountCurrency(x) === null) notNetted[x.currency] = (notNetted[x.currency] || 0) + (Number(x.amount) || 0);
  }
  const netIncome = grossIncome - managementCommission - otherExpensesTotal;

  const nightsBetween = (a, b) => {
    if (!a || !b) return "—";
    const n = Math.round((new Date(b) - new Date(a)) / 86400000);
    return Number.isFinite(n) ? n : "—";
  };

  const ownerName = (() => {
    if (property.ownerContactName) return property.ownerContactName;
    const withOwner = monthEx.find((x) => x.ownerContactName) || propEx.find((x) => x.ownerContactName);
    return withOwner ? withOwner.ownerContactName : null;
  })();

  panel.innerHTML = `
    <div class="statement-controls">
      <select id="stmtProperty">
        ${properties.map((p) => `<option value="${p.id}" ${p.id === property.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
      </select>
      <select id="stmtMonth" ${sortedMonths.length ? "" : "disabled"}>
        ${sortedMonths.length
          ? sortedMonths.map((m) => `<option value="${m}" ${m === statementState.month ? "selected" : ""}>${esc(monthLabel(m))}</option>`).join("")
          : `<option>${esc(t("selectMonth"))}</option>`}
      </select>
      <span class="lang-toggle">
        <button class="btn lang-btn ${statementState.lang === "en" ? "active" : ""}" data-lang="en">EN</button>
        <button class="btn lang-btn ${statementState.lang === "es" ? "active" : ""}" data-lang="es">ES</button>
      </span>
      <button class="btn" id="stmtPrint">${t("print")}</button>
      <button class="btn" id="stmtExport">${t("exportCsv")}</button>
    </div>

    <div class="statement-sheet" id="statementSheet">
      <h2>${esc(t("statementFor"))} ${esc(property.name)}</h2>
      <p class="statement-period">${statementState.month ? esc(monthLabel(statementState.month)) : "—"}</p>
      <p class="statement-owner">${esc(t("owner"))}: ${ownerName ? esc(ownerName) : t("noOwnerOnFile")}</p>

      <table class="statement-summary">
        <tbody>
          <tr><td>${esc(t("grossIncome"))}</td><td>${money(grossIncome)}</td></tr>
          <tr><td>${esc(t("managementCommission"))}</td><td>(${money(managementCommission)})</td></tr>
          <tr><td>${esc(t("otherExpenses"))}</td><td>(${money(otherExpensesTotal)})</td></tr>
          <tr class="statement-net"><td>${esc(t("netIncome"))}</td><td>${money(netIncome)}</td></tr>
        </tbody>
      </table>
      ${Object.keys(notNetted).length
        ? `<p class="note">${esc(t("notNetted"))}: ${Object.entries(notNetted).map(([c, v]) => esc(moneyIn(v, c))).join(" · ")}</p>`
        : ""}

      <h3>${esc(t("reservations"))}</h3>
      ${table(
        [t("resName"), t("guest"), t("checkIn"), t("checkOut"), t("nights"), t("grossRent")],
        monthTx.map((x) => `<tr><td>${dash(x.name)}</td><td>${dash(x.guestName)}</td><td>${dateFmt(x.checkinDate)}</td><td>${dateFmt(x.checkoutDate)}</td><td>${nightsBetween(x.checkinDate, x.checkoutDate)}</td><td>${money(x.bookingTotal)}</td></tr>`).join("")
          || emptyRow(6, t("noReservations")),
        null
      )}

      <h3>${esc(t("expensesTitle"))}</h3>
      ${table(
        [t("paidOn"), t("category"), t("description"), t("amount")],
        monthEx.map((x) => `<tr><td>${dateFmt(x.paidOn)}</td><td>${dash(categoryLabel(x.categoryKey, x.category))}</td><td>${dash(x.lineItemDescription)}</td><td>(${moneyIn(x.amount, x.currency)}${x.convertedAmount && x.currency !== DATA.accountCurrency ? ` = ${money(x.convertedAmount)}` : ""})</td></tr>`).join("")
          || emptyRow(4, t("noExpenses")),
        null
      )}
    </div>
  `;

  panel.dataset.exportRows = JSON.stringify(
    monthTx.map((x) => ({ type: "reservation", name: x.name, guest: x.guestName, checkIn: x.checkinDate, checkOut: x.checkoutDate, grossRent: x.bookingTotal }))
      .concat(monthEx.map((x) => ({ type: "expense", paidOn: x.paidOn, category: categoryLabel(x.categoryKey, x.category), description: x.lineItemDescription, amount: x.amount, currency: x.currency || DATA.accountCurrency || "", convertedAmount: x.convertedAmount ?? "", exchangeRate: x.exchangeRate ?? "", rateDate: x.rateDate ?? "" })))
  );
}

function table(headers, rowsHtml, count) {
  return `
    ${count !== null && count !== undefined ? `<div class="toolbar"><div class="count">${count} record${count === 1 ? "" : "s"}</div></div>` : ""}
    <table>
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function emptyRow(colspan, msg) {
  return `<tr class="empty-row"><td colspan="${colspan}">${esc(msg)}</td></tr>`;
}

// ---------- Universal search ----------
function searchableText(obj) {
  return Object.values(obj)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ␟ ")
    .toLowerCase();
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    $("#searchResults").hidden = true;
    showTab(activeTab);
    return;
  }
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  $("#searchResults").hidden = false;

  // A vendor tenant has none of the client collections below -- searching them
  // would throw on undefined. Search what it actually has.
  if (DATA.kind === "vendor") {
    const expHits = (DATA.expenses || []).filter((e) =>
      [e.name, e.vendor, e.category, e.notes].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
    const revHits = (DATA.revenue || []).filter((r) =>
      [r.name, r.payer, r.source, r.period, r.notes].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
    const revNet = revHits.reduce((s, r) => s + r.net, 0);
    const expTotal = expHits.reduce((s, e) => s + e.amount, 0);

    $("#searchResults").innerHTML =
      expHits.length || revHits.length
        ? (revHits.length
            ? `<h3>Revenue (${revHits.length}) — net ${usd(revNet)}</h3>` +
              table(
                ["Entry", "Payer", "Received", "Gross", "Net"],
                revHits
                  .map((r) => `<tr><td>${esc(r.name)}</td><td>${dash(r.payer)}</td><td>${dateFmt(r.receivedOn)}</td><td>${usd(r.gross)}</td><td>${usd(r.net)}</td></tr>`)
                  .join(""),
                revHits.length
              )
            : "") +
          (expHits.length
            ? `<h3>Expenses (${expHits.length}) — ${usd(expTotal)}</h3>` +
              table(
                ["Expense", "Vendor", "Category", "Paid on", "Amount"],
                expHits
                  .map((e) => `<tr><td>${esc(e.name)}</td><td>${dash(e.vendor)}</td><td>${esc(CATEGORY_LABELS[e.category] || e.category)}</td><td>${dateFmt(e.paidOn)}</td><td>${usd(e.amount)}</td></tr>`)
                  .join(""),
                expHits.length
              )
            : "")
        : `<p class="note">Nothing matches "${esc(query)}".</p>`;
    return;
  }

  const groups = [
    ["Properties", DATA.properties, (p) => `${dash(p.name)} — ${dash(p.address)}`],
    ["OTA Channels", DATA.otaChannels, (o) => `${dash(o.name)} — ${dash(o.propertyName)}`],
    ["Transactions", DATA.transactions, (t) => `${dash(t.name)} — ${dash(t.guestName)} — ${dash(t.bookingReference)}`],
    ["Cleaning Checklists", DATA.checklists, (c) => `${dash(c.name)} — ${dash(c.propertyName)} — cleaner ${dash(c.cleanerContactName || c.cleanerNameService)}`],
    ["Expenses", DATA.expenses, (e) => `${dash(e.name)} — ${dash(e.propertyName)} — ${dash(e.category)}`],
    ["Property Inventory", DATA.inventoryItems, (i) => `${dash(i.name)} — ${dash(i.propertyName)} — ${dash(i.category)}`],
    ["Contacts", DATA.contacts, (c) => `${dash(c.name)} — ${dash(c.email)}`],
  ];

  let totalMatches = 0;
  let html = "";
  for (const [label, list, render] of groups) {
    const matches = list.filter((item) => searchableText(item).includes(q));
    if (!matches.length) continue;
    totalMatches += matches.length;
    html += `<div class="result-group"><h3>${label} (${matches.length})</h3>
      <table><tbody>
        ${matches.map((m) => `<tr data-kind="${m.kind}" data-id="${m.id}"><td>${render(m)}</td></tr>`).join("")}
      </tbody></table>
    </div>`;
  }
  $("#searchResults").innerHTML = totalMatches
    ? html
    : `<div class="state-msg">No matches for "${esc(query)}"</div>`;
}

// ---------- Detail overlay ----------
function findRecord(kind, id) {
  const map = {
    property: DATA.properties, ota_channel: DATA.otaChannels, transaction: DATA.transactions,
    checklist: DATA.checklists, expense: DATA.expenses, inventory_item: DATA.inventoryItems, contact: DATA.contacts,
  };
  return (map[kind] || []).find((r) => r.id === id);
}

function openDetail(kind, id) {
  const record = findRecord(kind, id);
  if (!record) return;
  let title = record.name;
  let rows = [];

  if (kind === "property") {
    rows = [
      ["Owner", record.ownerContactName], ["Status", record.status], ["Type", record.propertyType], ["Address", record.address],
      ["Bedrooms", record.bedrooms], ["Bathrooms", record.bathrooms], ["Max Occupancy", record.maxOccupancy],
      ["Nightly Rate", money(record.baseNightlyRate)], ["Cleaning Fee", money(record.cleaningFee)],
      ["Pet Fee", money(record.petFee)], ["OTA Channels", record.otaChannelNames.join(", ") || "—"],
      ["Bookings", record.transactionCount],
    ];
  } else if (kind === "ota_channel") {
    rows = [
      ["Property", record.propertyName], ["External Listing ID", record.externalListingId],
      ["Listing URL", record.listingUrl], ["iCal Link", record.icalLink],
      ["Sync Status", record.syncStatus], ["Commission Rate", record.commissionRate],
      ["Last Synced", dateFmt(record.lastSynced)],
    ];
  } else if (kind === "transaction") {
    title = record.name;
    rows = [
      ["Guest", record.guestName], ["Property", record.propertyName], ["OTA Channel", record.otaChannelName],
      ["Booking Reference", record.bookingReference], ["Check-in", dateFmt(record.checkinDate)],
      ["Check-out", dateFmt(record.checkoutDate)], ["Booking Total", money(record.bookingTotal)],
      ["Platform Fee", money(record.platformFee)], ["Net Payout", money(record.netPayout)],
      ["Payment Status", record.paymentStatus],
    ];
  } else if (kind === "checklist") {
    rows = [
      ["Property", record.propertyName], ["Booking Reference", record.bookingReference],
      ["Cleaner", record.cleanerContactName || record.cleanerNameService],
      ["Turnover Type", record.turnoverType], ["Date Cleaned", dateFmt(record.completionDate)],
      ["Overall Status", record.overallStatus], ["Damage / Issues", record.damageNotes],
      ["Missing Supplies", record.missingSupplies], ["Guest Items Found", record.guestItemsFound],
    ];
  } else if (kind === "expense") {
    rows = [
      ["Property", record.propertyName], ["Owner", record.ownerContactName],
      ["Paid On", dateFmt(record.paidOn)], ["Category", record.category],
      ["Description", record.lineItemDescription], ["Amount", moneyIn(record.amount, record.currency)],
      ["Converted", record.convertedAmount ? money(record.convertedAmount) : null], ["Exchange Rate", record.rateSource],
      ["Can Reimburse", money(record.canReimburse)], ["Already Reimbursed", money(record.alreadyReimbursed)],
      ["Reimbursing Now", money(record.reimbursingNow)], ["Review Status", record.reviewStatus],
    ];
  } else if (kind === "inventory_item") {
    rows = [
      ["Property", record.propertyName], ["Category", record.category], ["Quantity", record.quantity],
      ["Condition", record.condition], ["Location in Property", record.locationInProperty],
      ["Purchase Date", dateFmt(record.purchaseDate)], ["Purchase Cost", money(record.purchaseCost)],
      ["Last Verified", dateFmt(record.lastVerifiedDate)], ["Notes", record.notes],
    ];
  } else if (kind === "contact") {
    rows = [
      ["Email", record.email], ["Phone", record.phone], ["Tags", record.tags.join(", ") || "—"],
    ];
  }

  $("#detailBody").innerHTML = `
    <h2>${esc(title)}</h2>
    <dl class="detail-grid">
      ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${dash(v)}</dd>`).join("")}
    </dl>`;
  $("#detailOverlay").hidden = false;
}

// ---------- CSV export ----------
function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escCsv(r[h])).join(","))].join("\n");
}

function downloadCsv(filename, rows) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Tabs ----------
function showTab(tab) {
  // A vendor tenant has no client panels. Without this guard, any tab click or a
  // cleared search box re-shows Properties/OTA/Checklists/Inventory on an account
  // that has none of those things.
  if (DATA && DATA.kind === "vendor") return renderVendor();
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  $("#searchResults").hidden = true;
  const target = $("#panel-" + tab);
  if (target) target.hidden = false;
}

// ---------- Wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  loadData();

  $("#refresh").addEventListener("click", loadData);

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    $("#search").value = "";
    showTab(btn.dataset.tab);
  });

  let debounce;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    const value = e.target.value;
    debounce = setTimeout(() => runSearch(value), 120);
  });

  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-kind]");
    if (row) openDetail(row.dataset.kind, row.dataset.id);

    const exportBtn = e.target.closest("[data-export]");
    if (exportBtn) {
      const which = exportBtn.dataset.export;
      const panel = $("#panel-reports");
      if (which === "revenue-by-property") downloadCsv("revenue-by-property.csv", JSON.parse(panel.dataset.revenueByProperty));
      if (which === "bookings-by-ota") downloadCsv("bookings-by-ota.csv", JSON.parse(panel.dataset.bookingsByOta));
    }

    const langBtn = e.target.closest(".lang-btn");
    if (langBtn) {
      statementState.lang = langBtn.dataset.lang;
      renderStatement();
    }

    if (e.target.id === "openAddExpense") openAddExpenseModal();

    if (e.target.id === "stmtPrint") window.print();
    if (e.target.id === "stmtExport") {
      const panel = $("#panel-statement");
      downloadCsv("owner-statement.csv", JSON.parse(panel.dataset.exportRows || "[]"));
    }

    const clearBtn = e.target.closest(".filter-clear");
    if (clearBtn) {
      filterState[clearBtn.dataset.tab] = {};
      renderTab(clearBtn.dataset.tab);
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "stmtProperty") {
      statementState.propertyId = e.target.value;
      statementState.month = null;
      renderStatement();
    }
    if (e.target.id === "stmtMonth") {
      statementState.month = e.target.value;
      renderStatement();
    }

    const filterSelect = e.target.closest(".filter-select");
    if (filterSelect) {
      const { tab, field } = filterSelect.dataset;
      if (filterSelect.value) filterState[tab][field] = filterSelect.value;
      else delete filterState[tab][field];
      renderTab(tab);
    }
  });

  $("#detailClose").addEventListener("click", () => ($("#detailOverlay").hidden = true));
  $("#detailOverlay").addEventListener("click", (e) => {
    if (e.target.id === "detailOverlay") $("#detailOverlay").hidden = true;
  });

  $("#addExpenseClose").addEventListener("click", () => ($("#addExpenseOverlay").hidden = true));
  $("#addExpenseOverlay").addEventListener("click", (e) => {
    if (e.target.id === "addExpenseOverlay") $("#addExpenseOverlay").hidden = true;
  });
  $("#addExpenseForm").addEventListener("submit", submitAddExpense);
});
