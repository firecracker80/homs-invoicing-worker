// vendor.js -- P&L for HOMS's own book.
//
// HOMS is the software business, not a client account. It holds no properties,
// no bookings, no guests. So this is a completely different data shape from
// handleData()'s six client objects, which is why it branches on tenant.kind
// rather than trying to be a variant of it.
//
// Deliberately has NO client dimension. HOMS's costs are HOMS's costs; per-client
// economics is a separate question and is not modelled here.
//
// Revenue comes from GHL natively (payments). Expenses come from the
// custom_objects.expenses object, which is fed by the Gmail sweep, the dashboard
// modal, and CSV import.

import { fetchAllObjectRecords, fetchSubscriptions, fetchTransactions } from "./ghl.js";

const EXPENSE_OBJECT = "custom_objects.expenses";

// Revenue that never touches GHL -- Upwork contracts, partner earnings paid by
// bank transfer. Without this the P&L reads only what GHL processed and reports
// a zero that looks real: the worst asymmetry a P&L can have, since expenses are
// captured thoroughly while income is captured by accident.
const REVENUE_OBJECT = "custom_objects.revenue_entries";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// GHL MONETORY fields come back as { value, currency }; everything else is scalar.
const money = (v) => (v && typeof v === "object" ? num(v.value) : num(v));

const monthKey = (iso) => (iso ? String(iso).slice(0, 7) : null);

export function normalizeVendorExpense(record) {
  const p = record.properties || {};
  return {
    id: record.id,
    name: p.expense_name || "(unnamed)",
    vendor: p.vendor || null,
    category: p.category || "other",
    amount: money(p.amount),
    currency: (p.currency || "usd").toUpperCase(),
    paidOn: p.paid_on || null,
    month: monthKey(p.paid_on),
    recurrence: p.recurrence || "one_off",
    billingPeriod: p.billing_period || null,
    source: p.source || null,
    notes: p.notes || null,
    // A record that can't be placed in time can't appear in a monthly P&L.
    // Surfaced rather than silently dropped.
    incomplete: !p.paid_on || !money(p.amount),
  };
}

export function normalizeRevenueEntry(record) {
  const p = record.properties || {};
  // GHL MONETORY fields reject negative values, so a refund is stored as a
  // positive magnitude with entry_type "adjustment" and negated here. Without
  // this, refunds inflate revenue instead of reducing it.
  const isAdjustment = (p.entry_type || "earning") === "adjustment";
  const sign = isAdjustment ? -1 : 1;
  const gross = money(p.gross_amount) * sign;
  const fees = money(p.fees) * sign;
  const net = money(p.net_amount) * sign;
  return {
    id: record.id,
    name: p.revenue_name || "(unnamed)",
    payer: p.payer || null,
    source: p.source || "other",
    gross,
    fees,
    // Trust a stored net, but fall back to gross-less-fees so a half-filled
    // record still contributes something sane instead of a silent zero.
    entryType: isAdjustment ? "adjustment" : "earning",
    net: net || gross - fees,
    currency: (p.currency || "usd").toUpperCase(),
    receivedOn: p.received_on || null,
    month: monthKey(p.received_on),
    period: p.period || null,
    provenance: p.provenance || null,
    notes: p.notes || null,
    // Aggregated rows (a whole-period Upwork export) have no single date, so
    // they can total correctly but cannot sit in a month. Flagged, not dropped.
    undated: !p.received_on,
  };
}

export function normalizeSubscription(sub) {
  return {
    id: sub._id || sub.id,
    contactName: sub.contactName || null,
    contactEmail: sub.contactEmail || null,
    amount: num(sub.amount),
    currency: (sub.currency || "usd").toUpperCase(),
    status: sub.status || null,
    liveMode: sub.liveMode !== false,
    startedAt: sub.subscriptionStartDate || sub.createdAt || null,
    source: sub.entitySourceName || null,
  };
}

export function normalizeVendorTransaction(tx) {
  return {
    id: tx._id || tx.id,
    contactName: tx.contactName || null,
    contactEmail: tx.contactEmail || null,
    amount: num(tx.amount),
    currency: (tx.currency || "usd").toUpperCase(),
    status: tx.status || null,
    liveMode: tx.liveMode !== false,
    paidAt: tx.createdAt || null,
    month: monthKey(tx.createdAt),
    source: tx.entitySourceName || null,
  };
}

