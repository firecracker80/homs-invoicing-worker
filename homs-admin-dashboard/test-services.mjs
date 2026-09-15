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
    invoices: {},
    calls: [],
    seq: 0,
  };
  const id = (p) => `${p}${++db.seq}`;
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  const handler = async (url, init = {}) => {
    const u = new URL(url);
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
    if ((m = path.match(/^\/contacts\/([^/]+)$/))) {
      return json(200, { contact: { id: m[1], firstName: "Ana", lastName: "Reyes", phone: "8095551234", email: "ana@example.com" } });
    }
    if ((m = path.match(/^\/locations\/([^/]+)$/))) {
      return json(200, { location: { id: m[1], name: "RL Santana Refrigeración", phone: "+18298779574", business: { name: "RL Santana Refrigeración", address: "Primera, Manzana 16", city: "Santo Domingo Este", country: "DO" } } });
    }
    if (path === "/invoices/estimate" && method === "POST") {
      const eid = id("est");
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
        businessDetails: est.businessDetails, status: "draft",
      };
      return json(200, { estimate: est, invoice: db.invoices[iid] });
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

const vendorEntry = { label: "RL Santana Refrigeración", kind: "service_vendor", ghlPitSecretName: "GHL_PIT_RL_SANTANA", currency: "DOP", dispatchUserId: "vo55Cl20aQZy7Blgr6xd" };
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

// ---- 6. sync: direct customers are not mirrored -----------------------------------
{
  ghl = makeGhl();
  seedRequest({ service_item: "X", request_source: "directo" });
  const out = await (await call(baseEnv("DOP"), "/api/services/sync", payload)).json();
  assert.equal(out.skipped, "not_a_homs_client_request");
  console.log("6) Sync ignores the vendor's own (direct) customers");
}

// ---- 7. sync lifecycle, same currency: create -> update -> paid (expense once) ----
{
  ghl = makeGhl();
  const env = baseEnv("DOP");
  seedRequest({ service_item: "Mantenimiento A/C", quoted_amount: { value: 3500, currency: "default" }, request_status: "solicitado", request_source: "cliente_homs", homs_client: CLIENT, job_address: "Villa Marisol, Las Terrenas", category: "aire_acondicionado", job_description: "Sala" });
  const first = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(first.action, "created");
  const mirrors = ghl.db.records[`${CLIENT}|${SR}`];
  const mirror = mirrors[first.mirrorId];
  assert.equal(mirror.properties.vendor_request_id, "sr1");
  assert.equal(mirror.properties.category, "air_conditioning");
  assert.equal(mirror.properties.request_status, "requested");
  assert.equal(mirror.properties.quoted_amount.value, 3500);
  assert.equal(first.links.property, "prop1");
  assert.ok(ghl.db.relations.some((r) => r.associationId === "a-sr-prop" && r.firstRecordId === "prop1" && r.secondRecordId === first.mirrorId), "relation respects the association's stored direction");

  await call(env, "/api/services/estimate", payload);
  await call(env, "/api/services/invoice", payload);
  vendorRec().properties.request_status = "pagado";
  const paid = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(paid.action, "updated");
  assert.equal(Object.keys(mirrors).length, 1, "never a second mirror");
  assert.equal(mirrors[first.mirrorId].properties.request_status, "paid");
  assert.equal(mirrors[first.mirrorId].properties.invoice_total.value, 3500);
  assert.equal(paid.expense.created, true);
  const expenses = Object.values(ghl.db.records[`${CLIENT}|custom_objects.expenses`]);
  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].properties.amount.value, 3500);
  assert.equal(expenses[0].properties.category, "maintenance_repairs");
  assert.equal(expenses[0].properties.review_status, "needs_review");
  assert.equal(paid.expense.property, "prop1");

  const again = await (await call(env, "/api/services/sync", payload)).json();
  assert.equal(again.expense.created, false);
  assert.equal(Object.values(ghl.db.records[`${CLIENT}|custom_objects.expenses`]).length, 1, "expense only on the transition into paid");
  console.log("7) Sync, same currency: mirror created + linked to the matching property, updated in place, one Expense on paid, none on re-sync");
}

// ---- 8. sync, currency mismatch: no amounts, no expense ---------------------------
{
  ghl = makeGhl();
  const env = baseEnv(null); // DEMO-HOMS today: no currency set
  seedRequest({ service_item: "Mantenimiento A/C", quoted_amount: { value: 3500, currency: "default" }, request_status: "pagado", request_source: "cliente_homs", homs_client: CLIENT, job_address: "somewhere unknown" });
  const out = await (await call(env, "/api/services/sync", payload)).json();
  const mirror = ghl.db.records[`${CLIENT}|${SR}`][out.mirrorId];
  assert.equal(out.amountsCopied, false);
  assert.ok(!("quoted_amount" in mirror.properties), "DOP must not be written into an account of another or unknown currency");
  assert.equal(out.expense.created, false);
  assert.match(out.expense.reason, /currency mismatch/);
  assert.equal(out.links.property, null, "no confident property match -> unlinked, not guessed");
  console.log("8) Sync, currency mismatch/unset: status mirrored, amounts withheld, no Expense, reason reported; unmatched property left unlinked");
}

// ---- 9. existing dashboard routes still gated --------------------------------------
{
  const res = await worker.fetch(new Request("https://w.dev/api/data?locationId=x"), baseEnv("DOP"));
  assert.equal(res.status, 401, "adding service routes must not open /api/data");
  console.log("9) /api/data still requires dashboard auth");
}

console.log("\nPASS — services flow: estimate, invoice with additions, client mirror + expense, auth gate.");
