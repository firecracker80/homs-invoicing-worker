// A property's owner and manager come from GHL, not from a map nobody maintains.
// Run: node test-property-contacts.mjs
//
// propertyOwnerNames and propertyManagerNames are read by this code and
// populated by nothing, so an account with several owners or several managers
// meant hand-editing tenant JSON in KV. Yari, 2026-10-07, on exactly this:
// "since the custom values only capture 1 owner name... my suggestion would be
// to tag them, same if there are various property managers."
//
// Tags are not needed. GHL carries both as labelled associations to real
// contacts -- property_owner, and property_manager created on 2026-10-07 -- and
// an association beats a tag because it points at a contact record rather than
// at a string somebody has to keep spelling identically.
import assert from "node:assert";

const { findAssociationId, propertyContactsFor } = await import("./src/ghl.js");
const { resolvePayoutNamesFromGhl } = await import("./src/ledger.js");

const OWNER_ASSOC = "assoc-owner-id";
const MANAGER_ASSOC = "assoc-manager-id";
const ASSOCIATIONS = [
  { id: OWNER_ASSOC, key: "property_owner", firstObjectKey: "contact", secondObjectKey: "custom_objects.properties" },
  { id: MANAGER_ASSOC, key: "property_manager", firstObjectKey: "contact", secondObjectKey: "custom_objects.properties" },
  { id: "assoc-expense", key: "expense_property", firstObjectKey: "custom_objects.expenses", secondObjectKey: "custom_objects.properties" },
];

const property = (relations) => ({ id: "p1", properties: { property_name: "Casa Bonita" }, relations });

// The owner's revenue split lives on the contact as a custom field, resolved by
// key against the location's field list -- so a case that sets one has to serve
// the definition as well as the value.
const SPLIT_FIELD_ID = "field-revenue-split-owner";
const SPLIT_FIELD_KEY = "contact.revenue_split_owner_";

// Case 3 builds the GHL stub; case 3b drives the same one with a split set, so
// the builder is shared rather than written twice and allowed to drift.
let serveGhl;

