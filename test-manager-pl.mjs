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
// paid_by is part of the shared fixture because, since attribution shipped, an
// expense that does not say whose it is counts against nobody. These cases are
// all about the MANAGER's own costs, so that is what they declare. The owner
// side, and the unattributed case, get their own cases at the end.
const approved = { review_status: "approved", paid_on: "2026-09-10", category: "utilities", paid_by: "manager" };

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

// ---- 14. a reimbursable in another currency is converted, not relabelled ----
// Yari, 2026-10-05, reading her own statement: "the recoverable amount that is
// the dop expenses should not reflect usd if they are not usd, that is
// misleading and problematic."
//
// The expense TOTAL already converted correctly. reimbursableOutstanding did
// not: it summed the raw can_reimburse and the page printed it with the report
// currency's symbol. Her real record is below -- 150 DOP shown as US$150.00,
// about 59x the true figure, on every statement of every account that spends in
// DOP. The figure was not merely mislabelled; it was added to a USD total.
{
  // DEMO-HOMS expense 6aa945f0491c584adfd0c0f0, verbatim in the fields that matter.
  const dopExpense = {
    id: "e-dop",
    properties: {
      expense_name: "RL Santana Refrigeración",
      category: "maintenance_repairs",
      amount: { currency: "default", value: 150 },
      paid_on: "2026-09-15",
      review_status: "approved",
      currency: "dop",
      converted_amount: { currency: "default", value: 2.54 },
      exchange_rate: 0.016961163,
      can_reimburse: { currency: "default", value: 150 },
    },
  };

  const row = managerExpenseOf(dopExpense, "USD");
  assert.strictEqual(row.reimbursable, 150, "what the record says, in the currency the record says it in");
  assert.strictEqual(row.currency, "DOP");
  assert.ok(Math.abs(row.reimbursableInReport - 2.54) < 0.01,
    `150 DOP is about US$2.54, not US$150.00 (got ${row.reimbursableInReport})`);

  const pl = summarisePL(1000, [row]);
  assert.ok(Math.abs(pl.reimbursableOutstanding - 2.54) < 0.01,
    "and the total is the converted figure, which is what the US$ symbol beside it claims");
  assert.notStrictEqual(pl.reimbursableOutstanding, 150, "the exact bug Yari caught");

  // The original is still reported, so DOP can be seen as DOP rather than only
  // as its converted shadow -- which is what she actually asked for.
  assert.deepStrictEqual(pl.reimbursableByCurrency, [{ currency: "DOP", total: 150, entries: 1 }]);
  assert.deepStrictEqual(pl.reimbursableUnconvertible, []);
  console.log("14) A reimbursable recorded in DOP is converted before totalling, and still shown as DOP");
}

// ---- 15. an account already in the report currency is untouched -----
// Every tenant that spends in its own currency, which is most of them. A fix
// that "converts" those too would be a rate applied to nothing.
{
  const plain = managerExpenseOf({
    id: "e-usd",
    properties: {
      expense_name: "Pest Control", amount: { value: 35 }, paid_on: "2026-09-10",
      review_status: "approved", can_reimburse: { value: 35 },
    },
  }, "USD");
  assert.strictEqual(plain.reimbursableInReport, 35, "no conversion, no rounding drift");
  const pl = summarisePL(100, [plain]);
  assert.strictEqual(pl.reimbursableOutstanding, 35);
  assert.deepStrictEqual(pl.reimbursableByCurrency, [{ currency: "USD", total: 35, entries: 1 }]);
  console.log("15) An expense already in the report currency is passed through untouched");
}

// ---- 16. no rate means no total, and the record is named --------------
// The same refusal the expense total already makes. A reimbursable that cannot
// be converted must not silently vanish from the sum -- that leaves a figure
// short by an unknown amount, which is the failure this line just had.
{
  const noRate = managerExpenseOf({
    id: "e-norate",
    properties: {
      expense_name: "Ferretería", amount: { value: 900 }, paid_on: "2026-09-12",
      review_status: "approved", currency: "dop", can_reimburse: { value: 900 },
    },
  }, "USD");
  assert.strictEqual(noRate.reimbursableInReport, null, "nothing to convert it with");

  const good = managerExpenseOf({
    id: "e-ok",
    properties: {
      expense_name: "Pest Control", amount: { value: 35 }, paid_on: "2026-09-10",
      review_status: "approved", can_reimburse: { value: 35 },
    },
  }, "USD");

  const pl = summarisePL(1000, [good, noRate]);
  assert.strictEqual(pl.reimbursableOutstanding, null,
    "one unconvertible row makes the total unknowable, not approximate");
  assert.notStrictEqual(pl.reimbursableOutstanding, 35,
    "and it must not quietly fall back to the rows it happened to understand");
  assert.deepStrictEqual(pl.reimbursableUnconvertible.map((e) => e.name), ["Ferretería"],
    "the record is named, because 'a figure is missing' is not actionable");
  console.log("16) One unconvertible reimbursable withholds the total and names the record");
}

