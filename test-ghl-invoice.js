// Local mock tests for the GHL invoice-enrichment path -- no network, no live GHL.
// Part 1 unit-tests src/ghl-invoice.js against the real (schema-verified) API shape.
// Part 2 runs the actual worker (src/index.js) end-to-end to prove the flag wiring,
// the fallback-on-failure, and that the existing PayPal-URL flow is untouched.
import assert from "node:assert";
import { buildAppendItems, resolveDraftInvoiceId, enrichAndSendInvoice } from "./src/ghl-invoice.js";

const tenant = {
  brandName: "Luminara", currency: "USD", ownerPct: 0.85, processingFeePct: 0.06,
  defaultCleaningFee: 69, cleaningFeeRecipient: "manager", bookingWorkerEnabled: true,
  gateway: "paypal", deposit: { rule: "tiered" },
  paypalApi: "https://p", paypalClientId: "C", paypalSecret: "S",
  airtableBaseId: "a", airtableToken: "pat", defaultPropertyRecId: "rP",
  ghlPit: "test-ghl-pit"
};
const env = {};

// ---- mock booking-composer output (real snapshot shape, not a flat "quote") ----
const snapshot = {
  bookingId: "BK-1001", locationId: "wLGDbGcQ4QSG3nlT3Sis", ghlContactId: "c_abc",
  guest: { name: "Test Guest", email: "guest@example.com", phone: "+18090000000" },
  stay: { checkIn: "2026-09-01", checkOut: "2026-09-06", nights: 5, nightlyRate: 60 },
  charges: { rentTotal: 300, cleaningFee: 50, processingFee: 24.3, grandTotal: 474.3 },
  securityDeposit: { total: 100 }
};

// ---- capture what the module sends to GHL ----
const calls = [];
function mockFetch(url, opts) {
  calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });

  if (url.includes("/invoices/?")) {
    assert.ok(url.includes(`altId=${encodeURIComponent(snapshot.locationId)}`), "list-invoices must send altId -- omitting it 401s live despite not being in describe_operation's schema");
    assert.ok(url.includes("altType=location"), "list-invoices must send altType=location");
    assert.ok(!url.includes("status="), "must NOT filter by status server-side -- 'draft' was an unverified guess that returned zero results live; filter client-side instead");
    // A real contact can have a mix: an old paid invoice (must be excluded)
    // and the actual unpaid draft the rental calendar just created (newer,
    // no known status string -- proves we don't need to guess it).
    return jsonRes({ invoices: [
      { _id: "inv_paid_old", invoiceNumber: "000012", status: "paid", createdAt: "2026-08-20T12:00:00Z" },
      { _id: "inv_draft_1", invoiceNumber: null, createdAt: "2026-08-26T12:00:00Z" }
    ], total: 2 });
  }
  if (url.match(/\/invoices\/[^/]+\/send$/)) return jsonRes({ emailData: {}, invoice: { _id: "inv_draft_1" }, smsData: {} });
  if (url.match(/\/invoices\/[^/?]+\?.*altType=location/) && (!opts.method || opts.method === "GET")) {
    assert.ok(url.includes(`altId=${encodeURIComponent(snapshot.locationId)}`), "get-invoice must send altId -- same 401 risk as list-invoices");
    // get-invoice: existing draft GHL's rental calendar already created (rent
    // line only), WITH GHL's own auto-assigned invoiceNumber -- proves the
    // PUT appends to it rather than overwriting GHL's sequential numbering.
    // Real GHL also returns full ISO datetimes here, NOT date-only -- this
    // is exactly the shape that 422'd live before the dateOnly() fix.
    return jsonRes({
      _id: "inv_draft_1", name: "Reserva BK-1001", title: "INVOICE", currency: "USD",
      invoiceNumber: "000018",
      issueDate: "2026-08-26T04:00:00.000Z", dueDate: "2026-09-01T03:59:59.999Z",
      invoiceItems: [{ name: "Estadía", currency: "USD", amount: 60, qty: 5 }],
      businessDetails: { name: "Luminara" }
    });
  }
  if (url.match(/\/invoices\/[^/]+$/) && opts.method === "PUT") return jsonRes({ _id: "inv_draft_1", status: "draft" });
  return jsonRes({});
}
function jsonRes(obj) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(obj)) });
}

