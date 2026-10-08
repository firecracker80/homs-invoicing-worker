// Putting back what the snapshot dropped, and nothing else.
// Run: node test-schema-repair.mjs
//
// Verified on YV Guest Properties 2026-10-08, the first snapshot load anyone
// ever checked: every object, field key and option key arrived intact, and all
// three FILE_UPLOAD fields across two objects lost BOTH acceptedFormats and
// maxFileLimit. Three for three, so this is how snapshots behave.
//
// The repair is deliberately the narrowest thing that fixes that. A missing
// field or a moved option key is NOT repairable here: writing one would be
// guessing at what records already hold, and the diff should send a person to
// look instead.
import assert from "node:assert";
import { repairsFor } from "./src/schema-fingerprint.js";

const LOC = "aOBTcPWktqBI0IpfXDgI";
const worker = (await import("./src/index.js")).default;

const fp = (fields) => ({ objects: { "custom_objects.expenses": { fields } } });
const UPLOAD = { dataType: "FILE_UPLOAD", options: [], name: "Receipt Photo" };

// ---- 1. only FILE_UPLOAD constraints are proposed ---------------------
{
  const expected = fp({
    "custom_objects.expenses.receipt_photo": { ...UPLOAD, acceptedFormats: [".jpg", ".pdf"], maxFileLimit: 5 },
    "custom_objects.expenses.amount": { dataType: "MONETORY", options: [], name: "Amount" },
    "custom_objects.expenses.paid_by": { dataType: "SINGLE_OPTIONS", options: ["manager", "owner"], name: "Paid By" },
  });
  const actual = fp({
    "custom_objects.expenses.receipt_photo": { ...UPLOAD, acceptedFormats: [], maxFileLimit: null },
    "custom_objects.expenses.amount": { dataType: "MONETORY", options: [], name: "Monto" },
    "custom_objects.expenses.paid_by": { dataType: "SINGLE_OPTIONS", options: ["manager"], name: "Pagado Por" },
  });

  const r = repairsFor(expected, actual);
  assert.strictEqual(r.length, 1, "a lost option key and a translated label are NOT repaired here");
  assert.strictEqual(r[0].fieldKey, "custom_objects.expenses.receipt_photo");
  assert.deepStrictEqual(r[0].acceptedFormats, [".jpg", ".pdf"]);
  assert.strictEqual(r[0].maxFileLimit, 5);
  assert.deepStrictEqual(r[0].was, { acceptedFormats: [], maxFileLimit: null }, "and it records what it is replacing");
  console.log("1) Only FILE_UPLOAD constraints are proposed — not a lost option key, not a label");
}

// ---- 2. nothing to do is nothing proposed ----------------------------
{
  const same = fp({ "custom_objects.expenses.receipt_photo": { ...UPLOAD, acceptedFormats: [".jpg"], maxFileLimit: 5 } });
  assert.deepStrictEqual(repairsFor(same, same), []);

  // Order is not a difference: the fingerprint sorts, and a reordered list
  // would otherwise rewrite every field on every run.
  const reordered = fp({ "custom_objects.expenses.receipt_photo": { ...UPLOAD, acceptedFormats: [".jpg"], maxFileLimit: 5 } });
  assert.deepStrictEqual(repairsFor(same, reordered), []);

  // A missing object or field is skipped rather than "repaired" into existence.
  assert.deepStrictEqual(repairsFor(same, { objects: {} }), []);
  assert.deepStrictEqual(repairsFor(same, fp({})), []);
  console.log("2) An account already correct proposes nothing, and nothing absent is invented");
}

// ---- 3. both constraints travel together ------------------------------
// update-custom-field takes the whole field. Sending only the half that differs
// invites the other half to be reset to a default nobody chose.
{
  const expected = fp({ "custom_objects.expenses.receipt_photo": { ...UPLOAD, acceptedFormats: [".jpg"], maxFileLimit: 5 } });
  const onlyLimitWrong = fp({ "custom_objects.expenses.receipt_photo": { ...UPLOAD, acceptedFormats: [".jpg"], maxFileLimit: 2 } });
  const [r] = repairsFor(expected, onlyLimitWrong);
  assert.deepStrictEqual(r.acceptedFormats, [".jpg"], "the matching half is still sent");
  assert.strictEqual(r.maxFileLimit, 5);
  console.log("3) Both constraints are sent together even when only one differs");
}

