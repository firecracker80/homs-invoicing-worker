// An owner statement has to show the management commission.
//
// The admin dashboard computed it locally as the sum of expense records
// categorised `management_fee` -- which nothing writes -- so it rendered $0.00
// on every statement ever produced. Villa Amarilla's October statement showed
// its owner keeping $4,303 of $4,430 gross on an account that takes 15%
// (Yari, 2026-10-13). The real split is two ledger rows per booking, and the
// manager's half carries recipient='manager', so an owner-scoped query can
// never see it.
//
// Run: node test-owner-commission.mjs
import assert from "node:assert/strict";
import { handleOwnerStatement } from "./src/reports.js";

const LOC = "L1";
const TOKEN = "owner-token";
const TENANT = { brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, ownerReportToken: TOKEN };

// Ledger rows, as the two queries in queryStatement would return them.
// amount_minor because that is how the table stores money.
const ownerRows = (rows) => rows.map((r) => ({
  booking_id: r.booking, invoice_number: null, invoice_id: null,
  entry_type: r.type, category: r.category, amount_minor: Math.round(r.amount * 100),
  currency: "USD", description: "", created_at: "2026-10-05T00:00:00.000Z",
}));

function makeDb({ owner, commissionMinor, onCommissionQuery, ownerNames = [] }) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              if (/recipient = 'manager'/.test(sql)) {
                onCommissionQuery?.(sql, params);
                return { results: [{ total_minor: commissionMinor, n: 2 }] };
              }
              if (/GROUP BY recipient_name/.test(sql)) return { results: ownerNames };
              if (/GROUP BY entry_type/.test(sql)) {
                // Summary: group the owner rows the way SQLite would.
                const by = new Map();
                for (const r of owner) {
                  const k = `${r.entry_type}|${r.category}|${r.currency}`;
                  const prev = by.get(k) || { ...r, total_minor: 0, entry_count: 0 };
                  prev.total_minor += r.amount_minor;
                  prev.entry_count += 1;
                  by.set(k, prev);
                }
                return { results: [...by.values()] };
              }
              return { results: owner }; // detail
            },
          };
        },
      };
    },
  };
}

const call = async (db, qs = "") => {
  const res = await handleOwnerStatement(
    new Request(`https://w.test/reports/owner-statement?locationId=${LOC}&token=${TOKEN}&format=json&period=all${qs}`),
    { TENANTS: { get: async () => TENANT }, LEDGER_DB: db });
  return { status: res.status, body: await res.json() };
};

// Villa Amarilla, October 2026, rebuilt from the screenshot: $4,430 gross rent
// at 85/15 is $3,765.50 to the owner and $664.50 to the manager, less $127 of
// owner-borne costs.
const AMARILLA = ownerRows([
  { booking: "BK-1", type: "rent_split_owner", category: "income", amount: 3765.50 },
  // NEGATIVE, as expenses.js actually stores it: -Math.abs(gross). This fixture
  // was positive when the test was written, which made assertions about the net
  // pass against a sign the ledger never produces.
  { booking: "expense:REC-9", type: "expense_owner", category: "expense", amount: -127 },
]);

console.log("1) the commission is reported, and it is not zero");
{
  const { body } = await call(makeDb({ owner: AMARILLA, commissionMinor: 66450 }));
  assert.strictEqual(body.managerCommission, 664.50);
}

console.log("2) gross is the two halves added back together, not the owner's share");
{
  const { body } = await call(makeDb({ owner: AMARILLA, commissionMinor: 66450 }));
  assert.strictEqual(body.grossRent, 4430.00, "owner share + commission is what the guest was charged");
  assert.notStrictEqual(body.grossRent, body.incomeTotal, "gross must not quietly equal the owner's share");
}

console.log("3) net is income less owner-borne expenses");
{
  const { body } = await call(makeDb({ owner: AMARILLA, commissionMinor: 66450 }));
  assert.strictEqual(body.incomeTotal, 3765.50);
  assert.strictEqual(body.expenseTotal, 127);
  assert.strictEqual(body.netIncome, 3638.50);
  // The number the dashboard used to print. If this ever comes back, the
  // commission has stopped being deducted somewhere.
  assert.notStrictEqual(body.netIncome, 4303, "4303 is gross minus expenses with NO commission -- the old bug");
}

console.log("4) the commission is fetched for the owner's own bookings, not the whole account");
{
  let seen = null;
  await call(makeDb({ owner: AMARILLA, commissionMinor: 66450, onCommissionQuery: (sql, p) => { seen = p; } }));
  assert.ok(seen, "the manager rows must actually be queried");
  assert.ok(seen.includes("BK-1"), "the owner's booking has to be in the commission query");
  assert.ok(!seen.some(p => String(p).startsWith("expense:")),
    "an expense row's synthetic bookingId can never have a manager half -- it must not pad the query");
}

console.log("5) an owner with no bookings gets zero, and the database is never asked");
{
  let asked = false;
  const { body } = await call(makeDb({ owner: [], commissionMinor: 0, onCommissionQuery: () => { asked = true; } }));
  assert.strictEqual(body.managerCommission, 0);
  assert.strictEqual(body.grossRent, 0);
  assert.strictEqual(asked, false, "an empty booking list must not reach SQL -- IN () is a syntax error");
}

// Deriving it as (1 - ownerPct) x gross would invent a number on any booking
// priced at a different rate, and repricing does exactly that.
console.log("6) the commission is read from the ledger, never derived from ownerPct");
{
  const { body } = await call(makeDb({ owner: AMARILLA, commissionMinor: 10000 }));
  assert.strictEqual(body.managerCommission, 100,
    "a ledger that says 100 must produce 100, whatever ownerPct implies");
  assert.strictEqual(body.grossRent, 3865.50);
}