// ---- 1. append-only line items (rent line is GHL's, NOT rebuilt here) ----
const appendItems = buildAppendItems(snapshot, tenant);
assert.equal(appendItems.length, 3, "expected 3 append-only line items (cleaning, deposit, fee)");
assert.equal(appendItems[0].name.includes("Cleaning"), true);
assert.equal(appendItems[1].name.includes("Security deposit"), true);
assert.equal(appendItems[2].amount, 24.3);

// ---- 2. resolve draft id: hinted id short-circuits (zero calls) ----
calls.length = 0;
const hintedId = await resolveDraftInvoiceId({ tenant, env, locationId: snapshot.locationId, contactId: snapshot.ghlContactId, bookingId: snapshot.bookingId, hintedInvoiceId: "inv_from_webhook" }, mockFetch);
assert.equal(hintedId, "inv_from_webhook");
assert.equal(calls.length, 0, "hinted id must skip the list-invoices lookup entirely");

// ---- 3. resolve draft id: no hint -> lookup, correct query shape ----
const id = await resolveDraftInvoiceId({ tenant, env, locationId: snapshot.locationId, contactId: snapshot.ghlContactId, bookingId: snapshot.bookingId, hintedInvoiceId: null }, mockFetch);
assert.equal(id, "inv_draft_1");

// ---- 4. enrich + send: PUT carries the full required body, not just invoiceItems ----
calls.length = 0;
// Phone deliberately NOT E.164 (spaces/dashes/parens, the shape a raw
// {{contact.phone}} merge tag can arrive in) -- proves toE164() normalizes
// it rather than assuming upstream already did.
const result = await enrichAndSendInvoice(
  { tenant, env, locationId: snapshot.locationId, invoiceId: id, snapshot, contact: { id: snapshot.ghlContactId, name: snapshot.guest.name, email: snapshot.guest.email, phoneNo: "(809) 000-0000" }, userId: "u_from_webhook" },
  mockFetch
);

const get = calls.find(c => c.method === "GET" && c.url.includes(id));
assert.ok(get, "expected a get-invoice call before the PUT");

const put = calls.find(c => c.method === "PUT");
assert.ok(put, "expected an update-invoice PUT");
assert.equal(put.body.invoiceNumber, "000018-BK-1001", "must APPEND bookingId to GHL's own invoiceNumber, not replace it -- keeps the guest-facing sequential numbering intact");
// The fields update-invoice actually REQUIRES (verified live) -- must be present, echoed from get-invoice
for (const f of ["name", "currency", "issueDate", "dueDate"]) {
  assert.ok(put.body[f], `update-invoice body missing required field: ${f}`);
}
assert.equal(put.body.issueDate, "2026-08-26", "issueDate must be truncated to YYYY-MM-DD -- GHL's GET returns a full ISO datetime, and the PUT validator 422s on that form live");
assert.equal(put.body.dueDate, "2026-09-01", "dueDate must be truncated to YYYY-MM-DD -- same live 422 as issueDate");
assert.ok(put.body.discount, "discount must be present -- 422s live with 'discount should not be empty' despite the schema marking it optional");
assert.equal(put.body.contactDetails.phoneNo, "+18090000000", "phone must be normalized to E.164 -- 422s live on '(809) 000-0000' with 'Phone number must be in E.164 format'");
// Rent line preserved + 3 appended = 4, rent line untouched (still GHL's own $60 x5)
assert.equal(put.body.invoiceItems.length, 4, "rent line (GHL's) + 3 appended lines");
assert.deepEqual(put.body.invoiceItems[0], { name: "Estadía", currency: "USD", amount: 60, qty: 5 }, "existing rent line must be preserved untouched, not rebuilt");

const send = calls.find(c => c.url.endsWith("/send"));
assert.ok(send, "expected a send-invoice call");
assert.equal(send.body.action, "sms_and_email", "action must be a real enum value, not the invented 'send'");
assert.equal(send.body.liveMode, true);
assert.equal(send.body.userId, "u_from_webhook", "userId must be the per-call value passed in, not resolved from tenant config");
assert.equal(send.body.sendTo, undefined, "sendTo is not a real field on this endpoint");
assert.equal(send.body.deliver, undefined, "deliver is not a real field on this endpoint");

console.log("PASS (unit) — ghl-invoice.js matches the verified live API schema");
console.log(`  Appended ${result.appendedItems.length} lines to the existing ${put.body.invoiceItems.length - result.appendedItems.length}-line draft`);
console.log(`  Sent via action=${send.body.action}, liveMode=${send.body.liveMode}`);

