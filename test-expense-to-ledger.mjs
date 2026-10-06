// An owner's expense reaches the owner's statement.
// Run: node test-expense-to-ledger.mjs
//
// Phase 4 of EXPENSE-ATTRIBUTION-SCOPE.md. Before this, an expense the OWNER
// bore appeared on exactly one page -- the MANAGER's -- because the owner
// statement is built from the ledger and the ledger had no expense entry type.
// The person paying for the fridge repair never saw the fridge repair.
import assert from "node:assert";

const { ownerLedgerRowFor, handleExpenseApproved } = await import("./src/expenses.js");

const expense = (props, id = "exp1") => ({ id, properties: props });
const owned = {
  paid_by: "owner", review_status: "approved", paid_on: "2026-07-15",
  amount: { value: 250, currency: "DOP" }, currency: "dop", expense_name: "Fridge repair",
};

// ---- 1. an owner's approved expense becomes one ledger row ----------
{
  const { row, skip } = ownerLedgerRowFor(expense(owned), "exp1");
  assert.strictEqual(skip, undefined);
  assert.strictEqual(row.recipient, "owner");
  assert.strictEqual(row.entryType, "expense_owner");
  assert.strictEqual(row.category, "expense");
  assert.strictEqual(row.amountMinor, -25000, "negative: it reduces what the owner is owed");
  assert.strictEqual(row.currency, "DOP", "in the currency it was incurred in");
  assert.strictEqual(row.description, "Fridge repair");
  console.log("1) An owner's approved expense becomes one negative ledger row, in its own currency");
}

// ---- 2. the key is the expense record, so a correction corrects -----
// Yari, 2026-10-06: "use the expense record id". An expense can be edited,
// unapproved and re-approved, and the row has to end up saying what the record
// currently says. The unique index is (booking_id, entry_type, reference), so
// both of those have to be derived from the record id and nothing else.
{
  const a = ownerLedgerRowFor(expense(owned, "exp1"), "exp1").row;
  const b = ownerLedgerRowFor(expense({ ...owned, amount: { value: 400 } }, "exp1"), "exp1").row;
  assert.strictEqual(a.bookingId, b.bookingId, "same record, same key");
  // Asserted against the record id, not just against each other -- two rows
  // both carrying an empty reference are also "equal", and that would silently
  // merge every expense on the account into one row.
  assert.strictEqual(a.reference, "exp1");
  assert.strictEqual(b.reference, "exp1");
  assert.strictEqual(b.amountMinor, -40000, "and the corrected amount, not an extra row");

  const other = ownerLedgerRowFor(expense(owned, "exp2"), "exp2").row;
  assert.notStrictEqual(other.bookingId, a.bookingId, "a different expense is a different row");
  assert.notStrictEqual(other.reference, a.reference, "on both halves of the key, not just one");

  // Namespaced so it can never collide with a real booking id, which shares
  // this column and this index.
  assert.strictEqual(a.bookingId, "expense:exp1");
  assert.ok(!/^expense:/.test("abc123"), "a GHL booking id never starts with that prefix");
  console.log("2) The row is keyed on the expense record, so re-posting corrects rather than duplicates");
}

// ---- 3. the period is the expense's, not the webhook's --------------
// A receipt entered in October for a repair paid in July belongs in July.
// Otherwise every statement period is decided by when somebody got round to
// typing it in, and a backdated receipt silently lands in the wrong month.
{
  const { row } = ownerLedgerRowFor(expense(owned), "exp1");
  assert.strictEqual(row.paidOn, "2026-07-15");
  console.log("3) The ledger date is the expense's Paid On, not the moment the webhook fired");
}

// ---- 4. everything it refuses, and why ------------------------------
// This runs from a webhook nobody watches. A named skip is the only trace of
// why an expense never reached a statement.
{
  const cases = [
    ["manager's own cost", { ...owned, paid_by: "manager" }, "manager_borne"],
    ["nobody said whose", { ...owned, paid_by: undefined }, "not_attributed"],
    ["still Needs Review", { ...owned, review_status: "needs_review" }, "not_approved"],
    ["no amount", { ...owned, amount: null }, "no_amount"],
    ["zero amount", { ...owned, amount: { value: 0 } }, "zero_amount"],
    ["no Paid On", { ...owned, paid_on: null }, "no_paid_on"],
  ];
  for (const [what, props, expected] of cases) {
    const { row, skip } = ownerLedgerRowFor(expense(props), "exp1");
    assert.strictEqual(skip, expected, `${what} -> ${expected}`);
    assert.strictEqual(row, undefined, `${what} writes nothing`);
  }
  console.log(`4) All ${cases.length} refusals are named, and none of them writes a row`);
}

