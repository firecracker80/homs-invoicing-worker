let DATA = null;
let activeTab = "overview";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n === null || n === undefined || n === "" ? "—" : `$${Number(n).toFixed(2)}`);
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
    const label = $(".brand-sub");
    if (label && json.tenantLabel) label.firstChild.textContent = json.tenantLabel + " ";
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

// ---------- Vendor P&L (HOMS's own book) ----------
// Separate render path, not a variant of the client dashboard. Leads with burn
// and breakeven because at zero revenue that is the only honest headline -- an
// averaged "cost per client" would divide by zero and hide it.

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

function signedMoney(n) {
  const v = Number(n) || 0;
  const cls = v < 0 ? "bad" : v > 0 ? "good" : "neutral";
  return `<span class="badge ${cls}">${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}</span>`;
}

function renderVendor() {
  const { pl, expenses, transactions, subscriptions, warnings = [] } = DATA;
  const tabs = $("#tabs");
  if (tabs) tabs.hidden = true;
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = true));
  const host = $("#panel-overview");
  host.hidden = false;

  const netPerMonth = pl.revenue.mrr - pl.cost.monthlyBurn;

  // "Unavailable" and "zero" must not look the same. A failed read is stated.
  const warnHtml = warnings.length
    ? `<div class="state-msg error">${warnings
        .map((w) => `<strong>${esc(w.source)}</strong> could not be read (${esc(String(w.status))}). ${esc(w.impact)}`)
        .join("<br>")}</div>`
    : "";

  const kpis = `
    <div class="card-grid">
      <div class="stat-card"><div class="num">$${pl.cost.monthlyBurn.toFixed(2)}</div><div class="label">Fixed monthly burn</div></div>
      <div class="stat-card"><div class="num">$${pl.revenue.mrr.toFixed(2)}</div><div class="label">MRR</div></div>
      <div class="stat-card"><div class="num">${netPerMonth < 0 ? "-" : ""}$${Math.abs(netPerMonth).toFixed(2)}</div><div class="label">Net per month</div></div>
      <div class="stat-card"><div class="num">$${pl.breakeven.monthlyRevenueNeeded.toFixed(2)}</div><div class="label">Revenue needed to break even</div></div>
      <div class="stat-card"><div class="num">${pl.revenue.payingClients}</div><div class="label">Paying clients</div></div>
    </div>`;

  const burnRows =
    pl.cost.burnLines
      .map(
        (l) => `<tr>
          <td>${esc(l.name)}</td>
          <td>${dash(l.vendor)}</td>
          <td>${esc(CATEGORY_LABELS[l.category] || l.category)}</td>
          <td>${esc(RECURRENCE_LABELS[l.recurrence] || l.recurrence)}</td>
          <td>${dateFmt(l.asOf)}</td>
          <td>${money(l.monthly)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No recurring lines recorded");

  const catRows =
    Object.entries(pl.byCategory)
      .sort((a, b) => b[1].total - a[1].total)
      .map(
        ([k, v]) => `<tr>
          <td>${esc(CATEGORY_LABELS[k] || k)}</td>
          <td>${v.count}</td>
          <td>${money(v.monthly)}</td>
          <td>${money(v.total)}</td>
        </tr>`
      )
      .join("") || emptyRow(4, "No expenses recorded");

  const monthRows =
    pl.timeline
      .slice()
      .reverse()
      .map(
        (m) => `<tr>
          <td>${esc(m.month)}</td>
          <td>${money(m.revenue)}</td>
          <td>${money(m.expense)}</td>
          <td>${signedMoney(m.net)}</td>
        </tr>`
      )
      .join("") || emptyRow(4, "No dated activity yet");

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
          <td>${dateFmt(e.paidOn)}</td>
          <td>${money(e.amount)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No expenses yet");

  const txRows =
    transactions
      .map(
        (t) => `<tr>
          <td>${dash(t.contactName)}</td>
          <td>${dash(t.source)}</td>
          <td>${paymentBadge(t.status)}</td>
          <td>${t.liveMode ? "" : '<span class="badge warn">test</span>'}</td>
          <td>${dateFmt(t.paidAt)}</td>
          <td>${money(t.amount)}</td>
        </tr>`
      )
      .join("") || emptyRow(6, "No transactions yet");

  const subNote = subscriptions.length
    ? ""
    : `<p class="state-msg">No active subscriptions. ${
        warnings.some((w) => w.source === "subscriptions")
          ? "(This could not be verified — see the warning above.)"
          : "Verified against GHL, not inferred."
      }</p>`;

  const incompleteNote = pl.incompleteRecords.length
    ? `<div class="state-msg error"><strong>${pl.incompleteRecords.length} record${
        pl.incompleteRecords.length === 1 ? "" : "s"
      } missing an amount or a paid date</strong>, so ${
        pl.incompleteRecords.length === 1 ? "it is" : "they are"
      } excluded from the monthly timeline: ${pl.incompleteRecords.map((r) => esc(r.name)).join(", ")}</div>`
    : "";

  host.innerHTML = `
    ${warnHtml}
    ${kpis}
    ${incompleteNote}
    <h3>Fixed monthly burn</h3>
    <p class="state-msg">One line per subscription, valued at its most recent charge — not the sum of every recorded month.</p>
    ${table(["Line", "Vendor", "Category", "Recurrence", "As of", "Per month"], burnRows, pl.cost.burnLines.length)}
    <h3>By category</h3>
    ${table(["Category", "Records", "Per month", "Total recorded"], catRows, Object.keys(pl.byCategory).length)}
    <h3>Month by month</h3>
    ${table(["Month", "Revenue", "Expense", "Net"], monthRows, pl.timeline.length)}
    <h3>Revenue</h3>
    ${subNote}
    ${table(["Contact", "Source", "Status", "Mode", "Date", "Amount"], txRows, transactions.length)}
    <h3>All expenses</h3>
    ${table(["Expense", "Vendor", "Category", "Recurrence", "Paid on", "Amount"], expenseRows, expenses.length)}
  `;
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
    headers: ["Expense", "Paid On", "Category", "Property", "Owner", "Amount", "Review Status"],
    colspan: 7, emptyLabel: "expenses",
    extraToolbarHtml: `<div class="toolbar" style="margin-bottom:12px"><button class="btn btn-primary" id="openAddExpense">+ Add Expense</button></div>`,
    rowFn: (e) => `
    <tr data-kind="expense" data-id="${e.id}">
      <td>${dash(e.name)}</td>
      <td>${dateFmt(e.paidOn)}</td>
      <td>${dash(e.category)}</td>
      <td>${dash(e.propertyName)}</td>
      <td>${dash(e.ownerContactName)}</td>
      <td>${money(e.amount)}</td>
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
  const managementCommission = managementEx.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  const otherExpensesTotal = otherEx.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
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
        monthEx.map((x) => `<tr><td>${dateFmt(x.paidOn)}</td><td>${dash(categoryLabel(x.categoryKey, x.category))}</td><td>${dash(x.lineItemDescription)}</td><td>(${money(x.amount)})</td></tr>`).join("")
          || emptyRow(4, t("noExpenses")),
        null
      )}
    </div>
  `;

  panel.dataset.exportRows = JSON.stringify(
    monthTx.map((x) => ({ type: "reservation", name: x.name, guest: x.guestName, checkIn: x.checkinDate, checkOut: x.checkoutDate, grossRent: x.bookingTotal }))
      .concat(monthEx.map((x) => ({ type: "expense", paidOn: x.paidOn, category: categoryLabel(x.categoryKey, x.category), description: x.lineItemDescription, amount: x.amount })))
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
    const hits = (DATA.expenses || []).filter((e) =>
      [e.name, e.vendor, e.category, e.notes].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
    $("#searchResults").innerHTML = hits.length
      ? `<h3>Expenses (${hits.length})</h3>` +
        table(
          ["Expense", "Vendor", "Category", "Paid on", "Amount"],
          hits
            .map(
              (e) =>
                `<tr><td>${esc(e.name)}</td><td>${dash(e.vendor)}</td><td>${esc(
                  CATEGORY_LABELS[e.category] || e.category
                )}</td><td>${dateFmt(e.paidOn)}</td><td>${money(e.amount)}</td></tr>`
            )
            .join(""),
          hits.length
        )
      : `<p class="state-msg">No expenses match "${esc(query)}".</p>`;
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
      ["Description", record.lineItemDescription], ["Amount", money(record.amount)],
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
