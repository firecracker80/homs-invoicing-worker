// Local mock tests for the portfolio intake importer. No network, no GHL.
// Run: node test-portfolio-import.mjs
//
// The .xlsx reader is tested against a real ZIP built here (stored, not
// deflated, so the test needs no compressor) rather than a binary fixture —
// a fixture nobody can read is a fixture nobody maintains.
import assert from "node:assert";

const { readWorkbook, rowsByHeader } = await import("./src/xlsx.js");
const {
  mapPropertiesSheet, accountSettingsFrom, calendarChecklist,
  parsePortfolio, importProperties, CANCELLATION_PRESETS,
} = await import("./src/portfolio-import.js");

// ---- a minimal .xlsx builder (ZIP, stored) -----------------------------------
const enc = new TextEncoder();
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push({ name: nameBytes, size: data.length, offset });
    offset += local.length + nameBytes.length + data.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const cd = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.size), ...u32(e.size), ...u16(e.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(e.offset)];
    chunks.push(new Uint8Array(cd), e.name);
    offset += cd.length + e.name.length;
  }
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - cdStart), ...u32(cdStart), ...u16(0)];
  chunks.push(new Uint8Array(eocd));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out.buffer;
}

const sheetXml = (rows) =>
  `<worksheet><sheetData>${rows.map((cells, ri) =>
    `<row r="${ri + 1}">${Object.entries(cells).map(([col, v]) =>
      typeof v === "number"
        ? `<c r="${col}${ri + 1}"><v>${v}</v></c>`
        : `<c r="${col}${ri + 1}" t="inlineStr"><is><t>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></is></c>`
    ).join("")}</row>`).join("")}</sheetData></worksheet>`;

const HEADERS = { A: "Listing Name", B: "Status", C: "Property Type", D: "Full Address", F: "Max Occupancy",
  G: "Bedrooms / Bed Configuration", H: "Bathrooms", N: "Currency", O: "Base Price", P: "Booking Unit",
  Q: "Cleaning Fee", R: "Pet Fee", S: "Security Deposit", T: "Check-in Time", W: "Cancellation Policy",
  X: "Calendar Platform(s)", Y: "Calendar Export Links (.ics)", Z: "Photos Folder Link" };

