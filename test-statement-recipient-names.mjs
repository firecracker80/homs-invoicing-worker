// Every row a statement is filtered by has to carry the name it is filtered on.
// Run: node test-statement-recipient-names.mjs
//
// Settlement set recipientName. Nothing else did -- every row written by
// cancellation.js and reschedule.js went in with it null, across fifteen row
// types. That was invisible while propertyOwnerNames was broken (fixed in #89),
// because nobody could scope a statement by name and an unscoped statement sums
// everything regardless.
//
// The moment they could, it mattered: queryStatement filters with
// `recipient_name = ?`, a SQL equality, and NULL matches nothing. On DEMO-HOMS
// 2026-09-30 that meant Elena Marchetti's statement showed her 629.00 of rent
// and neither the 629.00 reversal nor the 157.25 cancellation charge -- she
// would have read 629.00 owed when the real figure was 157.25.
import assert from "node:assert";

const { writeAndSyncRows } = await import("./src/ledger.js");

// D1 that records what it was handed, in the column order writeAndSyncRows binds.
let written = [];
const LEDGER_DB = {
  prepare: () => ({ bind: (...a) => ({ recipient: a[4], recipientName: a[5], entry_type: a[7], amount: a[8] / 100 }) }),
  batch: async (stmts) => { written.push(...stmts); return stmts; },
};
// No PIT, so the GHL half short-circuits and only the D1 write is exercised.
const env = { LEDGER_DB };
const tenant = { currency: "USD" };

const snapshot = {
  locationId: "LOC", bookingId: "BK-1", propertyCode: "Test Villa 3",
  charges: { rentTotal: 740, cleaningFee: 65 },
  payout: { ownerPct: 0.85, owner: 629, manager: 111, ownerName: "Elena Marchetti", managerName: "Rosa Jiménez" },
};

const write = async (rows) => { written = []; await writeAndSyncRows(env, tenant, snapshot, rows); return written; };
const nameOf = (rows, type) => rows.find((r) => r.entry_type === type)?.recipientName;

// ---- 1. a row that names nobody is given this booking's names -------
// The cancellation and reschedule rows, all fifteen of them, look like this.
{
  const rows = await write([
    { recipient: "owner", category: "income", entry_type: "cancellation_rent_refund_owner", amount: -629 },
    { recipient: "manager", category: "income", entry_type: "cancellation_rent_refund_manager", amount: -111 },
    { recipient: "owner", category: "income", entry_type: "cancellation_charge_owner", amount: 157.25 },
    { recipient: "manager", category: "income", entry_type: "cancellation_charge_manager", amount: 27.75 },
  ]);

  assert.strictEqual(nameOf(rows, "cancellation_rent_refund_owner"), "Elena Marchetti",
    "the reversal carries the same name as the income it reverses, or the statement shows one without the other");
  assert.strictEqual(nameOf(rows, "cancellation_charge_owner"), "Elena Marchetti");
  assert.strictEqual(nameOf(rows, "cancellation_rent_refund_manager"), "Rosa Jiménez");
  assert.strictEqual(nameOf(rows, "cancellation_charge_manager"), "Rosa Jiménez");
  console.log("1) Cancellation rows are given the owner and manager this booking was settled to");
}

// ---- 2. a row that names somebody keeps that name -------------------
// Settlement sets these explicitly. Overwriting them would rewrite history on
// a booking whose owner changed after it was paid.
{
  const rows = await write([
    { recipient: "owner", recipientName: "Carlos Mendoza", category: "income", entry_type: "rent_split_owner", amount: 629 },
  ]);
  assert.strictEqual(nameOf(rows, "rent_split_owner"), "Carlos Mendoza",
    "an explicit name wins over the snapshot's current one");
  console.log("2) A row that already names someone is left alone");
}

// ---- 3. guest and platform rows stay unnamed ------------------------
// Neither is a statement recipient. Naming them would put the guest's own
// deposit and the gateway's cut onto somebody's statement.
{
  const rows = await write([
    { recipient: "guest", category: "liability", entry_type: "deposit_held", amount: 200 },
    { recipient: "platform", category: "pass_through", entry_type: "processing_fee", amount: 48.3 },
  ]);
  assert.strictEqual(nameOf(rows, "deposit_held"), null, "the deposit is the guest's money, not a recipient's earnings");
  assert.strictEqual(nameOf(rows, "processing_fee"), null);
  console.log("3) Guest and platform rows stay unnamed, because neither reads a statement");
}

// ---- 4. an account with no names configured is unaffected -----------
// Most accounts have one owner and one manager and set no names at all. They
// must not start getting "null" or "undefined" written into the column.
{
  const anon = { ...snapshot, payout: { ownerPct: 0.85 } };
  written = [];
  await writeAndSyncRows(env, tenant, anon, [
    { recipient: "owner", category: "income", entry_type: "cancellation_charge_owner", amount: 157.25 },
  ]);
  assert.strictEqual(written[0].recipientName, null, "no name configured stays no name, not a string");
  console.log("4) An account that names nobody writes nothing, rather than a placeholder");
}

// ---- 5. the shape the statement actually filters on -----------------
// queryStatement does `WHERE recipient = ? AND recipient_name = ?`. This is
// that filter, run over a whole booking's worth of rows: the settlement, then
// the cancellation that reverses it.
{
  const rows = await write([
    { recipient: "owner", recipientName: "Elena Marchetti", category: "income", entry_type: "rent_split_owner", amount: 629 },
    { recipient: "manager", recipientName: "Rosa Jiménez", category: "income", entry_type: "rent_split_manager", amount: 111 },
    { recipient: "manager", recipientName: "Rosa Jiménez", category: "income", entry_type: "cleaning_fee", amount: 65 },
    { recipient: "platform", category: "pass_through", entry_type: "processing_fee", amount: 48.3 },
    { recipient: "owner", category: "income", entry_type: "cancellation_rent_refund_owner", amount: -629 },
    { recipient: "owner", category: "income", entry_type: "cancellation_charge_owner", amount: 157.25 },
  ]);

  const elena = rows.filter((r) => r.recipient === "owner" && r.recipientName === "Elena Marchetti");
  assert.strictEqual(elena.length, 3, "all three of her rows survive the filter, not just the one she was paid");
  assert.strictEqual(Math.round(elena.reduce((s, r) => s + r.amount, 0) * 100) / 100, 157.25,
    "and they net to what she is actually owed -- 629 in, 629 back out, 157.25 retained");
  console.log("5) A scoped owner statement nets to 157.25, where before it read 629.00");
}

console.log("\nPASS — every row a statement filters by carries the name it is filtered on.");