// ---- 5. the endpoint, including what it refuses to trust ------------
{
  const RECORD = expense(owned, "exp1");
  let fetched = [];
  const serve = (status, body) => {
    fetched = [];
    globalThis.fetch = async (url, init) => {
      fetched.push({ url: String(url), auth: init?.headers?.Authorization });
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    };
  };

  let written = [];
  const env = (tenant = {}) => ({
    TENANTS: { get: async () => ({ brandName: "B", currency: "USD", ghlPit: "pit", ...tenant }) },
    LEDGER_DB: {
      prepare: (sql) => ({ bind: (...args) => ({ run: async () => { written.push({ sql, args }); } }) }),
    },
  });
  const post = async (body, e = env(), headers = {}) => {
    written = [];
    const res = await handleExpenseApproved(
      new Request("https://w.dev/ghl-expense-approved", { method: "POST", headers, body: JSON.stringify(body) }), e);
    return { status: res.status, body: await res.json() };
  };

  serve(200, { record: RECORD });
  const ok = await post({ locationId: "L1", recordId: "exp1" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.posted, true);
  assert.strictEqual(ok.body.amountMinor, -25000);
  assert.strictEqual(written.length, 1, "one row written");

  // The SQL has to actually CORRECT on conflict. "ON CONFLICT DO NOTHING" also
  // contains the words "ON CONFLICT" and would leave an owner charged the old
  // amount forever after a correction.
  assert.match(written[0].sql, /ON CONFLICT\(booking_id, entry_type, reference\) DO UPDATE SET/);
  assert.match(written[0].sql, /amount_minor\s*=\s*excluded\.amount_minor/,
    "and the amount is among the things it corrects");

  // Bound values, not the shape computed above -- the row object can be right
  // while the wrong thing reaches the database.
  const bound = written[0].args;
  assert.ok(bound.includes("exp1"), "the record id is bound as the reference");
  assert.ok(bound.includes("expense:exp1"), "and as the namespaced booking id");
  assert.ok(bound.some((v) => typeof v === "string" && v.startsWith("2026-07-15")),
    "and created_at carries the expense's Paid On, not today");
  assert.ok(!bound.some((v) => typeof v === "string" && v.startsWith(new Date().toISOString().slice(0, 10))),
    "nothing bound is stamped with the moment the webhook fired");

  // The record is re-read rather than trusted from the body. A workflow sends
  // whatever merge tags it was configured with, and this writes money.
  assert.strictEqual(fetched.length, 1);
  assert.match(fetched[0].url, /custom_objects\.expenses\/records\/exp1/);
  const spoofed = await post({ locationId: "L1", recordId: "exp1", amount: 999999, paid_by: "owner" });
  assert.strictEqual(spoofed.body.amountMinor, -25000, "the body's own amount is ignored entirely");

  // Auth, when the tenant sets a secret.
  serve(200, { record: RECORD });
  const guarded = env({ webhookSecret: "s3cret" });
  assert.strictEqual((await post({ locationId: "L1", recordId: "exp1" }, guarded)).status, 401);
  assert.strictEqual(written.length, 0, "and nothing is written on a refused call");
  assert.strictEqual((await post({ locationId: "L1", recordId: "exp1", secret: "s3cret" }, guarded)).status, 200);

  console.log("5) The endpoint re-reads the record, ignores the body's figures, and honours the webhook secret");
}

// ---- 6. a skip is a 200, because this is a workflow step ------------
// A non-2xx marks the workflow run failed in GHL and invites a retry that would
// skip identically. The skip is reported in the body instead, where it can be
// read without re-running anything.
{
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ record: expense({ ...owned, paid_by: "manager" }) }) });
  const e = {
    TENANTS: { get: async () => ({ ghlPit: "pit" }) },
    LEDGER_DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("must not write"); } }) }) },
  };
  const res = await handleExpenseApproved(
    new Request("https://w.dev/ghl-expense-approved", { method: "POST", body: JSON.stringify({ locationId: "L1", recordId: "exp1" }) }), e);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).skipped, "manager_borne");

  // A deleted record is a skip too, not a 500 that fails the workflow forever.
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "{}" });
  const gone = await handleExpenseApproved(
    new Request("https://w.dev/ghl-expense-approved", { method: "POST", body: JSON.stringify({ locationId: "L1", recordId: "exp1" }) }), e);
  assert.strictEqual(gone.status, 200);
  assert.strictEqual((await gone.json()).skipped, "record_not_found");
  console.log("6) Every skip answers 200 with a reason, so a workflow run is not marked failed");
}

// ---- 7. an unknown tenant is refused before any GHL call ------------
{
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => "{}" }; };
  const res = await handleExpenseApproved(
    new Request("https://w.dev/ghl-expense-approved", { method: "POST", body: JSON.stringify({ locationId: "nope", recordId: "x" }) }),
    { TENANTS: { get: async () => null } });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(called, false, "and no PIT is used against an account we do not know");
  console.log("7) An unknown locationId is refused before anything is fetched");
}

console.log("\nPASS — an owner's expense reaches the owner's ledger once, in its own currency, dated when it was paid.");
