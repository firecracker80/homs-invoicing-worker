// A snapshot load is only proven if a changed key fails the check.
// Run: node test-schema-fingerprint.mjs
//
// The comparison has one job split two ways, and getting the split wrong makes
// it useless in opposite directions:
//
//   keys and shape  -> integrity. A missing field or a moved option key orphans
//                      records, silently. Must FAIL.
//   labels          -> cosmetic. Spanish accounts have translated labels by
//                      design. Must NOT fail, or the check cries wolf on every
//                      translated account and gets ignored.
//
// Nothing had ever verified that a snapshot reproduces the object layer: DEMO-HOMS
// was built by hand and Luminara predates objects entirely.
import assert from "node:assert";
import { fingerprint, diffSchemas, formatDiff, EXPECTED_ABSENT } from "./src/schema-fingerprint.js";

// Shaped like the live responses, trimmed to what the fingerprint reads.
const objectsOf = (keys) => [
  { key: "contact", type: "SYSTEM_DEFINED", labels: { singular: "Contact", plural: "Contacts" } },
  { key: "opportunity", type: "SYSTEM_DEFINED", labels: { singular: "Opportunity", plural: "Opportunities" } },
  { key: "business", type: "SYSTEM_DEFINED", labels: { singular: "Company", plural: "Companies" } },
  ...keys.map((k) => ({
    key: k, type: "USER_DEFINED",
    labels: { singular: "Expense", plural: "Expenses" },
    description: "Property expenses.",
    primaryDisplayProperty: `${k}.expense_name`,
    requiredProperties: [`${k}.expense_name`],
  })),
];

const EXPENSE_FIELDS = {
  "custom_objects.expenses": {
    fields: [
      { fieldKey: "custom_objects.expenses.expense_name", dataType: "TEXT", name: "Expense Name" },
      { fieldKey: "custom_objects.expenses.amount", dataType: "MONETORY", name: "Amount" },
      {
        fieldKey: "custom_objects.expenses.paid_by", dataType: "SINGLE_OPTIONS", name: "Paid By",
        options: [{ key: "owner", label: "Owner" }, { key: "manager", label: "Manager" }],
      },
    ],
  },
};

const base = () => fingerprint({
  locationId: "DEMO",
  objects: objectsOf(["custom_objects.expenses"]),
  fieldsByObject: structuredClone(EXPENSE_FIELDS),
  capturedAt: "2026-10-08T00:00:00.000Z",
});

// ---- 1. the fingerprint records keys, not the system objects -----------
{
  const fp = base();
  assert.deepStrictEqual(Object.keys(fp.objects), ["custom_objects.expenses"],
    "the three SYSTEM_DEFINED objects exist on every GHL account and prove nothing about a snapshot");
  const f = fp.objects["custom_objects.expenses"].fields;
  assert.deepStrictEqual(Object.keys(f).sort(), [
    "custom_objects.expenses.amount",
    "custom_objects.expenses.expense_name",
    "custom_objects.expenses.paid_by",
  ]);
  // Option KEYS, sorted, with labels discarded: the key is what records store.
  assert.deepStrictEqual(f["custom_objects.expenses.paid_by"].options, ["manager", "owner"]);
  assert.strictEqual(f["custom_objects.expenses.amount"].options.length, 0, "a non-option field has none");
  console.log("1) A fingerprint records user-defined objects, field keys and option keys");
}

// ---- 2. an identical account passes -----------------------------------
{
  const r = diffSchemas(base(), base());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.failures, []);
  assert.deepStrictEqual(r.notes, [], "and says nothing, so a clean run is actually quiet");
  console.log("2) An identical account passes with no output at all");
}

// ---- 3. translated labels pass -- this is the whole point --------------
// A Spanish account has every label translated and every key identical. If this
// failed, the check would flag every translated account and be switched off.
{
  const es = base();
  const o = es.objects["custom_objects.expenses"];
  o.labels = { singular: "Gasto", plural: "Gastos" };
  o.description = "Gastos de la propiedad.";
  o.fields["custom_objects.expenses.expense_name"].name = "Nombre del Gasto";
  o.fields["custom_objects.expenses.amount"].name = "Monto";
  o.fields["custom_objects.expenses.paid_by"].name = "Pagado Por";

  const r = diffSchemas(base(), es);
  assert.strictEqual(r.ok, true, "translation must not fail the check");
  assert.deepStrictEqual(r.failures, []);
  const kinds = r.notes.map((n) => n.kind).sort();
  assert.deepStrictEqual(kinds, ["description_differs", "field_label_differs", "field_label_differs", "field_label_differs", "label_differs"],
    "every label change is reported as a note, so the pass is still visible");
  console.log("3) A fully translated account passes, with each label change noted");
}

