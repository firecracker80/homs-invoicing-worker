// A reservation says where it is in its life, not just whether it was paid.
// Run: node test-reservation-status.mjs
//
// The Transactions tab showed a payment status and two dates and left the reader
// to work out whether anyone was arriving, in the house, or leaving. Four of the
// five states asked for are derivable from the dates that are already there; the
// other two -- cancelled and rescheduled -- are not recorded anywhere, so the
// reader for them is built and the field they read is not yet created.
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const APP = fs.readFileSync("./public/app.js", "utf8");

// app.js top-level `const`s are lexical, so they are only reachable from inside
// the same context. The panel is captured by handing querySelector a node whose
// innerHTML is just a property.
const panels = {};
const node = (sel) => (panels[sel] ??= { innerHTML: "", addEventListener() {}, textContent: "" });
const sandbox = {
  document: {
    body: {}, documentElement: { style: { setProperty() {} } },
    querySelector: node, querySelectorAll: () => [], getElementById: () => null,
    addEventListener() {}, createTreeWalker: () => ({ nextNode: () => null }),
  },
  location: { search: "" }, URLSearchParams, NodeFilter: { SHOW_TEXT: 4 },
  MutationObserver: class { observe() {} }, console, navigator: { language: "en" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  window: {}, fetch: async () => ({ ok: true, json: async () => ({}) }), setTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(APP, sandbox);
const run = (code) => vm.runInContext(code, sandbox);

const TODAY = "2026-10-07";
const status = (t, today = TODAY) => run(`stayStatus(${JSON.stringify(t)}, ${JSON.stringify(today)})`);

// ---- 1. the four states the dates can tell us -----------------------
{
  assert.strictEqual(status({ checkinDate: "2026-10-20", checkoutDate: "2026-10-25" }), "new",
    "check-in still ahead");
  assert.strictEqual(status({ checkinDate: "2026-10-05", checkoutDate: "2026-10-11" }), "active",
    "arrived and not yet gone");
  assert.strictEqual(status({ checkinDate: "2026-10-02", checkoutDate: "2026-10-07" }), "departing",
    "leaves today");
  assert.strictEqual(status({ checkinDate: "2026-09-20", checkoutDate: "2026-09-27" }), "past",
    "already over");
  console.log("1) New, active, departing and past all come out of the two dates");
}

// ---- 2. the boundaries, which is where this kind of thing is wrong ---
{
  // Arriving today is active, not new: they are in the house tonight.
  assert.strictEqual(status({ checkinDate: TODAY, checkoutDate: "2026-10-12" }), "active");
  // Last full day is still active, not departing.
  assert.strictEqual(status({ checkinDate: "2026-10-01", checkoutDate: "2026-10-08" }), "active");
  // Yesterday's checkout is past, not departing.
  assert.strictEqual(status({ checkinDate: "2026-10-01", checkoutDate: "2026-10-06" }), "past");
  // Tomorrow's check-in is new, not active.
  assert.strictEqual(status({ checkinDate: "2026-10-08", checkoutDate: "2026-10-12" }), "new");
  // A same-day booking leaving today reads as departing: checkout wins, because
  // that is the half of it somebody still has to do something about.
  assert.strictEqual(status({ checkinDate: TODAY, checkoutDate: TODAY }), "departing");
  console.log("2) Every boundary day lands on the right side of it");
}

// ---- 3. the timezone trap --------------------------------------------
// A date-only string parses as UTC midnight, so `new Date("2026-10-07")` is the
// evening of the 6th anywhere west of Greenwich -- including the DR, at UTC-4,
// which is where the readers are. Comparing Date objects would make every
// status a day early for exactly the people using this.
{
  // Dates arrive from GHL as either a plain date or a UTC-midnight timestamp;
  // both must mean the same day.
  assert.strictEqual(status({ checkinDate: "2026-10-02T00:00:00.000Z", checkoutDate: "2026-10-07T00:00:00.000Z" }),
    "departing", "a UTC-midnight timestamp is the day it prints, not the day before");

  // And `today` is built from the reader's local clock, not UTC's. At 9pm in
  // Santo Domingo on the 7th, UTC is already the 8th.
  const localEvening = new Date(2026, 9, 7, 21, 30); // local, not UTC
  assert.strictEqual(run(`todayISO(new Date(2026, 9, 7, 21, 30))`), "2026-10-07",
    "late evening is still today where the reader is standing");
  assert.ok(localEvening.toISOString().startsWith("2026-10-08") || true); // documents the drift

  // Single-digit months and days are padded, or the string compare is garbage:
  // "2026-1-7" sorts after "2026-10-07".
  assert.strictEqual(run(`todayISO(new Date(2026, 0, 7))`), "2026-01-07");
  console.log("3) Dates are compared as strings, so no status is a day early in the DR");
}

// ---- 4. a missing date claims nothing --------------------------------
{
  assert.strictEqual(status({ checkinDate: "", checkoutDate: "" }), null);
  assert.strictEqual(status({ checkinDate: "2026-10-20", checkoutDate: "" }), "new",
    "a future check-in is enough to say it has not started");
  assert.strictEqual(status({ checkinDate: "", checkoutDate: "2026-10-20" }), null,
    "a checkout alone cannot say whether anyone arrived");
  assert.strictEqual(status({ checkinDate: "not a date", checkoutDate: "2026-10-20" }), null,
    "and unparseable text is not treated as a date");
  assert.strictEqual(run(`stayBadge(null)`), '<span class="badge neutral">—</span>',
    "which shows as a dash rather than a guess");
  console.log("4) An unknown status is shown as unknown, not guessed from one date");
}

// ---- 5. cancelled and rescheduled, when the field exists -------------
// These are the two states the dates cannot express, and the whole reason a
// booking_status field is needed. The reader is here; nothing writes it yet.
{
  for (const s of ["cancelled", "rescheduled", "new", "active", "departing", "past"]) {
    assert.strictEqual(status({ bookingStatus: s, checkinDate: "2026-10-20", checkoutDate: "2026-10-25" }), s,
      `a written "${s}" outranks the dates`);
  }
  // Case and whitespace from a CRM dropdown.
  assert.strictEqual(status({ bookingStatus: "Cancelled", checkinDate: "2026-10-20", checkoutDate: "2026-10-25" }), "cancelled");

  // But a value outside the vocabulary is not promoted to a status. Otherwise a
  // typo in GHL becomes a badge nobody can explain, and a filter option that
  // matches one row.
  assert.strictEqual(status({ bookingStatus: "cancelledd", checkinDate: "2026-10-20", checkoutDate: "2026-10-25" }), "new");
  assert.strictEqual(status({ bookingStatus: "", checkinDate: "2026-10-02", checkoutDate: "2026-10-07" }), "departing");
  console.log("5) A written status wins, and an unrecognised one does not become a badge");
}

// ---- 6. the filter offers what is there, in lifecycle order ----------
{
  const list = [{ stayStatus: "past" }, { stayStatus: "new" }, { stayStatus: "departing" }, { stayStatus: "new" }, { stayStatus: null }];
  // Parsed back out of the context: an array handed across a vm realm has a
  // different Array.prototype, and deepStrictEqual compares prototypes -- it
  // fails on two lists that print identically.
  const opts = JSON.parse(run(`JSON.stringify(stayStatusOptions(${JSON.stringify(list)}))`));
  assert.deepStrictEqual(opts.map((o) => o.value), ["new", "departing", "past"],
    "lifecycle order -- alphabetical would read Departing, New, Past, which is no order at all");
  assert.deepStrictEqual(opts.map((o) => o.label), ["New", "Departing", "Past"]);
  assert.strictEqual(run(`stayStatusOptions([{stayStatus: null}]).length`), 0,
    "and a status nothing has is not offered, so no filter can select an empty table");
  console.log("6) The Status filter lists only present statuses, in lifecycle order");
}

// ---- 7. the panel actually renders it -------------------------------
// Cases 1-6 prove the functions. Deleting the line in renderTransactions that
// stamps stayStatus onto each record passes all of them, and the column shows a
// dash on every row while the filter offers nothing -- i.e. the whole defect,
// untouched. Asserted through the panel the reader looks at.
{
  run(`DATA = { transactions: [
    { id: "t1", guestName: "Sofia Reyes", propertyName: "Villa Azul", checkinDate: "2026-10-02", checkoutDate: "2026-10-07",
      bookingTotal: { value: 500, currency: "USD" }, paymentStatus: "paid", bookingReference: "BR-1", otaChannelName: "Airbnb" },
    { id: "t2", guestName: "Luis Mora", propertyName: "Casa Bonita", checkinDate: "2026-12-01", checkoutDate: "2026-12-05",
      bookingTotal: { value: 900, currency: "USD" }, paymentStatus: "pending", bookingReference: "BR-2", otaChannelName: "Direct" },
  ] }`);
  run(`renderTransactions()`);
  const html = panels["#panel-transactions"].innerHTML;

  assert.ok(html, "the panel was written to");
  assert.match(html, /<th>Status<\/th>/, "there is a Status column");
  assert.match(html, /<td data-label="Status"><span class="badge [a-z]+">[A-Za-z]+<\/span><\/td>/,
    "and it holds a badge, not an empty cell");
  assert.ok(!/<span class="badge neutral">—<\/span>/.test(html),
    "neither row is unknown: both have both dates, so a dash here means stayStatus was never computed");

  // Guest, property, dates, status lead the row, in that order.
  const headers = [...html.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepStrictEqual(headers.slice(0, 4), ["Guest", "Property", "Stay Dates", "Status"]);

  // transaction_name is gone: the Worker builds it as "<guest> — <check-in>",
  // so it repeated the two columns beside it.
  assert.ok(!headers.includes("Transaction"), "the duplicated name column is gone");
  assert.strictEqual(headers.length, 8, "and the colspan on the empty row still matches");

  // The filter bar offers the statuses these two rows actually have.
  assert.match(html, /data-field="stayStatus"/, "the Status filter is in the bar");
  assert.match(html, /<option value="new"/);
  assert.match(html, /<option value="departing"/);
  assert.ok(!/<option value="past"/.test(html), "and not one no row has");
  console.log("7) The panel renders a real status per row and a filter for it");
}

// ---- 8. the filter selects on it ------------------------------------
{
  run(`filterState.transactions.stayStatus = "new"; renderTransactions();`);
  const html = panels["#panel-transactions"].innerHTML;
  assert.ok(html.includes("Luis Mora"), "the future booking is kept");
  assert.ok(!html.includes("Sofia Reyes"), "the one leaving today is filtered out");
  run(`filterState.transactions.stayStatus = "";`);
  console.log("8) Choosing a status filters the table to it");
}

// ---- 9. every label is translatable ---------------------------------
// The audience is Dominican. A badge built in JS is prose like any other, and
// the locale pass only translates what the dictionary holds.
{
  const dict = JSON.parse(run(`JSON.stringify(I18N.es)`));
  for (const label of JSON.parse(run(`JSON.stringify(Object.values(STAY_LABELS))`))) {
    assert.ok(dict[label], `"${label}" is a badge the table prints and has no Spanish`);
  }
  for (const header of ["Guest", "Property", "Stay Dates", "Status", "Total", "Payment", "OTA Channel", "Booking Ref"]) {
    assert.ok(dict[header], `"${header}" is a column header with no Spanish`);
  }
  console.log("9) Every new badge and every column header has Spanish");
}

// ---- 10. the normalizer carries the field ---------------------------
{
  const { normalizeTransaction } = await import("./src/normalize.js");
  const t = normalizeTransaction({ id: "x", properties: { booking_status: "cancelled", guest_name: "A" } });
  assert.strictEqual(t.bookingStatus, "cancelled",
    "booking_status is read off the record -- without this the dashboard can never see a cancellation");
  const bare = normalizeTransaction({ id: "y", properties: { guest_name: "A" } });
  assert.ok(!bare.bookingStatus, "and its absence today is not an error");
  console.log("10) The normalizer reads booking_status, so the field only has to be created and written");
}

console.log("\nPASS — a reservation shows guest, property, dates and where it is in its life.");
