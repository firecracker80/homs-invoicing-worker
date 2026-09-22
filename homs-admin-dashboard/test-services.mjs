// Local mock tests for the services flow -- no network, no live GHL/KV.
// Run: node test-services.mjs
import assert from "node:assert";

const VENDOR = "CKDO0Xbqdn3CVxPLGECb";
const CLIENT = "ZghxU8I60bEm39JUbtCm";
const SR = "custom_objects.service_requests";

// ---- in-memory GHL -----------------------------------------------------------
function makeGhl() {
  const db = {
    records: {
      [`${VENDOR}|${SR}`]: {},
      [`${CLIENT}|${SR}`]: {},
      [`${CLIENT}|custom_objects.properties`]: {
        prop1: { id: "prop1", properties: { property_name: "Villa Marisol", address: "Calle 5 #12, Las Terrenas" } },
        prop2: { id: "prop2", properties: { property_name: "Casa Azul", address: "Av. Independencia 40" } },
      },
      [`${CLIENT}|custom_objects.expenses`]: {},
    },
    associations: {
      [VENDOR]: [{ id: "a-sr-contact", firstObjectKey: "contact", secondObjectKey: SR }],
      [CLIENT]: [
        { id: "a-sr-prop", firstObjectKey: "custom_objects.properties", secondObjectKey: SR },
        { id: "a-exp-prop", firstObjectKey: "custom_objects.expenses", secondObjectKey: "custom_objects.properties" },
      ],
    },
    relations: [],
    estimates: {},
    estimateNumbers: {},
    invoices: {},
    calls: [],
    customValues: {
      [CLIENT]: [
        { fieldKey: "{{ custom_values.wcurrency }}", value: "USD" },
        { fieldKey: "{{ custom_values.wservice_cost_currency }}", value: "DOP only" },
      ],
    },
    rates: { dop: { usd: 0.016925833, eur: 0.014631939 } },
    rateFail: false,
    seq: 0,
  };
  const id = (p) => `${p}${++db.seq}`;
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  const handler = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "cdn.jsdelivr.net" || u.hostname.endsWith("currency-api.pages.dev")) {
      db.calls.push({ method: "GET", path: "rate:" + url });
      const m2 = u.pathname.match(/currencies\/([a-z]+)\.json$/);
      if (db.rateFail || !m2 || !db.rates[m2[1]]) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ [m2[1]]: db.rates[m2[1]] }) };
    }
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const path = u.pathname;
    const loc = u.searchParams.get("locationId") || u.searchParams.get("altId") || body?.locationId || body?.altId;
    db.calls.push({ method, path, body });
    let m;

    if ((m = path.match(/^\/objects\/([^/]+)\/records\/search$/)) && method === "POST") {
      return json(201, { records: Object.values(db.records[`${body.locationId}|${m[1]}`] || {}) });
    }
    if ((m = path.match(/^\/objects\/([^/]+)\/records$/)) && method === "POST") {
      const rid = id("rec");
      const rec = { id: rid, properties: body.properties, createdAt: "2026-09-15T12:00:00.000Z" };
      db.records[`${body.locationId}|${m[1]}`][rid] = rec;
      return json(201, { record: rec });
    }
    if ((m = path.match(/^\/objects\/([^/]+)\/records\/([^/]+)$/))) {
      const table = db.records[`${loc}|${m[1]}`] || {};
      if (method === "GET") return table[m[2]] ? json(200, { record: table[m[2]] }) : json(404, { message: "not found" });
      if (method === "PUT") {
        assert.ok(!("locationId" in body), "update bodies must not carry locationId");
        table[m[2]].properties = { ...table[m[2]].properties, ...body.properties };
        return json(200, { record: table[m[2]] });
      }
    }
    if (path === "/associations/" && method === "GET") return json(200, { associations: db.associations[loc] || [] });
    if ((m = path.match(/^\/associations\/relations\/([^/]+)$/)) && method === "GET") {
      return json(200, { relations: db.relations.filter((r) => r.firstRecordId === m[1] || r.secondRecordId === m[1]) });
    }
    if (path === "/associations/relations" && method === "POST") {
      db.relations.push(body);
      return json(201, body);
    }
    if (path === "/contacts/search" && method === "POST") return json(200, { contacts: [] });
    if (db.customValuesFail && path.endsWith("/customValues")) return json(500, { message: "boom" });
    if ((m = path.match(/^\/locations\/([^/]+)\/customValues$/))) {
      return json(200, { customValues: db.customValues[m[1]] || [] });
    }
    if ((m = path.match(/^\/contacts\/([^/]+)\/tasks$/)) && method === "POST") {
      const tid = id("task");
      db.tasks = db.tasks || [];
      db.tasks.push({ id: tid, contactId: m[1], ...body });
      return json(201, { task: { id: tid, ...body } });
    }
    if ((m = path.match(/^\/contacts\/([^/]+)$/))) {
      return json(200, { contact: { id: m[1], firstName: "Ana", lastName: "Reyes", phone: "8095551234", email: "ana@example.com", ...(db.contactExtra?.[m[1]] || {}) } });
    }
    if ((m = path.match(/^\/locations\/([^/]+)$/))) {
      return json(200, { location: { id: m[1], name: "RL Santana Refrigeración", phone: "+18298779574", timezone: "America/Santo_Domingo", business: { name: "RL Santana Refrigeración", address: "Primera, Manzana 16", city: "Santo Domingo Este", country: "DO" } } });
    }
    if (path === "/invoices/estimate" && method === "POST") {
      const eid = id("est");
      db.estimateNumbers[eid] = 20 + Object.keys(db.estimates).length + 2;
      db.estimates[eid] = { _id: eid, ...body, status: "draft" };
      return json(201, db.estimates[eid]);
    }
    if ((m = path.match(/^\/invoices\/estimate\/([^/]+)\/send$/))) {
      db.estimates[m[1]].status = "sent";
      return json(201, db.estimates[m[1]]);
    }
    if ((m = path.match(/^\/invoices\/estimate\/([^/]+)\/invoice$/))) {
      const est = db.estimates[m[1]];
      const iid = id("inv");
      db.invoices[iid] = {
        _id: iid, name: est.name, title: "FACTURA", currency: est.currency, invoiceNumber: "000105",
        contactDetails: { ...est.contactDetails, phoneNo: "8095551234" },
        invoiceItems: est.items.map((i) => ({ ...i })), issueDate: "2026-09-15T04:00:00.000Z", dueDate: "2026-09-22T03:59:59.999Z",
        businessDetails: est.businessDetails, status: "draft", source: "estimate", sourceId: m[1],
        contactId: est.contactDetails.id, createdAt: new Date().toISOString(),
      };
      est.status = "invoiced";
      // Live GHL (2026-09-15) created the invoice but returned no `invoice` key.
      if (db.bareInvoiceResponse) return json(200, { traceId: "t" });
      return json(200, { estimate: est, invoice: db.invoices[iid] });
    }
    if (path === "/invoices/estimate/list" && method === "GET") {
      return json(200, { estimates: Object.values(db.estimates).map((e) => ({ ...e, estimateNumber: db.estimateNumbers[e._id] })) });
    }
    if (path === "/invoices/" && method === "GET") {
      const cid = u.searchParams.get("contactId");
      return json(200, { invoices: Object.values(db.invoices).filter((i) => !cid || i.contactId === cid).reverse() });
    }
    if ((m = path.match(/^\/invoices\/([^/]+)\/send$/))) {
      db.invoices[m[1]].status = "sent";
      return json(200, db.invoices[m[1]]);
    }
    if ((m = path.match(/^\/invoices\/([^/]+)$/))) {
      const inv = db.invoices[m[1]];
      const total = () => inv.invoiceItems.reduce((s, i) => s + i.amount * i.qty, 0);
      if (method === "GET") return json(200, { ...inv, total: total() });
      if (method === "PUT") {
        assert.match(body.issueDate, /^\d{4}-\d{2}-\d{2}$/, "update-invoice needs date-only issueDate");
        assert.match(body.dueDate, /^\d{4}-\d{2}-\d{2}$/, "update-invoice needs date-only dueDate");
        assert.ok(body.discount, "update-invoice 422s without discount");
        Object.assign(inv, body, { invoiceItems: body.invoiceItems });
        return json(200, inv);
      }
    }
    throw new Error(`unmocked: ${method} ${path}`);
  };
  return { db, handler };
}