// ---- 1. two contacts on one property, told apart ---------------------
// Both are contacts. The only thing distinguishing them is WHICH association
// each relation belongs to, so reading the object type alone picks whichever
// GHL happened to return first.
{
  const p = property([
    { associationId: MANAGER_ASSOC, objectKey: "contact", recordId: "c-manager" },
    { associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-owner" },
  ]);
  assert.deepStrictEqual(propertyContactsFor(p, ASSOCIATIONS),
    { ownerContactId: "c-owner", managerContactId: "c-manager" },
    "the manager listed first must not be read as the owner");

  // Either alone, which is every account today.
  assert.deepStrictEqual(
    propertyContactsFor(property([{ associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-owner" }]), ASSOCIATIONS),
    { ownerContactId: "c-owner", managerContactId: null });
  assert.deepStrictEqual(propertyContactsFor(property([]), ASSOCIATIONS),
    { ownerContactId: null, managerContactId: null });

  // A non-contact relation on the same property is not a person.
  assert.deepStrictEqual(
    propertyContactsFor(property([{ associationId: "assoc-expense", objectKey: "custom_objects.expenses", recordId: "e1" }]), ASSOCIATIONS),
    { ownerContactId: null, managerContactId: null });
  console.log("1) A property's owner and manager contacts are told apart by association, not by object type");
}

// ---- 2. an ambiguous lookup refuses rather than guesses --------------
// Creating property_manager gave contact <-> properties two associations. Any
// caller asking by object keys alone is now asking which of two relationships
// it meant, and answering would silently link a manager where an owner belongs.
{
  assert.strictEqual(findAssociationId(ASSOCIATIONS, "contact", "custom_objects.properties"), null,
    "two candidates means no answer");
  assert.strictEqual(
    findAssociationId(ASSOCIATIONS, "contact", "custom_objects.properties", "property_manager")?.id, MANAGER_ASSOC,
    "unless the caller says which");
  assert.strictEqual(
    findAssociationId(ASSOCIATIONS, "contact", "custom_objects.properties", "property_owner")?.id, OWNER_ASSOC);

  // An unambiguous pair still answers without a key, which is every existing
  // caller -- transactions, expenses, service requests.
  assert.strictEqual(
    findAssociationId(ASSOCIATIONS, "custom_objects.expenses", "custom_objects.properties")?.id, "assoc-expense");
  assert.strictEqual(findAssociationId(ASSOCIATIONS, "contact", "nothing_like_this"), null);
  console.log("2) An ambiguous association returns nothing rather than one of two, and a named one still answers");
}

// ---- 3. the names, resolved end to end ------------------------------
{
  const serve = ({ properties = [], contacts = {}, splitField = false }) => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      const contact = u.match(/\/contacts\/([^/?]+)/);
      const body = u.includes("/customFields")
          ? { customFields: splitField ? [{ id: SPLIT_FIELD_ID, fieldKey: SPLIT_FIELD_KEY }] : [] }
        : contact ? { contact: contacts[contact[1]] || null }
        : u.includes("/associations/") ? { associations: ASSOCIATIONS }
        : u.includes("custom_objects.properties") ? { records: properties }
        : { records: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
  };

  serveGhl = serve;

  serve({
    properties: [property([
      { associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-owner" },
      { associationId: MANAGER_ASSOC, objectKey: "contact", recordId: "c-manager" },
    ])],
    contacts: { "c-owner": { firstName: "Carlos", lastName: "Mendoza" }, "c-manager": { name: "Rosa Jiménez" } },
  });
  // The whole return shape, not just the names: since 2026-10-25 the resolver
  // also answers with the owner's own revenue split. Both split keys are
  // undefined here because this owner has none set, and undefined rather than
  // null is load-bearing -- writeLedgerEntries reads them with "??", so
  // undefined falls through to the account percentage where a null would read as
  // a deliberate 0% and hand the owner nothing. Asserted as the whole object on
  // purpose: a field appearing here unannounced is what this test is for.
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita"),
    { ownerName: "Carlos Mendoza", managerName: "Rosa Jiménez", ownerPct: undefined, splitNote: undefined });

  // A property nobody linked resolves nothing, so the configured names stand.
  serve({ properties: [property([])] });
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita"),
    { ownerName: undefined, managerName: undefined, ownerPct: undefined, splitNote: undefined });

  // The RIGHT property, on an account that has several. Taking the first record
  // would resolve every booking to whoever owns whichever property GHL returned
  // first -- correct on a single-property account and wrong on every other.
  serve({
    properties: [
      { id: "other", properties: { property_name: "Villa Verde" },
        relations: [{ associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-elena" }] },
      property([{ associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-owner" }]),
    ],
    contacts: { "c-owner": { name: "Carlos Mendoza" }, "c-elena": { name: "Elena Marchetti" } },
  });
  assert.strictEqual((await resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita")).ownerName, "Carlos Mendoza",
    "matched by name, not by position");

  // A booking whose property cannot be found, and one with no property at all.
  serve({ properties: [] });
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita"), {});
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl("pit", "L1", null), {});
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl(null, "L1", "Casa Bonita"), {},
    "and an account with no PIT does not try");
  console.log("3) Owner and manager names resolve from their linked contacts, and resolve to nothing when unlinked");
}

// ---- 3b. the split reaches the caller, not just fetchContactPayout --------
// test-per-owner-split.mjs proves fetchContactPayout reads the field, and proves
// the split arithmetic, each on its own. Neither says the two are joined: a
// resolver that stopped calling fetchContactPayout, or dropped its percentage on
// the way out, passes that whole file AND every assertion in case 3 above --
// because "no split set" and "split thrown away" both look like undefined.
{
  const withSplit = (value) => {
    serveGhl({
      properties: [property([{ associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-owner" }])],
      contacts: { "c-owner": { name: "Carlos Mendoza", customFields: [{ id: SPLIT_FIELD_ID, value }] } },
      splitField: true,
    });
    return resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita");
  };

  // A PERCENTAGE on the contact has to arrive as the FRACTION the ledger
  // multiplies by. 70 reaching the caller unconverted would pay out 7000%.
  const set = await withSplit(70);
  assert.strictEqual(set.ownerPct, 0.7, "70 on the owner's contact resolves as 0.70");
  assert.strictEqual(set.splitNote, undefined, "and warns about nothing, because a set split is not a fault");
  assert.strictEqual(set.ownerName, "Carlos Mendoza", "and the name comes from the same read");

  // 0% is a real arrangement, and has to survive a chain written with ?? and ||.
  assert.strictEqual((await withSplit(0)).ownerPct, 0, "a deliberate 0% is carried through, not read as unset");

  // A garbled split falls back AND says so, rather than coercing to 0% in silence.
  const garbled = await withSplit("eighty-five");
  assert.strictEqual(garbled.ownerPct, undefined, "an unusable split falls back to the account percentage");
  assert.match(garbled.splitNote, /not a usable percentage/, "and reports why it fell back");
  assert.strictEqual(garbled.ownerName, "Carlos Mendoza", "while the name still resolves");
  console.log("3b) The owner's own revenue split resolves through to the caller, and an unusable one falls back loudly");
}

// ---- 4. GHL being unreachable costs a name, never a settlement -------
// This runs inside writeLedgerEntries on the payment path. A booking that has
// been paid for must settle whether or not a name can be looked up.
{
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita"), {},
    "an unreachable GHL returns nothing and throws nothing");

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' });
  assert.deepStrictEqual(await resolvePayoutNamesFromGhl("pit", "L1", "Casa Bonita"), {},
    "and so does a dead token");
  console.log("4) A lookup that fails costs a name and never a settlement");
}

// ---- 5. and the ledger rows carry those names ------------------------
// Cases 1-4 prove the resolver. They say nothing about whether writeLedgerEntries
// uses it: leaving that call out, or preferring the configured name, passes all
// of them while every statement still goes to the wrong person.
{
  const { writeLedgerEntries } = await import("./src/ledger.js");

  const bound = [];
  const env = {
    LEDGER_DB: {
      prepare: () => ({ bind: (...args) => { bound.push(args); return { run: async () => {} }; } }),
      batch: async () => {},
    },
  };

  globalThis.fetch = async (url) => {
    const u = String(url);
    const contact = u.match(/\/contacts\/([^/?]+)/);
    const body = contact
      ? { contact: { "c-owner": { name: "Carlos Mendoza" }, "c-manager": { name: "Rosa Jiménez" } }[contact[1]] }
      : u.includes("/associations/") ? { associations: ASSOCIATIONS }
      : u.includes("custom_objects.properties") ? {
          records: [property([
            { associationId: OWNER_ASSOC, objectKey: "contact", recordId: "c-owner" },
            { associationId: MANAGER_ASSOC, objectKey: "contact", recordId: "c-manager" },
          ])],
        }
      : { records: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const snapshot = {
    bookingId: "b1", locationId: "L1", propertyCode: "Casa Bonita",
    charges: { rentTotal: 1000, cleaningFee: 0, processingFee: 0, addOns: 0 },
    securityDeposit: { total: 0 },
    // The configured names, which are what this used before and must now lose.
    payout: { basis: 1000, owner: 800, manager: 200, ownerPct: 0.8, cleaningFeeTo: "manager",
              ownerName: "Stale Owner", managerName: "Stale Manager" },
  };

  await writeLedgerEntries(env, { currency: "USD", ghlPit: "pit" }, snapshot, {});

  const names = new Set(bound.map((a) => a[5]).filter(Boolean));
  assert.ok(names.has("Carlos Mendoza"), `owner row carries the linked contact, got ${[...names]}`);
  assert.ok(names.has("Rosa Jiménez"), "and so does the manager row");
  assert.ok(!names.has("Stale Owner"), "the configured name does not reach a single row");
  assert.ok(!names.has("Stale Manager"));

  // Written back onto the snapshot too, because nameFor() fills any row that did
  // not set a name of its own from there -- a resolved name kept local would put
  // two different names on one statement.
  assert.strictEqual(snapshot.payout.ownerName, "Carlos Mendoza");
  assert.strictEqual(snapshot.payout.managerName, "Rosa Jiménez");
  console.log("5) The ledger rows carry the linked contacts' names, and the configured ones reach nothing");
}

console.log("\nPASS — a property's owner and manager come from the contacts linked to it, with the configured names as the fallback they always were.");