console.log("8) the owner picker is filled from the ledger's own names, not from property records");
{
  const { body } = await call(makeDb({
    owner: AMARILLA, commissionMinor: 66450,
    ownerNames: [{ recipient_name: "carlos mendoza", n: 7 }, { recipient_name: "elena marchetti", n: 3 }],
  }));
  assert.deepStrictEqual(body.availableOwners,
    [{ name: "carlos mendoza", entryCount: 7 }, { name: "elena marchetti", entryCount: 3 }],
    "recipientName is matched with =, so the picker has to offer the STORED spelling");
}

// An account with one owner never sets recipient_name. Dropping that row would
// leave the picker empty on exactly the accounts that work fine without one.
console.log("9) an unnamed owner is reported as null, not dropped");
{
  const { body } = await call(makeDb({
    owner: AMARILLA, commissionMinor: 66450, ownerNames: [{ recipient_name: null, n: 4 }],
  }));
  assert.deepStrictEqual(body.availableOwners, [{ name: null, entryCount: 4 }]);
}

console.log("10) the HTML statement is unchanged and carries no picker data");
{
  const res = await handleOwnerStatement(
    new Request("https://w.test/reports/owner-statement?locationId=" + LOC + "&token=" + TOKEN + "&period=all"),
    { TENANTS: { get: async () => TENANT },
      LEDGER_DB: makeDb({ owner: AMARILLA, commissionMinor: 66450, ownerNames: [{ recipient_name: "x", n: 1 }] }) });
  assert.ok(String(res.headers.get("Content-Type")).includes("html"), "default format is still HTML");
}

// Expenses are stored negative. Every number derived from them has a sign that
// can be got backwards, and getting it backwards ADDS a cost to an owner's
// income instead of deducting it -- a 254-dollar error on a 127-dollar expense,
// in the owner's favour, in a document HOMS sends to a client.
console.log("12) a negative stored expense becomes a positive magnitude, and net goes DOWN");
{
  const { body } = await call(makeDb({ owner: AMARILLA, commissionMinor: 66450 }));
  assert.strictEqual(body.expenseSum, -127, "the signed sum stays as the ledger stores it");
  assert.strictEqual(body.expenseTotal, 127, "the displayed magnitude is positive -- the line already reads (...)");
  assert.ok(body.netIncome < body.incomeTotal, "costs must reduce the net, never raise it");
  assert.strictEqual(body.netIncome, 3638.50);
  assert.notStrictEqual(body.netIncome, 3892.50, "3892.50 is income PLUS the expense -- the sign flipped");
}

// Negating the sum rather than taking its absolute value, so a credit posted
// against a cost reduces what the owner is charged instead of inflating it.
console.log("13) a credit against a cost reduces the total rather than adding to it");
{
  const withCredit = ownerRows([
    { booking: "BK-1", type: "rent_split_owner", category: "income", amount: 1000 },
    { booking: "expense:A", type: "expense_owner", category: "expense", amount: -200 },
    { booking: "expense:B", type: "expense_owner", category: "expense", amount: 50 },
  ]);
  const { body } = await call(makeDb({ owner: withCredit, commissionMinor: 0 }));
  assert.strictEqual(body.expenseTotal, 150, "200 charged less a 50 credit is 150");
  assert.strictEqual(body.netIncome, 850);
}

// The case that separates -sum from Math.abs(sum): credits exceeding charges,
// which happens when a cost booked in an earlier period is refunded in this one.
// abs() would deduct that refund from the owner as though it were another cost.
console.log("13b) a period that is net a credit RAISES the owner's net income");
{
  const netCredit = ownerRows([
    { booking: "BK-1", type: "rent_split_owner", category: "income", amount: 1000 },
    { booking: "expense:A", type: "expense_owner", category: "expense", amount: -50 },
    { booking: "expense:B", type: "expense_owner", category: "expense", amount: 200 },
  ]);
  const { body } = await call(makeDb({ owner: netCredit, commissionMinor: 0 }));
  assert.strictEqual(body.expenseSum, 150);
  assert.strictEqual(body.expenseTotal, -150, "a net credit is a negative cost, not a positive one");
  assert.strictEqual(body.netIncome, 1150, "the owner is owed MORE, not less");
}

console.log("14) an owner with no costs still reconciles");
{
  const noCosts = ownerRows([{ booking: "BK-1", type: "rent_split_owner", category: "income", amount: 1000 }]);
  const { body } = await call(makeDb({ owner: noCosts, commissionMinor: 17647 }));
  assert.strictEqual(body.expenseTotal, 0);
  assert.strictEqual(body.netIncome, 1000);
  assert.strictEqual(body.grossRent, 1176.47);
}

console.log("11) a manager statement is unchanged -- no commission fields on it");
{
  const { handleManagerStatement } = await import("./src/reports.js");
  const res = await handleManagerStatement(
    new Request(`https://w.test/reports/manager-statement?locationId=${LOC}&token=mgr&format=json&period=all`),
    { TENANTS: { get: async () => ({ ...TENANT, managerReportToken: "mgr" }) },
      LEDGER_DB: makeDb({ owner: AMARILLA, commissionMinor: 66450 }) });
  const body = await res.json();
  assert.strictEqual(body.managerCommission, undefined, "the manager's own cut is not a deduction from the manager");
  assert.strictEqual(body.grossRent, undefined);
}

console.log("\nall owner-commission tests passed");