// ---- 17. an unapproved expense is still money the manager is owed ----
// It is excluded from the EXPENSE total because it is not approved, but the
// manager paid it either way. This was already true and must stay true -- the
// currency fix must not quietly narrow what the line covers.
{
  const pending = managerExpenseOf({
    id: "e-pending",
    properties: {
      expense_name: "Pending thing", amount: { value: 80 }, paid_on: "2026-09-11",
      review_status: "needs_review", can_reimburse: { value: 80 },
    },
  }, "USD");
  assert.strictEqual(pending.counted, false, "not in the expense total");
  const pl = summarisePL(500, [pending]);
  assert.strictEqual(pl.expenses, 0);
  assert.strictEqual(pl.reimbursableOutstanding, 80, "but still owed back to the manager");
  console.log("17) An unapproved expense stays out of the total and stays in what the owner owes");
}

// ---- 18. the page, which is the only thing Yari actually read -------
// Cases 14-17 prove the arithmetic; none of them prove the page shows it.
// Leaving the template alone passes all four, and the template is where the
// US$150.00 was. This renders the real handler.
{
  const { handleManagerPL } = await import("./src/reports.js");
  // The default window is the last 30 days, so a record has to be dated inside
  // it to reach the page at all -- an undated expense is dropped long before
  // anything renders, which is its own case above.
  const TODAY = new Date().toISOString().slice(0, 10);
  const envWith = (records) => {
    globalThis.fetch = async (url) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(String(url).includes("/records/search") ? { records } : {}),
    });
    return {
      TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
      LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ currency: "USD", total_minor: 50000, n: 1 }] }) }) }) },
    };
  };
  const render = async (records) => (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t"), envWith(records))).text();

  // Her record: 150 DOP, rate on the record, reimbursable in full.
  const dop = rec({
    expense_name: "RL Santana Refrigeración", review_status: "approved", category: "maintenance_repairs",
    paid_on: TODAY, amount: { value: 150, currency: "DOP" }, currency: "DOP",
    converted_amount: { value: 2.54 }, exchange_rate: 0.016961163,
    can_reimburse: { value: 150 },
  }, "dop1");

  const page = await render([dop]);
  assert.ok(!/USD 150\.00/.test(page),
    "150 DOP is never printed as USD 150.00 -- the exact figure Yari was shown");
  assert.ok(/USD 2\.5[34]/.test(page), "the converted figure is what sits beside the USD symbol");
  assert.ok(/DOP 150\.00/.test(page), "and the original is still visible as DOP, which is what she asked for");

  // No rate anywhere: the total is withheld rather than guessed, and the record
  // is named so it can be fixed.
  const noRate = rec({
    expense_name: "Ferretería", review_status: "approved", category: "other",
    paid_on: TODAY, amount: { value: 900, currency: "DOP" }, currency: "DOP", can_reimburse: { value: 900 },
  }, "nr1");
  const withhold = await render([noRate]);
  assert.ok(/cannot be totalled/.test(withhold), "the page says it will not total it");
  assert.ok(/Ferreter/.test(withhold), "and names the record standing in the way");
  assert.ok(!/USD 0\.00 is recoverable/.test(withhold),
    "and above all does not render the withheld total as zero, which reads as 'nothing is owed'");

  // An all-USD account gets none of this -- no breakdown line, no warning.
  const plain = await render([rec({ review_status: "approved", paid_on: TODAY, amount: usd(35), category: "other", can_reimburse: usd(35) }, "u1")]);
  assert.ok(/USD 35\.00 is recoverable/.test(plain), "a single-currency account reads exactly as before");
  assert.ok(!/Recorded as/.test(plain), "with no breakdown line it does not need");
  assert.ok(!/cannot be totalled/.test(plain), "and no warning it has not earned");
  console.log("18) The page converts DOP before showing it, shows the original too, and withholds a total it cannot compute");
}

