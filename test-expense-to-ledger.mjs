// An owner's expense reaches the owner's statement.
// Run: node test-expense-to-ledger.mjs
//
// Phase 4 of EXPENSE-ATTRIBUTION-SCOPE.md. Before this, an expense the OWNER
// bore appeared on exactly one page -- the MANAGER's -- because the owner
// statement is built from the ledger and the ledger had no expense entry type.
// The person paying for the fridge repair never saw the fridge repair.
//
// The webhook carries no record id. Yari, 2026-10-07: "record.id is not exposed
// on the object workflow." So the POST is a nudge, and the Worker reconciles the
// whole location: post what qualifies, remove what no longer does.
import assert from "node:assert";

const { ownerLedgerRowFor, reconcileOwnerExpenses, handleExpenseApproved } =
  await import("./src/expenses.js");

const expense = (props, id = "exp1") => ({ id, properties: props });
const owned = {
  paid_by: "owner", review_status: "approved", paid_on: "2026-07-15",
  amount: { value: 250, currency: "DOP" }, currency: "dop", expense_name: "Fridge repair",
};

// A ledger stub that behaves like the real table: keyed on
// (booking_id, entry_type, reference), upserting rather than duplicating.
function fakeLedger(seed = []) {
  const rows = new Map(seed.map((r) => [r.reference, { ...r }]));
  return {
    rows,
    sql: [],
    prepare(sql) {
      this.sql.push(sql);
      const db = this;
      return {
        bind(...args) {
          return {
            async run() {
              if (/^INSERT INTO ledger_entries/.test(sql)) {
                const [, bookingId, , , , , amountMinor, currency, description, reference, createdAt] = args;
                // Model the real table rather than a Map. The unique index on
                // (booking_id, entry_type, reference) means a second write for
                // the same expense only CHANGES anything if the statement says
                // DO UPDATE; an INSERT OR IGNORE silently keeps the old row.
                // A stub that always overwrites cannot tell those apart, and
                // "leaves an owner charged the old amount after a correction"
                // is precisely the bug worth catching.
                if (rows.has(reference) && !/DO UPDATE SET/.test(sql)) return;
                rows.set(reference, { reference, bookingId, amountMinor, currency, description, createdAt });
              } else if (/^DELETE FROM ledger_entries/.test(sql)) {
                rows.delete(args[1]);
              } else throw new Error(`unexpected write: ${sql}`);
            },
            async all() {
              if (!/^SELECT reference/.test(sql)) throw new Error(`unexpected read: ${sql}`);
              return { results: [...rows.values()].map((r) => ({ reference: r.reference })) };
            },
          };
        },
      };
    },
  };
}

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
{
  const a = ownerLedgerRowFor(expense(owned, "exp1"), "exp1").row;
  const b = ownerLedgerRowFor(expense({ ...owned, amount: { value: 400 } }, "exp1"), "exp1").row;
  assert.strictEqual(a.bookingId, b.bookingId, "same record, same key");
  // Asserted against the record id, not just against each other -- two rows both
  // carrying an empty reference are also "equal", and that would merge every
  // expense on the account into one row.
  assert.strictEqual(a.reference, "exp1");
  assert.strictEqual(b.amountMinor, -40000, "and the corrected amount, not an extra row");

  const other = ownerLedgerRowFor(expense(owned, "exp2"), "exp2").row;
  assert.notStrictEqual(other.bookingId, a.bookingId, "a different expense is a different row");
  assert.notStrictEqual(other.reference, a.reference, "on both halves of the key");

  // Namespaced so it can never collide with a real booking id, which shares
  // this column and this index.
  assert.strictEqual(a.bookingId, "expense:exp1");
  console.log("2) The row is keyed on the expense record, so re-posting corrects rather than duplicates");
}

