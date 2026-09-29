// Shortening a stay has to take the income back off, not only add the fee.
// Run: node test-reschedule-shortening-ledger.mjs
//
// The reversal rows were written only when the gateway had ISSUED the refund.
// On the ghl_invoice gateway there is no capture to refund against -- refunds
// there are manual by design, which is GHL's own behaviour and not a fault --
// so the part is rent_refund_needed_manual and no reversal was ever written.
// The admin-fee income rows, gated on nothing but the fee existing, were.
//
// So shortening a paid stay booked a fee for dropping the nights and went on
// crediting the owner for hosting them. Income on both sides of one change,
// and the guest owed money that nothing anywhere mentioned.
//
// /cancel has always got this right: it references a manual refund with
// MANUAL_REFUND_REF and writes the rows anyway, because the income is gone
// whether or not the cash has moved yet. This is that, applied here.
import assert from "node:assert";

global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = (s) => Buffer.from(s).toString("base64");

const LOC = "ZghxU8I60bEm39JUbtCm";
const BOOKING = "SHORTEN-TEST";

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { store.set(k, v); },
};
const hdr = (s) => ({ get: (n) => (n === "X-Admin-Secret" ? s : null) });

// The ledger rows themselves, straight off the D1 bind. Reading them here
// rather than through the GHL object sync keeps the assertions about what was
// recorded, not about how it was transported.
let ledgerRows = [];
const LEDGER_DB = {
  prepare: () => ({
    bind: (...args) => ({
      recipient: args[4], category: args[6], entry_type: args[7],
      amountMinor: args[8], description: args[10], source: args[11], reference: args[12],
    }),
  }),
  batch: async (stmts) => { ledgerRows.push(...stmts); return stmts; },
};

const baseTenant = {
  brandName: "Casa Bonita", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  cleaningFeeRecipient: "manager", bookingWorkerEnabled: true, deposit: { rule: "none" },
  paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  adminSecret: "admin123", ghlPit: "pit", tzOffsetHours: -4, checkInHour: 15,
  ghlRescheduleUrl: "https://ghl.test/rescheduled",
  // Keep one night and half of the rest, inside five days of check-in.
  cancellationPolicy: { tiers: [{ underHours: 120, nights: 1, remainderPct: 0.5 }], checkedInChargePct: 1 },
};

const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Five nights at 135, paid. The gateway is what decides whether a refund can
// be issued at all, so it is the only thing that varies between the cases.
const paidSnapshot = ({ gateway = "ghl_invoice", captureId = null, checkIn }) => ({
  bookingId: BOOKING, locationId: LOC, ghlContactId: "c1", propertyCode: "Test Villa 2",
  createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
  guest: { name: "Shorten Test", email: "g@example.com" },
  stay: { checkIn, checkOut: dayOffset(new Date(checkIn) > new Date() ? 0 : 0), nights: 5, nightlyRate: 135 },
  charges: { rentTotal: 675, cleaningFee: 65, processingFee: 44.4, feePct: 0.06, grandTotal: 784.4 },
  securityDeposit: { total: 0, blocks: [], status: "none" },
  payout: { basis: 675, ownerPct: 0.85, owner: 573.75, manager: 101.25, cleaningFeeTo: "manager", status: "paid" },
  gateway, settled: true,
  captures: { RENT: { gross: 784.4, ...(captureId ? { captureId } : {}), source: gateway } },
  ghl: { transactionId: "tx-1", paymentIds: [] },
});

let notifies = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u === baseTenant.ghlRescheduleUrl) { notifies.push(JSON.parse(opts.body || "{}")); return ok({}); }
  if (u.includes("oauth2/token")) return ok({ access_token: "T" });
  if (u.includes("checkout/orders")) return ok({ id: "PP-1", links: [] });
  if (u.includes("/refund")) return ok({ id: "REF-1", status: "COMPLETED" });
  if (u.includes("backend.leadconnectorhq.com/calendars/bookings/details/")) {
    return ok({ serviceBooking: { contactId: "c1", appointmentTitle: "stay", deleted: false, services: [] } });
  }
  return ok({ ok: true, records: [], record: { id: "r" }, associations: [] });
};