const book = (propertyRows) => zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Instructions" sheetId="1" r:id="rId1"/><sheet name="Properties" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet9.xml"/><Relationship Id="rId2" Target="worksheets/sheet4.xml"/></Relationships>`,
  "xl/worksheets/sheet9.xml": sheetXml([{ B: "HOMS Portfolio Intake" }]),
  "xl/worksheets/sheet4.xml": sheetXml([HEADERS, ...propertyRows]),
});

const EXAMPLE = { A: "Arpel 07", B: "Active", C: "Apartment", D: "Calle Arpel 7", F: 4,
  G: "1 bedroom, 1 king + 1 sofa bed", H: 1.5, N: "USD", O: 80, P: "Day", Q: 25, R: 50, S: 100,
  T: "15:00", W: "Moderate", X: "Airbnb", Y: "https://airbnb.com/ical/xxxx.ics", Z: "https://drive.google.com/drive/folders/xxxx" };

// ---- 1. the reader: real ZIP, sheets resolved through the rels ---------------
{
  const wb = await readWorkbook(book([{ A: "Casa Uno", O: 120 }]));
  assert.deepEqual(wb.sheets.map((s) => s.name), ["Instructions", "Properties"],
    "sheets come back in workbook order, not file order");
  // sheet9/sheet4 deliberately do not match sheet1/sheet2 -- resolved via rels.
  const props = wb.sheets[1];
  const { records } = rowsByHeader(props);
  assert.equal(records.length, 1);
  assert.equal(records[0].values["Listing Name"], "Casa Uno");
  assert.equal(records[0].rowNumber, 2);
  console.log("1) .xlsx read with no dependencies: ZIP directory, rels-resolved sheet paths, header mapping");
}

// ---- 2. the shipped example row is detected, not imported --------------------
{
  const wb = await readWorkbook(book([EXAMPLE, { A: "Casa Dos", B: "Active", C: "Villa", O: 150, N: "USD", W: "Moderate" }]));
  const { rows } = mapPropertiesSheet(wb.sheets[1]);
  assert.ok(rows[0].issues.includes("example_row"), "the template's own row carries placeholder markers");
  assert.equal(rows[0].include, false, "and must never be imported into a client's account");
  assert.equal(rows[1].include, true, "a real row beside it is unaffected");
  console.log("2) The template example row is caught by its placeholders and unticked");
}

// ---- 3. field mapping, including the two type mismatches ---------------------
{
  const wb = await readWorkbook(book([{ A: "Casa Uno", B: "Active", C: "Apartment", D: "Calle 1",
    F: 6, G: "3 bedrooms, 2 king + 1 bunk", H: 2.5, O: 120, Q: 30, R: 25, N: "USD", W: "Moderate", P: "Day" }]));
  const { rows } = mapPropertiesSheet(wb.sheets[1]);
  const p = rows[0].properties;
  assert.equal(p.property_name, "Casa Uno");
  assert.equal(p.status, "active", "the label is stored as the option key");
  assert.equal(p.property_type, "apartment");
  assert.equal(p.max_occupancy, 6);
  assert.equal(p.bedrooms, 3, "the object stores a number; the workbook asks for a description");
  assert.equal(rows[0].carried["bed configuration"], "3 bedrooms, 2 king + 1 bunk", "...and the prose is kept for the reviewer");
  assert.equal(p.bathrooms, 2.5);
  assert.deepEqual(p.base_nightly_rate, { value: 120, currency: "default" });
  assert.deepEqual(p.pet_fee, { value: 25, currency: "default" });
  assert.equal(rows[0].include, true);
  console.log("3) Ten object fields mapped; a bed description becomes a count and the prose is not lost");
}

// ---- 4. everything the object has no home for is reported, never dropped -----
{
  const wb = await readWorkbook(book([{ A: "Casa Uno", O: 120, N: "USD", W: "Moderate", S: 200, T: "15:00", Z: "https://drive.google.com/folders/abc" }]));
  const out = mapPropertiesSheet(wb.sheets[1]);
  const unmapped = Object.keys(out.rows[0].unmapped);
  assert.ok(unmapped.includes("Security Deposit"), "collected by the workbook, no field on the object: " + unmapped);
  assert.ok(unmapped.includes("Check-in Time"));
  assert.ok(!unmapped.includes("Currency"), "account-level columns are not 'unmapped', they are handled separately");
  assert.ok(!unmapped.includes("Cancellation Policy"));
  console.log("4) Columns with nowhere to go are surfaced per row; account-level columns excluded from that list");
}

// ---- 5. account settings: first row wins, disagreement is loud ---------------
{
  const wb = await readWorkbook(book([
    EXAMPLE,
    { A: "Casa Uno", O: 100, N: "USD", W: "Moderate" },
    { A: "Casa Dos", O: 110, N: "DOP", W: "Moderate" },
    { A: "Casa Tres", O: 120, N: "DOP", W: "Moderate" },
  ]));
  const sheet = wb.sheets[1];
  const { rows } = mapPropertiesSheet(sheet);
  const { settings, disagreements } = accountSettingsFrom(sheet, rows);

  assert.equal(settings.currency, "USD", "taken from the first real row, not the example row");
  assert.equal(settings.cancellationPolicy, CANCELLATION_PRESETS.moderate, "the label is stored as the sentence the parser reads");
  assert.equal(settings.cancellationPolicyLabel, "Moderate");

  const conflict = disagreements.find((d) => d.field === "currency");
  assert.ok(conflict, "a mixed-currency workbook must not pass silently");
  assert.deepEqual(conflict.rows, [4, 5], "and it names the rows that disagree");
  assert.deepEqual(conflict.alsoSeen, ["DOP"]);
  assert.equal(conflict.used, "USD");
  console.log("5) First row wins; the rows that disagree are named, never quietly reconciled");
}

// ---- 6. an unrecognised policy is held for review, never provisioned ---------
{
  const wb = await readWorkbook(book([{ A: "Casa Uno", O: 100, N: "usd", W: "Other" }]));
  const sheet = wb.sheets[1];
  const { settings, disagreements } = accountSettingsFrom(sheet, mapPropertiesSheet(sheet).rows);
  assert.equal(settings.currency, "USD", "currency is upper-cased, so 'usd' and a stray space both land");
  assert.equal(settings.cancellationPolicy, "Other", "left as written, NOT guessed into a preset");
  assert.ok(disagreements.some((d) => d.kind === "needs_review"), "and flagged for a human: " + JSON.stringify(disagreements));
  console.log("6) 'Other' is never mapped to a preset -- a guessed policy is a wrong refund");
}

// ---- 7. duplicates against the account and within the file -------------------
{
  const wb = await readWorkbook(book([
    { A: "Casa Uno", O: 100, N: "USD", W: "Moderate" },
    { A: "casa uno", O: 105, N: "USD", W: "Moderate" },
    { A: "Casa Dos", O: 110, N: "USD", W: "Moderate" },
  ]));
  const { rows } = mapPropertiesSheet(wb.sheets[1], { existingNames: ["Casa Dos"] });
  assert.ok(rows[1].issues.includes("duplicate_in_file"), "case-insensitive within the file");
  assert.ok(rows[2].issues.includes("already_in_account"), "and against what the account already holds");
  assert.deepEqual(rows.map((r) => r.include), [true, false, false]);
  console.log("7) Re-importing a workbook cannot create the same property twice");
}

// ---- 8. a property priced per week is flagged, not silently made nightly -----
{
  const wb = await readWorkbook(book([{ A: "Casa Larga", O: 900, P: "Week", N: "USD", W: "Moderate" }]));
  const { rows } = mapPropertiesSheet(wb.sheets[1]);
  assert.ok(rows[0].issues.includes("not_priced_per_night"), "the object field is a NIGHTLY rate");
  assert.equal(rows[0].include, false, "900 a week stored as 900 a night is a 7x error");
  console.log("8) Weekly/monthly pricing held back -- the object stores a nightly rate");
}

// ---- 9. the calendar checklist covers what the API cannot create -------------
{
  const wb = await readWorkbook(book([EXAMPLE, { A: "Casa Uno", O: 100, N: "USD", W: "Moderate",
    P: "Day", T: "14:00", X: "Airbnb, VRBO", Y: "https://airbnb.com/ical/real.ics" }]));
  const sheet = wb.sheets[1];
  const { rows } = mapPropertiesSheet(sheet);
  const list = calendarChecklist(sheet, rows);
  assert.equal(list.length, 1, "only rows that will actually be imported");
  assert.equal(list[0].listing, "Casa Uno");
  assert.equal(list[0].icsLinks, "https://airbnb.com/ical/real.ics");
  assert.equal(list[0].checkIn, "14:00");
  console.log("9) Calendar checklist carries name, price, times and .ics links for the manual step");
}

// ---- 10. end to end, and the writer --------------------------------------
{
  const buf = book([EXAMPLE, { A: "Casa Uno", B: "Active", C: "Villa", O: 100, N: "USD", W: "Strict" }]);
  const out = await parsePortfolio(buf, { existingNames: [] });
  assert.equal(out.summary.total, 2);
  assert.equal(out.summary.ready, 1, "the example row is not ready, the real one is");
  assert.equal(out.accountSettings.cancellationPolicy, CANCELLATION_PRESETS.strict);
  assert.ok(out.unmappedColumns.length > 0);
  assert.equal(out.calendarChecklist.length, 1);

  const writes = [];
  globalThis.fetch = async (url, init) => {
    writes.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ record: { id: "p" + writes.length } }) };
  };
  const res = await importProperties("pit", "loc", out.rows.filter((r) => r.include));
  assert.equal(res.created.length, 1);
  assert.equal(res.failed.length, 0);
  assert.equal(writes[0].properties.property_name, "Casa Uno");
  assert.equal(writes.length, 1, "only the ticked row is written");
  console.log("10) End to end: parse -> review -> write only what was ticked");
}

// ---- 11. the routes: gated, client accounts only, nothing written on parse ---
{
  const HOMS = "dytwzgmOP5v0Jh7gop4y";      // a vendor book
  const DEMO = "ZghxU8I60bEm39JUbtCm";      // a client account
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const body = { records: [], record: { id: "p1" }, total: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const makeKv = (o) => ({ get: async (k, opt) => (o[k] == null ? null : (opt?.type === "json" ? o[k] : JSON.stringify(o[k]))) });
  const env = {
    ADMIN_KEY: "admin", GHL_PIT_DEMO_HOMS: "pit-demo", GHL_PIT_HOMS: "pit-homs",
    DASHBOARD_TENANTS: makeKv({
      [DEMO]: { label: "DEMO-HOMS", ghlPitSecretName: "GHL_PIT_DEMO_HOMS" },
      [HOMS]: { label: "HOMS", kind: "vendor", ghlPitSecretName: "GHL_PIT_HOMS" },
    }),
  };
  const { default: worker } = await import("./src/index.js");
  const call = (path, payload, key = "admin") => worker.fetch(new Request("https://d.dev" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
    body: JSON.stringify(payload),
  }), env);

  const b64 = Buffer.from(new Uint8Array(book([EXAMPLE, { A: "Casa Uno", O: 100, N: "USD", W: "Moderate" }]))).toString("base64");

  assert.equal((await call("/api/portfolio/parse", { locationId: DEMO, data: b64 }, null)).status, 401, "no bearer");
  assert.equal((await call("/api/portfolio/parse", { locationId: HOMS, data: b64 })).status, 400, "a vendor book has no properties");
  assert.equal((await call("/api/portfolio/parse", { locationId: DEMO })).status, 400, "no file");

  calls.length = 0;
  const res = await call("/api/portfolio/parse", { locationId: DEMO, data: b64 });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.summary.ready, 1);
  assert.equal(out.accountSettings.currency, "USD");
  assert.equal(calls.filter((c) => c.method === "POST" && /\/records$/.test(c.url)).length, 0, "parse creates nothing");

  const imported = await (await call("/api/portfolio/import", { locationId: DEMO, rows: out.rows.filter((r) => r.include) })).json();
  assert.equal(imported.imported, 1);
  console.log("11) Routes gated by bearer, client accounts only; parse writes nothing, import writes the ticked rows");
}

console.log("\nPASS — portfolio intake: read without dependencies, example row caught, account settings first-row-and-warn.");