// ---- 3. the period is the expense's, not the webhook's --------------
{
  const db = fakeLedger();
  await reconcileOwnerExpenses({ LEDGER_DB: db }, "L1", [expense(owned)]);
  assert.ok(db.rows.get("exp1").createdAt.startsWith("2026-07-15"),
    "a receipt entered in October for a July repair belongs in July");
  assert.ok(!db.rows.get("exp1").createdAt.startsWith(new Date().toISOString().slice(0, 10)));
  console.log("3) The ledger date is the expense's Paid On, not the moment the webhook fired");
}

// ---- 4. everything it refuses, and why ------------------------------
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

// ---- 5. a nudge reconciles the whole location -----------------------
// The webhook cannot say which record changed, so this posts what qualifies and
// counts what did not, from whatever the account currently holds.
{
  const db = fakeLedger();
  const out = await reconcileOwnerExpenses({ LEDGER_DB: db }, "L1", [
    expense(owned, "a"),
    expense({ ...owned, amount: { value: 100 }, expense_name: "Paint" }, "b"),
    expense({ ...owned, paid_by: "manager" }, "c"),
    expense({ ...owned, review_status: "needs_review" }, "d"),
  ]);
  assert.strictEqual(out.posted, 2);
  assert.deepStrictEqual(out.skipped, { manager_borne: 1, not_approved: 1 });
  assert.deepStrictEqual([...db.rows.keys()].sort(), ["a", "b"]);
  assert.strictEqual(db.rows.get("b").amountMinor, -10000);
  console.log("5) A nudge posts every qualifying expense on the location and counts the rest");
}

// ---- 6. and removes what stopped qualifying -------------------------
// The case a per-record webhook could never have handled: nothing fires for a
// record that stopped qualifying, so un-approving an expense would have left
// the deduction in place forever, taking money off an owner for something
// retracted.
{
  const db = fakeLedger([{ reference: "a" }, { reference: "b" }, { reference: "gone" }]);
  const out = await reconcileOwnerExpenses({ LEDGER_DB: db }, "L1", [
    expense(owned, "a"),
    expense({ ...owned, review_status: "needs_review" }, "b"), // un-approved
    // "gone" was deleted in GHL and is not in the account at all any more
  ]);
  assert.strictEqual(out.posted, 1);
  assert.strictEqual(out.removed, 2, "the un-approved one and the deleted one both stop deducting");
  assert.deepStrictEqual([...db.rows.keys()], ["a"]);
  console.log("6) An expense that stops qualifying stops deducting, including one deleted in GHL");
}

// ---- 7. it reconciles to the same place however often it runs -------
// A workflow that fires on every record update will nudge this far more often
// than anything changes. Running twice must not post twice, remove anything, or
// move a figure.
{
  const db = fakeLedger();
  const env = { LEDGER_DB: db };
  const first = await reconcileOwnerExpenses(env, "L1", [expense(owned, "a"), expense(owned, "b")]);
  const snapshot = JSON.stringify([...db.rows.entries()].sort());
  const second = await reconcileOwnerExpenses(env, "L1", [expense(owned, "a"), expense(owned, "b")]);
  assert.deepStrictEqual(second, first, "the same account reconciles to the same report");
  assert.strictEqual(second.removed, 0, "and removes nothing it just wrote");
  assert.strictEqual(JSON.stringify([...db.rows.entries()].sort()), snapshot, "the ledger is unchanged");

  // But an expense that DID change must reach the stored row. Idempotent is not
  // the same as inert, and INSERT OR IGNORE would pass every assertion above
  // while leaving an owner charged the old amount forever after a correction.
  await reconcileOwnerExpenses(env, "L1", [
    expense({ ...owned, amount: { value: 999 }, expense_name: "Fridge repair, corrected" }, "a"),
    expense(owned, "b"),
  ]);
  assert.strictEqual(db.rows.get("a").amountMinor, -99900, "a correction reaches the ledger");
  assert.strictEqual(db.rows.get("a").description, "Fridge repair, corrected");
  assert.strictEqual(db.rows.size, 2, "and does not add a second row for the same expense");
  console.log("7) Reconciling twice changes nothing, but a corrected expense still corrects");
}