const worker = (await import("./src/index.js")).default;
const { MANUAL_REFUND_REF } = await import("./src/cancellation.js");
const env = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123", LEDGER_DB };

// The stay starts in `startsIn` days and is cut from five nights to two.
const shorten = async ({ gateway = "ghl_invoice", captureId = null, startsIn }) => {
  ledgerRows = []; notifies = [];
  await kv.put(LOC, JSON.stringify(baseTenant));
  const checkIn = dayOffset(startsIn);
  const snap = paidSnapshot({ gateway, captureId, checkIn });
  snap.stay.checkOut = dayOffset(startsIn + 5);
  await kv.put(BOOKING, JSON.stringify(snap));
  const res = await worker.fetch({
    method: "POST", url: "https://w.dev/reschedule",
    json: async () => ({ bookingId: BOOKING, newCheckIn: checkIn, newCheckOut: dayOffset(startsIn + 2), reason: "test" }),
    headers: hdr("admin123"),
  }, env);
  return { status: res.status, body: await res.json() };
};

const rowsOfType = (t) => ledgerRows.filter((r) => r.entry_type === t);
const minorOf = (t) => rowsOfType(t).reduce((s, r) => s + r.amountMinor, 0);

// ---- 1. the plain case: nights dropped, nothing reversed ------------
// Far enough out that no tier applies, so there is no admin fee to argue
// about -- just three nights nobody is staying, still on the owner's books.
{
  const out = await shorten({ startsIn: 60 });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.settlement.parts[0].type, "rent_refund_needed_manual",
    "an invoice-paid booking has no capture, so the refund is a person's job -- by design, not a fault");

  assert.strictEqual(minorOf("reschedule_refund_owner"), -34425,
    "the owner's 85% of the 405 dropped rent comes back off");
  assert.strictEqual(minorOf("reschedule_refund_manager"), -6075,
    "and the manager's 15%");
  console.log("1) Rent for nights nobody is staying is taken back off, on a gateway that cannot refund itself");
}

// ---- 2. referenced as unpaid, and described as unpaid ---------------
// The row says the income is gone. It must not also imply the guest has been
// paid back, because they have not.
{
  await shorten({ startsIn: 60 });
  const row = rowsOfType("reschedule_refund_owner")[0];
  assert.strictEqual(row.reference, MANUAL_REFUND_REF,
    "the same marker /cancel uses, so the two read alike in the ledger");
  assert.match(row.description, /issued manually/,
    "and it says on its face that the money has not moved yet");
  assert.strictEqual(row.category, "income", "income reversed, not a liability recorded");
  console.log("2) The reversal is referenced and described as a refund still to be issued");
}

// ---- 3. the fee and the reversal, on one change ---------------------
// Inside the tier: one night plus half the rest is kept. Both sides now get
// written -- before, only the fee did, so shortening a stay ADDED income.
{
  const out = await shorten({ startsIn: 3 });
  const info = out.body.cancellationInfo;
  assert.strictEqual(info.lostRent, 405);
  assert.strictEqual(info.adminFee, 270, "135 for one night, plus half of the remaining 270");

  assert.strictEqual(minorOf("reschedule_admin_fee_owner") + minorOf("reschedule_admin_fee_manager"), 27000,
    "the fee is earned");
  assert.strictEqual(minorOf("reschedule_refund_owner") + minorOf("reschedule_refund_manager"), -13500,
    "and the 135 actually owed back comes off -- the two together are the 405 that stopped being earned");

  const net = minorOf("reschedule_admin_fee_owner") + minorOf("reschedule_admin_fee_manager")
    + minorOf("reschedule_refund_owner") + minorOf("reschedule_refund_manager");
  assert.strictEqual(net, 13500,
    "so a shortened stay nets to the fee retained, not to the fee ADDED on top of the rent it replaced");
  console.log("3) The admin fee and the rent reversal are both written, so the change nets to what was kept");
}