// ---- 19. "All time" has to mean all time -----------------------------
// Yari, 2026-10-05, before merging the currency fix: "the all-time is not
// reflecting the 215 dop from july."
//
// The dropdown said All time and sent no range at all, so the Worker applied
// its 30-day default and the panel quietly hid everything older than a month.
// Her two July expenses -- 180 + 35 DOP -- were not excluded, flagged or
// counted anywhere. They were simply out of frame, under a label promising
// otherwise, which is the worst of the three.
{
  const { handleManagerPL } = await import("./src/reports.js");

  // Dated in July. Today is well past the 30-day default, which is the point.
  const july = [
    rec({ expense_name: "Test Villa 1 - Carpet Wash", review_status: "approved", category: "maintenance_repairs",
          paid_on: "2026-07-20", amount: { value: 180, currency: "DOP" }, currency: "DOP",
          converted_amount: { value: 3.06 }, exchange_rate: 0.016961163,
          can_reimburse: { value: 180 } }, "jul1"),
    rec({ expense_name: "Test Villa 1 - Pest Control", review_status: "approved", category: "pest_control",
          paid_on: "2026-07-15", amount: { value: 35, currency: "DOP" }, currency: "DOP",
          converted_amount: { value: 0.6 }, exchange_rate: 0.016961163,
          can_reimburse: { value: 35 } }, "jul2"),
  ];
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(String(url).includes("/records/search") ? { records: july } : {}),
  });
  const env = {
    TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
    LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ currency: "USD", total_minor: 50000, n: 1 }] }) }) }) },
  };
  const get = async (qs) => {
    const res = await handleManagerPL(new Request(`https://w.dev/reports/manager-pl?locationId=l&token=t&${qs}`), env);
    return res.json();
  };

  // The default is unchanged: a caller that asks for nothing still gets 30 days
  // and therefore does not see July. Changing that silently would move every
  // other report in the system.
  const dflt = await get("format=json");
  assert.strictEqual(dflt.allTime, false);
  assert.deepStrictEqual(dflt.reimbursableByCurrency, [], "the default window still ends before July");

  const all = await get("format=json&period=all");
  assert.strictEqual(all.allTime, true);
  assert.deepStrictEqual(all.reimbursableByCurrency, [{ currency: "DOP", total: 215, entries: 2 }],
    "180 + 35 DOP, the exact figure Yari was looking for");
  assert.ok(Math.abs(all.reimbursableOutstanding - 3.66) < 0.02,
    `and about US$3.66 once converted (got ${all.reimbursableOutstanding})`);

  // The page says All time rather than printing the sentinel dates that make it
  // work -- "0001-01-01 to 9999-12-31" is a correct range and a useless label.
  const page = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&period=all"), env)).text();
  assert.ok(/All time/.test(page), "the period line reads All time");
  assert.ok(!/0001-01-01|9999/.test(page), "and never shows the sentinel dates");

  const es = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&period=all"),
    { ...env, TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit", statementLocale: "es" }) } })).text();
  assert.ok(/Todo el período/.test(es), "in Spanish too");
  assert.ok(!/All time/.test(es));

  // Open at the far end as well as the near one. An expense dated forward --
  // an annual insurance premium, a prepaid booking -- is still a record of this
  // account, and "all" is not a word that should quietly stop at this morning.
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(String(url).includes("/records/search") ? {
      records: [rec({ expense_name: "Insurance, paid ahead", review_status: "approved", category: "insurance",
                      paid_on: nextYear, amount: usd(500), can_reimburse: usd(500) }, "fwd")],
    } : {}),
  });
  const ahead = await get("format=json&period=all");
  assert.strictEqual(ahead.reimbursableOutstanding, 500,
    "a forward-dated record is inside all time, not beyond its far edge");
  console.log("19) period=all covers every dated record, including July, and labels itself honestly");
}

