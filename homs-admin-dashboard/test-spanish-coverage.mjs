// What the page leaves in English when it is switched to Spanish.
// Run: node test-spanish-coverage.mjs
//
// localize() matches a WHOLE trimmed text node against I18N.es. Two things
// defeat that, and both shipped:
//
//   1. A key that is simply absent. Address, Bed/Bath, Nightly Rate and
//      Bookings sat in English in a table whose other headers translated --
//      the uppercase on screen is CSS, so it was never a casing problem.
//   2. A string built by interpolation. Every filter's "All" option renders as
//      `${label}: All`, so no fixed key could ever match it. "Year: All" and
//      "Month: All" are literals in the markup, which is the only reason those
//      two were translated and the other fifteen were not (Yari, 2026-10-13).
//
// The test that matters here is 2: it reads the filter definitions out of the
// page and fails on a filter whose option has no Spanish, so the sixteenth one
// is caught here rather than by a client.
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("./public/app.js", "utf8");

// The dictionary as the page actually ends up with it: the literal block plus
// whatever the generator adds. Evaluated rather than parsed, so a generator
// that stops running is a failure here too.
const i18nStart = src.indexOf("const I18N = {");
const i18nEnd = src.indexOf("\nlet LOCALE =");
assert.ok(i18nStart > -1 && i18nEnd > i18nStart, "could not find the I18N block");
const I18N = new Function(src.slice(i18nStart, i18nEnd) + "; return I18N;")();
const es = I18N.es;

console.log("1) the dictionary is built, generator included");
assert.ok(Object.keys(es).length > 150, "the Spanish dictionary looks truncated");

// The whole point of generating these. A filter added later is translated the
// moment its label is, and one whose label has no Spanish is named here.
console.log("2) every filter's All option has Spanish");
{
  const labels = [...src.matchAll(/\blabel:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 14, `expected the filter defs to be found, got ${labels.length}`);
  const missing = [...new Set(labels)].filter((l) => !es[`${l}: All`]);
  assert.deepStrictEqual(missing, [],
    `these filters render "<label>: All" with no Spanish for it: ${missing.join(", ")}`);
}

console.log("3) the base label is translated too, or the option would be half Spanish");
{
  const labels = [...new Set([...src.matchAll(/\blabel:\s*"([^"]+)"/g)].map((m) => m[1]))];
  const missing = labels.filter((l) => !es[l]);
  assert.deepStrictEqual(missing, [], `filter labels with no Spanish: ${missing.join(", ")}`);
}

// Spanish agrees in gender. "Propiedad: Todos" is the kind of thing that reads
// as machine translation to the people the page was translated for.
console.log("4) the All option agrees in gender");
{
  assert.equal(es["Property: All"], "Propiedad: Todas");
  assert.equal(es["Category: All"], "Categoría: Todas");
  assert.equal(es["Condition: All"], "Condición: Todas");
  assert.equal(es["Status: All"], "Estado: Todos");
  assert.equal(es["Type: All"], "Tipo: Todos");
  assert.equal(es["Review Status: All"], "Estado de Revisión: Todos");
}

console.log("5) the four property headers that were absent");
for (const k of ["Address", "Bed/Bath", "Nightly Rate", "Bookings"]) {
  assert.ok(es[k], `${k} is a column header and has no Spanish`);
}

// GHL stores these lowercase and unnormalised, and they reach the page as they
// are. The capitalised reservation statuses were already translated, which is
// how one table came to show "Nueva" and "active" side by side.
console.log("6) status values as GHL actually stores them");
for (const k of ["active", "inactive", "paid", "refunded"]) {
  assert.ok(es[k], `${k} is a value shown in a table and has no Spanish`);
}

// A number inside a sentence makes the whole node unmatchable. The counter now
// renders the figure in its own span so the word beside it can be looked up.
console.log("7) the record counter keeps its number out of the translated word");
{
  const fn = src.slice(src.indexOf("function table("), src.indexOf("function emptyRow("));
  // The number has to be inside its own element. That is what splits the text
  // node, which is the whole mechanism -- "5 records" as one node matches
  // nothing, while a span around the 5 leaves "records" alone to be looked up.
  // Wrapping the WORD as well changes nothing and was removed.
  assert.ok(fn.includes("<span>${count}</span>"),
    "the count must be wrapped, or the word beside it is unmatchable");
  assert.ok(es["records"] && es["record"], "both forms are needed -- Spanish pluralises too");
}

// A multi-line template literal carries its own indentation inside the text
// node, so the key would have to reproduce that whitespace exactly.
console.log("8) translated prose is on one source line");
{
  for (const key of Object.keys(es)) {
    if (key.length < 60) continue;
    assert.ok(!key.includes("\n"), `this key spans lines and will never match a text node: ${key.slice(0, 50)}…`);
  }
}


// A figure interpolated mid-sentence makes the whole node match nothing. The
// manager statement carried one in English on an otherwise Spanish page
// (Yari, 2026-10-16): "Deducted from owner payouts was recorded as RD$365.00,
// converted at the rate stored on each expense."
console.log("9) prose in the statements keeps its figures out of the sentence");
{
  // The whole panel, render function included -- the offending line lives
  // INSIDE renderManagerStatement, so a slice ending at its declaration
  // scanned none of the markup and passed against the very string it was
  // written for.
  const manager = src.slice(src.indexOf("// --- manager statement"), src.indexOf("function renderStatementSection"));
  const offenders = [...manager.matchAll(/>([A-Z][^<>{}]{10,}\$\{[^}]+\}[^<>]{10,})</g)].map((m) => m[1]);
  assert.deepStrictEqual(offenders, [],
    "these sentences interpolate a value and can never be translated: " + offenders.join(" | "));

  for (const k of [
    "Deducted from owner payouts was recorded as",
    ", converted at the rate stored on each expense.",
  ]) {
    assert.ok(es[k], `the manager statement renders "${k}" and it has no Spanish`);
  }
}

console.log("\nPASS — the filter options are generated from their labels, so the next filter is translated too.");
