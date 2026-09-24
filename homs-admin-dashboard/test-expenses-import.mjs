// Local mock tests for expense CSV import -- no network, no live GHL/KV.
// Run: node test-expenses-import.mjs
//
// The CSV fixtures are the shapes Yari actually imports: a GHL/SaaS receipt
// export in English, a Banreservas-style statement in Spanish with DOP amounts
// and day-first dates, and a hand-made sheet with the columns in a different order.
import assert from "node:assert";

const HOMS = "dytwzgmOP5v0Jh7gop4y";
const DEMO = "ZghxU8I60bEm39JUbtCm";
const EXP = "custom_objects.expenses";

// ---- in-memory GHL -----------------------------------------------------------
function makeGhl() {
  const db = { records: { [`${HOMS}|${EXP}`]: {}, [`${DEMO}|${EXP}`]: {} }, calls: [], seq: 0, failOn: null };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const loc = u.searchParams.get("locationId") || body?.locationId;
    db.calls.push({ method, path: u.pathname, body });

    if (u.pathname === `/objects/${EXP}/records/search` && method === "POST") {
      const table = db.records[`${loc}|${EXP}`] || {};
      return json(200, { records: Object.values(table), total: Object.keys(table).length });
    }
    if (u.pathname === `/objects/${EXP}/records` && method === "POST") {
      if (db.failOn && body.properties.expense_name === db.failOn) return json(400, { message: "field validation failed" });
      const id = `exp${++db.seq}`;
      const rec = { id, properties: body.properties };
      db.records[`${loc}|${EXP}`][id] = rec;
      return json(200, { record: rec });
    }
    return json(200, {});
  };
  return { db, handler };
}

let ghl = makeGhl();
globalThis.fetch = (url, init) => ghl.handler(url, init);

const { default: worker } = await import("./src/index.js");
const { parseCsv, parseAmount, parseDateParts, mapCsvRows, mapHeader, guessCategory } = await import("./src/expenses-import.js");