// ---- 20. an expense says whose cost it is ---------------------------
// Yari, 2026-10-05: "these should be expenses for the owner not the manager,
// manager expenses will likely be the cleaning staff, HOMS fee, things like
// that."
//
// Can Reimburse had been doing this job implicitly: set it to the full amount
// and the expense nets to zero for the manager. Right arithmetic reached by
// accident, and silent when the field is blank -- an owner's cost with Can
// Reimburse unset counted squarely against the manager and nothing said so.
{
  const mk = (extra, id) => managerExpenseOf(rec({ ...approved, amount: usd(100), ...extra }, id), "USD");

  const mgr = mk({ paid_by: "manager" }, "m");
  const own = mk({ paid_by: "owner" }, "o");
  assert.strictEqual(mgr.paidBy, "manager");
  assert.strictEqual(own.paidBy, "owner");

  const pl = summarisePL(1000, [mgr, own]);
  assert.strictEqual(pl.expenses, 100, "only the manager's own cost reaches the manager's total");
  assert.strictEqual(pl.ownerBorneCount, 1);
  assert.strictEqual(pl.ownerBorneTotal, 100, "and the owner's is stated, not silently dropped");
  assert.deepStrictEqual(pl.byCategory.map((c) => c.count), [1],
    "the owner's expense is not in the manager's categories either");

  // The case Can Reimburse could never express: an owner cost the manager has
  // not billed back yet. Under the old rule this counted fully against the
  // manager, because nothing distinguished it from the manager's own spending.
  const unbilled = mk({ paid_by: "owner", can_reimburse: usd(0) }, "u");
  const pl2 = summarisePL(1000, [unbilled]);
  assert.strictEqual(pl2.expenses, 0,
    "an owner cost not yet billed back is still the owner's, not the manager's");
  assert.strictEqual(pl2.ownerBorneTotal, 100);

  // What the OWNER bears is the gross. Net is gross less what comes back to the
  // manager, which is a fact about the manager -- using it here would understate
  // the owner's costs by exactly the amount already billed back, and the two are
  // identical whenever Can Reimburse is unset, so only a part-billed expense
  // can tell them apart.
  const partBilled = mk({ paid_by: "owner", amount: usd(250), can_reimburse: usd(100) }, "p");
  assert.strictEqual(partBilled.net, 150, "net is the manager's view of it");
  const pl3 = summarisePL(1000, [partBilled]);
  assert.strictEqual(pl3.ownerBorneTotal, 250,
    "but the owner bears the whole 250, not the 150 still outstanding");
  console.log("20) Only the manager's own costs reach the manager's total, however Can Reimburse is set");
}

// ---- 21. an owner's expense is not a warning ------------------------
// The distinction that keeps the page readable. An owner-borne expense is the
// ORDINARY case -- it is what the field exists to say -- so it must never be
// reported as something left out. Warning about correct data is how the old
// exclusion count became noise nobody read.
{
  const own = managerExpenseOf(rec({ ...approved, amount: usd(100), paid_by: "owner" }, "o"), "USD");
  const pl = summarisePL(1000, [own]);
  assert.deepStrictEqual(pl.excluded, [], "an owner's expense is not an exclusion");
  assert.strictEqual(pl.ownerBorneCount, 1, "it is reported as what it is instead");

  // An unattributed one IS reported: that is a real gap somebody has to close.
  const silent = managerExpenseOf(rec({ ...approved, amount: usd(100), paid_by: undefined }, "s"), "USD");
  assert.ok(silent.issues.includes("not_attributed"));
  assert.strictEqual(silent.paidBy, null, "and it is not guessed at");
  const pl2 = summarisePL(1000, [silent]);
  assert.strictEqual(pl2.excluded.length, 1);
  assert.strictEqual(pl2.expenses, 0, "counted against nobody until somebody says");

  // Not inferred from Can Reimburse, however tempting. Guessing is how that
  // field came to mean two things at once.
  const full = managerExpenseOf(
    rec({ ...approved, amount: usd(100), can_reimburse: usd(100), paid_by: undefined }, "f"), "USD");
  assert.strictEqual(full.paidBy, null,
    "a fully reimbursable expense still has to SAY it is the owner's");
  assert.ok(full.issues.includes("not_attributed"));

  // A junk value is not an attribution either.
  for (const junk of ["", "both", "Owner ", "OWNER", 0]) {
    const r = managerExpenseOf(rec({ ...approved, amount: usd(10), paid_by: junk }, "j"), "USD");
    if (junk === "OWNER") {
      assert.strictEqual(r.paidBy, "owner", "case is forgiven, because GHL option keys are not");
    } else {
      assert.strictEqual(r.paidBy, null, `"${junk}" is not an attribution`);
    }
  }
  console.log("21) An owner's expense is reported as the owner's; only an unattributed one is a warning");
}

