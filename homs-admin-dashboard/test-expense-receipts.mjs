// A receipt fills in the expense, and is filed where it can be found again.
// Run: node test-expense-receipts.mjs
//
// Two things that look like one. Reading a receipt stores nothing; filing one
// reads nothing. Each is useful alone -- a read can be corrected by hand before
// saving, and a receipt can be attached to an expense entered weeks ago.
//
// The filing has no field and no index behind it. FILE_UPLOAD custom fields
// cannot be SET through the records API (probed on DEMO-HOMS 2026-10-07: ten
// value shapes, every one 422, and a bare url string accepted with 200 and
// silently dropped), and a TEXT field would hold one url and be overwritten by
// the second receipt. So the join is the filename plus one folder, and the
// media library is the only copy of it.
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const {
  PROFILES, resolveProfile, requestBodyFor, contentBlocksFor, expenseFromExtraction,
} = await import("./src/receipt-extract.js");
const { receiptFileName, recordIdFromReceipt, listReceipts } = await import("./src/ghl.js");

const APP = fs.readFileSync("./public/app.js", "utf8");
const HTML = fs.readFileSync("./public/index.html", "utf8");

// ---- 1. the reader is told which chart of accounts it is reading into ----
// Naming the categories is most of what makes the read accurate. The two charts
// share ONE category ("other"), so a receipt read against the wrong one has
// almost nowhere to put itself.
{
  const ops = PROFILES.operations.categories;
  const prop = PROFILES.property.categories;
  const shared = ops.filter((c) => prop.includes(c));
  assert.deepStrictEqual(shared, ["other"], "the two charts overlap only at 'other'");

  const enumOf = (profile) =>
    requestBodyFor({ mediaType: "image/png", data: "x" }, "claude-opus-5", profile)
      .output_config.format.schema.properties.expenses.items.properties.category.enum;
  assert.deepStrictEqual(enumOf("property"), prop, "the schema binds the model to the property chart");
  assert.deepStrictEqual(enumOf("operations"), ops);

  const promptOf = (profile) => contentBlocksFor({ mediaType: "image/png", data: "x" }, profile)[1].text;
  assert.match(promptOf("property"), /maintenance_repairs/);
  assert.ok(!/GoHighLevel/.test(promptOf("property")),
    "and does not describe the operations book to it");
  assert.match(promptOf("operations"), /GoHighLevel/, "while the P&L importer is unchanged");
  assert.match(promptOf("property"), /rental management company/, "the business is named too, not just the list");
  console.log("1) Each profile binds the reader to its own chart of accounts, in schema and prompt");
}

// ---- 2. an unknown profile falls back rather than reaching the API -------
// It arrives from the browser. An unrecognised one must not produce an empty
// category enum, which is a 400 from the API at best.
{
  for (const junk of ["", null, undefined, "Property", "../operations", "constructor", "toString"]) {
    assert.strictEqual(resolveProfile(junk), "operations", `${JSON.stringify(junk)} falls back`);
  }
  assert.strictEqual(resolveProfile("property"), "property");
  // Object.hasOwn, not `in`: "toString" is on the prototype and `in` would
  // accept it, then index PROFILES to undefined and throw on .categories.
  assert.ok(requestBodyFor({ mediaType: "image/png", data: "x" }, "claude-opus-5", "toString"));
  console.log("2) A junk profile falls back instead of producing an empty category list");
}

