// Every row is readable on a phone.
// Run: node test-phone-layout.mjs
//
// Measured on a 375px viewport before this: a Properties row showed 36% of
// itself and the other 64% sat behind a sideways scroll that nothing
// advertised. Transactions 38%, Expenses 42%. The tab strip is 1206px wide and
// hid 831 of them, so most tabs could not be reached at all.
//
// The fix is one helper and one block of CSS, which is why this file is small:
// labelCells() puts each column's name on its own cell, and the stylesheet
// turns the row into a card. Doing it in the twelve row builders instead would
// have been twelve chances to forget, and a thirteenth the next time somebody
// adds a column.
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const APP = fs.readFileSync("./public/app.js", "utf8");
const CSS = fs.readFileSync("./public/styles.css", "utf8");

// app.js top-level `const`s are lexical, so they are reachable only by running
// code inside the same context.
const sandbox = {
  document: { body: {}, documentElement: { style: { setProperty() {} } }, querySelector: () => null,
              querySelectorAll: () => [], addEventListener() {}, createTreeWalker: () => ({ nextNode: () => null }) },
  location: { search: "" }, URLSearchParams, NodeFilter: { SHOW_TEXT: 4 },
  MutationObserver: class { observe() {} }, console, navigator: { language: "en" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  window: {}, fetch: async () => ({ ok: true, json: async () => ({}) }), setTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(APP, sandbox);
const run = (code) => vm.runInContext(code, sandbox);

// ---- 1. each cell carries its column's name -------------------------
{
  const out = run(`labelCells('<tr><td>Casa Bonita</td><td>$135.00</td><td>4</td></tr>', ["Name", "Nightly Rate", "Bookings"])`);
  assert.match(out, /<td data-label="Name">Casa Bonita</);
  assert.match(out, /<td data-label="Nightly Rate">\$135\.00</);
  assert.match(out, /<td data-label="Bookings">4</);
  console.log("1) Each cell carries its own column name, in order");
}

// ---- 1b. and table() actually calls it ------------------------------
// Case 1 proves the helper. Deleting the call from table() passes it, and every
// table in the app goes back to being unreadable on a phone -- which is the
// whole defect, untouched. Asserted through the thing the panels actually use.
{
  const out = run(`table(["Name", "Amount"], '<tr><td>Casa Bonita</td><td>$135.00</td></tr>', 1)`);
  assert.match(out, /<td data-label="Name">Casa Bonita</, "a table built the normal way carries labels");
  assert.match(out, /<td data-label="Amount">\$135\.00</);
  assert.match(out, /<th>Name<\/th>/, "and still has its header row for wider screens");
  console.log("1b) table() labels the rows it builds, which is where every panel gets one");
}

// ---- 2. attributes already on the cell survive ----------------------
// Several row builders set a class or a colspan. Replacing "<td" rather than
// the whole tag is what keeps those, and it is the easy thing to get wrong.
{
  const out = run(`labelCells('<tr><td class="n">1</td><td data-id="x">2</td></tr>', ["A", "B"])`);
  assert.match(out, /<td data-label="A" class="n">1</);
  assert.match(out, /<td data-label="B" data-id="x">2</);
  console.log("2) Classes and other attributes already on a cell are kept");
}

// ---- 3. several rows each start their own numbering -----------------
// The counter has to reset per row. Without that, row two's first cell is
// labelled with row one's last column and everything after it is blank.
{
  const out = run(`labelCells('<tr><td>a1</td><td>a2</td></tr><tr><td>b1</td><td>b2</td></tr>', ["One", "Two"])`);
  assert.strictEqual((out.match(/data-label="One"/g) || []).length, 2);
  assert.strictEqual((out.match(/data-label="Two"/g) || []).length, 2);
  assert.match(out, /<td data-label="One">b1</, "the second row starts again at the first column");
  console.log("3) Every row starts its labels again at the first column");
}

// ---- 4. the empty-state row is left alone ---------------------------
// It spans every column and belongs to none of them, so labelling it would
// print a column name beside "No expenses yet".
{
  const out = run(`labelCells('<tr class="empty-row"><td colspan="9">No properties yet</td></tr>', ["Name", "Owner"])`);
  assert.ok(!/data-label/.test(out), "an empty-state row gets no label");
  assert.match(out, /colspan="9"/);
  console.log("4) The empty-state row is left exactly as it was");
}

// ---- 5. a header is a label, not markup -----------------------------
{
  const withTags = run(`labelCells('<tr><td>7</td></tr>', ['<span class="n">Count</span>'])`);
  assert.match(withTags, /data-label="Count"/, "tags are stripped, not rendered inside an attribute");

  const quoted = run(`labelCells('<tr><td>x</td></tr>', ['Owner "primary"'])`);
  assert.ok(!/data-label="Owner "primary""/.test(quoted), "a quote in a header does not break out of the attribute");

  // More cells than headers: label what is known, leave the rest bare rather
  // than printing "undefined" down the side of a card.
  const extra = run(`labelCells('<tr><td>a</td><td>b</td></tr>', ["Only"])`);
  assert.match(extra, /<td data-label="Only">a</);
  assert.match(extra, /<td>b</);
  assert.ok(!/undefined/.test(extra));
  console.log("5) Headers are stripped of markup, escaped, and never invent a label they do not have");
}

// ---- 6. the stylesheet turns those labels into cards -----------------
// The helper alone changes nothing a reader sees.
{
  const phone = CSS.slice(CSS.indexOf("@media (max-width: 600px)"));
  assert.ok(phone, "there is a phone breakpoint");
  assert.match(phone, /thead\s*\{\s*display:\s*none/, "the header row is dropped");
  assert.match(phone, /td::before\s*\{[\s\S]*content:\s*attr\(data-label\)/, "and reappears beside each value");
  assert.match(phone, /tbody tr\s*\{[\s\S]*border/, "rows read as cards");

  // The statement is a document and keeps its columns -- a two-column sheet
  // does not become clearer as a stack of cards.
  // Written as comma-pairs with .stmt-doc, so the rule is matched by what it
  // targets rather than by assuming a selector sits alone.
  assert.match(phone, /\.statement-sheet td::before[^{]*\{[^}]*content:\s*none/);
  assert.match(phone, /\.statement-sheet table[^{]*\{[^}]*display:\s*table/);
  console.log("6) The stylesheet turns the labels into cards, and leaves the statement a document");
}

// ---- 7. the tab strip can be reached and the page is not moved ------
{
  // Comments stripped: the block carries a comment explaining why it does NOT
  // use scrollIntoView, and a check for the absence of a word finds it in the
  // sentence saying so.
  const showTab = APP.slice(APP.indexOf("function showTab")).replace(/^\s*\/\/.*$/gm, "");
  const body = showTab.slice(0, showTab.indexOf("\n}"));
  assert.match(body, /\.tabs/, "it scrolls the strip");
  assert.match(body, /scrollTo/);
  assert.ok(!/scrollIntoView/.test(body),
    "not scrollIntoView, which also scrolls ancestors and would move the page under the reader");
  assert.match(body, /behavior:\s*"auto"/,
    "and instantly: a smooth scroll on this strip is cancelled by its own scroll-snapping and settles back at 0");
  assert.match(body, /scrollWidth > strip\.clientWidth/, "and does nothing at all when the strip already fits");

  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 700px)"));
  assert.match(mobile, /\.tabs\s*\{[\s\S]*overflow-x:\s*auto/);
  // The unprefixed property specifically: -webkit-mask-image alone going missing
  // changes nothing on a browser made this decade, so matching either would be
  // matching nothing worth matching.
  assert.match(mobile, /\n\s*mask-image:/, "with a fade, so a strip that continues does not read as one that ended");
  assert.match(mobile, /min-height:\s*44px/, "and targets a thumb can hit");
  console.log("7) The tab strip scrolls to the chosen tab without moving the page, and advertises that it scrolls");
}

console.log("\nPASS — a row is readable on a phone, and every tab can be reached.");