const makeKv = (obj) => ({ get: async (k, o) => (obj[k] == null ? null : (o?.type === "json" ? obj[k] : JSON.stringify(obj[k]))) });
const env = {
  ADMIN_KEY: "admin",
  GHL_PIT_HOMS: "pit-homs",
  GHL_PIT_DEMO_HOMS: "pit-demo",
  DASHBOARD_TENANTS: makeKv({
    [HOMS]: { label: "HOMS", kind: "vendor", ghlPitSecretName: "GHL_PIT_HOMS" },
    [DEMO]: { label: "DEMO-HOMS", ghlPitSecretName: "GHL_PIT_DEMO_HOMS" },
  }),
};
const call = (path, body, key = "admin") =>
  worker.fetch(new Request(`https://d.dev${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }), env);

// ---- 1. the CSV parser itself ------------------------------------------------
{
  const rows = parseCsv('﻿Date,Vendor,Amount\r\n2026-09-01,"Doe, John","1,234.56"\r\n2026-09-02,"He said ""hi""",10\r\n\r\n');
  assert.deepEqual(rows[0], ["Date", "Vendor", "Amount"], "BOM stripped from the first header");
  assert.deepEqual(rows[1], ["2026-09-01", "Doe, John", "1,234.56"], "comma inside quotes is not a column break");
  assert.deepEqual(rows[2], ["2026-09-02", 'He said "hi"', "10"], "doubled quotes unescape");
  assert.equal(rows.length, 3, "trailing blank lines are not records");

  const multiline = parseCsv('a,b\n1,"line one\nline two"\n');
  assert.equal(multiline[1][1], "line one\nline two", "newline inside quotes stays in the field");
  console.log("1) CSV parser: BOM, quoted commas, doubled quotes, embedded newlines, CRLF, blank lines");
}

// ---- 2. amounts --------------------------------------------------------------
{
  assert.equal(parseAmount("1,234.56").amount, 1234.56, "US thousands");
  assert.equal(parseAmount("1.234,56").amount, 1234.56, "DR/EU thousands");
  assert.equal(parseAmount("RD$ 2.500,00").currency, "DOP");
  assert.equal(parseAmount("RD$ 2.500,00").amount, 2500);
  assert.equal(parseAmount("$58.72").amount, 58.72);
  assert.equal(parseAmount("(45.00)").amount, 45, "accounting parentheses are a magnitude");
  assert.ok(parseAmount("(45.00)").negative, "...but the sign is remembered");
  assert.equal(parseAmount("45.00-").negative, true, "trailing minus too");
  assert.equal(parseAmount("").amount, null);
  assert.equal(parseAmount("n/a").amount, null, "no digits -> no amount, not 0");
  assert.equal(parseAmount("297").amount, 297);
  console.log("2) Amounts: both thousand conventions, RD$/US$, parentheses and trailing minus, empty -> null");
}

// ---- 3. dates ----------------------------------------------------------------
{
  assert.equal(parseDateParts("2026-09-04").date, "2026-09-04");
  assert.equal(parseDateParts("2026/09/04").date, "2026-09-04");
  assert.equal(parseDateParts("13/09/2026").date, "2026-09-13", "13 can only be a day");
  assert.equal(parseDateParts("13/09/2026").order, "dmy");
  assert.equal(parseDateParts("09/13/2026").date, "2026-09-13", "and here only a month");
  assert.equal(parseDateParts("4 Sep 2026").date, "2026-09-04");
  assert.equal(parseDateParts("4 sep 2026").date, "2026-09-04");
  assert.equal(parseDateParts("Sep 4, 2026").date, "2026-09-04");
  const febThirtyFirst = parseDateParts("31/02/2026");
  assert.deepEqual([febThirtyFirst.mdy, febThirtyFirst.dmy], [null, null], "31 Feb is not a date in either reading");
  assert.equal(parseDateParts("garbage").date, null);
  const ambiguous = parseDateParts("03/04/2026");
  assert.equal(ambiguous.date, undefined, "03/04 alone cannot be settled");
  assert.deepEqual([ambiguous.mdy, ambiguous.dmy], ["2026-03-04", "2026-04-03"]);
  console.log("3) Dates: ISO, month names (EN+ES), d/m vs m/d disambiguated where possible, 31 Feb rejected");
}

// ---- 4. a whole file settles its own date order ------------------------------
{
  // Every row here reads as either order except the first, which can only be d/m.
  const csv = [
    "Fecha;Proveedor;Monto",
    "13/09/2026;Claro;1.500,00",       // 13 -> day-first, settles the file
    "03/04/2026;Edesur;2.000,00",      // ambiguous alone
    "05/06/2026;Alquiler;25.000,00",
  ].join("\n");
  const { rows } = mapCsvRows(csv, { defaultCurrency: "DOP" });
  assert.deepEqual(rows.map((r) => r.paidOn), ["2026-09-13", "2026-04-03", "2026-06-05"], "the file's order applies to every row");
  assert.ok(!rows.some((r) => r.issues.includes("ambiguous_date")), "nothing left ambiguous once the file voted");
  assert.deepEqual(rows.map((r) => r.amount), [1500, 2000, 25000]);
  assert.deepEqual(rows.map((r) => r.currency), ["dop", "dop", "dop"], "tenant default currency applies");
  assert.deepEqual(rows.map((r) => r.category), ["telecom", "office", "office"], "categories guessed from the vendor");
  console.log("4) Spanish statement (semicolon-delimited): one unambiguous row settles d/m for the file; DOP amounts; categories guessed");
}

// ---- 5. ambiguity with no vote is flagged, not guessed silently --------------
{
  const { rows } = mapCsvRows("Date,Vendor,Amount\n03/04/2026,Someone,10.00");
  assert.equal(rows[0].paidOn, "2026-03-04", "falls back to month-first");
  assert.ok(rows[0].issues.includes("ambiguous_date"));
  assert.equal(rows[0].include, true, "still importable -- the reviewer sees the flag");
  console.log("5) An unsettleable date is flagged as ambiguous rather than quietly chosen");
}

// ---- 6. header mapping, column order, unknown columns ------------------------
{
  const cols = mapHeader(["Notes", "Importe", "Categoría", "Concepto", "Fecha de Pago", "Random"]);
  assert.deepEqual([cols.notes, cols.amount, cols.category, cols.name, cols.paidOn], [0, 1, 2, 3, 4]);
  assert.equal(cols.vendor, undefined, "no vendor column in this file");
  assert.equal(guessCategory("Cloudflare", ""), "infrastructure");
  assert.equal(guessCategory("Anthropic", "Claude Max"), "software");
  assert.equal(guessCategory("Somebody Unknown", ""), null);
  console.log("6) Header mapping: any column order, accented Spanish names, unknown columns ignored");
}

// ---- 7. rows that cannot go in a P&L are held back ---------------------------
{
  const csv = [
    "Date,Vendor,Description,Amount",
    "2026-09-01,GoHighLevel,Agency plan,297.00",
    ",Nobody,No date at all,50.00",
    "2026-09-03,Ghost,Missing amount,",
    "2026-09-04,Refunded,Credit note,(25.00)",
    "2026-09-05,Zero,Nothing charged,0.00",
  ].join("\n");
  const { rows, summary } = mapCsvRows(csv);
  assert.deepEqual(rows.map((r) => r.include), [true, false, false, false, false]);
  assert.ok(rows[1].issues.includes("no_date"));
  assert.ok(rows[2].issues.includes("no_amount"));
  assert.ok(rows[3].issues.includes("negative_in_source"), "a credit is surfaced, not imported as a cost");
  assert.ok(rows[4].issues.includes("zero_amount"));
  assert.deepEqual([summary.total, summary.ready, summary.needsReview], [5, 1, 4]);
  assert.deepEqual([rows[0].line, rows[4].line], [2, 6], "line numbers point at the file, header included");
  assert.equal(rows[0].category, "platform");
  console.log("7) No date / no amount / zero / credit -> held back with the reason, never silently dropped");
}

// ---- 8. duplicates: against the book, and within the file --------------------
{
  const existing = [{ vendor: "GoHighLevel", name: "Agency plan", amount: 297, paidOn: "2026-09-01" }];
  const csv = [
    "Date,Vendor,Description,Amount",
    "2026-09-01,GoHighLevel,Agency plan,297.00",
    "2026-09-02,WhatsApp,Business API,20.00",
    "2026-09-02,WhatsApp,Business API,20.00",
  ].join("\n");
  const { rows, summary } = mapCsvRows(csv, { existing });
  assert.ok(rows[0].issues.includes("duplicate_of_existing"), "already in the book");
  assert.equal(rows[1].issues.some((i) => i.startsWith("duplicate")), false, "first occurrence is clean");
  assert.ok(rows[2].issues.includes("duplicate_in_file"), "same row twice in one file");
  assert.deepEqual(rows.map((r) => r.include), [false, true, false], "duplicates are unticked by default");
  assert.equal(summary.duplicates, 2);
  console.log("8) Duplicates caught both ways -- re-importing a statement can't double a burn line");
}

// ---- 9. route: parse writes nothing ------------------------------------------
{
  ghl = makeGhl();
  ghl.db.records[`${HOMS}|${EXP}`].seed = { id: "seed", properties: { expense_name: "Agency plan", vendor: "GoHighLevel", amount: { value: 297 }, paid_on: "2026-09-01" } };
  const res = await call("/api/expenses/parse", { locationId: HOMS, csv: "Date,Vendor,Description,Amount\n2026-09-01,GoHighLevel,Agency plan,297.00\n2026-09-08,Cloudflare,Workers paid,5.00" });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.rows.length, 2);
  assert.ok(out.rows[0].issues.includes("duplicate_of_existing"), "the book was read for duplicates");
  assert.equal(out.summary.ready, 1);
  assert.equal(ghl.db.calls.filter((c) => c.method === "POST" && c.path === `/objects/${EXP}/records`).length, 0, "parse creates nothing");
  console.log("9) POST /api/expenses/parse: draft rows + duplicate check, zero writes");
}

// ---- 10. route: import writes exactly what it is handed ----------------------
{
  const rows = [
    { line: 2, name: "Workers paid", vendor: "Cloudflare", amount: 5, currency: "usd", paidOn: "2026-09-08", category: "infrastructure", recurrence: "monthly", billingPeriod: "2026-09", notes: "seat" },
    { line: 3, name: "No date", vendor: "X", amount: 9, currency: "usd", paidOn: null, category: "other", recurrence: "one_off" },
  ];
  const out = await (await call("/api/expenses/import", { locationId: HOMS, rows })).json();
  assert.equal(out.imported, 1);
  assert.equal(out.ok, false, "one row could not be written, and that is reported");
  assert.equal(out.failed[0].line, 3);
  const written = Object.values(ghl.db.records[`${HOMS}|${EXP}`]).find((r) => r.properties.expense_name === "Workers paid").properties;
  assert.deepEqual(written.amount, { value: 5, currency: "default" });
  assert.equal(written.source, "csv_import", "provenance recorded so a bad batch can be undone");
  assert.equal(written.recurrence, "monthly");
  assert.equal(written.currency, "usd");
  assert.equal(written.billing_period, "2026-09");
  assert.equal(written.vendor, "Cloudflare");
  console.log("10) POST /api/expenses/import: writes the handed rows, tags source=csv_import, reports what failed");
}

// ---- 10b. one import, several files: each row keeps its own provenance -------
{
  const rows = [
    { line: 2, name: "From the statement", amount: 10, currency: "usd", paidOn: "2026-09-08", category: "other", recurrence: "one_off", source: "csv_import" },
    { line: 1, name: "From a photo", amount: 20, currency: "usd", paidOn: "2026-09-09", category: "other", recurrence: "one_off", source: "receipt_upload" },
    { line: 3, name: "No source given", amount: 30, currency: "usd", paidOn: "2026-09-10", category: "other", recurrence: "one_off" },
    { line: 4, name: "Nonsense source", amount: 40, currency: "usd", paidOn: "2026-09-11", category: "other", recurrence: "one_off", source: "made_up" },
  ];
  const out = await (await call("/api/expenses/import", { locationId: HOMS, rows })).json();
  assert.equal(out.imported, 4, JSON.stringify(out));
  const byName = Object.fromEntries(Object.values(ghl.db.records[`${HOMS}|${EXP}`]).map((r) => [r.properties.expense_name, r.properties.source]));
  assert.equal(byName["From the statement"], "csv_import");
  assert.equal(byName["From a photo"], "receipt_upload", "a receipt row keeps receipt_upload even in a mixed batch");
  assert.equal(byName["No source given"], "csv_import", "falls back to the batch default");
  assert.equal(byName["Nonsense source"], "csv_import", "an unrecognised source is ignored, not written");
  console.log("10b) A mixed batch: every row is written with its own source, junk values ignored");
}

// ---- 11. a failed write doesn't stop the batch, and is named -----------------
{
  ghl = makeGhl();
  ghl.db.failOn = "Bad one";
  const rows = [
    { line: 2, name: "Good one", amount: 1, currency: "usd", paidOn: "2026-09-08", category: "other", recurrence: "one_off" },
    { line: 3, name: "Bad one", amount: 2, currency: "usd", paidOn: "2026-09-08", category: "other", recurrence: "one_off" },
    { line: 4, name: "Also good", amount: 3, currency: "usd", paidOn: "2026-09-08", category: "other", recurrence: "one_off" },
  ];
  const out = await (await call("/api/expenses/import", { locationId: HOMS, rows })).json();
  assert.equal(out.imported, 2, "the rest of the batch still went in");
  assert.deepEqual(out.failed.map((f) => f.name), ["Bad one"]);
  console.log("11) One rejected row doesn't abort the import; it is reported by name and line");
}

// ---- 12. gates: auth, wrong book, junk input --------------------------------
{
  assert.equal((await call("/api/expenses/parse", { locationId: HOMS, csv: "a,b" }, null)).status, 401, "no bearer");
  assert.equal((await call("/api/expenses/parse", { locationId: HOMS, csv: "a,b" }, "wrong")).status, 401, "wrong bearer");

  const client = await call("/api/expenses/parse", { locationId: DEMO, csv: "Date,Vendor,Amount\n2026-09-01,X,1" });
  assert.equal(client.status, 400, "a client account is not a vendor book");
  assert.match((await client.json()).error, /vendor book/);

  assert.equal((await call("/api/expenses/import", { locationId: DEMO, rows: [{ name: "x", amount: 1, paidOn: "2026-09-01" }] })).status, 400);
  assert.equal((await call("/api/expenses/parse", { locationId: HOMS, csv: "   " })).status, 400, "blank csv");
  assert.equal((await call("/api/expenses/import", { locationId: HOMS, rows: [] })).status, 400, "no rows");
  assert.equal((await call("/api/expenses/import", { locationId: HOMS, rows: Array(301).fill({ name: "x", amount: 1, paidOn: "2026-09-01" }) })).status, 400, "batch cap");
  assert.equal((await call("/api/expenses/parse", { locationId: "nope", csv: "a,b" })).status, 404, "unknown tenant");

  const noAmount = await call("/api/expenses/parse", { locationId: HOMS, csv: "Date,Vendor\n2026-09-01,X" });
  assert.equal(noAmount.status, 400);
  assert.equal((await noAmount.json()).error, "no_amount_column", "says which column is missing");
  console.log("12) Gated: bearer required, vendor books only, blank/oversized/unusable input rejected with a reason");
}

console.log("\nPASS — expense CSV import: parse is read-only, import writes only reviewed rows.");
