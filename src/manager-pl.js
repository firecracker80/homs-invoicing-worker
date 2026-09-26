// manager-pl.js -- the manager's own profit and loss.
//
// The owner statement answers "what do I owe the owner". The manager statement
// answers "what did the manager earn". Neither answers "did the manager's
// business make money this period", because nothing has ever subtracted what
// the manager SPENT. That is what this is for.
//
// Income: ledger_entries, recipient='manager', category='income'. Negative rows
// (cancellation reversals) net off on their own, so a refunded booking stops
// counting without any special case here.
//
// Expense: the client account's Expenses object -- but only the part the
// manager cannot recover. A cost that gets billed back to the owner is a
// RECEIVABLE, not an expense. Counting `amount` whole would show a loss the
// manager never took, which is the one error that would make this report worse
// than having no report.
//
//   manager's cost = amount - can_reimburse
//
// Two things this refuses to do rather than guess:
//   - mix currencies. A DOP expense added to USD income is a wrong number that
//     looks right. Anything needing conversion without a converted_amount is
//     excluded and listed.
//   - count unreviewed expenses in the bottom line. review_status
//     "needs_review" is reported separately, so the total is made of numbers a
//     person has actually looked at.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const round2 = (n) => Math.round(n * 100) / 100;
const fromMinor = (n) => round2((n || 0) / 100);