// ---- 4. a moved option key FAILS --------------------------------------
// The unrecoverable one. Option keys are stored on records (paid_by: "owner"),
// so a renamed key orphans every record holding the old one, with nothing on
// screen to say so.
{
  const broken = base();
  broken.objects["custom_objects.expenses"].fields["custom_objects.expenses.paid_by"].options = ["manager", "propietario"];

  const r = diffSchemas(base(), broken);
  assert.strictEqual(r.ok, false, "a renamed option key must fail");
  const f = r.failures.find((x) => x.kind === "option_keys_missing");
  assert.ok(f, "named as a missing option key");
  assert.deepStrictEqual(f.missing, ["owner"]);
  assert.strictEqual(f.field, "custom_objects.expenses.paid_by");
  // The added one is reported too, so the message shows the rename, not half of it.
  assert.ok(r.notes.some((n) => n.kind === "option_keys_added" && n.added.includes("propietario")));
  console.log("4) An option key renamed to Spanish fails, and the diff shows both halves");
}

// ---- 5. a missing field or object FAILS -------------------------------
{
  const noField = base();
  delete noField.objects["custom_objects.expenses"].fields["custom_objects.expenses.paid_by"];
  let r = diffSchemas(base(), noField);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((x) => x.kind === "field_missing" && x.field === "custom_objects.expenses.paid_by"));

  const noObject = fingerprint({ locationId: "NEW", objects: objectsOf([]), fieldsByObject: {} });
  r = diffSchemas(base(), noObject);
  assert.strictEqual(r.ok, false, "a snapshot that did not carry an object must fail loudly");
  assert.ok(r.failures.some((x) => x.kind === "object_missing" && x.object === "custom_objects.expenses"));

  // A dataType change too: MONETORY -> TEXT reads back as a string and every
  // amount silently stops being a number.
  const retyped = base();
  retyped.objects["custom_objects.expenses"].fields["custom_objects.expenses.amount"].dataType = "TEXT";
  r = diffSchemas(base(), retyped);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((x) => x.kind === "data_type_changed"));
  console.log("5) A missing field, a missing object and a changed dataType all fail");
}

// ---- 6. ota_channels is absent on purpose ----------------------------
// Yari left it out of the snapshot on 2026-09-29, once the dashboard stopped
// displaying it. Its absence must not read as a broken load, or the first real
// use of this tool reports a failure that is actually correct.
{
  const expected = fingerprint({
    locationId: "DEMO",
    objects: objectsOf(["custom_objects.expenses", "custom_objects.ota_channels"]),
    fieldsByObject: structuredClone(EXPENSE_FIELDS),
  });
  const actual = base(); // expenses only

  const r = diffSchemas(expected, actual);
  assert.strictEqual(r.ok, true, "a deliberately excluded object is not a failure");
  const note = r.notes.find((n) => n.kind === "object_absent_as_expected");
  assert.ok(note && note.object === "custom_objects.ota_channels");
  assert.match(note.why, /2026-09-29/, "and the note says why, so nobody re-investigates it");

  // But it is only excused because it is on the list. Any OTHER missing object
  // still fails -- the exemption must not be a blanket one.
  const alsoMissing = fingerprint({
    locationId: "DEMO",
    objects: objectsOf(["custom_objects.expenses", "custom_objects.ota_channels", "custom_objects.payments"]),
    fieldsByObject: structuredClone(EXPENSE_FIELDS),
  });
  const r2 = diffSchemas(alsoMissing, actual);
  assert.strictEqual(r2.ok, false, "a different missing object is still a failure");
  assert.ok(r2.failures.some((x) => x.object === "custom_objects.payments"));
  assert.ok(!r2.failures.some((x) => x.object === "custom_objects.ota_channels"));

  // And if it turns up after all, that is worth saying: it means the snapshot
  // changed without this list changing with it.
  const r3 = diffSchemas(base(), expected);
  assert.ok(r3.notes.some((n) => n.kind === "object_present_but_listed_absent"));
  assert.strictEqual(r3.ok, true, "though its presence breaks nothing");
  console.log("6) ota_channels may be absent; anything else missing still fails");
}

