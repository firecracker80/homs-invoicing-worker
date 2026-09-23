// Local mock tests for receipt / PDF extraction -- no network, no live GHL, and
// no real Claude call. Run: node test-receipt-extract.mjs
//
// What matters here is the contract around the model, not the model: the request
// shape sent to Claude, and that whatever comes back lands in the same draft rows
// the CSV path produces, with the same hold-back rules.
import assert from "node:assert";

const HOMS = "dytwzgmOP5v0Jh7gop4y";
const DEMO = "ZghxU8I60bEm39JUbtCm";
const EXP = "custom_objects.expenses";

// ---- mocks -------------------------------------------------------------------
let anthropic = { status: 200, body: null, calls: [] };
let ghlRecords = {};
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "api.anthropic.com") {
    anthropic.calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    return json(anthropic.status, anthropic.body);
  }
  const body = init.body ? JSON.parse(init.body) : null;
  const loc = u.searchParams.get("locationId") || body?.locationId;
  if (u.pathname === `/objects/${EXP}/records/search`) {
    const recs = ghlRecords[loc] || [];
    return json(200, { records: recs, total: recs.length });
  }
  if (u.pathname === `/objects/${EXP}/records` && init.method === "POST") return json(200, { record: { id: "new1" } });
  return json(200, {});
};

const { default: worker } = await import("./src/index.js");
const { requestBodyFor, contentBlocksFor, rowsFromExtraction, extractFromFile, FILE_TYPES, MAX_FILE_BYTES } =
  await import("./src/receipt-extract.js");

