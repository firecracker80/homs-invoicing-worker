// Local mock tests for the manager P&L. No network, no GHL, no D1.
// Run: node test-manager-pl.mjs
//
// The field shapes here are DEMO-HOMS's real Expenses object, read from the
// live schema 2026-09-25: amount, can_reimburse, currency, converted_amount,
// review_status, paid_on, category -- all MONETORY fields arriving as
// { value, currency }.
//
// The number this report exists to get right is the one that is easiest to get
// wrong: a cost the owner pays back is not the manager's expense.
import assert from "node:assert";

const {
  moneyOf, managerExpenseOf, inWindow, summarisePL, buildManagerPL, queryManagerIncome,
} = await import("./src/manager-pl.js");

const rec = (props, id = "e1") => ({ id, properties: props });
const usd = (v) => ({ value: v, currency: "USD" });
const approved = { review_status: "approved", paid_on: "2026-09-10", category: "utilities" };

// ---- 1. MONETORY fields arrive in more than one shape ---------------------
{
  assert.strictEqual(moneyOf({ value: 120.5, currency: "USD" }), 120.5);
  assert.strictEqual(moneyOf(120.5), 120.5, "older records carry a bare number");
  assert.strictEqual(moneyOf("120.5"), 120.5);
  assert.strictEqual(moneyOf(null), null);
  assert.strictEqual(moneyOf(""), null);
  assert.strictEqual(moneyOf({ value: null }), null);
  assert.strictEqual(moneyOf(0), 0, "zero is a real amount, not a missing one");
  console.log("1) MONETORY fields read the same whether wrapped, bare, or blank");
}

// ---- 2. a reimbursable cost is not the manager's expense ------------------
// The whole point of the report. Counting `amount` whole would show a loss the
// manager never took.
{
  const full = managerExpenseOf(rec({ ...approved, amount: usd(400), can_reimburse: usd(400) }), "USD");
  assert.strictEqual(full.net, 0, "fully recoverable costs the manager nothing");
  assert.ok(full.counted);

  const part = managerExpenseOf(rec({ ...approved, amount: usd(400), can_reimburse: usd(150) }), "USD");
  assert.strictEqual(part.net, 250);

  const none = managerExpenseOf(rec({ ...approved, amount: usd(400) }), "USD");
  assert.strictEqual(none.net, 400, "a blank Can Reimburse means nothing is recoverable");
  assert.strictEqual(none.reimbursable, 0);
  console.log("2) Only the unrecoverable share counts as the manager's expense");
}

// ---- 3. currencies are never silently mixed -------------------------------
{
  const noRate = managerExpenseOf(rec({ ...approved, amount: { value: 3000, currency: "DOP" }, currency: "DOP" }), "USD");
  assert.strictEqual(noRate.net, null);
  assert.ok(noRate.issues.includes("unconverted_currency"));
  assert.strictEqual(noRate.counted, false, "3000 DOP must never be added to a USD total");

  const withRate = managerExpenseOf(rec({
    ...approved, amount: { value: 3000, currency: "DOP" }, currency: "DOP",
    converted_amount: usd(50), exchange_rate: 60,
  }), "USD");
  assert.strictEqual(withRate.net, 50);
  assert.ok(withRate.counted);

  // converted_amount is the converted GROSS, so a reimbursable share has to
  // travel at the same rate -- subtracting 600 DOP from 50 USD would be absurd.
  const partial = managerExpenseOf(rec({
    ...approved, amount: { value: 3000, currency: "DOP" }, currency: "DOP",
    can_reimburse: { value: 600, currency: "DOP" }, converted_amount: usd(50),
  }), "USD");
  assert.strictEqual(partial.net, 40, "600/3000 of 50 USD is 10, so 40 is the manager's share");

  // Same currency as the report needs no conversion even if one is absent.
  const same = managerExpenseOf(rec({ ...approved, amount: usd(75), currency: "USD" }), "USD");
  assert.strictEqual(same.net, 75);
  console.log("3) A foreign-currency expense is converted or excluded, never guessed");
}

// ---- 4. unreviewed and unusable records stay out of the total -------------
{
  const unreviewed = managerExpenseOf(rec({ ...approved, review_status: "needs_review", amount: usd(90) }), "USD");
  assert.strictEqual(unreviewed.counted, false);
  assert.ok(unreviewed.issues.includes("not_approved"));

  const blankStatus = managerExpenseOf(rec({ paid_on: "2026-09-10", amount: usd(90) }), "USD");
  assert.strictEqual(blankStatus.counted, false, "no status is not approval");

  const noAmount = managerExpenseOf(rec({ ...approved }), "USD");
  assert.strictEqual(noAmount.counted, false);
  assert.ok(noAmount.issues.includes("no_amount"));
  console.log("4) Unreviewed, unstated and amountless expenses are excluded and say why");
}

