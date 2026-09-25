// xlsx.js -- reading an .xlsx inside a Worker, with no dependencies.
//
// An .xlsx is a ZIP of XML. This Worker has no node_modules by design (see
// receipt-extract.js), and a spreadsheet library would be the largest thing in
// the bundle by far, so the ZIP is read directly: the runtime already provides
// DecompressionStream("deflate-raw"), which is the only hard part.
//
// Only what a portfolio intake needs is supported: shared strings, sheet names
// in workbook order, and cell values as text. No formulas (the intake has
// none), no styles, no dates as serial numbers beyond a plain passthrough.

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

const dec = new TextDecoder();

/** Reads a ZIP's central directory. Returns a Map of filename -> {offset, method, size}. */
function readCentralDirectory(buf) {
  const view = new DataView(buf);
  // The end-of-central-directory record is last, but a trailing comment can push
  // it back up to 64KB, so scan backwards for the signature rather than assuming.
  let eocd = -1;
  const start = Math.max(0, buf.byteLength - 65557);
  for (let i = buf.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("Not a valid .xlsx file (no ZIP end record found)");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CD_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.set(name, { localOffset, method, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extracts one file from the zip as text. */
async function readEntry(buf, entry) {
  const view = new DataView(buf);
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's -- always read the data offset from the local header.
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const bytes = new Uint8Array(buf, dataStart, entry.compressedSize);
  if (entry.method === 0) return dec.decode(bytes);
  if (entry.method === 8) return dec.decode(await inflate(bytes));
  throw new Error(`Unsupported compression in the .xlsx (method ${entry.method})`);
}

const unescapeXml = (s) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseSharedStrings(xml) {
  if (!xml) return [];
  // A shared string can be split across several <t> runs when part of it is
  // formatted differently; joining them is what the cell actually reads as.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""))
  );
}

const colOf = (ref) => (ref.match(/^[A-Z]+/) || [""])[0];
const rowOf = (ref) => Number((ref.match(/\d+$/) || [0])[0]);

/** A sheet as an array of rows, each row a { A: "value", B: "value" } object. */
function parseSheet(xml, strings) {
  const rows = [];
  for (const r of xml.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(r[1]);
    const cells = {};
    for (const c of r[2].matchAll(/<c\s+r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, ref, attrs, body] = c;
      const isShared = /t="s"/.test(attrs);
      const isInline = /t="(inlineStr|str)"/.test(attrs);
      let value;
      if (isInline) {
        value = unescapeXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      } else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v === undefined) continue;
        value = isShared ? (strings[Number(v)] ?? "") : unescapeXml(v);
      }
      const text = String(value).trim();
      if (text !== "") cells[colOf(ref)] = text;
    }
    // Self-closing <c r="A1"/> cells carry no value and are skipped above.
    if (Object.keys(cells).length) rows.push({ rowNumber, cells });
  }
  return rows;
}

/**
 * Reads an .xlsx into { sheets: [{ name, rows }] }, in workbook order.
 * `data` is an ArrayBuffer.
 */
export async function readWorkbook(data) {
  const entries = readCentralDirectory(data);

  const need = (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`The file is missing ${name} -- it may not be an .xlsx`);
    return readEntry(data, e);
  };

  const workbookXml = await need("xl/workbook.xml");
  const relsEntry = entries.get("xl/_rels/workbook.xml.rels");
  const relsXml = relsEntry ? await readEntry(data, relsEntry) : "";

  // rId -> target path. Sheet files are NOT reliably sheet1.xml, sheet2.xml in
  // workbook order once sheets have been reordered or deleted, so resolve them.
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship([^>]*)\/>/g)) {
    const id = (m[1].match(/Id="([^"]+)"/) || [])[1];
    const target = (m[1].match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }

  const sharedEntry = entries.get("xl/sharedStrings.xml");
  const strings = parseSharedStrings(sharedEntry ? await readEntry(data, sharedEntry) : "");

  const sheets = [];
  const sheetTags = [...workbookXml.matchAll(/<sheet([^>]*)\/>/g)];
  for (const [i, tag] of sheetTags.entries()) {
    const name = unescapeXml((tag[1].match(/name="([^"]*)"/) || [])[1] || `Sheet${i + 1}`);
    const rid = (tag[1].match(/r:id="([^"]+)"/) || [])[1];
    const path = (rid && rels.get(rid)) || `worksheets/sheet${i + 1}.xml`;
    const entry = entries.get(`xl/${path}`);
    if (!entry) continue;
    sheets.push({ name, rows: parseSheet(await readEntry(data, entry), strings) });
  }
  return { sheets };
}

/**
 * Turns a sheet into objects keyed by its header row, which is the first row
 * that has more than one filled cell -- intake templates often carry a title
 * row above the headers.
 */
export function rowsByHeader(sheet) {
  const headerRow = sheet.rows.find((r) => Object.keys(r.cells).length > 1);
  if (!headerRow) return { headers: {}, records: [] };

  const headers = headerRow.cells;                       // { A: "Listing Name", ... }
  const records = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= headerRow.rowNumber) continue;
    const obj = {};
    for (const [col, value] of Object.entries(row.cells)) {
      const key = headers[col];
      if (key) obj[key] = value;
    }
    if (Object.keys(obj).length) records.push({ rowNumber: row.rowNumber, values: obj });
  }
  return { headers, records };
}

export const __test = { readCentralDirectory, parseSharedStrings, parseSheet, unescapeXml };