// ---- 4. a gateway that can refund is unchanged ----------------------
// The fix must not turn a real refund into a manual-looking one.
{
  await shorten({ gateway: "paypal", captureId: "cap-1", startsIn: 60 });
  const row = rowsOfType("reschedule_refund_owner")[0];
  assert.strictEqual(row.reference, "REF-1", "referenced by the refund the gateway actually issued");
  assert.doesNotMatch(row.description, /issued manually/, "and not described as owing anything");
  assert.strictEqual(minorOf("reschedule_refund_owner"), -34425, "the same money, reversed the same way");
  console.log("4) A gateway refund is still referenced by its own id, and reads as settled");
}

// ---- 5. somebody is told the guest is owed money --------------------
// The ledger now knows. Until this, nothing told a person to go and pay it --
// the same gap /cancel closed on 2026-09-26.
{
  await shorten({ startsIn: 60 });
  const n = notifies.at(-1);
  assert.strictEqual(n.manualRefundRequired, "yes");
  assert.strictEqual(n.manualRefundTotal, "405.00", "the amount, not just the fact");
  assert.strictEqual(n.refundFailed, "no",
    "and kept apart from a refund the gateway REFUSED, which is a fault rather than a task");

  await shorten({ gateway: "paypal", captureId: "cap-1", startsIn: 60 });
  assert.strictEqual(notifies.at(-1).manualRefundRequired, "no",
    "a booking whose refund went through asks nobody to do anything");
  console.log("5) A refund the gateway cannot issue is announced, with its amount");
}

// ---- 6. the deposit is NOT treated the same way ---------------------
// The rent row records income that stopped being earned, which is true the
// moment the nights are dropped. The deposit row records the guest's own money
// going back to them. Until it actually has, the liability is still
// outstanding, and writing the row early would say a deposit had been returned
// when it had not. So this one stays gated on the refund being issued.
{
  ledgerRows = []; notifies = [];
  // A deposit only exists at all on the legacy policy; everyone else collects
  // it through GHL's own fees.
  const depositTenant = { ...baseTenant, depositPolicy: "tiered_legacy", deposit: { rule: "per_night", amount: 50 } };
  await kv.put(LOC, JSON.stringify(depositTenant));

  const checkIn = dayOffset(60);
  const snap = paidSnapshot({ gateway: "ghl_invoice", captureId: null, checkIn });
  snap.stay.checkOut = dayOffset(65);
  snap.securityDeposit = { total: 250, blocks: [{ block: 1, nights: 5, amount: 250 }], status: "held" };
  await kv.put(BOOKING, JSON.stringify(snap));

  const res = await worker.fetch({
    method: "POST", url: "https://w.dev/reschedule",
    json: async () => ({ bookingId: BOOKING, newCheckIn: checkIn, newCheckOut: dayOffset(62), reason: "test" }),
    headers: hdr("admin123"),
  }, env);
  const body = await res.json();

  assert.strictEqual(body.depositDelta, -150, "three nights at 50 less deposit is owed back");
  assert.ok(body.settlement.parts.some((p) => p.type === "deposit_refund_needed_manual"),
    "and with no capture behind it, a person has to return it");

  assert.strictEqual(ledgerRows.filter((r) => r.description.includes("Deposit adjustment")).length, 0,
    "so nothing yet says the deposit went back");
  assert.ok(ledgerRows.some((r) => r.entry_type === "reschedule_refund_owner"),
    "while the rent on the same reschedule is reversed, because that is a different kind of fact");
  // 324 of rent (the legacy policy keeps a 20% admin fee out of the 405
  // dropped) plus the 150 of deposit. Both are money a person has to move.
  assert.strictEqual(notifies.at(-1).manualRefundTotal, "474.00",
    "and both amounts are named to whoever has to pay them");
  console.log("6) A deposit not yet returned is not recorded as returned, though the rent beside it reverses");
}

console.log("\nPASS — shortening a stay reverses the rent it dropped, whoever has to move the money.");