// ---- the route -------------------------------------------------------
const tenant = { label: "YV", ghlPitSecretName: "PIT_YV" };
const env = {
  PROVISION_KEY: "prov", ADMIN_KEY: "admin", PIT_YV: "pit",
  DASHBOARD_TENANTS: { get: async (k, o) => (o?.type === "json" ? tenant : JSON.stringify(tenant)) },
};

let LIVE, puts;
const install = () => {
  puts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes("/objects/?")) return ok({ objects: [{ key: "custom_objects.expenses", type: "USER_DEFINED", labels: {} }] });
    if (u.includes("/custom-fields/object-key/")) return ok({ fields: LIVE, folders: [] });
    if (u.includes("/custom-fields/") && init.method === "PUT") {
      puts.push({ id: u.split("/custom-fields/")[1], body: JSON.parse(init.body) });
      return ok({ field: { id: "f1" } });
    }
    throw new Error("unmocked: " + u);
  };
};

const post = async (body, auth = "Bearer prov") => {
  install();
  const res = await worker.fetch(new Request("https://d.dev/api/schema/repair", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json() };
};

const RECEIPT = {
  id: "f1", fieldKey: "custom_objects.expenses.receipt_photo", dataType: "FILE_UPLOAD",
  name: "Recibo", showInForms: true,
};
const REPAIR = { fieldKey: "custom_objects.expenses.receipt_photo", acceptedFormats: [".jpg", ".pdf"], maxFileLimit: 5 };

// ---- 4. a dry run writes nothing -------------------------------------
{
  LIVE = [RECEIPT];
  const r = await post({ locationId: LOC, repairs: [REPAIR] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.planned.length, 1, "it says what it would do");
  assert.deepStrictEqual(puts, [], "and does none of it");
  console.log("4) Without apply, the repair plans and writes nothing");
}

// ---- 5. applying echoes name and showInForms back ---------------------
// update-custom-field REQUIRES showInForms: omitting it silently flips whether
// the field appears in forms. And `name` must survive untouched -- on a
// translated account it is the Spanish label, and a repair that renamed fields
// back to English would undo the translation it is supposed to be safe for.
{
  LIVE = [RECEIPT];
  const r = await post({ locationId: LOC, repairs: [REPAIR], apply: true });
  assert.strictEqual(r.body.applied.length, 1);
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].id, "f1");
  assert.strictEqual(puts[0].body.name, "Recibo", "the Spanish label is echoed, not reset");
  assert.strictEqual(puts[0].body.showInForms, true, "required by the endpoint, so always sent");
  assert.deepStrictEqual(puts[0].body.acceptedFormats, [".jpg", ".pdf"]);
  assert.strictEqual(puts[0].body.maxFileLimit, 5);
  // locationId travels in the BODY on this endpoint and is REJECTED in the
  // query -- the opposite of the records endpoint. All three repairs failed
  // with "LocationId can.t be undefined" on the first real run because of it.
  assert.strictEqual(puts[0].body.locationId, LOC, "sent in the body, where this endpoint wants it");
  assert.ok(!puts[0].id.includes("locationId="), "and never in the query, which this endpoint 422s on");
  console.log("5) Applying sends the constraints and echoes name and showInForms unchanged");
}

// ---- 6. it refuses to touch anything that is not an upload field ------
{
  LIVE = [{ id: "f9", fieldKey: "custom_objects.expenses.amount", dataType: "MONETORY", name: "Amount", showInForms: true }];
  let r = await post({ locationId: LOC, apply: true, repairs: [
    { fieldKey: "custom_objects.expenses.amount", acceptedFormats: [".jpg"], maxFileLimit: 5 },
  ] });
  assert.deepStrictEqual(puts, [], "a MONETORY field is never written through this route");
  assert.match(r.body.skipped[0].reason, /not a FILE_UPLOAD/);

  // A key that is not on the account at all.
  LIVE = [RECEIPT];
  r = await post({ locationId: LOC, apply: true, repairs: [{ fieldKey: "nope", acceptedFormats: [], maxFileLimit: 1 }] });
  assert.deepStrictEqual(puts, []);
  assert.match(r.body.skipped[0].reason, /no such field/);
  console.log("6) A non-upload field or an unknown key is skipped, never written");
}