// ---- 3. the form can choose every category the reader can ----------------
// These are three copies of one list -- the GHL field, the reader, and the
// dropdown -- and they had already drifted: software_subscriptions was added to
// the object on 2026-10-06 and the dropdown never got it, so the form could not
// select a category the record already had.
{
  const block = APP.slice(APP.indexOf("const EXPENSE_CATEGORY_OPTIONS = ["));
  const keys = [...block.slice(0, block.indexOf("];")).matchAll(/\["([a-z_]+)",/g)].map((m) => m[1]);
  assert.deepStrictEqual([...keys].sort(), [...PROFILES.property.categories].sort(),
    "the Add Expense dropdown and the receipt reader offer exactly the same categories");
  console.log(`3) The form and the reader agree on all ${keys.length} categories`);
}

// ---- 3b. and the route asks for the property chart --------------------
// Cases 1 and 3 prove the profiles. The route defaulting to "operations"
// passes both, and every receipt read from the expense form would then be
// offered platform/infrastructure/telecom and land in "other".
{
  const SRC = fs.readFileSync("./src/index.js", "utf8");
  const fn = SRC.slice(SRC.indexOf("async function handleReadReceipt"));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.strictEqual((body.match(/profile: "property"/g) || []).length, 2,
    "both the read and the mapping are told it is a property expense");
  assert.ok(!/profile: "operations"/.test(body));

  // And the P&L importer's own route is untouched -- it must keep reading into
  // the operations chart, which it gets by not asking.
  const other = SRC.slice(SRC.indexOf("async function handleReceiptParse"));
  assert.ok(!/profile:/.test(other.slice(0, other.indexOf("\nasync function "))),
    "the P&L importer still takes the default");
  console.log("3b) The expense form's route reads into the property chart, and the importer still does not");
}

// ---- 4. what a read gives back, and what it refuses to invent ------------
{
  const read = (expenses, rest = {}) =>
    expenseFromExtraction({ is_expense_document: true, expenses, ...rest }, { profile: "property" });

  const ok = read([{
    name: "Pool pump replacement", vendor: "Ferretería Ochoa", amount: 12500.5, currency: "DOP",
    paid_on: "2026-10-02", category: "maintenance_repairs", notes: "Bomba 1HP", confidence: "high",
  }]);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.expense, {
    name: "Pool pump replacement", vendor: "Ferretería Ochoa", amount: 12500.5, currency: "dop",
    paidOn: "2026-10-02", category: "maintenance_repairs", notes: "Bomba 1HP", confidence: "high",
  });

  // An unreadable amount is null, never 0. A prefilled zero is a plausible
  // number somebody saves without looking; an empty box is not.
  for (const bad of [null, "", "n/a", 0, -40, NaN]) {
    const out = read([{ name: "x", vendor: null, amount: bad, currency: null, paid_on: null,
      category: "other", notes: null, confidence: "low" }]);
    assert.strictEqual(out.expense.amount, null, `amount ${JSON.stringify(bad)} must not become a number`);
  }

  // Same for a date: a half-read date is worse than none, because it lands on
  // the wrong month's statement and nothing flags it.
  for (const bad of ["25/09/2026", "2026-9-5", "October 2", "", null, "2026-10-02T00:00:00Z"]) {
    assert.strictEqual(read([{ name: "x", vendor: null, amount: 10, currency: null, paid_on: bad,
      category: "other", notes: null, confidence: "high" }]).expense.paidOn, null,
      `paid_on ${JSON.stringify(bad)} is not a YYYY-MM-DD date`);
  }

  // A category off the chart becomes null rather than an invalid option on the
  // record. The schema should prevent it; this is the second line.
  assert.strictEqual(read([{ name: "x", vendor: null, amount: 10, currency: null, paid_on: null,
    category: "platform", notes: null, confidence: "high" }]).expense.category, null,
    "an operations category must not reach a property expense record");

  // Confidence is only ever one of three words; anything else is treated as the
  // worst case, so the form warns rather than reassures.
  assert.strictEqual(read([{ name: "x", vendor: null, amount: 10, currency: null, paid_on: null,
    category: "other", notes: null, confidence: "certain" }]).expense.confidence, "low");
  console.log("4) A read fills in what it saw and leaves null what it could not read");
}

