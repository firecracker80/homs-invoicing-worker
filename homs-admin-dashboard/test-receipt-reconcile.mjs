// A receipt shows up wherever it was filed, and an expense says whose cost it is.
// Run: node test-receipt-reconcile.mjs
//
// There are two places a receipt can live, because only one of them is
// writable. A receipt attached inside GHL lands in the record's own
// receipt_photo field; one filed from the dashboard lands in a media-library
// folder, because FILE_UPLOAD fields cannot be SET through the records API
// (probed 2026-10-07: ten value shapes, all 422). Which half a receipt is in
// says only where it was typed, which is no use to somebody looking for it --
// so the drawer shows one list.
//
// And three fields come out: can_reimburse, already_reimbursed and
// reimbursing_now describe a reimbursement cycle that does not exist. An
// owner's cost is deducted from their payout, never invoiced to them. They
// were on screen while paid_by -- the field that actually decides it -- was
// never read at all.
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const { normalizeExpense, fileUrlsProp } = await import("./src/normalize.js");
const APP = fs.readFileSync("./public/app.js", "utf8");

const expense = (properties) => normalizeExpense({ id: "e1", properties });

// ---- 1. the reimbursement fields are gone -----------------------------
{
  const e = expense({
    expense_name: "Pool pump", amount: { value: 120, currency: "USD" },
    can_reimburse: { value: 120, currency: "USD" },
    already_reimbursed: { value: 40, currency: "USD" },
    reimbursing_now: { value: 80, currency: "USD" },
  });
  for (const dead of ["canReimburse", "alreadyReimbursed", "reimbursingNow"]) {
    assert.ok(!(dead in e), `${dead} must not be read -- the process it describes does not exist`);
  }
  // Not read even when the record carries values, which three DEMO-HOMS
  // records still do. The fields stay on the object; nothing consumes them.
  assert.strictEqual(e.amount, 120, "and the amount is still the amount");

  for (const label of ["Can Reimburse", "Already Reimbursed", "Reimbursing Now"]) {
    assert.ok(!APP.includes(`"${label}"`), `"${label}" is still on screen somewhere in app.js`);
  }
  console.log("1) The three reimbursement fields are read nowhere and shown nowhere");
}

// ---- 2. whose cost it is, which replaced them -------------------------
{
  assert.strictEqual(expense({ paid_by: "owner" }).paidBy, "Owner");
  assert.strictEqual(expense({ paid_by: "owner" }).paidByKey, "owner");
  assert.strictEqual(expense({ paid_by: "manager" }).paidBy, "Manager");

  // No answer is the case worth seeing: it counts against nobody and arrives on
  // a statement flagged.
  assert.strictEqual(expense({}).paidBy, null);
  assert.strictEqual(expense({}).paidByKey, null);

  // An unrecognised value is shown as itself rather than swallowed, so a typo
  // in the CRM is visible instead of silently reading as unattributed.
  assert.strictEqual(expense({ paid_by: "landlord" }).paidBy, "landlord");
  console.log("2) paid_by is read and labelled -- it was not read at all before");
}

