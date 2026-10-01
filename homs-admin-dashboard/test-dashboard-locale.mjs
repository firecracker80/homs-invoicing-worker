// The dashboard renders in the account's language.
// Run: node test-dashboard-locale.mjs
//
// Yari, 2026-09-30, the night before the conference: "i will have the dashboard
// open on display it is a key feature." Its audience is Dominican and every
// string in it was English.
//
// This loads the REAL public/app.js in a stub DOM and calls the real localize(),
// rather than testing a copy of the dictionary. The repo has no dependencies and
// no jsdom, so the DOM here is hand-rolled -- only the handful of APIs localize()
// actually touches, which is the point: if it starts touching more, this breaks
// loudly instead of silently passing.
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

// ---- the smallest DOM that localize() can run against ----------------
class Text {
  constructor(v) { this.nodeValue = v; this.children = []; this.attrs = {}; }
}
class El {
  constructor(tag, attrs = {}) { this.tagName = tag; this.attrs = attrs; this.children = []; this.nodeValue = null; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelectorAll() { // only ever called as "[placeholder],[title]"
    const out = [];
    (function walk(n) {
      if (n.tagName && ("placeholder" in n.attrs || "title" in n.attrs)) out.push(n);
      n.children.forEach(walk);
    })(this);
    return out;
  }
}
const textNodesOf = (root) => {
  const out = [];
  (function walk(n) { if (n instanceof Text) out.push(n); n.children.forEach(walk); })(root);
  return out;
};

function makeDocument(body) {
  return {
    body,
    documentElement: { lang: "en", style: { setProperty() {} } },
    createTreeWalker(root) {
      const nodes = textNodesOf(root);
      let i = -1;
      return { currentNode: null, nextNode() { i += 1; this.currentNode = nodes[i]; return i < nodes.length ? nodes[i] : null; } };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
}

// ---- load the real app.js --------------------------------------------
const src = fs.readFileSync("./public/app.js", "utf8");
function loadApp(search, body) {
  const document = makeDocument(body);
  const sandbox = {
    document,
    location: { search },
    URLSearchParams,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} },
    console,
    navigator: { language: "en" },
    window: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // Top-level `let LOCALE` is a lexical binding, not a property of the sandbox,
  // so it can only be set by running code inside the same context.
  sandbox.setLocale = (l) => vm.runInContext(`LOCALE = ${JSON.stringify(l)}; localize();`, sandbox);
  return sandbox;
}

const page = () => {
  const root = new El("body");
  const h = (tag, text, attrs) => { const e = new El(tag, attrs); if (text !== null) e.children.push(new Text(text)); root.children.push(e); return e; };
  h("button", "Overview");
  h("button", "Owner Statement");
  h("button", "Refresh");
  h("h2", "Profit & Loss");
  h("th", "Gross revenue");
  h("th", "Net revenue");
  h("span", "Needs Review");
  h("td", "Casa Bonita");                       // data, must survive untouched
  h("td", "$1234.56");                          // a number, must survive untouched
  // Free text a user typed, which CONTAINS dictionary keys. The expense
  // Description field is open text ("e.g. Pest control"), so this is ordinary
  // content, not a contrived case -- and it is what a substring match would
  // quietly mangle into half-Spanish.
  h("td", "Paid on site, cash");                // contains "Paid on" and "Paid"
  h("td", "Pending inspection by Vendor");      // contains "Pending" and "Vendor"
  h("td", "Revenue share agreed with owner");   // contains "Revenue"
  h("p", "No checklists yet");
  h("input", null, { placeholder: "Search by name, property, booking ID, cleaner, transaction, OTA channel..." });
  return root;
};

const textsOf = (root) => textNodesOf(root).map((n) => n.nodeValue.trim());

// ---- 1. an account that says nothing stays English -------------------
// Every tenant except DEMO-HOMS. This path must not even walk the DOM.
{
  const body = page();
  const app = loadApp("", body);
  assert.strictEqual(app.resolveLocale(null), "en");
  app.setLocale("en");
  assert.ok(textsOf(body).includes("Overview"), "English is left exactly as it was");
  assert.ok(textsOf(body).includes("Profit & Loss"));
  console.log("1) An account with no locale set renders English, untouched");
}

// ---- 2. the account's own setting switches it ------------------------
// DEMO-HOMS already carries statementLocale "es" from the statement work, so
// this needs no GHL change and no new link.
{
  const body = page();
  const app = loadApp("", body);
  app.setLocale(app.resolveLocale("es"));
  const t = textsOf(body);
  assert.ok(t.includes("Resumen"), "the tab");
  assert.ok(t.includes("Estado de Cuenta del Propietario"));
  assert.ok(t.includes("Estado de Resultados"), "the P&L heading");
  assert.ok(t.includes("Ingresos brutos") && t.includes("Ingresos netos"), "the column headers");
  assert.ok(t.includes("Requiere Revisión"), "the status badge");
  assert.ok(t.includes("Aún no hay listas"), "the empty state");
  assert.strictEqual(app.document.documentElement.lang, "es", "and the document declares it");
  console.log("2) statementLocale es switches the whole page, with no link change");
}

// ---- 3. the data is never translated --------------------------------
// The failure that would matter most: this walks text nodes, and a property
// name or an amount sitting in one must come out the other side identical.
{
  const body = page();
  const app = loadApp("", body);
  app.setLocale("es");
  const t = textsOf(body);
  assert.ok(t.includes("Casa Bonita"), "a property name is data, not a label");
  assert.ok(t.includes("$1234.56"), "and so is an amount -- untouched, same separators");

  // Only whole-string matches translate. A substring match would turn
  // "Paid on site, cash" into "Fecha de pago site, cash" -- visibly broken, on
  // a client's own data, on a screen being presented from.
  assert.ok(t.includes("Paid on site, cash"), "free text containing a label is not partially translated");
  assert.ok(t.includes("Pending inspection by Vendor"));
  assert.ok(t.includes("Revenue share agreed with owner"));
  console.log("3) Property names, amounts and free text containing labels all pass through untranslated");
}

// ---- 4. nothing English is left behind ------------------------------
// Half a translation looks broken rather than foreign, which is worse on a
// screen somebody is presenting from.
{
  const body = page();
  const app = loadApp("", body);
  app.setLocale("es");
  const t = textsOf(body);
  for (const leak of ["Overview", "Owner Statement", "Refresh", "Profit & Loss", "Gross revenue", "Needs Review", "No checklists yet"]) {
    assert.ok(!t.includes(leak), `"${leak}" is still in English`);
  }
  const input = body.children.find((c) => c.tagName === "input");
  assert.ok(input.getAttribute("placeholder").startsWith("Buscar por"), "the search placeholder too");
  console.log("4) No English label survives on a Spanish page, placeholders included");
}

// ---- 5. ?lang= overrides, and nonsense falls back -------------------
{
  const app = loadApp("?lang=es", page());
  assert.strictEqual(app.resolveLocale(null), "es", "the link wins with no tenant setting");
  assert.strictEqual(app.resolveLocale("en-US"), "es", "and over an English tenant");

  const plain = loadApp("", page());
  for (const v of ["es", "ES", "es-DO", "Español", "spanish"]) assert.strictEqual(plain.resolveLocale(v), "es", v);
  for (const v of ["en-US", "English", "fr", "{{custom_values.wlang}}", "", null]) assert.strictEqual(plain.resolveLocale(v), "en", String(v));
  console.log("5) ?lang= overrides the account; an unknown locale falls back to English");
}

// ---- 6. the dashboard and the statement agree -----------------------
// One account setting must not produce a Spanish statement and an English
// dashboard. Both resolvers are asserted against the same inputs.
{
  const { resolveLocale: statementResolve } = await import("../src/reports.js");
  const app = loadApp("", page());
  for (const v of ["es", "ES", "es-DO", "Español", "spanish", "en-US", "English", "fr", ""]) {
    const viaStatement = statementResolve({ searchParams: new URLSearchParams("") }, { statementLocale: v });
    assert.strictEqual(app.resolveLocale(v), viaStatement, `the two disagree on ${JSON.stringify(v)}`);
  }
  console.log("6) The dashboard and the statement resolve every locale identically");
}

console.log("\nPASS — the dashboard renders in the account's language, and the data in none.");