// ---- 5. not a receipt, and more than one charge -------------------------
{
  const no = expenseFromExtraction(
    { is_expense_document: false, document_note: "This is a boarding pass.", expenses: [] },
    { profile: "property" });
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.error, "not_an_expense_document");
  assert.match(no.message, /boarding pass/, "it says what it was looking at instead of failing blankly");

  // An empty list with is_expense_document true is still nothing to fill in.
  assert.strictEqual(expenseFromExtraction({ is_expense_document: true, expenses: [] }, {}).ok, false);
  assert.strictEqual(expenseFromExtraction(null, {}).ok, false, "and a null read does not throw");

  // A statement with several charges fills in the first and SAYS so, rather
  // than silently dropping the rest.
  const many = expenseFromExtraction({ is_expense_document: true, expenses: [
    { name: "a", vendor: null, amount: 10, currency: null, paid_on: null, category: "other", notes: null, confidence: "high" },
    { name: "b", vendor: null, amount: 20, currency: null, paid_on: null, category: "other", notes: null, confidence: "high" },
    { name: "c", vendor: null, amount: 30, currency: null, paid_on: null, category: "other", notes: null, confidence: "high" },
  ] }, { profile: "property" });
  assert.strictEqual(many.expense.name, "a");
  assert.strictEqual(many.extra, 2, "the other two are counted so the form can point at Import");
  console.log("5) A non-receipt says what it was; a multi-charge document says how much it left behind");
}

// ---- 6. the filename IS the join ----------------------------------------
{
  const ID = "6ac6e543af19b2b02f0cd133";
  assert.strictEqual(recordIdFromReceipt(receiptFileName(ID, "recibo.jpg")), ID);

  // A filename containing the separator must still split at the FIRST one,
  // which is the only reason the id goes in front.
  assert.strictEqual(recordIdFromReceipt(receiptFileName(ID, "factura--octubre.pdf")), ID);
  assert.strictEqual(receiptFileName(ID, "factura--octubre.pdf"), `${ID}--factura--octubre.pdf`);

  // Slashes out: the name becomes a path segment on a CDN url.
  assert.ok(!receiptFileName(ID, "a/b\\c.png").slice(ID.length).includes("/"));
  assert.ok(!receiptFileName(ID, "a/b\\c.png").includes("\\"));

  // A phone can hand over a very long name. Truncated from the FRONT, so the
  // extension survives -- a receipt called ".pdf"-less is a receipt no browser
  // will open properly.
  const long = receiptFileName(ID, "x".repeat(400) + ".pdf");
  assert.ok(long.endsWith(".pdf"), "the extension is what has to survive truncation");
  assert.ok(long.length < 140);
  assert.strictEqual(recordIdFromReceipt(long), ID, "and it still splits back to the right record");

  // Something a person dropped into the folder by hand belongs to no expense.
  for (const stray of ["invoice.pdf", "", null, "--leading.png"]) {
    assert.strictEqual(recordIdFromReceipt(stray), null, `${JSON.stringify(stray)} names no record`);
  }
  console.log("6) The record id survives the filename, including names that contain the separator");
}