// ---- 3. and it reads as a badge, with the gap called out --------------
{
  const sandbox = {
    document: { body: {}, documentElement: { style: { setProperty() {} } }, querySelector: () => null,
                querySelectorAll: () => [], addEventListener() {}, createTreeWalker: () => ({ nextNode: () => null }) },
    location: { search: "" }, URLSearchParams, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} }, console, navigator: { language: "en" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: {}, fetch: async () => ({ ok: true, json: async () => ({}) }), setTimeout, FileReader: class {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);

  assert.match(run(`paidByBadge("owner", "Owner")`), /badge neutral">Owner</);
  assert.match(run(`paidByBadge("manager", "Manager")`), /badge good">Manager</);
  // The one that matters: a blank is not a blank cell.
  assert.match(run(`paidByBadge(null, null)`), /badge warn">Unattributed</,
    "an expense attributed to nobody has to look wrong, not empty");
  assert.match(run(`paidByBadge("", "")`), /Unattributed/);

  // Every label it can print has Spanish.
  const dict = JSON.parse(run(`JSON.stringify(I18N.es)`));
  for (const label of ["Paid By", "Owner", "Manager", "Unattributed", "in GHL", "Receipts"]) {
    assert.ok(dict[label], `"${label}" has no Spanish`);
  }
  console.log("3) Unattributed reads as a warning, and every new label has Spanish");
}

// ---- 4. the table shows it, where the dead fields used to be ----------
{
  const fn = APP.slice(APP.indexOf("function renderExpenses"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /"Paid By"/, "there is a Paid By column");
  assert.match(body, /paidByBadge\(e\.paidByKey/, "rendered as a badge, not raw text");
  assert.match(body, /key: "paidBy", label: "Paid By"/, "and a filter for it");

  const headers = [...body.matchAll(/headers: \[([^\]]+)\]/g)][0][1];
  assert.strictEqual(headers.split(",").length, 8, "the colspan on the empty row still matches");
  assert.ok(!/Reimburs/.test(body), "and nothing about reimbursement is left in the table");
  console.log("4) The Expenses table carries Paid By, as a badge and as a filter");
}

// ---- 5. a FILE_UPLOAD field, in whatever shape it arrives -------------
// No expense record on any account has ever had a receipt attached, so the
// shape GHL returns for a populated FILE_UPLOAD field is genuinely unknown --
// an empty one is simply omitted from `properties`. Every shape GHL uses for
// files elsewhere is accepted; anything else yields nothing rather than
// throwing, so the folder half keeps working regardless.
{
  const urls = (v) => fileUrlsProp({ properties: { receipt_photo: v } }, "receipt_photo");
  const CDN = "https://assets.cdn.filesafe.space/LOC/media/abc.png";

  assert.deepStrictEqual(urls([{ url: CDN, name: "recibo.png" }]), [{ url: CDN, name: "recibo.png", source: "ghl_field" }]);

  // The shape GHL ACTUALLY returns, confirmed 2026-10-08 the first time a
  // receipt was attached through the object widget. The name is in meta, and
  // reading only x.name fell through to the urls last segment -- a uuid.
  assert.deepStrictEqual(
    urls([{ url: CDN, meta: { name: "WhatsApp Image 2026-10-08 at 10.14.28 AM.jpeg", extension: ".jpg", size: 147436 } }]),
    [{ url: CDN, name: "WhatsApp Image 2026-10-08 at 10.14.28 AM.jpeg", source: "ghl_field" }],
    "meta.name is the filename a person recognises");
  // meta present but nameless still yields a usable label rather than throwing.
  assert.strictEqual(urls([{ url: CDN, meta: { size: 1 } }])[0].name, "abc.png");
  assert.deepStrictEqual(urls(CDN).map((r) => r.url), [CDN], "a bare string");
  assert.deepStrictEqual(urls([CDN, CDN]).map((r) => r.url), [CDN, CDN], "an array of strings");
  assert.deepStrictEqual(urls({ url: CDN }).map((r) => r.url), [CDN], "a single object");
  assert.deepStrictEqual(urls([{ fileUrl: CDN }]).map((r) => r.url), [CDN], "fileUrl instead of url");
  assert.deepStrictEqual(urls(`${CDN},${CDN}`).map((r) => r.url), [CDN, CDN], "comma separated");
  assert.deepStrictEqual(urls(`${CDN}\n${CDN}`).map((r) => r.url), [CDN, CDN], "newline separated");

  // Nothing, in every way nothing arrives.
  for (const empty of [null, undefined, "", [], {}, [{}], [null], 42]) {
    assert.deepStrictEqual(urls(empty), [], `${JSON.stringify(empty)} yields no receipts`);
  }

  // This becomes an href. A CRM field is a place a person types, and a
  // javascript: or data: value there must never become a clickable link.
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "//evil.example/x", "ftp://h/x", "   "]) {
    assert.deepStrictEqual(urls(bad), [], `${JSON.stringify(bad)} is not a link worth offering`);
    assert.deepStrictEqual(urls([{ url: bad }]), []);
  }

  // A name is derived from the url when the field does not carry one, because
  // "receipt" on every row tells the reader nothing.
  assert.strictEqual(urls(CDN)[0].name, "abc.png");
  assert.strictEqual(urls("https://h/a%20b.pdf")[0].name, "a b.pdf", "and is url-decoded");
  assert.strictEqual(urls("https://h/")[0].name, "receipt", "falling back when there is no segment");
  console.log("5) A populated receipt_photo is read in any plausible shape, and only ever as an http link");
}

// ---- 6. both halves land in one list ---------------------------------
{
  const fn = APP.slice(APP.indexOf("async function paintReceipts"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  assert.match(body, /record\?\.receiptPhotos \|\| \[\]/, "the GHL field half is read");
  assert.match(body, /all\[recordId\] \|\| \[\]/, "the folder half is read");
  assert.match(body, /\[\.\.\.fromGhl, \.\.\.fromHere\]/, "and they are ONE list, not two sections");
  assert.match(body, /source === "ghl_field" \? "in GHL"/,
    "with where it came from as a quiet label, since the reader wants the receipt not the provenance");
  assert.match(body, /No receipt filed for this expense\./,
    "and an empty state that covers both halves being empty");

  // The drawer still passes the record id through, which is the only thing
  // tying the two halves to the same expense.
  assert.match(APP, /if \(kind === "expense"\) paintReceipts\(record\.id\)/);
  console.log("6) The drawer merges receipts from the GHL field and the dashboard folder into one list");
}

console.log("\nPASS — one receipt list from two places, and an expense that says whose cost it is.");