// ---- 4b. retry lookup: substring match against an already-stamped number ----
// Simulates a second webhook fire hitting list-invoices directly (e.g. the
// hinted-id path was unavailable) after this exact invoice was already
// enriched once. GHL's own number ("000018") isn't known in advance, so this
// MUST be a substring match, not the exact "===" the earlier CC-prefix design used.
calls.length = 0;
async function retryMockFetch(url, opts) {
  if (url.includes("/invoices/?")) {
    return jsonRes({ invoices: [
      { _id: "inv_paid_old", invoiceNumber: "000012", status: "paid", createdAt: "2026-08-20T12:00:00Z" },
      { _id: "inv_draft_1", invoiceNumber: "000018-BK-1001", status: "sent", createdAt: "2026-08-26T12:00:00Z" },
      // A DIFFERENT, unrelated newer invoice for the same contact -- proves
      // the substring match on bookingId wins over "just take the newest".
      { _id: "inv_unrelated", invoiceNumber: "000019", status: "sent", createdAt: "2026-08-27T12:00:00Z" }
    ], total: 3 });
  }
  throw new Error("unexpected call in retry test: " + url);
}
const retryId = await resolveDraftInvoiceId({ tenant, env, locationId: snapshot.locationId, contactId: snapshot.ghlContactId, bookingId: snapshot.bookingId, hintedInvoiceId: null }, retryMockFetch);
assert.equal(retryId, "inv_draft_1", "must find the already-stamped invoice by substring match, not fall through to 'newest' and grab the unrelated one");
console.log("4b) Retry lookup against a stamped '000018-BK-1001' -> found inv_draft_1, not the newer unrelated invoice");

// =========================================================================
// Part 2 — end-to-end through the actual worker, proving the flag wiring
// =========================================================================
global.Response = class { constructor(b, i = {}) { this.body = b; this.status = i.status || 200; } async json() { return JSON.parse(this.body); } };
global.btoa = s => Buffer.from(s).toString("base64");
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); }, async put(k, v) { store.set(k, v); } };

let paypalOrderCalls = 0;
let ghlInvoiceCalls = 0;
let forceGhlFailure = false;
let lastSendUserId = null;

global.fetch = async (url, opts = {}) => {
  if (url.includes("oauth2/token")) return { ok: true, json: async () => ({ access_token: "T" }) };
  if (url.includes("checkout/orders")) {
    paypalOrderCalls++;
    return { ok: true, json: async () => ({ id: "PP-ORDER", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=PP" }] }) };
  }
  if (url.includes("services.leadconnectorhq.com/invoices")) {
    ghlInvoiceCalls++;
    if (forceGhlFailure) return { ok: false, status: 500, text: async () => JSON.stringify({ message: "boom" }) };
    if (url.endsWith("/send")) lastSendUserId = JSON.parse(opts.body).userId;
    return mockFetch(url, opts);
  }
  if (url.includes("airtable")) {
    const b = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === "PATCH") return { ok: true, json: async () => ({ id: "patched" }) };
    return { ok: true, json: async () => ({ records: (b?.records || []).map((r, i) => ({ id: "rec" + i, fields: r.fields })) }) };
  }
  if (url.includes("leadconnector")) return { ok: true, json: async () => ({ ok: true }) };
  throw new Error("unmocked: " + url);
};

const worker = (await import("./src/index.js")).default;
const workerEnv = { WORKER_URL: "https://w.dev", TENANTS: kv, BOOKINGS: kv, ADMIN_SECRET: "admin123" };
const baseTenantKV = { ...tenant, defaultPropertyRecId: "rP" };

// bookingId and userId below stand in for {{contact.booking_id}} and
// {{user.id}} -- both per-request merge tags on the real webhook, not
// anything HOMS invents or stores per tenant.
const bookingBody = (bookingId, extra = {}) => ({
  bookingId, locationId: "wLGDbGcQ4QSG3nlT3Sis", contactId: "c_abc", userId: "u_from_ghl_workflow",
  firstName: "Test", lastName: "Guest", email: "guest@example.com", phone: "+18090000000",
  checkIn: "2026-09-01", checkOut: "2026-09-06", stayTotal: "300", cleaningFee: "50",
  ...extra
});

// 5. Default behavior UNCHANGED: no invoiceStrategy set -> still paypal_url
await kv.put("wLGDbGcQ4QSG3nlT3Sis", JSON.stringify(baseTenantKV));
paypalOrderCalls = 0; ghlInvoiceCalls = 0;
const r5 = await (await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => bookingBody("E2E-DEFAULT"), headers: { get: () => null } }, workerEnv)).json();
assert.equal(r5.mode, "paypal_url", "with no invoiceStrategy set, default must remain paypal_url");
assert.equal(paypalOrderCalls, 1, "default path must still call PayPal exactly once");
assert.equal(ghlInvoiceCalls, 0, "default path must never touch the GHL invoices API");
console.log("5) Default (no flag) -> mode:", r5.mode, "| PayPal calls:", paypalOrderCalls, "| GHL invoice calls:", ghlInvoiceCalls);