// Pure. State in, P&L out -- no I/O, so it is unit-testable without GHL.
export function computePL({ expenses, subscriptions, transactions, revenue = [] }) {
  // Only money that actually moved counts as revenue. A pending or failed charge
  // is not income, and counting it is how a P&L starts lying.
  const collected = transactions.filter((t) => t.liveMode && /succeeded|paid|completed/i.test(t.status || ""));
  const activeSubs = subscriptions.filter((s) => s.liveMode && /active|trialing/i.test(s.status || ""));

  const mrr = activeSubs.reduce((sum, s) => sum + s.amount, 0);

  // Fixed burn: what recurs every month regardless of activity. Annual is
  // amortised; one-offs are excluded by design -- they are not burn.
  //
  // Recurring lines are DEDUPED, not summed. A monthly subscription produces one
  // record per billing period, so summing every monthly record counts the same
  // subscription once per month it has been recorded -- an error that grows every
  // month. One subscription is one burn line, valued at its most recent charge.
  const recurring = expenses.filter((e) => e.recurrence === "monthly" || e.recurrence === "annual");
  const latestByLine = new Map();
  for (const e of recurring) {
    const key = `${(e.vendor || "").toLowerCase()}|${e.name.toLowerCase()}`;
    const prev = latestByLine.get(key);
    if (!prev || String(e.paidOn || "") > String(prev.paidOn || "")) latestByLine.set(key, e);
  }
  const burnLines = [...latestByLine.values()].map((e) => ({
    vendor: e.vendor,
    name: e.name,
    category: e.category,
    monthly: e.recurrence === "annual" ? e.amount / 12 : e.amount,
    recurrence: e.recurrence,
    asOf: e.paidOn,
  }));
  const monthlyBurn = burnLines.reduce((sum, l) => sum + l.monthly, 0);

  // total = everything ever recorded; monthly = deduped recurring lines only.
  const byCategory = {};
  for (const e of expenses) {
    if (!byCategory[e.category]) byCategory[e.category] = { total: 0, monthly: 0, count: 0 };
    byCategory[e.category].total += e.amount;
    byCategory[e.category].count += 1;
  }
  for (const l of burnLines) {
    if (!byCategory[l.category]) byCategory[l.category] = { total: 0, monthly: 0, count: 0 };
    byCategory[l.category].monthly += l.monthly;
  }

  const byVendor = {};
  for (const e of expenses) {
    const k = e.vendor || "(unknown)";
    if (!byVendor[k]) byVendor[k] = { total: 0, monthly: 0, count: 0 };
    byVendor[k].total += e.amount;
    byVendor[k].count += 1;
  }
  for (const l of burnLines) {
    const k = l.vendor || "(unknown)";
    if (!byVendor[k]) byVendor[k] = { total: 0, monthly: 0, count: 0 };
    byVendor[k].monthly += l.monthly;
  }

  // Month-by-month actuals, from what was really paid on both sides.
  const months = {};
  const touch = (m) => (months[m] = months[m] || { month: m, revenue: 0, expense: 0, net: 0 });
  for (const e of expenses) if (e.month) { touch(e.month).expense += e.amount; }
  for (const t of collected) if (t.month) { touch(t.month).revenue += t.amount; }
  // net is computed once, after recorded revenue is folded in below.

  const totalExpense = expenses.reduce((s, e) => s + e.amount, 0);
  const totalRevenue = collected.reduce((s, t) => s + t.amount, 0);

  // Recorded revenue: everything earned outside GHL. Kept separate from GHL's own
  // collected figure so it is always visible which half came from where.
  const recordedGross = revenue.reduce((s, r) => s + r.gross, 0);
  const recordedFees = revenue.reduce((s, r) => s + r.fees, 0);
  const recordedNet = revenue.reduce((s, r) => s + r.net, 0);

  const grossRevenue = totalRevenue + recordedGross;
  const netRevenue = totalRevenue + recordedNet;

  const bySource = {};
  for (const r of revenue) {
    if (!bySource[r.source]) bySource[r.source] = { gross: 0, fees: 0, net: 0, count: 0 };
    bySource[r.source].gross += r.gross;
    bySource[r.source].fees += r.fees;
    bySource[r.source].net += r.net;
    bySource[r.source].count += 1;
  }
  if (totalRevenue) bySource.ghl = { gross: totalRevenue, fees: 0, net: totalRevenue, count: collected.length };

  const byPayer = {};
  for (const r of revenue) {
    const k = r.payer || "(unknown)";
    if (!byPayer[k]) byPayer[k] = { gross: 0, net: 0, count: 0 };
    byPayer[k].gross += r.gross;
    byPayer[k].net += r.net;
    byPayer[k].count += 1;
  }

  // Dated revenue only -- undated aggregate rows would otherwise dump a whole
  // period's earnings into one arbitrary month.
  for (const r of revenue) if (r.month) touch(r.month).revenue += r.net;
  for (const m of Object.values(months)) m.net = m.revenue - m.expense;
  const timeline = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));

  return {
    revenue: {
      mrr,
      totalCollected: totalRevenue,
      recordedGross,
      recordedFees,
      recordedNet,
      grossRevenue,
      netRevenue,
      bySource,
      byPayer,
      undatedRevenue: revenue.filter((r) => r.undated).map((r) => ({ id: r.id, name: r.name, payer: r.payer, net: r.net, period: r.period })),
      activeSubscriptions: activeSubs.length,
      payingClients: new Set(activeSubs.map((s) => s.contactEmail).filter(Boolean)).size,
    },
    cost: {
      monthlyBurn,
      totalRecorded: totalExpense,
      recurringLineCount: burnLines.length,
      burnLines: burnLines.sort((a, b) => b.monthly - a.monthly),
    },
    // The number that actually matters pre-revenue: what has to come in each
    // month before the business stops losing money. With zero clients this is
    // the whole story, and an averaged "cost per client" would hide it.
    breakeven: {
      monthlyRevenueNeeded: Math.max(0, monthlyBurn - mrr),
      covered: mrr >= monthlyBurn,
    },
    byCategory,
    byVendor,
    timeline,
    incompleteRecords: expenses.filter((e) => e.incomplete).map((e) => ({ id: e.id, name: e.name })),
  };
}

