// A refund reads as a refund, and a Spanish statement is Spanish all the way down.
// Run: node test-statement-refunds.mjs
//
// Two things Yari found on the live statement, 2026-10-01, hours before the
// conference:
//
//   "the bottom half of the manager statement is english"
//     Every row in D1 carries a description, written in English at settle time
//     ("Cancellation charge 20% (under_336h), owner share"). The detail cell
//     rendered `description || label`, so the description always won and the
//     labels added in #90/#91 never reached the detail table at all. My render
//     test used rows with description: null -- a shape real data never has --
//     which is why it passed while the live page was half English.
//
//   "if there is a refund, shouldn't that be marked something else not
//    income...it's a loss of income"
//     A reversal is stored as category "income" with a negative amount, which
//     is correct for arithmetic and wrong to read. The totals must not move.
import assert from "node:assert";

const {
  describeEntry, categoryLabelFor, categoryClassFor, isRefund, handleManagerStatement,
} = await import("./src/reports.js");

// ---- 1. a negative income row is a refund, not income ---------------
{
  assert.strictEqual(categoryLabelFor("income", -629, "en"), "Refund");
  assert.strictEqual(categoryLabelFor("income", -629, "es"), "Reembolso");
  assert.strictEqual(categoryLabelFor("income", 629, "en"), "Income", "money coming in is still income");
  assert.strictEqual(categoryLabelFor("income", 629, "es"), "Ingreso");
  console.log("1) Income paid out reads as a refund; income coming in still reads as income");
}

// ---- 2. only income reverses into a refund --------------------------
// A deposit returned to the guest is a liability being discharged and a
// negative pass-through is a fee reversal. Neither is the client's refund, and
// calling them one would put a word on a row that does not mean it.
{
  assert.strictEqual(isRefund("liability", -200), false);
  assert.strictEqual(isRefund("pass_through", -48.3), false);
  assert.strictEqual(isRefund("shadow", -100), false);
  assert.strictEqual(categoryLabelFor("liability", -200, "es"), "Retenido");
  assert.strictEqual(isRefund("income", 0), false, "zero is not a refund");
  console.log("2) Only reversed income is called a refund -- held and passed-through money keeps its own name");
}

// ---- 3. it is visible, not just differently worded ------------------
{
  assert.strictEqual(categoryClassFor("income", -629), "refund", "its own colour");
  assert.strictEqual(categoryClassFor("income", 629), "income");
  assert.strictEqual(categoryClassFor("pass_through", -10), "pass_through");
  console.log("3) A refund gets its own colour rather than reading as income with a minus sign");
}

// ---- 4. the detail cell, which is the bit that stayed English -------
// The real shape: description always present, written in English.
{
  const row = {
    entryType: "cancellation_rent_refund_owner",
    description: "Rent income reversed on cancellation (85% share) — under_120h — refund to be issued manually",
    amount: -629,
    category: "income",
  };
  assert.match(describeEntry(row, "en"), /under_120h/,
    "English keeps the stored detail, which says more than the label does");
  assert.strictEqual(describeEntry(row, "es"), "Alquiler reembolsado por cancelación — parte del propietario",
    "Spanish uses the label, because the stored description is English prose");
  assert.ok(!describeEntry(row, "es").includes("reversed"), "and none of that English survives");

  // A row with no description at all still reads as something.
  assert.strictEqual(describeEntry({ entryType: "cleaning_fee", description: null }, "es"), "Tarifa de limpieza");
  assert.strictEqual(describeEntry({ entryType: "cleaning_fee", description: "" }, "en"), "Cleaning fee");
  console.log("4) The detail cell is Spanish on a Spanish statement, and keeps its English detail in English");
}

// ---- 5. the rendered page, with rows shaped like the real ones ------
// The guard the earlier test did not have: every row carries a description.
const rows = [
  { entry_type: "rent_split_manager", category: "income", currency: "USD", total_minor: 11100, entry_count: 1,
    booking_id: "BK-R", amount_minor: 11100, description: "Rent split 15% of $740.00", created_at: "2026-09-30T02:00:00.000Z" },
  { entry_type: "cancellation_rent_refund_manager", category: "income", currency: "USD", total_minor: -11100, entry_count: 1,
    booking_id: "BK-R", amount_minor: -11100,
    description: "Rent income reversed on cancellation (manager share) — under_120h — refund to be issued manually",
    created_at: "2026-09-30T03:00:00.000Z" },
  { entry_type: "cancellation_charge_manager", category: "income", currency: "USD", total_minor: 2775, entry_count: 1,
    booking_id: "BK-R", amount_minor: 2775, description: "Cancellation charge 75% (under_120h), manager share",
    created_at: "2026-09-30T03:00:00.000Z" },
];
const envWith = (tenant) => ({
  TENANTS: { get: async () => ({ brandName: "Casa Bonita", currency: "USD", managerReportToken: "tok", ...tenant }) },
  LEDGER_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
});
const render = async (tenant) =>
  (await handleManagerStatement(
    new Request("https://w.dev/reports/manager-statement?locationId=L1&token=tok"), envWith(tenant))).text();

{
  const html = await render({ statementLocale: "es" });
  for (const leak of ["reversed on cancellation", "Rent split", "Cancellation charge 75%", "refund to be issued manually", "Income"]) {
    assert.ok(!html.includes(leak), `"${leak}" is still English on a Spanish statement`);
  }
  assert.match(html, /Alquiler reembolsado por cancelación — parte del administrador/);
  assert.match(html, /Cargo por cancelación — parte del administrador/);
  // Both tables, not just one. Matching the word alone passes even if the
  // summary reverts, because the detail row prints it too -- that mutation
  // escaped the first run.
  assert.strictEqual((html.match(/class="cat cat-refund"/g) || []).length, 2,
    "the summary row AND the detail row are both marked as a refund");
  assert.match(html, /Reembolso/, "and the reversal is labelled a refund");
  console.log("5) A Spanish manager statement is Spanish in the detail table too, descriptions and all");
}

// ---- 6. the English statement keeps what it had ---------------------
{
  const html = await render({});
  assert.match(html, /under_120h/, "the stored detail still reaches an English reader");
  assert.match(html, /Rent split 15% of \$740\.00/);
  assert.strictEqual((html.match(/class="cat cat-refund"/g) || []).length, 2,
    "both tables mark it in English too");
  assert.match(html, /Refund/, "and the reversal is still called a refund");
  console.log("6) The English statement keeps its stored detail, and labels its refund too");
}

// ---- 7. the money does not move -------------------------------------
// The whole point: this renames a row, it does not re-count it. 111.00 in,
// 111.00 straight back out, 27.75 retained.
{
  const res = await handleManagerStatement(
    new Request("https://w.dev/reports/manager-statement?locationId=L1&token=tok&format=json"), envWith({}));
  const body = await res.json();
  assert.strictEqual(body.incomeTotal, 27.75,
    "the total is what it always was -- the refund still nets against the income");
  const refundRow = body.summary.find((s) => s.entryType === "cancellation_rent_refund_manager");
  assert.strictEqual(refundRow.category, "income", "the stored category is untouched, so nothing downstream shifts");
  assert.strictEqual(refundRow.total, -111);
  console.log("7) Totals and stored categories are unchanged -- 27.75 before and after");
}

console.log("\nPASS — a refund reads as a refund, and a Spanish statement is Spanish to the bottom.");