// ---- 5. the period is read off Paid On, by date --------------------------
{
  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-10-01T00:00:00.000Z";   // half-open, as resolveWindow builds it
  assert.strictEqual(inWindow("2026-09-01", from, to), true, "the first day is in");
  assert.strictEqual(inWindow("2026-09-30", from, to), true, "the last day is in");
  assert.strictEqual(inWindow("2026-10-01", from, to), false, "the day after is out");
  assert.strictEqual(inWindow("2026-08-31", from, to), false);
  assert.strictEqual(inWindow(null, from, to), false);
  // A timestamped paid_on must not slide into the next period on a timezone.
  assert.strictEqual(inWindow("2026-09-30T23:30:00.000Z", from, to), true);
  console.log("5) Paid On decides the period, compared as dates so no day slips");
}

// ---- 6. the bottom line, and what it leaves out --------------------------
{
  const rows = [
    managerExpenseOf(rec({ ...approved, amount: usd(100), category: "utilities" }, "a"), "USD"),
    managerExpenseOf(rec({ ...approved, amount: usd(300), can_reimburse: usd(100), category: "maintenance_repairs" }, "b"), "USD"),
    managerExpenseOf(rec({ ...approved, amount: usd(50), category: "utilities" }, "c"), "USD"),
    managerExpenseOf(rec({ ...approved, amount: usd(999), review_status: "needs_review" }, "d"), "USD"),
  ];
  const pl = summarisePL(1000, rows);

  assert.strictEqual(pl.expenses, 350, "100 + 200 + 50; the unreviewed 999 is out");
  assert.strictEqual(pl.net, 650);
  assert.strictEqual(pl.countedCount, 3);
  assert.strictEqual(pl.reimbursableOutstanding, 100, "stated separately, not as a cost");

  assert.deepStrictEqual(pl.byCategory.map((c) => [c.category, c.total, c.count]),
    [["maintenance_repairs", 200, 1], ["utilities", 150, 2]], "largest category first");

  assert.deepStrictEqual(pl.excluded.map((e) => e.id), ["d"], "and the excluded one is named");
  console.log("6) The total is built only from reviewed, convertible expenses, and names the rest");
}

// ---- 7. a loss reads as a loss -------------------------------------------
{
  const rows = [managerExpenseOf(rec({ ...approved, amount: usd(800) }), "USD")];
  const pl = summarisePL(500, rows);
  assert.strictEqual(pl.net, -300);
  console.log("7) A loss comes through as a negative net, not an absolute value");
}

// ---- 8. refunds net off on their own ------------------------------------
// Cancellation reversals are negative income rows, so a refunded booking stops
// counting without the P&L needing to know what a cancellation is.
{
  const pl = summarisePL(1000 - 400, [managerExpenseOf(rec({ ...approved, amount: usd(100) }), "USD")]);
  assert.strictEqual(pl.income, 600);
  assert.strictEqual(pl.net, 500);
  console.log("8) A refunded booking reduces income through the ledger, with no special case here");
}

// ---- 9. undated expenses are surfaced, not dropped ----------------------
// An expense with no Paid On belongs to no period, so it would otherwise vanish
// from every statement at once and nobody would ever see it missing.
{
  const pl = buildManagerPL({
    income: { total: 500, byCurrency: [{ currency: "USD", total: 500, entries: 2 }], mixedCurrency: false },
    records: [
      rec({ ...approved, amount: usd(100) }, "dated"),
      rec({ review_status: "approved", amount: usd(70), category: "other" }, "undated"),
    ],
    from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", reportCurrency: "USD",
  });
  assert.strictEqual(pl.expenses, 100, "the undated one is not in the total");
  assert.deepStrictEqual(pl.undated.map((u) => u.id), ["undated"], "but it is reported");
  assert.strictEqual(pl.net, 400);
  console.log("9) An expense with no Paid On is reported rather than vanishing from every period");
}

// ---- 10. mixed ledger currency refuses to total -------------------------
{
  const pl = buildManagerPL({
    income: {
      total: null, mixedCurrency: true,
      byCurrency: [{ currency: "USD", total: 500, entries: 1 }, { currency: "DOP", total: 30000, entries: 1 }],
    },
    records: [rec({ ...approved, amount: usd(100) })],
    from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", reportCurrency: "USD",
  });
  assert.strictEqual(pl.mixedIncomeCurrency, true);
  assert.strictEqual(pl.income, 0, "no blended income figure is invented");
  assert.deepStrictEqual(pl.incomeByCurrency.map((c) => c.currency), ["USD", "DOP"], "both are shown instead");
  console.log("10) A ledger holding two currencies reports both rather than adding them");
}