// Each source degrades independently. A missing scope on one endpoint should cost
// you that section, not the whole P&L -- the client-side handleData() fails
// all-or-nothing on a single Promise.all and that is worth not repeating here.
// Failures are reported in `warnings` so a silent zero is never mistaken for a
// real zero: "no subscriptions" and "couldn't read subscriptions" must not look
// the same on screen.
async function settle(label, promise) {
  try {
    return { label, ok: true, value: await promise };
  } catch (err) {
    return {
      label,
      ok: false,
      value: [],
      error: err.message || String(err),
      status: err.status || null,
    };
  }
}

export async function handleVendorData(pit, locationId) {
  const [expensesRes, subsRes, txsRes, revRes] = await Promise.all([
    settle("expenses", fetchAllObjectRecords(pit, locationId, EXPENSE_OBJECT)),
    settle("subscriptions", fetchSubscriptions(pit, locationId)),
    settle("transactions", fetchTransactions(pit, locationId)),
    settle("revenue", fetchAllObjectRecords(pit, locationId, REVENUE_OBJECT)),
  ]);

  // Expenses are the one source with no fallback -- without them there is no P&L.
  if (!expensesRes.ok) {
    const err = new Error(`Could not read expenses: ${expensesRes.error}`);
    err.status = expensesRes.status || 502;
    throw err;
  }

  const expenses = expensesRes.value.map(normalizeVendorExpense);
  const subscriptions = subsRes.value.map(normalizeSubscription);
  const transactions = txsRes.value.map(normalizeVendorTransaction);
  const revenue = revRes.value.map(normalizeRevenueEntry);

  // A 404 on the revenue object means this account simply doesn't track recorded
  // revenue (HOMS takes its income through GHL payments; only DTCS books Upwork
  // and partner earnings). That is a genuine zero, not a failed read, so it must
  // not raise a warning. Any other failure on it still does.
  const revenueNotConfigured = !revRes.ok && revRes.status === 404;

  const warnings = [subsRes, txsRes, revRes]
    .filter((r) => !r.ok)
    .filter((r) => !(r.label === "revenue" && revenueNotConfigured))
    .map((r) => ({
      source: r.label,
      status: r.status,
      message: r.error,
      impact:
        r.label === "subscriptions"
          ? "MRR and paying-client count are unavailable, not zero."
          : r.label === "revenue"
            ? "Recorded revenue (Upwork, partner earnings) is unavailable, not zero. This account may not have the revenue object."
            : "GHL-collected revenue is unavailable, not zero.",
    }));

  return {
    fetchedAt: new Date().toISOString(),
    locationId,
    kind: "vendor",
    warnings,
    revenueTracked: !revenueNotConfigured,
    pl: computePL({ expenses, subscriptions, transactions, revenue }),
    expenses,
    revenue,
    subscriptions,
    transactions,
  };
}
