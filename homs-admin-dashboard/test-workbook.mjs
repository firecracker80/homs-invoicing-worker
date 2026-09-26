// A minimal .xlsx builder (ZIP, stored) shared by the workbook tests.
// Stored, not deflated, so the tests need no compressor; a real ZIP rather
// than a binary fixture, because a fixture nobody can read is a fixture
// nobody maintains.

const enc = new TextEncoder();
export function zip(files) {
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

export const sheetXml = (rows) =>
  `<worksheet><sheetData>${rows.map((cells, ri) =>
    `<row r="${ri + 1}">${Object.entries(cells).map(([col, v]) =>
      typeof v === "number"
        ? `<c r="${col}${ri + 1}"><v>${v}</v></c>`
        : `<c r="${col}${ri + 1}" t="inlineStr"><is><t>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></is></c>`
    ).join("")}</row>`).join("")}</sheetData></worksheet>`;

export const HEADERS = { A: "Listing Name", B: "Status", C: "Property Type", D: "Full Address", F: "Max Occupancy",
  G: "Bedrooms / Bed Configuration", H: "Bathrooms", N: "Currency", O: "Base Price", P: "Booking Unit",
  Q: "Cleaning Fee", R: "Pet Fee", S: "Security Deposit", T: "Check-in Time", W: "Cancellation Policy",
  X: "Calendar Platform(s)", Y: "Calendar Export Links (.ics)", Z: "Photos Folder Link" };

export const book = (propertyRows) => zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Instructions" sheetId="1" r:id="rId1"/><sheet name="Properties" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet9.xml"/><Relationship Id="rId2" Target="worksheets/sheet4.xml"/></Relationships>`,
  "xl/worksheets/sheet9.xml": sheetXml([{ B: "HOMS Portfolio Intake" }]),
  "xl/worksheets/sheet4.xml": sheetXml([HEADERS, ...propertyRows]),
});

export const EXAMPLE = { A: "Arpel 07", B: "Active", C: "Apartment", D: "Calle Arpel 7", F: 4,
  G: "1 bedroom, 1 king + 1 sofa bed", H: 1.5, N: "USD", O: 80, P: "Day", Q: 25, R: 50, S: 100,
  T: "15:00", W: "Moderate", X: "Airbnb", Y: "https://airbnb.com/ical/xxxx.ics", Z: "https://drive.google.com/drive/folders/xxxx" };