// ---- 7. listing groups by expense, pages, and ignores strays ------------
{
  const ID_A = "6ac6e543af19b2b02f0cd133", ID_B = "6ab876a5bc3a50ac99453994";
  const page = (n, extra = []) => ({
    files: [...Array.from({ length: n }, (_, i) => ({
      name: receiptFileName(ID_A, `r${i}.jpg`), url: `https://cdn/${i}.jpg`,
      _id: `f${i}`, contentType: "image/jpeg", size: 1000, createdAt: "2026-10-07T00:00:00.000Z",
    })), ...extra],
  });

  let calls = 0;
  const pit = "pit";
  global.fetch = async (url) => {
    calls++;
    const offset = Number(new URL(url).searchParams.get("offset"));
    // Two full pages then a short one, which is what ends the loop.
    const body = offset === 0 ? page(100)
      : offset === 100 ? page(100)
      : { files: [
          { name: receiptFileName(ID_B, "factura.pdf"), url: "https://cdn/b.pdf", _id: "fb",
            contentType: "application/pdf", size: 2000, createdAt: "2026-10-06T00:00:00.000Z" },
          { name: "somebody-dropped-this-here.png", url: "https://cdn/x.png", _id: "fx" },
        ] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const out = await listReceipts(pit, "LOC", "FOLDER");
  assert.strictEqual(calls, 3, "it pages until a short page, rather than stopping at the first 100");
  assert.strictEqual(out[ID_A].length, 200, "every receipt for one expense, not just the first page");
  assert.strictEqual(out[ID_B].length, 1);
  assert.ok(!Object.keys(out).some((k) => k.includes("somebody")),
    "a file nobody named after a record is not grouped under one");

  // The record id is stripped back off for display: a reader should see
  // "factura.pdf", not the 24-character id they never typed.
  assert.strictEqual(out[ID_B][0].name, "factura.pdf");
  assert.strictEqual(out[ID_B][0].url, "https://cdn/b.pdf");
  assert.strictEqual(out[ID_B][0].contentType, "application/pdf");
  console.log("7) Receipts come back grouped by expense, across pages, with the id stripped off");
}

// ---- 8. the form reads before it saves ----------------------------------
{
  assert.match(HTML, /<input type="file" id="aeReceipts" multiple/, "the form takes a file");
  assert.match(HTML, /accept="image\/jpeg,image\/jpg,image\/png,image\/webp,application\/pdf"/,
    "offering a phone the camera and a PDF, and nothing the reader cannot read");
  assert.match(HTML, /id="aeName"/, "and a name of its own, which the receipt supplies");

  assert.match(APP, /\$\("#aeReceipts"\)\.addEventListener\("change", readReceiptIntoForm\)/,
    "the read runs on change, so the fields are filled before anyone reads them");

  const fn = APP.slice(APP.indexOf("async function readReceiptIntoForm"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /api\/expenses\/read-receipt/);
  assert.match(body, /if \(el && value !== null[\s\S]*?&& !el\.value\) el\.value = value/,
    "a prefill never overwrites something already typed -- re-picking a file must not wipe a correction");
  assert.match(body, /AE_FILES\.length > 5|picked\.length > 5/, "five is the limit, as on the native field");

  // The files stay attached when the read fails: an unreadable document is
  // still the receipt for an expense somebody is about to type in by hand.
  assert.ok(!/AE_FILES = \[\];[\s\S]{0,400}status\.textContent = out\.message/.test(body),
    "a failed read must not throw away the files");

  // Submit attaches them after the record exists, because the name needs its id.
  const sub = APP.slice(APP.indexOf("async function submitAddExpense"));
  const subBody = sub.slice(0, sub.indexOf("\nfunction "));
  assert.match(subBody, /api\/expenses\/receipt/);
  assert.match(subBody, /json\.id/, "named after the record that was just created");
  assert.ok(subBody.indexOf("json.id") > subBody.indexOf("/api/expenses"),
    "and therefore only after the create call");
  console.log("8) The form reads on pick, never overwrites a correction, and files after the record exists");
}

// ---- 9. a failed upload does not look like a failed expense -------------
// The expense is already saved by then. Telling someone it failed invites them
// to enter it a second time, and a duplicate expense is worse than a missing
// photo.
{
  const sub = APP.slice(APP.indexOf("async function submitAddExpense"));
  const body = sub.slice(0, sub.indexOf("\nfunction "));
  const upload = body.slice(body.indexOf("AE_FILES.length && json.id"));
  assert.match(upload, /Expense saved/, "the message says the expense is safe");
  assert.ok(!/throw/.test(upload.slice(0, upload.indexOf("addExpenseOverlay"))),
    "and nothing throws out of the upload into the create's error path");
  console.log("9) A receipt that fails to upload still reports the expense as saved");
}

// ---- 10. today is the reader's today ------------------------------------
// toISOString is UTC: after 8pm in the DR the form defaulted to tomorrow.
{
  assert.ok(!/aePaidOn"\)\.value = new Date\(\)\.toISOString\(\)/.test(APP),
    "the date default no longer goes through UTC");
  assert.match(APP, /\$\("#aePaidOn"\)\.value = todayISO\(\)/);
  console.log("10) The Paid On default is the reader's own day, not UTC's");
}

console.log("\nPASS — a receipt fills the form in, and is filed where it can be found again.");