function makeKv(entries) {
  return { async get(k, o) { const v = entries[k]; return v == null ? null : o?.type === "json" ? v : JSON.stringify(v); } };
}

const vendorEntry = { sweepRetryDelayMs: 0, label: "RL Santana Refrigeración", kind: "service_vendor", ghlPitSecretName: "GHL_PIT_RL_SANTANA", currency: "DOP", dispatchUserId: "vo55Cl20aQZy7Blgr6xd" };
const baseEnv = (clientCurrency) => ({
  SERVICES_WEBHOOK_KEY: "svc-key",
  ADMIN_KEY: "admin",
  GHL_PIT_RL_SANTANA: "pit-vendor",
  GHL_PIT_DEMO_HOMS: "pit-client",
  DASHBOARD_TENANTS: makeKv({
    [VENDOR]: vendorEntry,
    [CLIENT]: { label: "DEMO-HOMS", ghlPitSecretName: "GHL_PIT_DEMO_HOMS", ...(clientCurrency ? { currency: clientCurrency } : {}) },
  }),
});

let ghl = makeGhl();
globalThis.fetch = (url, init) => ghl.handler(url, init);

const { default: worker } = await import("./src/index.js");
const svc = await import("./src/services.js");
const call = (env, path, body, key = "svc-key") =>
  worker.fetch(new Request(`https://w.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }), env);

function seedRequest(props) {
  const rec = { id: "sr1", createdAt: "2026-09-15T12:00:00.000Z", properties: props };
  ghl.db.records[`${VENDOR}|${SR}`].sr1 = rec;
  ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact9", secondRecordId: "sr1" });
  return rec;
}
const vendorRec = () => ghl.db.records[`${VENDOR}|${SR}`].sr1;
const payload = { vendorLocationId: VENDOR, serviceRequestId: "sr1" };

// ---- 1. auth gate --------------------------------------------------------------
{
  const env = baseEnv("DOP");
  assert.equal((await call(env, "/api/services/estimate", payload, null)).status, 401);
  assert.equal((await call(env, "/api/services/estimate", payload, "admin")).status, 401, "ADMIN_KEY must not open service webhooks");
  const viaHeader = (key) => worker.fetch(new Request("https://w.dev/api/services/estimate", { method: "POST", headers: { "Content-Type": "application/json", "X-Services-Key": key }, body: JSON.stringify({ vendorLocationId: VENDOR, pending: true }) }), env);
  assert.equal((await viaHeader("svc-key")).status, 200, "X-Services-Key header is accepted");
  assert.equal((await viaHeader(" svc-key ")).status, 200, "surrounding whitespace from a pasted value is tolerated");
  assert.equal((await viaHeader("admin")).status, 401, "X-Services-Key still rejects any other key");
  assert.equal((await call({ ...env, SERVICES_WEBHOOK_KEY: undefined }, "/api/services/estimate", payload)).status, 500, "fails closed without the secret");
  console.log("1) Service webhooks: no key / admin key -> 401, unset secret -> 500");
}

// ---- 2. estimate ---------------------------------------------------------------
{
  const env = baseEnv("DOP");
  seedRequest({ service_item: "Mantenimiento A/C 3-5 toneladas", quoted_amount: { value: 3500, currency: "default" }, job_description: "Unidad cassette, sala", request_status: "solicitado", request_source: "cliente_homs", homs_client: CLIENT, job_address: "Villa Marisol, Las Terrenas", category: "aire_acondicionado" });
  const res = await call(env, "/api/services/estimate", payload);
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  const est = ghl.db.estimates[out.estimateId];
  assert.equal(est.currency, "DOP");
  // Live 400 "Issue date cannot be in the future": the mock location is in
  // America/Santo_Domingo, so after 20:00 there UTC is already tomorrow.
  assert.equal(est.issueDate, svc.todayInZone("America/Santo_Domingo"), "issue date is today where the vendor is, not UTC");
  assert.equal(svc.todayInZone("America/Santo_Domingo", new Date("2026-09-16T02:00:00Z")), "2026-09-15");
  assert.equal(svc.todayInZone("Not/AZone", new Date("2026-09-16T02:00:00Z")), "2026-09-16", "an unknown timezone falls back to UTC rather than throwing");
  assert.match(est.expiryDate, /^\d{4}-\d{2}-\d{2}$/, "GHL 422s without a date-only expiryDate");
  assert.equal(est.expiryDate, new Date(Date.parse(est.issueDate) + 7 * 86400000).toISOString().slice(0, 10), "valid 7 days by default");
  assert.equal(est.items.length, 1);
  assert.equal(est.items[0].amount, 3500);
  assert.ok(!("taxes" in est.items[0]) && !est.automaticTaxesEnabled, "no ITBIS: no tax fields on the line");
  assert.equal(est.contactDetails.id, "contact9");
  assert.equal(est.contactDetails.phoneNo, "+18095551234");
  assert.match(est.termsNotes, /costo adicional/);
  assert.equal(est.status, "sent");
  assert.equal(vendorRec().properties.estimate_id, out.estimateId);
  assert.equal(vendorRec().properties.request_status, "cotizado");
  const idWrite = ghl.db.calls.findIndex((c) => c.method === "PUT" && c.body?.properties?.estimate_id);
  const send = ghl.db.calls.findIndex((c) => c.path.endsWith("/send"));
  assert.ok(idWrite < send, "estimate id is recorded before sending, so a failed send can't cause a duplicate");

  const again = await (await call(env, "/api/services/estimate", payload)).json();
  assert.equal(again.skipped, "estimate_already_created");
  assert.equal(Object.keys(ghl.db.estimates).length, 1);
  console.log("2) Estimate: one DOP line at the quoted price, no tax, terms included, sent, id+status written; re-run skips");
}

// ---- 3. estimate preconditions ---------------------------------------------------
{
  ghl = makeGhl();
  const env = baseEnv("DOP");
  seedRequest({ service_item: "Revisión", request_source: "directo" });
  const noPrice = await call(env, "/api/services/estimate", payload);
  assert.equal(noPrice.status, 400);
  assert.match((await noPrice.json()).error, /quoted_amount/);
  const notVendor = await call(env, "/api/services/estimate", { vendorLocationId: CLIENT, serviceRequestId: "sr1" });
  assert.equal(notVendor.status, 404, "a non-vendor tenant can't be used as a vendor");
  console.log("3) Estimate refuses a request with no price, and a tenant that isn't a service vendor");
}

// ---- 4. invoice with additional services ----------------------------------------
{
  ghl = makeGhl();
  const env = baseEnv("DOP");
  seedRequest({ service_item: "Mantenimiento A/C", quoted_amount: { value: 3500, currency: "default" }, request_source: "directo" });
  await call(env, "/api/services/estimate", payload);
  vendorRec().properties.additional_amount = { value: 1500, currency: "default" };
  vendorRec().properties.additional_services = "Cambio de capacitor";
  const res = await call(env, "/api/services/invoice", payload);
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  const inv = ghl.db.invoices[out.invoiceId];
  assert.equal(inv.invoiceItems.length, 2);
  assert.equal(inv.invoiceItems[1].name, "Servicios adicionales");
  assert.equal(inv.invoiceItems[1].amount, 1500);
  assert.equal(out.total, 5000);
  assert.equal(inv.invoiceNumber, "000105", "GHL's own invoice number is kept");
  assert.equal(inv.status, "sent");
  assert.equal(vendorRec().properties.invoice_id, out.invoiceId);
  assert.equal(vendorRec().properties.request_status, "facturado");
  assert.equal((await (await call(env, "/api/services/invoice", payload)).json()).skipped, "invoice_already_created");
  assert.equal(Object.keys(ghl.db.invoices).length, 1);
  console.log("4) Invoice: from the estimate, + one 'Servicios adicionales' line (3,500 + 1,500 = 5,000), sent, id+status written; re-run skips");
}

// ---- 5. invoice with nothing added skips the update -------------------------------
{
  ghl = makeGhl();
  const env = baseEnv("DOP");
  seedRequest({ service_item: "Instalación", quoted_amount: { value: 6000, currency: "default" }, request_source: "directo" });
  await call(env, "/api/services/estimate", payload);
  const out = await (await call(env, "/api/services/invoice", payload)).json();
  assert.equal(out.total, 6000);
  assert.ok(!ghl.db.calls.some((c) => c.method === "PUT" && c.path.startsWith("/invoices/")), "no update-invoice call when nothing was added");
  console.log("5) Invoice with no additional services: estimate lines only, no update call");
  const noEst = makeGhl();
  ghl = noEst;
  seedRequest({ service_item: "X", quoted_amount: 100, request_source: "directo" });
  assert.equal((await call(env, "/api/services/invoice", payload)).status, 422, "no estimate -> nothing to invoice");
}

// ---- 5b. invoice: bare create response, and recovery after a failed record write ----
{
  ghl = makeGhl();
  ghl.db.bareInvoiceResponse = true;
  const env = baseEnv("DOP");
  seedRequest({ service_item: "Mantenimiento", quoted_amount: { value: 100, currency: "default" }, additional_amount: { value: 50, currency: "default" }, request_source: "directo" });
  await call(env, "/api/services/estimate", payload);
  const out = await (await call(env, "/api/services/invoice", payload)).json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.total, 150);
  assert.equal(vendorRec().properties.invoice_id, out.invoiceId, "invoice found by sourceId when the create response has no invoice");

  // Simulate today's live failure: invoice exists, record never got invoice_id.
  delete vendorRec().properties.invoice_id;
  const creates = () => ghl.db.calls.filter((c) => c.path.endsWith("/invoice") && c.method === "POST").length;
  const before = creates();
  const retry = await (await call(env, "/api/services/invoice", payload)).json();
  assert.equal(retry.reusedExisting, true);
  assert.equal(retry.invoiceId, out.invoiceId);
  assert.equal(creates(), before, "retry reuses the estimate's invoice, never creates a second");
  assert.equal(Object.keys(ghl.db.invoices).length, 1);
  assert.equal(retry.total, 150, "retry does not append the additional line twice");
  assert.equal(Object.values(ghl.db.invoices)[0].invoiceItems.length, 2);
  console.log("5b) Invoice: bare create response handled via sourceId lookup; retry after a lost invoice_id reuses the same invoice");
}

// ---- 6. sync: direct customers are not mirrored -----------------------------------
{
  ghl = makeGhl();
  seedRequest({ service_item: "X", request_source: "directo" });
  const out = await (await call(baseEnv("DOP"), "/api/services/sync", payload)).json();
  assert.equal(out.skipped, "not_a_homs_client_request");
  console.log("6) Sync ignores the vendor's own (direct) customers");
}

// helper: run a HOMS-client request through estimate -> invoice -> paid
async function throughToPaid(env, { paidAt = "2026-09-14T15:30:00.000Z" } = {}) {
  await call(env, "/api/services/estimate", payload);
  await call(env, "/api/services/invoice", payload);
  ghl.db.invoices[vendorRec().properties.invoice_id].lastPaidAt = paidAt;
  vendorRec().properties.request_status = "pagado";
}
const homsReq = (extra = {}) => ({ service_item: "Mantenimiento A/C", quoted_amount: { value: 3500, currency: "default" }, request_status: "solicitado", request_source: "cliente_homs", homs_client: CLIENT, job_address: "Villa Marisol, Las Terrenas", category: "aire_acondicionado", job_description: "Sala", ...extra });
const setClient = (currency, mode) => { ghl.db.customValues[CLIENT] = [{ fieldKey: "{{ custom_values.wcurrency }}", value: currency }, { fieldKey: "{{ custom_values.wservice_cost_currency }}", value: mode }]; };
const expensesOf = () => Object.values(ghl.db.records[`${CLIENT}|custom_objects.expenses`]);

// ---- 7. sync lifecycle, DOP-only client: create -> update -> paid (one DOP expense) ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  setClient("USD", "DOP only");
  seedRequest(homsReq());
  const first = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(first.action, "created");
  const mirrors = ghl.db.records[`${CLIENT}|${SR}`];
  const mirror = mirrors[first.mirrorId];
  assert.equal(mirror.properties.vendor_request_id, "sr1");
  assert.equal(mirror.properties.category, "air_conditioning");
  assert.equal(mirror.properties.request_status, "requested");
  assert.equal(mirror.properties.currency, "dop", "original currency is recorded on the mirror");
  assert.equal(mirror.properties.quoted_amount.value, 3500, "original amount always crosses, even into a USD account");
  assert.equal(first.links.property, "prop1");
  assert.ok(ghl.db.relations.some((r) => r.associationId === "a-sr-prop" && r.firstRecordId === "prop1" && r.secondRecordId === first.mirrorId), "relation respects the association's stored direction");

  await throughToPaid(env);
  const paid = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(paid.action, "updated");
  assert.equal(Object.keys(mirrors).length, 1, "never a second mirror");
  assert.equal(mirrors[first.mirrorId].properties.request_status, "paid");
  assert.equal(mirrors[first.mirrorId].properties.invoice_total.value, 3500);
  assert.equal(paid.expense.created, true);
  const exp = expensesOf();
  assert.equal(exp.length, 1);
  assert.equal(exp[0].properties.amount.value, 3500);
  assert.equal(exp[0].properties.currency, "dop");
  assert.equal(exp[0].properties.paid_on, "2026-09-14", "paid date comes from the invoice, not the sync day");
  assert.ok(!("converted_amount" in exp[0].properties), "DOP-only client: no conversion stored");
  assert.equal(paid.conversion.applied, false);
  assert.ok(!ghl.db.calls.some((c) => c.path.startsWith("rate:")), "no rate lookup when the client chose DOP only");
  assert.equal(paid.expense.property, "prop1");

  const again = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(again.expense.created, false);
  assert.equal(expensesOf().length, 1, "expense only on the transition into paid");
  console.log("7) DOP-only client (USD account): mirror + property link, amounts kept in DOP, one DOP Expense dated from the invoice, no rate lookup, none on re-sync");
}

// ---- 8. convert client: original kept + converted at the paid-date rate ----------
{
  ghl = makeGhl();
  const env = baseEnv(null);
  setClient("USD", "Convert");
  seedRequest(homsReq());
  await call(env, "/api/services/sync", payload);
  await throughToPaid(env);
  const out = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(out.conversion.applied, true, JSON.stringify(out.conversion));
  const exp = expensesOf()[0].properties;
  assert.equal(exp.amount.value, 3500, "original amount kept");
  assert.equal(exp.currency, "dop");
  assert.equal(exp.converted_amount.value, 59.24, "3500 x 0.016925833 = 59.24");
  assert.equal(exp.exchange_rate, 0.016925833);
  assert.equal(exp.rate_date, "2026-09-14");
  assert.match(exp.rate_source, /1 USD = 59\.0813 DOP on 2026-09-14/);
  assert.ok(ghl.db.calls.some((c) => c.path.includes("currency-api@2026-09-14/v1/currencies/dop.json")), "rate is looked up for the paid date");
  const mirror = Object.values(ghl.db.records[`${CLIENT}|${SR}`])[0].properties;
  assert.equal(mirror.converted_total.value, 59.24);
  assert.equal(mirror.quoted_amount.value, 3500);
  const rateCalls = ghl.db.calls.filter((c) => c.path.startsWith("rate:")).length;
  await call(env, "/api/services/sync", payload);
  assert.equal(ghl.db.calls.filter((c) => c.path.startsWith("rate:")).length, rateCalls, "re-sync never re-rates");
  assert.equal(expensesOf().length, 1);
  console.log("8) Convert client: DOP 3,500 kept, converted USD 59.24 at the 2026-09-14 rate with rate, date and source; re-sync neither re-rates nor duplicates");
}

// ---- 9. convert client, rate unavailable / account currency unset -----------------
{
  ghl = makeGhl();
  const env = baseEnv(null);
  setClient("USD", "convert");
  ghl.db.rateFail = true;
  seedRequest(homsReq());
  await throughToPaid(env);
  const out = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(out.expense.created, true, "no rate never blocks recording the DOP cost");
  assert.equal(out.conversion.applied, false);
  assert.match(out.conversion.reason, /no DOP->USD rate/);
  assert.ok(!("converted_amount" in expensesOf()[0].properties));
  assert.equal(ghl.db.calls.filter((c) => c.path.startsWith("rate:")).length, 8, "4 days x 2 mirrors tried before giving up");

  ghl = makeGhl();
  ghl.db.customValues[CLIENT] = [{ fieldKey: "{{ custom_values.wservice_cost_currency }}", value: "Convert" }];
  seedRequest(homsReq());
  await throughToPaid(env);
  const unset = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(unset.expense.created, true);
  assert.match(unset.conversion.reason, /WCurrency/);

  ghl = makeGhl();
  setClient("DOP", "Convert");
  seedRequest(homsReq({ job_address: "somewhere unknown" }));
  await throughToPaid(env);
  const same = await (await call(env, "/api/services/sync", payload)).json();
  assert.match(same.conversion.reason, /same currency/);
  assert.equal(same.links.property, null, "no confident property match -> unlinked, not guessed");
  console.log("9) Convert client edge cases: rate unavailable, WCurrency unset, same currency -> DOP Expense still recorded, reason reported; unmatched property left unlinked");
}

// ---- 12. stages by estimateId / invoiceId / contactId, each with its own sync ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  setClient("USD", "DOP only");
  seedRequest(homsReq());

  const est = await (await call(env, "/api/services/estimate", payload)).json();
  assert.equal(est.ok, true);
  assert.equal(est.sync.action, "created", "estimate stage syncs the client copy itself");

  const estimateId = vendorRec().properties.estimate_id;
  const acc = await (await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId })).json();
  assert.equal(acc.ok, true, JSON.stringify(acc));
  assert.equal(acc.serviceRequestId, "sr1", "record found from the estimate id");
  assert.equal(vendorRec().properties.request_status, "aceptado");
  assert.equal(ghl.db.tasks.length, 1);
  const task = ghl.db.tasks[0];
  assert.equal(task.contactId, "contact9");
  assert.equal(task.assignedTo, "vo55Cl20aQZy7Blgr6xd", "task goes to the vendor's dispatch user");
  assert.match(task.title, /Mantenimiento A\/C/);
  assert.match(task.body, /Villa Marisol/);
  assert.match(task.dueDate, /T13:00:00Z$/);
  assert.equal(vendorRec().properties.task_id, task.id);
  const acc2 = await (await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId })).json();
  assert.equal(acc2.skipped, "task_already_created");
  assert.equal(ghl.db.tasks.length, 1, "accepted twice -> still one task");

  vendorRec().properties.request_status = "completado";
  const inv = await (await call(env, "/api/services/invoice", { vendorLocationId: VENDOR, contactId: "contact9" })).json();
  assert.equal(inv.ok, true, JSON.stringify(inv));
  assert.equal(inv.serviceRequestId, "sr1", "contact fallback picks the job in progress");

  const invoiceId = vendorRec().properties.invoice_id;
  const paid = await (await call(env, "/api/services/paid", { vendorLocationId: VENDOR, invoiceId })).json();
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(vendorRec().properties.request_status, "pagado");
  assert.equal(paid.sync.status, "paid");
  assert.equal(paid.sync.expense.created, true, "paid stage creates the client expense through its own sync");
  const paid2 = await (await call(env, "/api/services/paid", { vendorLocationId: VENDOR, invoiceId })).json();
  assert.equal(paid2.sync.expense.created, false);
  assert.equal(expensesOf().length, 1);
  // Status bounce (seen live 2026-09-15): mirror pulled back to requested, then paid again.
  Object.values(ghl.db.records[`${CLIENT}|${SR}`])[0].properties.request_status = "requested";
  const bounced = await (await call(env, "/api/services/sync", { vendorLocationId: VENDOR, serviceRequestId: "sr1" })).json();
  assert.equal(bounced.expense.created, false, JSON.stringify(bounced.expense));
  assert.equal(bounced.expense.reason, "already recorded");
  assert.equal(expensesOf().length, 1, "a paid -> requested -> paid bounce never creates a second Expense");
  console.log("12) Stages: estimate syncs; accepted by estimateId -> aceptado + one task to Rogelio (idempotent); invoice by contactId; paid by invoiceId -> pagado + one Expense");
}

// ---- 13. contact fallback respects the stage's status, and unknown ids 404 ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  seedRequest(homsReq({ request_status: "pagado", estimate_id: "old-est", invoice_id: "old-inv" }));
  const newer = { id: "sr2", createdAt: "2026-09-16T12:00:00.000Z", properties: homsReq({ request_status: "cotizado", estimate_id: "new-est" }) };
  ghl.db.records[`${VENDOR}|${SR}`].sr2 = newer;
  ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact9", secondRecordId: "sr2" });

  const acc = await (await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, contactId: "contact9" })).json();
  assert.equal(acc.serviceRequestId, "sr2", "a paid job is never picked for an acceptance");
  const none = await call(env, "/api/services/paid", { vendorLocationId: VENDOR, contactId: "contact9" });
  assert.equal(none.status, 404, "no facturado request for this contact -> 404, nothing touched");
  assert.equal((await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId: "nope" })).status, 404);
  const late = await (await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId: "old-est" })).json();
  assert.equal(late.skipped, "not_awaiting_acceptance", "an acceptance for a paid job changes nothing");
  assert.equal(ghl.db.records[`${VENDOR}|${SR}`].sr1.properties.request_status, "pagado");
  assert.equal((await call(env, "/api/services/accepted", { vendorLocationId: VENDOR })).status, 400);
  console.log("13) Contact fallback only picks a request in the stage's status; unknown estimate -> 404; no identifier -> 400");
}

// ---- 14. pending sweeps: no record ID needed ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  setClient("USD", "DOP only");
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const add = (id, props, createdAt = now) => {
    ghl.db.records[`${VENDOR}|${SR}`][id] = { id, createdAt, updatedAt: createdAt, properties: props };
    ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact9", secondRecordId: id });
  };
  add("ready", homsReq());
  add("noPrice", homsReq({ quoted_amount: null }));
  add("quoted", homsReq({ request_status: "cotizado", estimate_id: "e-x" }));
  add("stale", homsReq(), old);
  const sweep = async () => (await call(env, "/api/services/estimate", { vendorLocationId: VENDOR, pending: true })).json();
  const out = await sweep();
  assert.equal(out.processed, 1, JSON.stringify(out));
  assert.equal(out.results[0].serviceRequestId, "ready", "only a fresh, priced, unquoted solicitado request is estimated");
  assert.equal(Object.keys(ghl.db.estimates).length, 1);
  assert.equal((await sweep()).processed, 0, "second sweep finds nothing left to do");
  assert.equal(Object.keys(ghl.db.estimates).length, 1);

  const recs = ghl.db.records[`${VENDOR}|${SR}`];
  recs.ready.properties.request_status = "completado";
  recs.ready.properties.additional_amount = { value: 25, currency: "default" };
  const inv = await (await call(env, "/api/services/invoice", { vendorLocationId: VENDOR, pending: true })).json();
  assert.equal(inv.processed, 1, JSON.stringify(inv));
  assert.equal(inv.results[0].total, 3525);
  const inv2 = await (await call(env, "/api/services/invoice", { vendorLocationId: VENDOR, pending: true })).json();
  assert.equal(inv2.processed, 0);
  assert.equal(Object.keys(ghl.db.invoices).length, 1);
  assert.equal((await call(env, "/api/services/estimate", { vendorLocationId: VENDOR, pending: "yes" })).status, 400, "pending must be exactly true");
  console.log("14) Pending sweeps: estimate picks only fresh priced solicitado requests, invoice only completado ones; repeat sweeps do nothing");
}

// ---- 15. an estimate/invoice NUMBER works as well as an id ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  seedRequest(homsReq({ request_source: "directo" }));
  await call(env, "/api/services/estimate", payload);
  const estimateId = vendorRec().properties.estimate_id;
  const number = ghl.db.estimateNumbers[estimateId];
  assert.ok(number, "fixture gives the estimate a number");

  const byNumber = await (await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId: String(number) })).json();
  assert.equal(byNumber.ok, true, JSON.stringify(byNumber));
  assert.equal(byNumber.serviceRequestId, "sr1", "GHL's merge tag gives the number, not the id");
  assert.equal(vendorRec().properties.request_status, "aceptado");

  // An unknown number with a contactId in the same body still falls back to the contact.
  ghl = makeGhl();
  seedRequest(homsReq({ request_source: "directo" }));
  await call(env, "/api/services/estimate", payload);
  const mixed = await (await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId: "999", contactId: "contact9" })).json();
  assert.equal(mixed.serviceRequestId, "sr1", "unknown number + contactId -> contact fallback");
  // An unknown number on its own is still a clean 404.
  ghl = makeGhl();
  seedRequest(homsReq({ request_source: "directo" }));
  await call(env, "/api/services/estimate", payload);
  assert.equal((await call(env, "/api/services/accepted", { vendorLocationId: VENDOR, estimateId: "999" })).status, 404);
  console.log("15) Estimate/invoice NUMBER resolves to the right request; unknown number falls back to contactId, or 404s on its own");
}

// ---- 16. declined estimate: rechazado, noted, requotable ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  setClient("USD", "DOP only");
  seedRequest(homsReq({ job_notes: "Nota previa" }));
  await call(env, "/api/services/estimate", payload);
  const estimateId = vendorRec().properties.estimate_id;

  const out = await (await call(env, "/api/services/declined", { vendorLocationId: VENDOR, estimateId })).json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.declinedEstimate, estimateId);
  const p = () => vendorRec().properties;
  assert.equal(p().request_status, "rechazado");
  assert.equal(p().estimate_id, "", "estimate link cleared so a corrected quote can go out");
  assert.match(p().job_notes, /Nota previa/, "previous notes are kept");
  assert.match(p().job_notes, /rechazada por el cliente/);
  assert.equal(out.sync.status, "cancelled", "the client's copy shows it as cancelled");

  assert.equal((await (await call(env, "/api/services/declined", { vendorLocationId: VENDOR, contactId: "contact9" })).json()).skipped, undefined);

  // Re-quote path: price corrected, back to Solicitado -> the sweep quotes it again.
  vendorRec().properties.request_status = "solicitado";
  vendorRec().properties.quoted_amount = { value: 2800, currency: "default" };
  const again = await (await call(env, "/api/services/estimate", { vendorLocationId: VENDOR, pending: true })).json();
  assert.equal(again.processed, 1, JSON.stringify(again));
  assert.equal(again.results[0].total, 2800);
  assert.notEqual(vendorRec().properties.estimate_id, estimateId, "a second, corrected estimate");

  // A decline arriving for a job already accepted changes nothing.
  ghl = makeGhl();
  seedRequest(homsReq({ request_status: "pagado", estimate_id: "e-old" }));
  const late = await (await call(env, "/api/services/declined", { vendorLocationId: VENDOR, estimateId: "e-old" })).json();
  assert.equal(late.skipped, "not_awaiting_a_decision");
  assert.equal(vendorRec().properties.request_status, "pagado");
  console.log("16) Declined estimate: rechazado + noted + estimate cleared, client copy cancelled, re-quote works, late decline ignored");
}

// ---- 17. taskId picks the right job; an empty sweep looks again ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  const now = new Date().toISOString();
  const add = (id, props) => {
    ghl.db.records[`${VENDOR}|${SR}`][id] = { id, createdAt: now, updatedAt: now, properties: props };
    ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact9", secondRecordId: id });
  };
  // Two accepted jobs for the same customer; the OLDER one's task was completed.
  add("older", homsReq({ request_source: "directo", request_status: "aceptado", estimate_id: "e1", task_id: "t-older" }));
  ghl.db.estimates.e1 = { _id: "e1", name: "x", currency: "DOP", items: [{ name: "x", amount: 100, qty: 1 }], contactDetails: { id: "contact9" }, status: "accepted" };
  const later = new Date(Date.now() + 1000).toISOString();
  ghl.db.records[`${VENDOR}|${SR}`].newer = { id: "newer", createdAt: later, updatedAt: later, properties: homsReq({ request_source: "directo", request_status: "aceptado", estimate_id: "e2", task_id: "t-newer" }) };
  ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact9", secondRecordId: "newer" });

  const out = await (await call(env, "/api/services/invoice", { vendorLocationId: VENDOR, taskId: "t-older", contactId: "contact9" })).json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.serviceRequestId, "older", "the completed task's own job is invoiced, not the newest one");
  ghl.db.estimates.e2 = { _id: "e2", name: "y", currency: "DOP", items: [{ name: "y", amount: 200, qty: 1 }], contactDetails: { id: "contact9" }, status: "accepted" };
  const byContact = await (await call(env, "/api/services/invoice", { vendorLocationId: VENDOR, taskId: "t-unknown", contactId: "contact9" })).json();
  assert.equal(byContact.serviceRequestId, "newer", "unknown taskId + contactId falls back to the contact (newest job in progress)");

  // Sweep: first search misses the just-created record, a later search finds it.
  ghl = makeGhl();
  add("fresh", homsReq({ request_source: "directo" }));
  const hidden = ghl.db.records[`${VENDOR}|${SR}`];
  let searches = 0;
  const realHandler = ghl.handler;
  ghl.handler = async (url, init) => {
    if (String(url).endsWith(`/objects/${SR}/records/search`) && ++searches === 1) {
      const saved = { ...hidden };
      for (const k of Object.keys(hidden)) delete hidden[k];
      const res = await realHandler(url, init);
      Object.assign(hidden, saved);
      return res;
    }
    return realHandler(url, init);
  };
  const swept = await (await call(env, "/api/services/estimate", { vendorLocationId: VENDOR, pending: true })).json();
  assert.equal(swept.processed, 1, JSON.stringify(swept));
  assert.equal(swept.attempts, 2, "found on the second look");
  ghl.handler = realHandler;
  ghl = makeGhl();
  const none = await (await call(env, "/api/services/estimate", { vendorLocationId: VENDOR, pending: true })).json();
  assert.equal(none.processed, 0);
  assert.equal(none.attempts, 3, "gives up after two extra looks");
  console.log("17) taskId invoices the completed task's own job; an empty sweep looks again (found on 2nd look, gives up after 3)");
}

// ---- 18. marketplace link tags the request with the HOMS client ----
{
  const env = baseEnv("DOP");
  const base = { service_item: "Mantenimiento A/C", quoted_amount: { value: 3500, currency: "default" }, request_status: "solicitado", request_source: "directo", job_address: "Villa Marisol, Las Terrenas", category: "aire_acondicionado" };

  ghl = makeGhl();
  ghl.db.contactExtra = { contact9: { attributionSource: { utmSource: "homs-marketplace", utmCampaign: CLIENT } } };
  seedRequest({ ...base });
  const out = await (await call(env, "/api/services/estimate", payload)).json();
  assert.equal(vendorRec().properties.homs_client, CLIENT, JSON.stringify(out));
  assert.equal(vendorRec().properties.request_source, "cliente_homs");
  assert.equal(Object.keys(ghl.db.records[`${CLIENT}|${SR}`]).length, 1, "tagged request is mirrored to the client");

  ghl = makeGhl();
  ghl.db.contactExtra = { contact9: { attributionSource: { url: `https://rlsantana.example/chat?utm_source=homs-marketplace&utm_campaign=${CLIENT}` } } };
  seedRequest({ ...base });
  await call(env, "/api/services/estimate", payload);
  assert.equal(vendorRec().properties.homs_client, CLIENT, "read from the landing URL when utm fields are absent");

  // Live shape 2026-09-22: first-touch campaign lowercased, no utmCampaign, URL intact.
  ghl = makeGhl();
  ghl.db.contactExtra = { contact9: { attributionSource: { utmSource: "homs-marketplace", campaign: CLIENT.toLowerCase(), url: `https://cliente.rlsantana.com/widget/form/x?utm_source=homs-marketplace&utm_campaign=${CLIENT}` } } };
  seedRequest({ ...base });
  await call(env, "/api/services/estimate", payload);
  assert.equal(vendorRec().properties.homs_client, CLIENT, "exact-case id from the URL beats GHL's lowercased campaign");

  for (const [why, attr] of [
    ["guest link", { utmSource: "homs-guest", utmCampaign: CLIENT }],
    ["vendor as campaign", { utmSource: "homs-marketplace", utmCampaign: VENDOR }],
    ["unknown account", { utmSource: "homs-marketplace", utmCampaign: "nope" }],
    ["no attribution", null],
  ]) {
    ghl = makeGhl();
    ghl.db.contactExtra = { contact9: attr ? { attributionSource: attr } : {} };
    seedRequest({ ...base });
    const r = await (await call(env, "/api/services/estimate", payload)).json();
    assert.equal(vendorRec().properties.homs_client, undefined, why);
    assert.equal(r.sync?.skipped, "not_a_homs_client_request", why);
  }

  ghl = makeGhl();
  ghl.db.contactExtra = { contact9: { attributionSource: { utmSource: "homs-marketplace", utmCampaign: "other" } } };
  seedRequest({ ...base, request_source: "cliente_homs", homs_client: CLIENT });
  await call(env, "/api/services/estimate", payload);
  assert.equal(vendorRec().properties.homs_client, CLIENT, "an existing tag is never overwritten");
  console.log("18) marketplace link tags homs_client (utm fields or landing URL); guest/vendor/unknown/none/existing left alone");
}

// ---- 19. WF1 sync sweep: a form submission (no Estado/Origen yet) is tagged and mirrored ----
{
  const env = baseEnv("DOP");
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 86400000).toISOString();

  ghl = makeGhl();
  ghl.db.contactExtra = { contact9: { attributionSource: { utmSource: "homs-marketplace", utmCampaign: CLIENT } } };
  // Straight from Rogelio's form: no request_status, no request_source.
  ghl.db.records[`${VENDOR}|${SR}`].form1 = { id: "form1", createdAt: now, updatedAt: now,
    properties: { service_item: "Mantenimiento de aire 18,000 BTU", category: "aire_acondicionado", job_address: "Villa Marisol", job_description: "Gotea agua", urgency: "media" } };
  ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact9", secondRecordId: "form1" });
  // A direct client's request from the same day, and an old one outside the window.
  ghl.db.records[`${VENDOR}|${SR}`].direct1 = { id: "direct1", createdAt: now, updatedAt: now, properties: { service_item: "Instalación", request_status: "solicitado", request_source: "directo" } };
  ghl.db.relations.push({ associationId: "a-sr-contact", firstRecordId: "contact8", secondRecordId: "direct1" });
  ghl.db.records[`${VENDOR}|${SR}`].old1 = { id: "old1", createdAt: old, updatedAt: old, properties: { service_item: "Viejo", request_status: "pagado", request_source: "cliente_homs", homs_client: CLIENT } };

  const res = await call(env, "/api/services/sync", { vendorLocationId: VENDOR, pending: true });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.processed, 2, "only requests touched in the window: " + JSON.stringify(out));
  const form1 = ghl.db.records[`${VENDOR}|${SR}`].form1.properties;
  assert.equal(form1.homs_client, CLIENT, "form request tagged from the marketplace link");
  assert.equal(form1.request_source, "cliente_homs");
  const mirrors = Object.values(ghl.db.records[`${CLIENT}|${SR}`]);
  assert.equal(mirrors.length, 1, "exactly one client copy (the marketplace request)");
  assert.equal(mirrors[0].properties.request_status, "requested", "a blank Estado reads as Solicitado -> requested");
  assert.equal(out.results.find((r) => r.serviceRequestId === "direct1").skipped, "not_a_homs_client_request");
  assert.equal(ghl.db.estimates && Object.keys(ghl.db.estimates).length, 0, "sync never creates an estimate");

  // Second run: the copy is updated, not duplicated.
  await call(env, "/api/services/sync", { vendorLocationId: VENDOR, pending: true });
  assert.equal(Object.values(ghl.db.records[`${CLIENT}|${SR}`]).length, 1, "re-sync updates the same client copy");

  // WF1 re-run: its update step set Origen back to Directo on a tagged request,
  // and search still returns the old copy (Cliente HOMS) -- the live 2026-09-22 case.
  ghl.db.records[`${VENDOR}|${SR}`].form1.properties.request_source = "directo";
  const staleHandler = ghl.handler;
  ghl.handler = async (url, init) => {
    if (String(url).endsWith(`/objects/${SR}/records/search`)) {
      const res = await staleHandler(url, init);
      const body = JSON.parse(await res.text());
      for (const r of body.records || []) if (r.id === "form1") r.properties = { ...r.properties, request_source: "cliente_homs" };
      return { ok: true, status: 201, text: async () => JSON.stringify(body), json: async () => body };
    }
    return staleHandler(url, init);
  };
  const rerun = await (await call(env, "/api/services/sync", { vendorLocationId: VENDOR, pending: true })).json();
  ghl.handler = staleHandler;
  assert.equal(ghl.db.records[`${VENDOR}|${SR}`].form1.properties.request_source, "cliente_homs", "a tagged request is put back to Cliente HOMS");
  assert.ok(!rerun.results.find((r) => r.serviceRequestId === "form1").skipped, "and it still syncs");

  // Search lag: nothing fresh on the first look -> looks again.
  ghl = makeGhl();
  let searches = 0;
  const realHandler = ghl.handler;
  ghl.handler = async (url, init) => {
    if (String(url).endsWith(`/objects/${SR}/records/search`) && ++searches === 1) {
      const table = ghl.db.records[`${VENDOR}|${SR}`]; const saved = { ...table };
      for (const k of Object.keys(table)) delete table[k];
      const res = await realHandler(url, init);
      Object.assign(table, saved);
      return res;
    }
    return realHandler(url, init);
  };
  ghl.db.records[`${VENDOR}|${SR}`].late = { id: "late", createdAt: now, updatedAt: now, properties: { service_item: "Tarde" } };
  const lagged = await (await call(env, "/api/services/sync", { vendorLocationId: VENDOR, pending: true })).json();
  assert.equal(lagged.attempts, 2, "looked again after an empty first search");
  assert.equal(lagged.processed, 1);
  ghl.handler = realHandler;
  console.log("19) WF1 sync sweep: form request (no Estado/Origen) tagged + mirrored once; direct skipped; old ignored; search lag retried; no estimate");
}

// ---- 10. existing dashboard routes still gated --------------------------------------
{
  const res = await worker.fetch(new Request("https://w.dev/api/data?locationId=x"), baseEnv("DOP"));
  assert.equal(res.status, 401, "adding service routes must not open /api/data");
  console.log("10) /api/data still requires dashboard auth");
}

// ---- 11. /api/data tells the UI the account currency, and survives a custom-values failure ----
{
  ghl = makeGhl();
  const env = baseEnv(null);
  const get = () => worker.fetch(new Request(`https://w.dev/api/data?locationId=${CLIENT}`, { headers: { Authorization: "Bearer admin" } }), env);
  const ok = await (await get()).json();
  assert.equal(ok.accountCurrency, "USD", JSON.stringify(ok).slice(0, 200));
  ghl.db.customValuesFail = true;
  const res = await get();
  assert.equal(res.status, 200, "a custom-values read failure must not break the dashboard");
  assert.equal((await res.json()).accountCurrency, null);
  console.log("11) /api/data returns accountCurrency from WCurrency; custom-values failure degrades to null, not an error");
}

console.log("\nPASS — services flow: estimate, invoice with additions, client mirror + expense, auth gate.");
