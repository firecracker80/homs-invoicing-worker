// test-worker.js (v2) — dry run against the REAL Airtable schema mapping
global.Response = class {
  constructor(body, init = {}) { this.body = body; this.status = init.status || 200; }
  async json() { return JSON.parse(this.body); }
};
global.btoa = s => Buffer.from(s).toString("base64");

function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async get(k, o) { const v = store.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    _dump() { return Object.fromEntries([...store].map(([k, v]) => [k, JSON.parse(v)])); }
  };
}

const calls = [];
global.fetch = async (url, opts = {}) => {
  const body = opts.body && opts.headers?.["Content-Type"] === "application/json" ? JSON.parse(opts.body) : opts.body;
  calls.push({ url, method: opts.method, body });
  if (url.includes("/v1/oauth2/token"))
    return { ok: true, json: async () => ({ access_token: "MOCK_TOKEN" }) };
  if (url.includes("/v2/checkout/orders"))
    return { ok: true, json: async () => ({ id: "PP-ORDER-TEST01", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=MOCK123" }] }) };
  if (url.includes("api.stripe.com/v1/checkout/sessions")) {
    return { ok: true, json: async () => ({ id: "cs_test_MOCK789", url: "https://checkout.stripe.com/c/pay/cs_test_MOCK789" }) };
  }
  if (url.includes("api.airtable.com"))
    return { ok: true, json: async () => ({ records: body.records.map(r => ({ id: "rec" + Math.random().toString(36).slice(2, 10), fields: r.fields })) }) };
  throw new Error("Unmocked fetch: " + url);
};

const worker = (await import("./src/index.js")).default;

const env = {
  WORKER_URL: "https://booking.yv-example.workers.dev",
  // Secret Name pattern: tenant references PAYPAL_SECRET_JT1, actual value in env
  PAYPAL_SECRET_JT1: "sandbox-secret-value",
  AIRTABLE_TOKEN_JT1: "pat-mock-token",
  TENANTS: mockKV({
    "wLGDbGcQ4QSG3nIT3Sis": {
      brandName: "Residencial JT1",
      locale: "es-ES",
      currency: "USD",
      defaultLanguage: "es",
      ownerPct: 0.85,
      processingFeePct: 0.06,
      defaultCleaningFee: 60,
      cleaningFeeRecipient: "manager",
      invoiceDueHours: 24,
      bookingWorkerEnabled: true,
      paypalApi: "https://api-m.sandbox.paypal.com",
      paypalClientId: "MOCK_CLIENT",
      paypalSecretName: "PAYPAL_SECRET_JT1",     // ← Accounts."PayPal Secret Name"
      airtableBaseId: "appMOCKBASE123",
      airtableToken: "patMOCKTOKEN",              // pilot fallback still works
      properties: { "JT1-A2": "recPROPERTY_A2" }, // Property Code → record ID
      defaultPropertyRecId: "recPROPERTY_A2"
    }
  }),
  BOOKINGS: mockKV(),
  STRIPE_SECRET_YV: "sk_test_mock"
};
// second tenant: Stripe gateway (e.g. YV-managed or US-entity client)
await env.TENANTS.put("stripeLocation001", JSON.stringify({
  brandName: "YV Direct", locale: "es-ES", currency: "USD", defaultLanguage: "es",
  ownerPct: 0.85, processingFeePct: 0.06, defaultCleaningFee: 60,
  cleaningFeeRecipient: "manager", invoiceDueHours: 24, bookingWorkerEnabled: true,
  gateway: "stripe", stripeSecretName: "STRIPE_SECRET_YV",
  airtableBaseId: "appSTRIPEBASE", airtableToken: "patMOCK2",
  defaultPropertyRecId: "recSTRIPEPROP"
}));

const booking = {
  bookingId: "RES-2026-0042",
  locationId: "wLGDbGcQ4QSG3nIT3Sis",
  propertyCode: "JT1-A2",
  ghlContactId: "cnt_abc123",
  bookingSource: "Direct",
  language: "es",
  guest: { name: "Ana Pérez", email: "ana@example.com", phone: "+18095551234" },
  adults: 2, children: 1, pets: 0,
  checkIn: "2026-08-01",
  checkOut: "2026-08-13",
  bookingTotal: 1140.00,
  cleaningFee: 60
};

const res = await worker.fetch({ method: "POST", url: env.WORKER_URL + "/booking-created", json: async () => booking }, env);
const ghlResponse = await res.json();

console.log("--- Airtable writes (exact field names, your real schema) ---\n");
for (const c of calls.filter(c => c.url.includes("airtable"))) {
  const table = decodeURIComponent(c.url.split("/").pop());
  console.log(`### ${table} (${c.body.records.length} record${c.body.records.length > 1 ? "s" : ""})`);
  for (const r of c.body.records) console.log(JSON.stringify(r.fields, null, 2));
  console.log();
}
console.log("--- Response GHL receives (PayPal tenant) ---");
console.log(JSON.stringify(ghlResponse, null, 2));

// ---- Stripe tenant booking ----
calls.length = 0;
const stripeBooking = { ...booking, bookingId: "RES-2026-0043", locationId: "stripeLocation001" };
const res2 = await worker.fetch({ method: "POST", url: env.WORKER_URL + "/booking-created", json: async () => stripeBooking }, env);
const stripeResponse = await res2.json();
console.log("\n--- Stripe call (decoded form params) ---");
const sc = calls.find(c => c.url.includes("stripe.com"));
console.log(decodeURIComponent(sc.body).split("&").filter(p => p.includes("line_items") || p.includes("mode") || p.includes("Idempotency") || p.includes("metadata")).join("\n"));
console.log("\n--- Response GHL receives (Stripe tenant) ---");
console.log(JSON.stringify(stripeResponse, null, 2));