// ---- 22. the page says all of that ----------------------------------
// Cases 20 and 21 prove the arithmetic and would pass with the template
// untouched, which is the lesson from every other render case in this file.
{
  const { handleManagerPL } = await import("./src/reports.js");
  const render = async (records, tenant = {}) => {
    globalThis.fetch = async (url) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(String(url).includes("/records/search") ? { records } : {}),
    });
    const env = {
      TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit", ...tenant }) },
      LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ currency: "USD", total_minor: 100000, n: 1 }] }) }) }) },
    };
    return (await handleManagerPL(
      new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&period=all"), env)).text();
  };

  const page = await render([
    rec({ ...approved, amount: usd(100), paid_by: "manager", expense_name: "Cleaner payout" }, "m"),
    rec({ ...approved, amount: usd(250), paid_by: "owner", expense_name: "Fridge repair" }, "o"),
  ]);
  assert.ok(page.includes("USD 100.00"), "the manager's own cost is the expense total");
  assert.ok(!/USD 350\.00/.test(page), "the owner's is not added to it");
  assert.match(page, /are the owner's cost/, "and the page says where the rest went");
  assert.ok(page.includes("USD 250.00"), "with the amount, so it can be checked");
  assert.ok(!/do not say who pays/.test(page), "no warning, because nothing here is wrong");

  const missing = await render([rec({ ...approved, amount: usd(100), paid_by: undefined }, "s")]);
  assert.match(missing, /do not say who pays for them/, "an unattributed expense is warned about");
  assert.match(missing, /Paid By/, "and the page names the field to set");

  const es = await render([
    rec({ ...approved, amount: usd(100), paid_by: "manager" }, "m"),
    rec({ ...approved, amount: usd(250), paid_by: "owner" }, "o"),
  ], { statementLocale: "es" });
  assert.match(es, /costo del propietario/, "the owner-borne note translates");
  assert.ok(!/are the owner's cost/.test(es), "with no English left behind");
  console.log("22) The page shows the manager's costs, says what the owner's were, and warns only when nobody said");
}

// ---- 23. the HOMS fee is just an expense, and has a label ------------
// Yari, 2026-10-06: the HOMS fee "is the account owner adding what they pay for
// using HOMS in their expenses because it is part of their operational
// overhead." So it needs no modelling -- phase 3 already counts it, because it
// is the manager's own cost. It only needed somewhere honest to sit.
//
// Management Fee was the nearest existing option and reads like what the
// manager CHARGES the owner, which is the opposite thing.
{
  const fee = managerExpenseOf(rec({
    ...approved, paid_by: "manager", category: "software_subscriptions",
    expense_name: "HOMS subscription", amount: usd(97),
  }, "homs"), "USD");

  assert.strictEqual(fee.categoryLabel, "Software & Subscriptions",
    "a category GHL offers but this map does not know renders as 'Other'");
  assert.strictEqual(fee.counted, true);

  const pl = summarisePL(1000, [fee]);
  assert.strictEqual(pl.expenses, 97, "it is the manager's own operational cost");
  assert.deepStrictEqual(pl.byCategory, [
    { category: "software_subscriptions", label: "Software & Subscriptions", total: 97, count: 1 },
  ]);
  assert.strictEqual(pl.ownerBorneCount, 0, "and is not the owner's");

  // Every key the GHL field offers has a label here. A category added to the
  // object and not to this map renders as "Other" on the statement, silently.
  const ghlKeys = [
    "maintenance_repairs", "cleaning_supplies", "utilities", "pest_control", "landscaping",
    "insurance", "property_tax", "management_fee", "software_subscriptions", "miscellaneous", "other",
  ];
  for (const key of ghlKeys) {
    const r = managerExpenseOf(rec({ ...approved, paid_by: "manager", category: key, amount: usd(1) }, key), "USD");
    // "other" is genuinely labelled Other; every other key reaching that label
    // means it fell through the map rather than being found in it.
    if (key === "other") assert.strictEqual(r.categoryLabel, "Other");
    else assert.notStrictEqual(r.categoryLabel, "Other", `"${key}" has no label of its own`);
  }
  console.log(`23) The HOMS fee is an ordinary manager expense, and all ${ghlKeys.length} GHL categories have labels`);
}

// ---- 24. what the owner still owes, not what they ever owed ---------
// Yari, 2026-10-06: "i record the payment manually when the owner pays me."
// So Already Reimbursed is maintained by hand, and until now nothing read it.
// "Recoverable from owners" summed Can Reimburse alone, which made it the total
// ever reimbursable rather than what is still owed -- it could never go down,
// however many times an owner settled, and a manager repaid in full still saw
// the whole amount listed as recoverable.
{
  const owed = (already) => summarisePL(1000, [managerExpenseOf(rec({
    ...approved, paid_by: "owner", amount: usd(300), can_reimburse: usd(300),
    already_reimbursed: already === null ? undefined : usd(already),
  }, "r"), "USD")]);

  assert.strictEqual(owed(null).reimbursableOutstanding, 300, "nothing repaid, all of it owed");
  assert.strictEqual(owed(0).reimbursableOutstanding, 300, "an explicit zero reads the same");
  assert.strictEqual(owed(100).reimbursableOutstanding, 200, "a part payment reduces it");
  assert.strictEqual(owed(300).reimbursableOutstanding, 0,
    "and settling in full clears it, which is the whole point");

  // The manager's own COST does not move when an owner repays. It is
  // amount less what is recoverable, and what is recoverable has not changed --
  // only how much of it has arrived.
  const paid = managerExpenseOf(rec({
    ...approved, paid_by: "manager", amount: usd(300), can_reimburse: usd(100), already_reimbursed: usd(100),
  }, "c"), "USD");
  assert.strictEqual(paid.net, 200, "the manager is still 200 out of pocket either way");

  // A fully settled expense drops out of the per-currency breakdown rather than
  // sitting there at zero.
  assert.deepStrictEqual(owed(300).reimbursableByCurrency, []);
  assert.deepStrictEqual(owed(100).reimbursableByCurrency, [{ currency: "USD", total: 200, entries: 1 }]);
  console.log("24) Recoverable from owners is what is still owed, and reaches zero when an owner settles");
}

// ---- 25. repaid more than was ever billable -------------------------
// A typo, or a double entry. Letting it go negative would quietly shrink the
// account's total by the size of the mistake, which is worse than the mistake.
{
  const pl = summarisePL(1000, [managerExpenseOf(rec({
    ...approved, paid_by: "owner", amount: usd(300), can_reimburse: usd(100), already_reimbursed: usd(250),
  }, "oops"), "USD")]);
  assert.strictEqual(pl.reimbursableOutstanding, 0, "floored, never negative");
  assert.deepStrictEqual(pl.overReimbursed.map((e) => [e.id, e.billable, e.repaid]), [["oops", 100, 250]],
    "and named, so it can be corrected rather than hidden");

  const fine = summarisePL(1000, [managerExpenseOf(rec({
    ...approved, paid_by: "owner", amount: usd(300), can_reimburse: usd(100), already_reimbursed: usd(100),
  }, "ok"), "USD")]);
  assert.deepStrictEqual(fine.overReimbursed, [], "settling exactly is not an error");
  console.log("25) Repaying more than was billable floors at zero and names the record");
}

// ---- 26. in another currency, and on the page -----------------------
{
  const dop = managerExpenseOf(rec({
    ...approved, paid_by: "owner", expense_name: "Nevera",
    amount: { value: 300, currency: "DOP" }, currency: "DOP",
    converted_amount: { value: 5.09 }, exchange_rate: 0.016961163,
    can_reimburse: { value: 300 }, already_reimbursed: { value: 100 },
  }, "d"), "USD");
  const pl = summarisePL(1000, [dop]);
  assert.deepStrictEqual(pl.reimbursableByCurrency, [{ currency: "DOP", total: 200, entries: 1 }],
    "the original currency shows what is still owed, not the original bill");
  assert.ok(Math.abs(pl.reimbursableOutstanding - 3.39) < 0.02,
    `200 DOP still owed is about US$3.39 (got ${pl.reimbursableOutstanding})`);

  const { handleManagerPL } = await import("./src/reports.js");
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(String(url).includes("/records/search") ? {
      records: [rec({
        ...approved, paid_by: "owner", expense_name: "Nevera", amount: usd(300),
        can_reimburse: usd(300), already_reimbursed: usd(300),
      }, "settled")],
    } : {}),
  });
  const page = await (await handleManagerPL(
    new Request("https://w.dev/reports/manager-pl?locationId=l&token=t&period=all"),
    {
      TENANTS: { get: async () => ({ brandName: "B", currency: "USD", managerReportToken: "t", ghlPit: "pit" }) },
      LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ currency: "USD", total_minor: 100000, n: 1 }] }) }) }) },
    })).text();
  assert.ok(/USD 0\.00 is recoverable/.test(page),
    "a fully settled account reads zero recoverable on the page, not the original 300");
  assert.ok(!/USD 300\.00 is recoverable/.test(page));
  console.log("26) A part payment converts correctly, and a settled account reads zero on the page");
}

console.log("\nPASS — manager P&L: a reimbursable cost is not an expense, every expense says whose it is, what an owner still owes goes down when they pay, every currency is converted at its own recorded rate or not at all, all time means all time, and nothing is quietly left out.");
