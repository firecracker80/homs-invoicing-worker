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


// --- cleaning margin --------------------------------------------------------
//
// The ledger credits the whole cleaning fee to the manager, and until
// 2026-10-01 nothing anywhere subtracted the cleaner. Yari, that day: the
// cleaner IS paid out of the retained fee. So a manager statement built on the
// ledger alone reports the gross fee as earnings -- on DEMO-HOMS that was
// 1,125.00 of "income" most of which belonged to somebody else.
//
// The cost lives on the cleaning job rather than in Expenses, because the job
// already knows the property, the booking, the date, the cleaner and the
// turnover type. An expense record would only know the month, and deep cleans
// cost more than standard turnovers.
//
// Cash basis, like the rest of this module: a job counts in the period the
// cleaner was PAID. A job with a cost and no payment date is money the manager
// still owes, reported separately rather than silently counted or silently
// dropped.

export async function fetchCleaningJobs(pit, locationId, { cap = 2000, pageLimit = 100 } = {}) {
  const all = [];
  let page = 1;
  while (all.length < cap) {
    const res = await fetch(`${GHL_BASE}/objects/custom_objects.jobs_tmpl/records/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pit}`, Version: GHL_VERSION,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify({ locationId, page, pageLimit }),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    // An account that has not got the object at all has no cleaning jobs; that
    // is not an outage, and it must not take the whole P&L down with it.
    if (res.status === 404) return all;
    if (!res.ok) {
      const err = new Error(`GHL cleaning jobs search -> ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
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

export const TURNOVER_TYPES = {
  standard_turnover: "Standard Turnover",
  deep_clean: "Deep Clean",
  midstay_clean: "Mid-Stay Clean",
};

export function cleaningJobOf(record) {
  const p = record?.properties || {};
  const cost = moneyOf(p.cleaner_cost);
  return {
    id: record?.id ?? null,
    name: p.job_name ?? null,
    propertyName: p.property_name ?? null,
    bookingReference: p.booking_reference ?? null,
    cleaner: p.cleaner_name__service ?? null,
    turnover: p.turnover_type ?? null,
    turnoverLabel: TURNOVER_TYPES[p.turnover_type] || null,
    completedOn: p.completion_date ?? null,
    paidOn: p.cleaner_paid_on ?? null,
    cost,
    // A job with no cost recorded is the thing that silently overstates the
    // margin, so it is carried as a fact rather than as an absence.
    hasCost: cost !== null,
  };
}

// `collected` is what the ledger already credited the manager for cleaning --
// the fee net of any cleaning refunded on cancellation. Passed in rather than
// re-queried so there is one definition of it.
export function buildCleaningSummary({ jobs, collected, from, to }) {
  const rows = jobs.map(cleaningJobOf);

  const paidInPeriod = [];
  const owed = [];
  const noCost = [];

  for (const j of rows) {
    if (!j.hasCost) {
      // Only jobs that fall in the window can overstate THIS period.
      if (inWindow(j.paidOn || j.completedOn, from, to)) noCost.push(j);
      continue;
    }
    if (!j.paidOn) { owed.push(j); continue; }
    if (inWindow(j.paidOn, from, to)) paidInPeriod.push(j);
  }

  const paidToCleaners = round2(paidInPeriod.reduce((s, j) => s + j.cost, 0));
  const byTurnover = new Map();
  for (const j of paidInPeriod) {
    const key = j.turnover || "other";
    const prev = byTurnover.get(key) || { turnover: key, label: j.turnoverLabel || "Other", total: 0, count: 0 };
    prev.total = round2(prev.total + j.cost);
    prev.count += 1;
    byTurnover.set(key, prev);
  }

  // What was kept on cleaning is fee MINUS cleaner, so it can only be stated
  // when the cleaner side is known. With no cost recorded anywhere, "collected
  // - 0" is not a margin earned at no cost -- it is an unknown presented as a
  // fact, and it was being printed as the manager's profit on cleaning.
  //
  // Three states, not two:
  //   exact    every clean in the period has a cost
  //   ceiling  some do; the real figure can only be LOWER than this
  //   unknown  none do; there is no figure to give
  const costMissing = noCost.length;
  const marginKnown = !(costMissing > 0 && paidInPeriod.length === 0);
  const marginIsCeiling = marginKnown && costMissing > 0;

  return {
    collected: round2(collected || 0),
    paidToCleaners,
    margin: round2((collected || 0) - paidToCleaners),
    marginKnown,
    marginIsCeiling,
    costMissing,
    jobsCounted: paidInPeriod.length,
    byTurnover: [...byTurnover.values()].sort((a, b) => b.total - a.total),
    // Cleans done in this period with no cost on them. Every one of these makes
    // the margin above too high, and by an unknown amount -- which is why the
    // count is reported beside the figure rather than in a footnote.
    jobsWithoutCost: noCost.map((j) => ({
      id: j.id, name: j.name, propertyName: j.propertyName,
      completedOn: j.completedOn, cleaner: j.cleaner,
    })),
    // Cleaners who have done the work and not been paid. Not an expense this
    // period on a cash basis, but the manager owes it, so it is stated.
    unpaidCleaners: round2(owed.reduce((s, j) => s + j.cost, 0)),
    unpaidCleanerJobs: owed.length,
  };
}

// How much of the manager's income was cleaning. Needed on its own because the
// margin is fee-minus-cleaner, and the fee is only one slice of their income.
// A cancellation that refunds the cleaning nets off here, same as everywhere.
export async function queryManagerCleaningIncome(env, locationId, from, to, recipientName = null) {
  const params = [locationId, from, to];
  let nameClause = "";
  if (recipientName) { nameClause = " AND recipient_name = ?4"; params.push(recipientName); }

  const res = await env.LEDGER_DB.prepare(
    `SELECT SUM(amount_minor) AS total_minor
       FROM ledger_entries
      WHERE location_id = ?1 AND recipient = 'manager'
        AND entry_type IN ('cleaning_fee', 'cancellation_cleaning_refund')
        AND created_at >= ?2 AND created_at < ?3${nameClause}`
  ).bind(...params).all();

  return fromMinor(res.results?.[0]?.total_minor ?? 0);
}


// --- owner payouts ----------------------------------------------------------
//
// "What do I owe each owner this period" existed nowhere. The manager opened
// each owner's statement one at a time and added them up by hand, which is why
// Yari asked for this beside the manager statement rather than as its own link
// -- it is the manager's payout run, and an owner must never see it.
//
// Only possible since the recipient_name backfill of 2026-10-01: before that,
// 52 of the owner rows carried no name at all and could not be attributed to
// anybody.
//
// IMPORTANT: this is what the period GENERATED for each owner, not an accounts
// payable balance. Nothing in the ledger records that a payout was actually
// made, so a manager who has already paid Carlos will still see Carlos here.
// The page has to say so; implying otherwise would have a manager pay twice.
export async function queryOwnerPayouts(env, locationId, from, to) {
  const res = await env.LEDGER_DB.prepare(
    `SELECT recipient_name, currency,
            SUM(amount_minor) AS total_minor,
            COUNT(*) AS n
       FROM ledger_entries
      WHERE location_id = ?1 AND recipient = 'owner' AND category = 'income'
        AND created_at >= ?2 AND created_at < ?3
      GROUP BY recipient_name, currency`
  ).bind(locationId, from, to).all();

  const rows = res.results || [];
  const byName = new Map();
  let unattributed = null;

  for (const r of rows) {
    const total = fromMinor(r.total_minor);
    // A row with no name cannot be paid to anybody. It is reported as its own
    // line rather than dropped, because a missing payout is the one error a
    // manager would not notice until an owner complained.
    const key = r.recipient_name || null;
    if (key === null) {
      unattributed = {
        owed: round2((unattributed?.owed || 0) + total),
        entries: (unattributed?.entries || 0) + r.n,
      };
      continue;
    }
    const prev = byName.get(key) || { name: key, owed: 0, entries: 0, currencies: new Set() };
    prev.owed = round2(prev.owed + total);
    prev.entries += r.n;
    prev.currencies.add(String(r.currency || "").toUpperCase());
    byName.set(key, prev);
  }

  const owners = [...byName.values()]
    .map((o) => ({
      name: o.name,
      owed: o.owed,
      entries: o.entries,
      // Two currencies for one owner cannot be added. Said, not blended.
      mixedCurrency: o.currencies.size > 1,
      currency: o.currencies.size === 1 ? [...o.currencies][0] : null,
    }))
    .sort((a, b) => b.owed - a.owed);

  return {
    owners,
    total: round2(owners.reduce((s, o) => s + o.owed, 0)),
    unattributed,
  };
}

export function buildManagerPL({ income, records, from, to, reportCurrency, jobs = [], cleaningCollected = 0 }) {
  const inPeriod = [];
  const undated = [];
  for (const r of records) {
    const row = managerExpenseOf(r, reportCurrency);
    if (!row.paidOn) { undated.push(row); continue; }
    if (inWindow(row.paidOn, from, to)) inPeriod.push(row);
  }

  const summary = summarisePL(income.total ?? 0, inPeriod);
  // What the cleaner was paid is a real cost of earning the cleaning fee, so it
  // comes off the bottom line as well as being reported on its own. It is never
  // reimbursable: the manager is paid the fee precisely so they can pay it.
  const cleaning = buildCleaningSummary({ jobs, collected: cleaningCollected, from, to });
  return {
    currency: reportCurrency,
    cleaning,
    incomeByCurrency: income.byCurrency,
    mixedIncomeCurrency: income.mixedCurrency,
    ...summary,
    // AFTER the spread, deliberately. summarisePL knows nothing about cleaners,
    // so spreading it last would quietly restore its own expenses and net and
    // the cleaner cost would vanish from the bottom line while still being
    // reported above it -- a statement disagreeing with itself.
    expensesBeforeCleaners: summary.expenses,
    expenses: round2(summary.expenses + cleaning.paidToCleaners),
    net: round2(summary.net - cleaning.paidToCleaners),
    // A clean with no cost recorded is a cost missing from this net, so the
    // real figure is lower. Said here rather than only in the cleaning block:
    // somebody reading just the top three lines is reading an overstatement.
    netIsCeiling: cleaning.costMissing > 0,
    // An expense with no paid_on cannot be put in any period. Silently dropping
    // it is how a cost disappears from every report at once.
    undated: undated.map((e) => ({ id: e.id, name: e.name, gross: e.gross, currency: e.currency })),
  };
}