// ---- 7. a field already correct is left alone ------------------------
// Re-running the repair must be free. Otherwise every provisioning run rewrites
// every upload field, and the audit trail fills with changes that changed nothing.
{
  LIVE = [{ ...RECEIPT, acceptedFormats: [".pdf", ".jpg"], maxFileLimit: 5 }];
  const r = await post({ locationId: LOC, repairs: [REPAIR], apply: true });
  assert.deepStrictEqual(puts, [], "order differs but the set matches, so nothing is written");
  assert.match(r.body.skipped[0].reason, /already correct/);
  console.log("7) A field that already matches is skipped, so repeat runs write nothing");
}

// ---- 8. gated, and refuses an empty request --------------------------
{
  assert.strictEqual((await post({ locationId: LOC, repairs: [REPAIR] }, "Bearer admin")).status, 401,
    "the dashboard key must not be able to rewrite schema");
  assert.strictEqual((await post({ locationId: LOC, repairs: [] })).status, 400);
  assert.strictEqual((await post({ repairs: [REPAIR] })).status, 400, "no locationId");
  console.log("8) PROVISION_KEY only, and an empty repair list is refused");
}

console.log("\nPASS — the repair puts back exactly what a snapshot drops, and touches nothing else.");

// ======================================================================
// --recreate: the destructive fallback, and when it must refuse
//
// Added 2026-10-08 after YV. create-custom-field REFUSES a FILE_UPLOAD field
// without maxFileLimit ("Required field maxFileLimit missing"), but a snapshot
// creates them exactly that way -- so the field exists in a state GHL's own API
// will not accept, and update 500s on it even when the missing value is
// supplied. Delete and rebuild is the only route, and it is reached only after
// a real update has really failed.
// ======================================================================