// GHL returns a MONETORY field as { value, currency } on a record, but older
// records and some write paths leave a bare number. Both have to read the same.
export function moneyOf(v) {
  // Number(null) and Number("") are both 0, so an empty field would read as a
  // real zero and count in the total instead of being flagged as missing. Every
  // empty form has to be rejected before it reaches Number().
  const empty = (x) => x === null || x === undefined || x === "";
  if (empty(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    if (empty(v.value)) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const currencyOf = (v, fallback) => {
  if (v && typeof v === "object" && v.currency) return String(v.currency).toUpperCase();
  return fallback ? String(fallback).toUpperCase() : null;
};

export const EXPENSE_CATEGORIES = {
  maintenance_repairs: "Maintenance & Repairs",
  cleaning_supplies: "Cleaning Supplies",
  utilities: "Utilities",
  pest_control: "Pest Control",
  landscaping: "Landscaping",
  insurance: "Insurance",
  property_tax: "Property Tax",
  management_fee: "Management Fee",
  miscellaneous: "Miscellaneous Expenses",
  other: "Other",
};

// One Expenses record -> what it costs the manager, in the report's currency.
// `issues` is the reason a record is excluded; an excluded record is always
// reported, never dropped.
export function managerExpenseOf(record, reportCurrency) {
  const p = record?.properties || {};
  const issues = [];

  const gross = moneyOf(p.amount);
  if (gross === null) issues.push("no_amount");

  // A blank can_reimburse means nothing is recoverable, which is the common
  // case. It is NOT the same as an unreadable one.
  const reimbursable = moneyOf(p.can_reimburse) ?? 0;

  // The expense's own currency wins over the amount field's, because the
  // dedicated field is what the import writes and what a person edits.
  const raw = p.currency ? String(p.currency).toUpperCase() : currencyOf(p.amount, null);
  const wanted = String(reportCurrency || "USD").toUpperCase();

  let net = gross === null ? null : round2(gross - reimbursable);

  if (net !== null && raw && raw !== wanted) {
    const converted = moneyOf(p.converted_amount);
    if (converted === null) {
      // Refusing here is the point. Adding 3,000 DOP to a USD total produces a
      // number nobody can tell is wrong.
      issues.push("unconverted_currency");
      net = null;
    } else {
      // converted_amount is the converted GROSS, so the reimbursable share has
      // to travel at the same rate rather than being subtracted in the original
      // currency.
      const rate = gross === 0 ? 0 : converted / gross;
      net = round2(converted - reimbursable * rate);
    }
  }

  const status = String(p.review_status || "").toLowerCase();
  if (status !== "approved") issues.push("not_approved");

  return {
    id: record?.id ?? null,
    name: p.expense_name ?? p.line_item_description ?? null,
    category: p.category ?? "other",
    categoryLabel: EXPENSE_CATEGORIES[p.category] || "Other",
    paidOn: p.paid_on ?? null,
    gross, reimbursable,
    net,
    currency: raw || wanted,
    reviewStatus: status || null,
    // Only a record with no issues at all reaches the bottom line.
    counted: issues.length === 0,
    issues,
  };
}

// paid_on is a date, and the window is an ISO instant. Compare as dates so a
// expense paid on the last day of the month is not pushed into the next one by
// a timezone.
export function inWindow(paidOn, from, to) {
  if (!paidOn) return false;
  const d = String(paidOn).slice(0, 10);
  return d >= String(from).slice(0, 10) && d < String(to).slice(0, 10);
}

export function summarisePL(income, expenseRows) {
  const counted = expenseRows.filter((e) => e.counted);
  const excluded = expenseRows.filter((e) => !e.counted);

  const byCategory = new Map();
  for (const e of counted) {
    const prev = byCategory.get(e.category) || { category: e.category, label: e.categoryLabel, total: 0, count: 0 };
    prev.total = round2(prev.total + e.net);
    prev.count += 1;
    byCategory.set(e.category, prev);
  }

  const expenseTotal = round2(counted.reduce((s, e) => s + e.net, 0));
  const reimbursable = round2(expenseRows.reduce((s, e) => s + (e.reimbursable || 0), 0));

  return {
    income: round2(income),
    expenses: expenseTotal,
    net: round2(income - expenseTotal),
    // Money the manager laid out and expects back. Not an expense, but they are
    // out of pocket for it until the owner settles, so it is stated.
    reimbursableOutstanding: reimbursable,
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    countedCount: counted.length,
    excluded: excluded.map((e) => ({
      id: e.id, name: e.name, paidOn: e.paidOn, gross: e.gross,
      currency: e.currency, issues: e.issues,
    })),
  };
}

export async function queryManagerIncome(env, locationId, from, to, recipientName = null) {
  const params = [locationId, from, to];
  let nameClause = "";
  if (recipientName) { nameClause = " AND recipient_name = ?4"; params.push(recipientName); }

  const res = await env.LEDGER_DB.prepare(
    `SELECT currency, SUM(amount_minor) AS total_minor, COUNT(*) AS n
       FROM ledger_entries
      WHERE location_id = ?1 AND recipient = 'manager' AND category = 'income'
        AND created_at >= ?2 AND created_at < ?3${nameClause}
      GROUP BY currency`
  ).bind(...params).all();

  const rows = res.results || [];
  // More than one currency in the ledger is a data problem, not something to
  // silently add up. Report it rather than producing a blended number.
  const byCurrency = rows.map((r) => ({ currency: r.currency, total: fromMinor(r.total_minor), entries: r.n }));
  return {
    byCurrency,
    total: byCurrency.length === 1 ? byCurrency[0].total : null,
    currency: byCurrency.length === 1 ? byCurrency[0].currency : null,
    mixedCurrency: byCurrency.length > 1,
  };
}

export async function fetchExpenseRecords(pit, locationId, { cap = 2000, pageLimit = 100 } = {}) {
  const all = [];
  let page = 1;
  while (all.length < cap) {
    const res = await fetch(`${GHL_BASE}/objects/custom_objects.expenses/records/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pit}`, Version: GHL_VERSION,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify({ locationId, page, pageLimit }),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok) {
      const err = new Error(`GHL expenses search -> ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const records = data.records || [];
    all.push(...records);
    if (records.length < pageLimit) break;
    page += 1;
  }
  return all.slice(0, cap);
}

export function buildManagerPL({ income, records, from, to, reportCurrency }) {
  const inPeriod = [];
  const undated = [];
  for (const r of records) {
    const row = managerExpenseOf(r, reportCurrency);
    if (!row.paidOn) { undated.push(row); continue; }
    if (inWindow(row.paidOn, from, to)) inPeriod.push(row);
  }

  const summary = summarisePL(income.total ?? 0, inPeriod);
  return {
    currency: reportCurrency,
    incomeByCurrency: income.byCurrency,
    mixedIncomeCurrency: income.mixedCurrency,
    ...summary,
    // An expense with no paid_on cannot be put in any period. Silently dropping
    // it is how a cost disappears from every report at once.
    undated: undated.map((e) => ({ id: e.id, name: e.name, gross: e.gross, currency: e.currency })),
  };
}