// 6. invoiceStrategy: "enrich" -> routes through GHL, PayPal never called
await kv.put("wLGDbGcQ4QSG3nlT3Sis", JSON.stringify({ ...baseTenantKV, invoiceStrategy: "enrich" }));
paypalOrderCalls = 0; ghlInvoiceCalls = 0; forceGhlFailure = false;
const r6 = await (await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => bookingBody("E2E-ENRICH"), headers: { get: () => null } }, workerEnv)).json();
assert.equal(r6.mode, "enrich");
assert.equal(r6.invoiceId, "inv_draft_1");
assert.equal(r6.approveUrl, null, "enrich mode has no PayPal link to return");
assert.equal(paypalOrderCalls, 0, "enrich success must never fall through to PayPal");
assert.ok(ghlInvoiceCalls > 0);
assert.equal(lastSendUserId, "u_from_ghl_workflow", "send-invoice's userId must come from the webhook's {{user.id}}, not tenant config");
console.log("6) invoiceStrategy=enrich -> mode:", r6.mode, "| invoiceId:", r6.invoiceId, "| sent as userId:", lastSendUserId, "| PayPal calls:", paypalOrderCalls);

// 6b. A DIFFERENT user firing the same workflow -> send-invoice uses THEIR id,
// proving this scales per-request rather than being pinned to one tenant-wide value.
paypalOrderCalls = 0; ghlInvoiceCalls = 0; lastSendUserId = null;
await (await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => bookingBody("E2E-ENRICH-2", { userId: "u_a_different_teammate" }), headers: { get: () => null } }, workerEnv)).json();
assert.equal(lastSendUserId, "u_a_different_teammate");
console.log("6b) Different {{user.id}} on the webhook -> sent as:", lastSendUserId);

// 7. GHL failure -> silent fallback to paypal_url, guest still gets a link
paypalOrderCalls = 0; ghlInvoiceCalls = 0; forceGhlFailure = true;
const r7 = await (await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => bookingBody("E2E-FALLBACK"), headers: { get: () => null } }, workerEnv)).json();
assert.equal(r7.mode, "paypal_url", "a GHL failure must fall back to the existing flow, not error out to the guest");
assert.ok(r7.approveUrl.includes("sandbox.paypal.com"), "guest must still receive a working PayPal link on fallback");
assert.equal(paypalOrderCalls, 1);
console.log("7) GHL enrich fails -> mode:", r7.mode, "| approveUrl present:", !!r7.approveUrl, "(fallback worked, nothing lost)");
forceGhlFailure = false;

// 7b. Missing {{user.id}} on the webhook (workflow misconfigured) -> same
// fallback path, not a hard error to the guest.
paypalOrderCalls = 0; ghlInvoiceCalls = 0;
const r7b = await (await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => bookingBody("E2E-NO-USERID", { userId: null }), headers: { get: () => null } }, workerEnv)).json();
assert.equal(r7b.mode, "paypal_url", "a missing {{user.id}} must also fall back cleanly, not error out");
assert.equal(paypalOrderCalls, 1);
console.log("7b) Missing userId on webhook -> mode:", r7b.mode, "(fallback worked)");

// 8. Idempotency: retrying an already-enriched booking must NOT re-send the invoice
ghlInvoiceCalls = 0;
const r8 = await (await worker.fetch({ method: "POST", url: "https://w.dev/booking-created", json: async () => bookingBody("E2E-ENRICH"), headers: { get: () => null } }, workerEnv)).json();
assert.equal(r8.idempotent, true);
assert.equal(r8.mode, "enrich");
assert.equal(ghlInvoiceCalls, 0, "a retried enrich booking must not re-fire get/update/send-invoice (no duplicate guest notification)");
console.log("8) Retry of E2E-ENRICH -> idempotent:", r8.idempotent, "| GHL calls made:", ghlInvoiceCalls, "(0 = no duplicate send)");

console.log("\nPASS — all end-to-end assertions held. Existing PayPal-URL flow is provably untouched by this change.");