// ---- 6b. an upload field that lost its constraints FAILS --------------
// Found on the first real load, and this file had the same blind spot: Yy
// Guest Properties' receipt_photo arrived with neither acceptedFormats nor
// maxFileLimit, while DEMO-HOMS has [".jpeg",".jpg",".png",".pdf"] and 5. The
// check called that account identical, because it was not looking.
{
  const withUpload = (accepted, limit) => fingerprint({
    locationId: "X",
    objects: objectsOf(["custom_objects.expenses"]),
    fieldsByObject: {
      "custom_objects.expenses": {
        fields: [{
          fieldKey: "custom_objects.expenses.receipt_photo", dataType: "FILE_UPLOAD",
          name: "Receipt Photo", acceptedFormats: accepted, maxFileLimit: limit,
        }],
      },
    },
  });

  const expected = withUpload([".jpeg", ".jpg", ".png", ".pdf"], 5);
  assert.deepStrictEqual(
    expected.objects["custom_objects.expenses"].fields["custom_objects.expenses.receipt_photo"].acceptedFormats,
    [".jpeg", ".jpg", ".pdf", ".png"], "captured and sorted, so order is not a false difference");

  // What the snapshot actually produced: both constraints gone.
  const r = diffSchemas(expected, withUpload(undefined, undefined));
  assert.strictEqual(r.ok, false, "a dropped upload constraint must fail");
  assert.ok(r.failures.some((x) => x.kind === "accepted_formats_changed"));
  assert.ok(r.failures.some((x) => x.kind === "max_file_limit_changed" && x.expected === 5 && x.actual === null));

  // Same constraints either way is clean, and order does not matter.
  assert.strictEqual(diffSchemas(expected, withUpload([".pdf", ".png", ".jpg", ".jpeg"], 5)).ok, true);

  // A fingerprint captured before these keys existed must still be usable:
  // undefined means "not captured", not "expected empty".
  const old = withUpload([".jpeg"], 5);
  delete old.objects["custom_objects.expenses"].fields["custom_objects.expenses.receipt_photo"].acceptedFormats;
  delete old.objects["custom_objects.expenses"].fields["custom_objects.expenses.receipt_photo"].maxFileLimit;
  assert.strictEqual(diffSchemas(old, withUpload([".pdf"], 2)).ok, true,
    "an older contract does not fail on a field it never recorded");
  console.log("6b) An upload field that lost acceptedFormats or maxFileLimit fails");
}

// ---- 7. the report leads with what breaks data ------------------------
{
  const broken = base();
  broken.objects["custom_objects.expenses"].fields["custom_objects.expenses.paid_by"].options = ["manager"];
  broken.objects["custom_objects.expenses"].labels = { singular: "Gasto", plural: "Gastos" };

  const text = formatDiff(diffSchemas(base(), broken));
  assert.match(text, /^FAIL/, "a failure is the first word, not buried under notes");
  assert.ok(text.indexOf("Integrity") < text.indexOf("Notes"),
    "and integrity comes before cosmetics");
  assert.match(text, /owner/, "naming the key that went missing");

  assert.match(formatDiff(diffSchemas(base(), base())), /^PASS/);
  console.log("7) The report leads with integrity failures and names the lost key");
}

// ---- 8. the exemption list is declared, not scattered ----------------
{
  assert.ok(Object.hasOwn(EXPECTED_ABSENT, "custom_objects.ota_channels"));
  for (const [key, why] of Object.entries(EXPECTED_ABSENT)) {
    assert.ok(why && why.length > 20, `${key} must carry a reason, not just an exemption`);
  }
  // Overridable, so a one-off check can be run without editing the module.
  const r = diffSchemas(base(), fingerprint({ objects: objectsOf([]), fieldsByObject: {} }),
    { expectedAbsent: { "custom_objects.expenses": "just this once" } });
  assert.strictEqual(r.ok, true);
  console.log("8) Every exemption carries its reason, and the list can be overridden per run");
}

console.log("\nPASS — keys and shape are enforced, labels are free to be translated.");
