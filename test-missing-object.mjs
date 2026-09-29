// An object the account does not have has no records. It is not an outage.
// Run: node test-missing-object.mjs
//
// Yari is dropping ota_channels from the provisioning snapshot (2026-09-29),
// now that the dashboard no longer displays it. Both codebases fetch that
// object unconditionally, and before this both broke on an account without it,
// quietly and in different ways:
//
//   the dashboard   /api/data throws on the first missing object, taking the
//                   WHOLE dashboard down -- properties, transactions,
//                   everything -- not just the part that was dropped
//
//   the Worker      syncRowsToGHL catches its own throw, so settlement still
//                   succeeds and D1 is still written, but no Transaction
//                   record is created at all. The money is real and nothing in
//                   GHL shows it.
//
// GHL answers a search on a missing object with 404 and "Custom Object (key)
// not found" -- verified live against DEMO-HOMS, 2026-09-29. That is
// unambiguous: an expired PIT is 401 and an outage is 5xx.
import assert from "node:assert";

const { fetchAllObjectRecords } = await import("./src/ghl.js");
const dash = await import("./homs-admin-dashboard/src/ghl.js");

const record = (id) => ({ id, properties: {} });

// GHL's real shapes, as the API returns them.
const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});
const NOT_FOUND = respond(404, {
  message: "Custom Object (custom_objects.ota_channels) not found",
  error: "Not Found", statusCode: 404,
});

let calls = [];
const serving = (fn) => {
  calls = [];
  global.fetch = async (url, init) => { calls.push(String(url)); return fn(String(url), init); };
};

for (const [label, impl] of [["worker", fetchAllObjectRecords], ["dashboard", dash.fetchAllObjectRecords]]) {

  // ---- 1. a missing object is an empty list ------------------------
  {
    serving(() => NOT_FOUND);
    const out = await impl("pit", "loc", "custom_objects.ota_channels");
    assert.deepStrictEqual(out, [], `${label}: no records, rather than an exception`);
    console.log(`1) [${label}] An object the account does not have reads as no records`);
  }

  // ---- 2. an expired PIT still surfaces ---------------------------
  // The failure this must not become. An empty dashboard reads "you have no
  // properties"; a thrown 401 reads "we could not reach GHL", and only one of
  // those sends somebody to look at the right thing.
  {
    serving(() => respond(401, { message: "Invalid token", statusCode: 401 }));
    await assert.rejects(
      () => impl("pit", "loc", "custom_objects.properties"),
      (e) => e.status === 401,
      `${label}: auth failure is not silently an empty account`
    );
    console.log(`2) [${label}] An expired PIT still fails loudly, and is never read as an empty account`);
  }

  // ---- 3. and so does an outage -----------------------------------
  {
    serving(() => respond(502, { message: "Bad Gateway", statusCode: 502 }));
    await assert.rejects(
      () => impl("pit", "loc", "custom_objects.properties"),
      (e) => e.status === 502,
      `${label}: an outage is not an empty account either`
    );
    console.log(`3) [${label}] A GHL outage still fails loudly`);
  }

  // ---- 4. an object that exists is unaffected ---------------------
  {
    serving(() => respond(200, { records: [record("a"), record("b")] }));
    const out = await impl("pit", "loc", "custom_objects.properties");
    assert.strictEqual(out.length, 2, `${label}: an ordinary read is untouched`);
    assert.strictEqual(calls.length, 1, "and still stops after a short page");
    console.log(`4) [${label}] An object that exists reads exactly as before`);
  }

  // ---- 5. a 404 on page two does not discard page one -------------
  // Paging asks repeatedly. An object cannot vanish mid-read, but if the
  // second call were to 404 the first page is real data already in hand, and
  // returning [] would throw it away.
  {
    let page = 0;
    serving(() => {
      page += 1;
      return page === 1
        ? respond(200, { records: Array.from({ length: 100 }, (_, i) => record(`p1-${i}`)) })
        : NOT_FOUND;
    });
    const out = await impl("pit", "loc", "custom_objects.transactions");
    assert.strictEqual(out.length, 100, `${label}: the page already read is kept`);
    console.log(`5) [${label}] A 404 partway through paging keeps what was already read`);
  }
}

console.log("\nPASS — a missing object is an empty list; a broken token or a broken GHL still says so.");