// ---- 8. the endpoint: auth, and what it refuses to trust ------------
{
  const RECORDS = [expense(owned, "a")];
  let fetched = [];
  const serve = (status, body) => {
    fetched = [];
    globalThis.fetch = async (url, init) => {
      fetched.push({ url: String(url), auth: init?.headers?.Authorization });
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    };
  };

  let db;
  const env = (tenant = {}) => {
    db = fakeLedger();
    return {
      TENANTS: { get: async () => ({ brandName: "B", currency: "USD", ghlPit: "pit", ...tenant }) },
      LEDGER_DB: db,
    };
  };
  const post = async (body, e = env(), headers = {}) => {
    const res = await handleExpenseApproved(
      new Request("https://w.dev/ghl-expense-approved", { method: "POST", headers, body: JSON.stringify(body) }), e);
    return { status: res.status, body: await res.json() };
  };

  serve(200, { records: RECORDS });
  const ok = await post({ locationId: "L1" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.posted, 1);
  assert.strictEqual(db.rows.get("a").amountMinor, -25000);
  assert.ok(fetched[0].url.includes("custom_objects.expenses/records/search"), "read from GHL");

  // The body is a nudge and is trusted for nothing but the location and secret.
  serve(200, { records: RECORDS });
  const spoofed = await post({ locationId: "L1", amount: 999999, paid_by: "owner", recordId: "attacker" });
  assert.strictEqual(spoofed.body.posted, 1);
  assert.strictEqual(db.rows.get("a").amountMinor, -25000, "the body's own figures are ignored entirely");
  assert.strictEqual(db.rows.get("attacker"), undefined);

  // A nudge with no body at all still works -- GHL may send nothing useful.
  serve(200, { records: RECORDS });
  const bare = await handleExpenseApproved(
    new Request("https://w.dev/ghl-expense-approved", { method: "POST", headers: { "X-Location-Id": "L1" } }), env());
  assert.strictEqual(bare.status, 200);
  assert.strictEqual((await bare.json()).posted, 1, "the location can come from a header alone");

  // Auth, when the tenant sets a secret.
  serve(200, { records: RECORDS });
  const guarded = env({ webhookSecret: "s3cret" });
  assert.strictEqual((await post({ locationId: "L1" }, guarded)).status, 401);
  assert.strictEqual(guarded.LEDGER_DB.rows.size, 0, "and nothing is written on a refused call");
  assert.strictEqual((await post({ locationId: "L1", secret: "s3cret" }, guarded)).status, 200);
  console.log("8) The endpoint reads from GHL, ignores the body's figures, and honours the webhook secret");
}

// ---- 9. an account with no Expenses object is not an outage ---------
// Every client account today, per the 2026-10-06 sweep. A workflow pointed at
// one must not mark its run failed.
{
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '{"message":"not found"}' });
  const res = await handleExpenseApproved(
    new Request("https://w.dev/ghl-expense-approved", { method: "POST", body: JSON.stringify({ locationId: "L1" }) }),
    { TENANTS: { get: async () => ({ ghlPit: "pit" }) }, LEDGER_DB: fakeLedger() });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).skipped, "no_expenses_object");
  console.log("9) An account without the Expenses object answers 200, not a failed workflow run");
}

// ---- 10. an unknown tenant is refused before any GHL call -----------
{
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => "{}" }; };
  const res = await handleExpenseApproved(
    new Request("https://w.dev/ghl-expense-approved", { method: "POST", body: JSON.stringify({ locationId: "nope" }) }),
    { TENANTS: { get: async () => null } });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(called, false, "and no PIT is used against an account we do not know");
  console.log("10) An unknown locationId is refused before anything is fetched");
}

console.log("\nPASS — a nudge leaves the ledger matching the account: every owner expense posted once, in its own currency, dated when it was paid, and none that stopped qualifying.");