const makeKv = (obj) => ({ get: async (k, o) => (obj[k] == null ? null : (o?.type === "json" ? obj[k] : JSON.stringify(obj[k]))) });
const envWith = (key) => ({
  ADMIN_KEY: "admin",
  ...(key ? { ANTHROPIC_API_KEY: key } : {}),
  GHL_PIT_HOMS: "pit-homs",
  GHL_PIT_DEMO_HOMS: "pit-demo",
  DASHBOARD_TENANTS: makeKv({
    [HOMS]: { label: "HOMS", kind: "vendor", ghlPitSecretName: "GHL_PIT_HOMS" },
    [DEMO]: { label: "DEMO-HOMS", ghlPitSecretName: "GHL_PIT_DEMO_HOMS" },
  }),
});
const call = (path, body, env = envWith("sk-test"), key = "admin") =>
  worker.fetch(new Request(`https://d.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }), env);

const reply = (obj) => ({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 180 } });
const oneExpense = (over = {}) => ({
  is_expense_document: true, document_note: null,
  expenses: [{ name: "Agency plan", vendor: "GoHighLevel", amount: 297, currency: "usd", paid_on: "2026-09-01",
    category: "platform", recurrence: "monthly", billing_period: "2026-09", notes: null, confidence: "high", ...over }],
});

// ---- 1. the request sent to Claude ------------------------------------------
{
  const pdf = requestBodyFor({ mediaType: "application/pdf", data: "QkFTRTY0" });
  assert.equal(pdf.messages[0].content[0].type, "document", "a PDF goes in a document block");
  assert.equal(pdf.messages[0].content[0].source.media_type, "application/pdf");
  assert.equal(pdf.messages[0].content[1].type, "text", "the file comes before the instruction");
  assert.equal(pdf.output_config.format.type, "json_schema", "structured output, not free text");
  assert.equal(pdf.output_config.effort, "low", "extraction does not need deep reasoning");
  assert.equal(pdf.model, "claude-opus-5");

  const img = contentBlocksFor({ mediaType: "image/jpeg", data: "QkFTRTY0" });
  assert.equal(img[0].type, "image", "a photo goes in an image block");

  const schema = pdf.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  const item = schema.properties.expenses.items;
  assert.deepEqual(item.properties.category.enum.slice(0, 2), ["platform", "infrastructure"], "the book's own categories are named");
  assert.ok(item.required.includes("confidence"), "the model must say how sure it is");
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(FILE_TYPES.includes("application/pdf") && FILE_TYPES.includes("image/png"), true);
  console.log("1) Request: PDF -> document block, photo -> image block, JSON-schema output, low effort, book's categories");
}

// ---- 2. no key configured, unsupported type ---------------------------------
{
  await assert.rejects(() => extractFromFile("", { mediaType: "image/png", data: "x" }), (e) => e.status === 503 && /ANTHROPIC_API_KEY/.test(e.message));
  await assert.rejects(() => extractFromFile("sk", { mediaType: "text/csv", data: "x" }), (e) => e.status === 400 && /Unsupported/.test(e.message));
  console.log("2) Missing key -> 503 naming the secret; unsupported type -> 400");
}

// ---- 3. a clean receipt becomes an importable row ---------------------------
{
  anthropic = { status: 200, body: reply(oneExpense()), calls: [] };
  ghlRecords = { [HOMS]: [] };
  const res = await call("/api/expenses/parse-file", { locationId: HOMS, filename: "ghl-sep.pdf", mediaType: "application/pdf", data: "QkFTRTY0" });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.rows.length, 1);
  assert.equal(out.source, "receipt_upload");
  const r = out.rows[0];
  assert.deepEqual([r.name, r.vendor, r.amount, r.paidOn, r.category, r.recurrence], ["Agency plan", "GoHighLevel", 297, "2026-09-01", "platform", "monthly"]);
  assert.equal(r.include, true);
  assert.match(r.notes, /Read from ghl-sep\.pdf/, "the row says where it came from");
  assert.equal(out.summary.ready, 1);
  console.log("3) A clean receipt -> one ready row, provenance noted in the row");
}

// ---- 4. an unreadable figure is never guessed -------------------------------
{
  anthropic.body = reply(oneExpense({ amount: null, paid_on: null, confidence: "low" }));
  const out = await (await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/jpeg", data: "QkFTRTY0" })).json();
  const r = out.rows[0];
  assert.ok(r.issues.includes("no_amount") && r.issues.includes("no_date") && r.issues.includes("low_confidence"));
  assert.equal(r.include, false, "held back for review, not written");
  assert.equal(out.summary.ready, 0);
  console.log("4) Illegible amount/date -> held back with the reason, never guessed into the book");
}

// ---- 5. a low-confidence read is held back even when it looks complete ------
{
  anthropic.body = reply(oneExpense({ confidence: "low" }));
  const out = await (await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png", data: "QkFTRTY0" })).json();
  assert.equal(out.rows[0].include, false, "a shaky read is exactly the row a human must see");
  assert.equal(out.rows[0].blocked, false, "...but it is fixable and tickable, not blocked");
  console.log("5) Low confidence -> unticked but editable");
}

// ---- 6. duplicates against the book, and within one document ----------------
{
  ghlRecords = { [HOMS]: [{ id: "e1", properties: { expense_name: "Agency plan", vendor: "GoHighLevel", amount: { value: 297 }, paid_on: "2026-09-01" } }] };
  anthropic.body = reply({
    is_expense_document: true, document_note: null,
    expenses: [
      { name: "Agency plan", vendor: "GoHighLevel", amount: 297, currency: "usd", paid_on: "2026-09-01", category: "platform", recurrence: "monthly", billing_period: null, notes: null, confidence: "high" },
      { name: "Workers paid", vendor: "Cloudflare", amount: 5, currency: "usd", paid_on: "2026-09-08", category: "infrastructure", recurrence: "monthly", billing_period: null, notes: null, confidence: "high" },
      { name: "Workers paid", vendor: "Cloudflare", amount: 5, currency: "usd", paid_on: "2026-09-08", category: "infrastructure", recurrence: "monthly", billing_period: null, notes: null, confidence: "high" },
    ],
  });
  const out = await (await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "application/pdf", data: "QkFTRTY0" })).json();
  assert.equal(out.rows.length, 3, "a multi-charge PDF yields a row per charge");
  assert.ok(out.rows[0].issues.includes("duplicate_of_existing"));
  assert.ok(out.rows[2].issues.includes("duplicate_in_file"));
  assert.deepEqual(out.rows.map((r) => r.include), [false, true, false]);
  console.log("6) Multi-charge document -> a row each; duplicates caught against the book and inside the file");
}

// ---- 7. not a receipt at all ------------------------------------------------
{
  anthropic.body = reply({ is_expense_document: false, document_note: "This looks like a boarding pass.", expenses: [] });
  const res = await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/jpeg", data: "QkFTRTY0" });
  const out = await res.json();
  assert.equal(res.status, 422);
  assert.equal(out.error, "not_an_expense_document");
  assert.match(out.message, /boarding pass/, "says what it saw instead of showing an empty table");
  // The two signals can disagree: charges listed on something that isn't a bill.
  // "Not an expense document" wins -- rows from it never reach the review table.
  anthropic.body = reply({ is_expense_document: false, document_note: "A quotation, not a bill.",
    expenses: [{ name: "Proposed work", vendor: "Someone", amount: 900, currency: "usd", paid_on: "2026-09-10", category: "contractors", recurrence: "one_off", billing_period: null, notes: null, confidence: "high" }] });
  const quote = await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "application/pdf", data: "QkFTRTY0" });
  assert.equal(quote.status, 422, "a quote with amounts on it is still not a bill");
  assert.deepEqual((await quote.json()).rows, [], "and none of its lines reach the table");
  console.log("7) Not a receipt -> 422 saying what the file appears to be, even when it lists amounts");
}

// ---- 8. upstream failures surface as themselves ------------------------------
{
  anthropic = { status: 401, body: { error: { message: "invalid x-api-key" } }, calls: [] };
  const bad = await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png", data: "QkFTRTY0" });
  assert.equal(bad.status, 503, "a rejected key is a configuration problem, not a bad request");

  anthropic = { status: 200, body: { content: [{ type: "text", text: "not json at all" }], stop_reason: "end_turn" }, calls: [] };
  const junk = await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png", data: "QkFTRTY0" });
  assert.equal(junk.status, 502);
  assert.match((await junk.json()).error, /could not be understood/);

  anthropic = { status: 200, body: { content: [], stop_reason: "refusal" }, calls: [] };
  assert.equal((await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png", data: "QkFTRTY0" })).status, 422);
  console.log("8) Bad key -> 503, unparseable answer -> 502, refusal -> 422; nothing is invented");
}

// ---- 9. gates ---------------------------------------------------------------
{
  anthropic = { status: 200, body: reply(oneExpense()), calls: [] };
  assert.equal((await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png", data: "x" }, envWith("sk"), null)).status, 401, "no bearer");
  assert.equal((await call("/api/expenses/parse-file", { locationId: DEMO, mediaType: "image/png", data: "x" })).status, 400, "client account is not a vendor book");
  assert.equal((await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png" })).status, 400, "no data");

  const big = "A".repeat(Math.ceil((MAX_FILE_BYTES + 1024) * 4 / 3));
  const tooBig = await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/jpeg", data: big });
  assert.equal(tooBig.status, 413);
  assert.match((await tooBig.json()).error, /too large/);
  assert.equal(anthropic.calls.length, 0, "an oversized file is rejected before it is ever sent anywhere");

  const unset = await call("/api/expenses/parse-file", { locationId: HOMS, mediaType: "image/png", data: "QkFTRTY0" }, envWith(null));
  assert.equal(unset.status, 503, "no key configured");
  console.log("9) Gated: bearer, vendor books only, size checked before any upload, missing key -> 503");
}

// ---- 10. the rows are the same shape the import endpoint takes --------------
{
  const { rows } = rowsFromExtraction(oneExpense(), { filename: "r.jpg" });
  const out = await (await call("/api/expenses/import", { locationId: HOMS, rows, source: "receipt_upload" })).json();
  assert.equal(out.imported, 1, "extraction output imports without translation: " + JSON.stringify(out));
  console.log("10) Extracted rows feed the same import endpoint as the CSV path, tagged receipt_upload");
}

console.log("\nPASS — receipt extraction: structured read, nothing guessed, same review and import path as CSV.");