let updateFails, deleted, created, recordCount;
const installR = () => {
  puts = []; deleted = []; created = []; 
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || "GET";
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes("/objects/?")) return ok({ objects: [{ key: "custom_objects.expenses", type: "USER_DEFINED", labels: {} }] });
    if (u.includes("/custom-fields/object-key/")) return ok({ fields: LIVE, folders: [] });
    if (u.includes("/records/search")) return ok({ records: [], total: recordCount });
    if (u.includes("/custom-fields/") && method === "PUT") {
      puts.push({ body: JSON.parse(init.body) });
      if (updateFails) return { ok: false, status: 500, text: async () => JSON.stringify({ message: "Something went wrong" }) };
      return ok({ field: { id: "f1" } });
    }
    if (u.includes("/custom-fields/") && method === "DELETE") { deleted.push(u); return ok({ succeded: true }); }
    if (u.endsWith("/custom-fields/") && method === "POST") {
      created.push(JSON.parse(init.body));
      return ok({ field: { id: "newid" } });
    }
    throw new Error("unmocked: " + method + " " + u);
  };
};
const postR = async (body) => {
  installR();
  const res = await worker.fetch(new Request("https://d.dev/api/schema/repair", {
    method: "POST", headers: { Authorization: "Bearer prov", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json() };
};
const SNAPSHOT_FIELD = { ...RECEIPT, objectKey: "custom_objects.expenses", parentId: "folder1" };

// ---- 9. the gentle path is tried first, always -----------------------
{
  LIVE = [SNAPSHOT_FIELD]; updateFails = false; recordCount = 0;
  const r = await postR({ locationId: LOC, repairs: [REPAIR], apply: true, recreate: true });
  assert.strictEqual(r.body.applied.length, 1, "update succeeded, so nothing is destroyed");
  assert.deepStrictEqual(deleted, [], "no delete when an update works");
  assert.deepStrictEqual(created, []);
  console.log("9) With --recreate, a field that updates cleanly is never deleted");
}

// ---- 10. destroy only after the update really failed -----------------
{
  LIVE = [SNAPSHOT_FIELD]; updateFails = true; recordCount = 0;
  const r = await postR({ locationId: LOC, repairs: [REPAIR], apply: true, recreate: true });
  assert.strictEqual(puts.length, 1, "it tried the update first");
  assert.strictEqual(deleted.length, 1, "then deleted");
  assert.strictEqual(created.length, 1, "then rebuilt");
  assert.strictEqual(r.body.recreated.length, 1);

  // Rebuilt with the contract's values AND the field's own identity.
  const c = created[0];
  assert.strictEqual(c.fieldKey, "custom_objects.expenses.receipt_photo");
  assert.strictEqual(c.objectKey, "custom_objects.expenses");
  assert.strictEqual(c.dataType, "FILE_UPLOAD");
  assert.strictEqual(c.parentId, "folder1", "back into the folder it came from");
  assert.strictEqual(c.name, "Recibo", "and keeps its translated label");
  assert.deepStrictEqual(c.acceptedFormats, [".jpg", ".pdf"]);
  assert.strictEqual(c.maxFileLimit, 5, "the value whose absence caused all this");
  console.log("10) A field that cannot be updated is rebuilt with its own identity and the contract's values");
}

// ---- 11. never destroy a field whose object holds records ------------
// Deleting a custom field takes its stored values with it. A guardrail is not
// worth data, so this refuses rather than asking.
{
  LIVE = [SNAPSHOT_FIELD]; updateFails = true; recordCount = 3;
  const r = await postR({ locationId: LOC, repairs: [REPAIR], apply: true, recreate: true });
  assert.deepStrictEqual(deleted, [], "an object with records is never touched");
  assert.deepStrictEqual(created, []);
  assert.strictEqual(r.body.recreated.length, 0);
  assert.match(r.body.failed[0].hint, /3 record/, "and says why, with the count");
  assert.match(r.body.failed[0].hint, /GHL UI/, "pointing at the way that is left");
  console.log("11) An object holding records is refused outright, with the count");
}

// ---- 12. without recreate it stays non-destructive --------------------
{
  LIVE = [SNAPSHOT_FIELD]; updateFails = true; recordCount = 0;
  const r = await postR({ locationId: LOC, repairs: [REPAIR], apply: true });
  assert.deepStrictEqual(deleted, [], "the default deletes nothing, whatever the failure");
  assert.strictEqual(r.body.failed.length, 1);
  assert.match(r.body.failed[0].hint, /recreate/, "but says the option exists");
  console.log("12) Default stays non-destructive and names the option rather than taking it");
}

// ---- 13. a delete that is not followed by a create is reported LOST ---
// The one outcome that loses something. The definition travels with the error
// so it can be put back by hand without going to find it.
{
  LIVE = [SNAPSHOT_FIELD]; updateFails = true; recordCount = 0;
  installR();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/custom-fields/") && (init.method || "GET") === "POST") {
      return { ok: false, status: 400, text: async () => JSON.stringify({ message: "nope" }) };
    }
    return realFetch(url, init);
  };
  const res = await worker.fetch(new Request("https://d.dev/api/schema/repair", {
    method: "POST", headers: { Authorization: "Bearer prov", "Content-Type": "application/json" },
    body: JSON.stringify({ locationId: LOC, repairs: [REPAIR], apply: true, recreate: true }),
  }), env);
  const body = await res.json();

  assert.strictEqual(res.status, 500, "losing a field is a 500, not a partial success");
  assert.ok(Array.isArray(body.lost) && body.lost.length === 1);
  assert.strictEqual(body.lost[0].fieldKey, "custom_objects.expenses.receipt_photo");
  const d = body.lost[0].definition;
  assert.ok(d.fieldKey && d.objectKey && d.dataType && d.parentId, "the recipe to rebuild it by hand");
  assert.strictEqual(d.maxFileLimit, 5);
  console.log("13) A delete without a rebuild is reported as LOST, with the definition to restore it");
}

console.log("\nPASS — destroy only after the gentle path failed, never over records, and never silently.");