// ---- 11. the income query asks only for the manager's own earnings -------
{
  let sql = "", bound = [];
  const env = {
    LEDGER_DB: {
      prepare(q) {
        sql = q;
        return { bind: (...a) => { bound = a; return { all: async () => ({ results: [{ currency: "USD", total_minor: 123400, n: 3 }] }) }; } };
      },
    },
  };
  const out = await queryManagerIncome(env, "loc1", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
  assert.ok(sql.includes("recipient = 'manager'"), "manager rows only");
  assert.ok(sql.includes("category = 'income'"),
    "income only -- shadow, pass_through and liability rows are not earnings");
  assert.deepStrictEqual(bound, ["loc1", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  assert.strictEqual(out.total, 1234, "minor units convert to currency");
  assert.strictEqual(out.mixedCurrency, false);

  const named = await queryManagerIncome(env, "loc1", "a", "b", "Rosa Jimenez");
  assert.ok(sql.includes("recipient_name = ?4"), "a named manager narrows further");
  assert.deepStrictEqual(bound, ["loc1", "a", "b", "Rosa Jimenez"]);
  assert.ok(named.total >= 0);

  // Two currencies in the ledger must NOT be added. A blended total is the
  // worst possible output here: plausible, precise, and meaningless.
  const mixedEnv = {
    LEDGER_DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [
        { currency: "USD", total_minor: 50000, n: 1 },
        { currency: "DOP", total_minor: 3000000, n: 1 },
      ] }) }) }),
    },
  };
  const mixed = await queryManagerIncome(mixedEnv, "loc1", "a", "b");
  assert.strictEqual(mixed.mixedCurrency, true);
  assert.strictEqual(mixed.total, null, "500 USD and 30000 DOP have no sum");
  assert.strictEqual(mixed.currency, null);
  assert.deepStrictEqual(mixed.byCurrency.map((c) => [c.currency, c.total]), [["USD", 500], ["DOP", 30000]]);
  console.log("11) Income comes only from the manager's own income rows, optionally by name");
}

// ---- 12. the route: gated, and readable in an iframe --------------------
{
  const { handleManagerPL } = await import("./src/reports.js");
  const expenses = [rec({ ...approved, amount: usd(100) })];
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(String(url).includes("/records/search") ? { records: expenses } : {}),
  });

  const env = {
    TENANTS: {
      get: async () => ({
        brandName: "Casa Bonita", currency: "USD",
        managerReportToken: "mtok", ownerReportToken: "otok",
        adminSecret: "adm", ghlPit: "pit",
      }),
    },
    LEDGER_DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ currency: "USD", total_minor: 100000, n: 2 }] }) }) }),
    },
  };
  const call = (qs, headers = {}) => handleManagerPL(new Request(`https://w.dev/reports/manager-pl?${qs}`, { headers }), env);

  assert.strictEqual((await call("locationId=loc1")).status, 401, "no token, no report");
  assert.strictEqual((await call("locationId=loc1&token=otok")).status, 401,
    "the owner's token must not open the manager's P&L");
  assert.strictEqual((await call("")).status, 400, "locationId required");

  const ok = await call("locationId=loc1&token=mtok&from=2026-09-01&to=2026-09-30&format=json");
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.strictEqual(body.income, 1000);
  assert.strictEqual(body.expenses, 100);
  assert.strictEqual(body.net, 900);
  assert.strictEqual(body.currency, "USD");

  // The admin header works too, same as the other statements.
  assert.strictEqual((await call("locationId=loc1&format=json", { "X-Admin-Secret": "adm" })).status, 200);

  // HTML is the default, because this is opened in a GHL menu link.
  const page = await call("locationId=loc1&token=mtok");
  assert.strictEqual(page.headers.get("Content-Type")?.includes("text/html"), true);
  const text = await page.text();
  assert.ok(text.includes("Casa Bonita"), "the brand is on the page");
  assert.ok(/Manager P&amp;L/.test(text));
  assert.ok(text.includes("USD 900.00"), "the net is rendered");
  console.log("12) Gated by the manager's own token, renders HTML for an iframe, JSON on request");
}

// ---- 13. the page says what it left out --------------------------------
{
  const { handleManagerPL } = await import("./src/reports.js");
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(String(url).includes("/records/search") ? {
      records: [
        rec({ ...approved, amount: usd(100), review_status: "needs_review" }, "x"),
        rec({ ...approved, amount: { value: 3000, currency: "DOP" }, currency: "DOP" }, "y"),
        rec({ review_status: "approved", amount: usd(40), category: "other" }, "z"),
      ],
    } : {}),
  });
  const env = {
    TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
    LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ currency: "USD", total_minor: 50000, n: 1 }] }) }) }) },
  };
  const text = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t"), env)).text();

  assert.ok(/still say/.test(text), "the unreviewed expense is called out");
  assert.ok(/no converted amount/.test(text), "so is the unconvertible one");
  assert.ok(/no Paid On date/.test(text), "and the undated one");
  assert.ok(text.includes("USD 500.00"), "income still totals");
  console.log("13) Every excluded expense is stated on the page, not quietly omitted");
}

console.log("\nPASS — manager P&L: a reimbursable cost is not an expense, currencies are never mixed, and nothing is quietly left out.");
