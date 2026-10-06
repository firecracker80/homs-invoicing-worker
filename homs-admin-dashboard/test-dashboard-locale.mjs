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
// Writes are counted, not just outcomes. localize() runs from a
// MutationObserver, and in a real browser assigning a text node the value it
// already holds still fires a characterData record -- so a pass that "changes
// nothing" but writes anyway feeds the observer and never terminates. Asserting
// the final text is identical cannot see that; only counting writes can.
let TEXT_WRITES = 0;
let ATTR_WRITES = 0;
class Text {
  constructor(v) { this._v = v; this.children = []; this.attrs = {}; }
  get nodeValue() { return this._v; }
  set nodeValue(v) { TEXT_WRITES += 1; this._v = v; }
}
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag; this.attrs = attrs; this.children = []; this.nodeValue = null;
    this.dataset = {};
    // Only what paintLangToggle touches. If it starts needing more, this breaks
    // loudly rather than quietly passing.
    this.classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    this.classList = {
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      contains: (c) => this.classes.has(c),
    };
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { ATTR_WRITES += 1; this.attrs[k] = v; }
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
    // loadData writes to #fetchedAt and #loading without a null check, so this
    // has to hand back a usable element rather than null, or the function dies
    // before reaching the line being tested. Cached by selector, so what a
    // render writes into a panel can be read back out again.
    querySelector(sel) {
      if (!this._bySel) this._bySel = new Map();
      if (!this._bySel.has(sel)) this._bySel.set(sel, new El("div"));
      return this._bySel.get(sel);
    },
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
    // getLocationId caches the id here; without it loadData throws before it
    // reaches anything this test is about.
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    window: {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // Top-level `let LOCALE` is a lexical binding, not a property of the sandbox,
  // so it can only be set by running code inside the same context.
  sandbox.vmEval = (code) => vm.runInContext(code, sandbox);
  // Renders at a locale outright, which is what the tests below it mean. NOT
  // the app's own setLocale(): that is a real function now and has its own
  // tests, and overwriting it here would hide them.
  sandbox.forceLocale = (l) => vm.runInContext(`LOCALE = ${JSON.stringify(l)}; localize();`, sandbox);
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
  app.forceLocale("en");
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
  app.forceLocale(app.resolveLocale("es"));
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
  app.forceLocale("es");
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
  app.forceLocale("es");
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

// ---- 7. the two strings the DOM walker cannot reach ---------------
// "Updated" is concatenated with a timestamp in JS, so no text node ever holds
// it on its own. The search placeholder is rewritten at load time to drop
// ", OTA channel" on every account that does not show that tab -- which is all
// of them -- so the string actually on screen never matched the dictionary key,
// which held the full version. Both were still English on the live dashboard.
{
  const app = loadApp("", page());
  app.forceLocale("es");
  assert.strictEqual(app.vmEval(JSON.stringify("Updated").replace(/^/, "tr(").replace(/$/, ")")), "Actualizado",
    "the header timestamp label, built in JS and unreachable by the walker");
  assert.strictEqual(app.vmEval("tr(\"Refresh\")"), "Actualizar");

  const body = page();
  const stripped = new El("input", {
    placeholder: "Search by name, property, booking ID, cleaner, transaction...",
  });
  body.children.push(stripped);
  const app2 = loadApp("", body);
  app2.forceLocale("es");
  assert.ok(stripped.getAttribute("placeholder").startsWith("Buscar por"),
    "the OTA-stripped placeholder is the one actually displayed, so it has to translate too");
  console.log("7) The header timestamp and the OTA-stripped search placeholder both translate");
}

// ---- 8. the statement panel starts in the account language --------
// That panel is a separate bilingual implementation -- its own string table,
// its own t(), and an EN/ES toggle a viewer can click. It was already complete
// in Spanish and simply defaulted to English, so a Spanish account opened it in
// English and had to be switched by hand every time.
//
// This runs the REAL loadData against a stubbed /api/data. Asserting that the
// binding is merely writable is not enough: deleting the assignment outright
// passed that version of this test. The only thing that proves it is loading an
// account and reading what the panel ended up set to.
//
// It also covers a hazard that would be worse than English. The assignment sits
// roughly 1300 lines ABOVE the `let statementState` that declares it, so it is
// only legal because loadData runs after the script has finished evaluating. If
// that ever stopped being true it would throw on the temporal dead zone and
// take the whole dashboard down.
{
  const withAccount = async (statementLocale) => {
    const app = loadApp("?locationId=L1", page());
    app.fetch = async () => ({
      ok: true,
      json: async () => ({
        statementLocale, branding: {}, fetchedAt: "2026-10-01T03:00:00.000Z",
        tenantLabel: "DEMO", properties: [], transactions: [], expenses: [],
        otaChannels: [], checklists: [], inventory: [], contacts: [],
      }),
    });
    await app.vmEval("loadData()");
    return app.vmEval("statementState.lang");
  };

  // Before any account loads -- and on an account whose data call fails -- the
  // panel shows this. It must not guess Spanish for an English client.
  assert.strictEqual(loadApp("", page()).vmEval("statementState.lang"), "en",
    "the pre-load default stays English, which is what a failed load leaves on screen");

  assert.strictEqual(await withAccount("es"), "es",
    "a Spanish account opens the statement panel in Spanish, without the viewer clicking ES");
  assert.strictEqual(await withAccount("en-US"), "en", "an English account is unaffected");
  assert.strictEqual(await withAccount(null), "en", "and so is one that sets nothing");
  console.log("8) Loading a Spanish account opens the statement panel in Spanish");
}

// ---- 9. every label the manager panel emits is translatable --------
// The panel renders English and lets localize() swap it, which only works on
// WHOLE text nodes. A number interpolated mid-sentence makes that sentence
// match nothing and silently stay English -- which is how the P&L note and the
// warning lines were originally written, and why they are now built with the
// figure outside the sentence.
//
// So rather than checking a handful of strings by hand, this renders the panel
// and asserts that every piece of prose in it is a dictionary key. A label
// added later without a translation fails here instead of on Yari's screen.
{
  const app = loadApp("?locationId=L1", page());

  // Give it a payload shaped like the Worker's, with every optional block
  // populated so no branch of the template goes unrendered.
  app.vmEval(`
    DATA = { transactions: [{ checkinDate: "2026-09-04" }], expenses: [{ paidOn: "2026-09-10" }] };
    managerPl = {
      month: "2026-09", loading: false, error: null,
      data: {
        currency: "USD", income: 1380.17, expenses: 100, net: 1280.17, reimbursableOutstanding: 215,
        mixedIncomeCurrency: true,
        byCategory: [{ category: "pest_control", label: "Pest Control", total: 35, count: 1 }],
        // Each exclusion reason, so the sweep below covers the phrase each one
        // emits. With a bare { id } none of those branches render and the sweep
        // silently checks nothing -- which is how they shipped untranslated.
        excluded: [
          { id: "e1", name: "Nevera Taller", issues: ["not_approved"] },
          { id: "e2", name: "Ferretería Central", issues: ["unconverted_currency"] },
          { id: "e3", name: "Sin Monto", issues: ["no_amount"] },
        ],
        undated: [{ id: "e2" }],
        ownerPayouts: {
          owners: [
            { name: "Carlos Mendoza", owed: 4972.08, entries: 36, mixedCurrency: false, currency: "USD" },
            { name: "Elena Marchetti", owed: 157.25, entries: 3, mixedCurrency: false, currency: "USD" },
          ],
          total: 5129.33,
          unattributed: { owed: 88, entries: 2 },
        },
        cleaning: {
          collected: 475, paidToCleaners: 100, margin: 375, jobsCounted: 2,
          byTurnover: [{ turnover: "deep_clean", label: "Deep Clean", total: 90, count: 1 }],
          jobsWithoutCost: [{ id: "j1" }], unpaidCleaners: 35, unpaidCleanerJobs: 1,
        },
      },
    };
    renderManagerStatement();
    __html = $("#panel-managerstmt").innerHTML;
  `);
  const html = app.vmEval("__html");
  assert.ok(html && html.length > 200, "the panel rendered something");

  // The figures, which must NOT be translated.
  assert.ok(html.includes("US$1280.17"), "the net is on the page");
  assert.ok(html.includes("US$375.00"), "and what was kept on cleaning");

  // Every warning fired, so none of their phrasing goes unchecked.
  assert.ok(html.includes("no cleaner cost recorded"), "uncosted cleans are warned about");
  assert.ok(html.includes("is owed to cleaners"), "so are unpaid cleaners");
  assert.ok(html.includes("is not attributed to any owner"), "and so is an unattributed payout");
  assert.ok(html.includes("Carlos Mendoza") && html.includes("US$4972.08"), "each owner and what they are owed");
  assert.ok(html.includes("pay through your own payout method"),
    "and that the account holder pays them, not this system");

  const dict = app.vmEval("JSON.stringify(Object.keys(I18N.es))");
  const keys = new Set(JSON.parse(dict));

  const prose = [...html.matchAll(/>([^<>]+)</g)]
    .map((mm) => mm[1].trim())
    // Data, numbers and punctuation are not labels and are never translated.
    .filter((s) => /[A-Za-z]{3}/.test(s))
    .filter((s) => !/^(US\$|\(US\$|RD\$|€)/.test(s))
    .filter((s) => !["Pest Control", "Deep Clean", "September 2026", "DEMO",
                      "Carlos Mendoza", "Elena Marchetti",
                      // Expense names are the client's own data. They appear in
                      // the warnings and must NEVER be translated.
                      "Nevera Taller", "Ferretería Central", "Sin Monto",
                      "Nevera Taller, Ferretería Central, Sin Monto"].includes(s));

  const untranslatable = [...new Set(prose)].filter((s) => !keys.has(s));
  assert.deepStrictEqual(untranslatable, [],
    `these would stay English on a Spanish page: ${JSON.stringify(untranslatable)}`);
  assert.ok(prose.length >= 12, "and there was real prose to check, not an empty panel");
  console.log(`9) All ${new Set(prose).size} labels in the manager panel are dictionary keys, so none can stay English`);
}

// ---- 10. switching back restores English exactly --------------------
// Yari, 2026-10-05: "the dashboard did not change back to english once the
// language switched back to english."
//
// The first version of localize() only went one way. Re-rendered panels came
// back English on their own because they are rebuilt through tr(), but the
// static shell -- tabs, header, search box -- is never rebuilt, so it stayed
// Spanish until a full page reload. With a toggle on the page that is the
// second click, so the round trip is the feature, not an edge case.
{
  const body = page();
  const app = loadApp("", body);
  const input = body.children.find((c) => c.tagName === "input");

  const before = textsOf(body);
  const placeholderBefore = input.getAttribute("placeholder");

  app.setLocale("es");
  assert.ok(textsOf(body).includes("Resumen"), "switched to Spanish");

  app.setLocale("en");
  assert.deepStrictEqual(textsOf(body), before,
    "every text node is back to the English it started as, in the same order");
  assert.strictEqual(input.getAttribute("placeholder"), placeholderBefore,
    "including the search placeholder, which is an attribute and not a text node");
  assert.strictEqual(app.document.documentElement.lang, "en", "and the document says so again");

  // And it is not a one-shot: a second round trip has to work too, which is
  // what rules out a restore that consumes its own record.
  app.setLocale("es");
  assert.ok(textsOf(body).includes("Resumen"), "and it can go back to Spanish again");
  app.setLocale("en");
  assert.deepStrictEqual(textsOf(body), before, "and back to English again");
  console.log("10) Switching to Spanish and back restores English exactly, repeatably");
}

// ---- 11. a viewer's own pick survives the next visit ----------------
// The dashboard is left open on a display, and whoever reads it may not be the
// person the account was configured for. A pick made from the toggle is that
// person's, so it outranks the account default -- but not a ?lang= link, which
// is an explicit instruction for the view being opened right now.
{
  const app = loadApp("", page());
  assert.strictEqual(app.resolveLocale("en-US"), "en", "nothing stored yet, the account decides");

  app.setLocale("es");
  assert.strictEqual(app.resolveLocale("en-US"), "es",
    "once picked, it outranks an English account on the next load");
  assert.strictEqual(app.resolveLocale(null), "es");

  app.setLocale("en");
  assert.strictEqual(app.resolveLocale("es"), "en",
    "and picking English outranks a Spanish account, which is the case that matters");

  // A stored pick is per browser, so it must not leak into a fresh one.
  assert.strictEqual(loadApp("", page()).resolveLocale("es"), "es",
    "another browser is unaffected and still follows the account");

  // The link still wins, or a statement sent to one owner in their language
  // would open in whatever the sender's browser happened to remember.
  //
  // The stored pick has to be the OPPOSITE of the link for this to mean
  // anything, and it has to be stored for real: setLocale returns early when
  // asked for the language the page is already in, so going out to Spanish
  // first is what makes the second call write "en".
  const linked = loadApp("?lang=es", page());
  linked.setLocale("es");
  linked.setLocale("en");
  assert.strictEqual(linked.vmEval("localStorage.getItem(\"homs_lang\")"), "en",
    "English really is the stored pick, so the next line is a contest and not a coincidence");
  assert.strictEqual(linked.resolveLocale("en-US"), "es", "?lang= outranks a stored pick");
  console.log("11) A pick from the toggle sticks for that browser, and ?lang= still outranks it");
}

// ---- 12. the toggle is wired to the page, not to the statement ------
// The owner statement has its own EN/ES, which changes THAT STATEMENT and not
// the page -- that is how Elena's statement gets printed in Spanish while the
// manager works in English. The two must not share a class, or printing one
// statement in Spanish would flip the whole dashboard.
{
  const html = fs.readFileSync("./public/index.html", "utf8");
  assert.match(html, /id="langToggle"/, "the toggle is in the topbar markup");
  assert.match(html, /class="btn ui-lang-btn active" data-lang="en"/);
  assert.match(html, /data-lang="es"/);

  const app = loadApp("", page());
  const src = fs.readFileSync("./public/app.js", "utf8");
  assert.ok(src.includes('closest(".ui-lang-btn")'), "its handler is scoped to its own class");
  assert.ok(src.includes('closest(".lang-btn")'),
    "and the statement's own switch is still handled separately");
  // .ui-lang-btn must not be matchable as .lang-btn, which is why the name is
  // a separate class rather than an extra one on the same buttons.
  //
  // Token-exact on purpose. A /\blang-btn\b/ test also matches INSIDE
  // "ui-lang-btn" -- the very string being allowed here -- so it would have
  // passed whatever the markup said.
  const classTokens = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].trim().split(/\s+/));
  assert.ok(!classTokens.includes("lang-btn"),
    "the topbar buttons do not also carry .lang-btn, which would trigger both handlers");

  // paintLangToggle shows the language the page is in, not the button clicked.
  const buttons = [new El("button", { class: "btn ui-lang-btn active" }), new El("button", { class: "btn ui-lang-btn" })];
  buttons[0].dataset.lang = "en";
  buttons[1].dataset.lang = "es";
  app.document.querySelectorAll = (sel) => (sel === ".ui-lang-btn" ? buttons : []);
  app.setLocale("es");
  assert.ok(!buttons[0].classList.contains("active") && buttons[1].classList.contains("active"),
    "ES is lit after switching to Spanish");
  app.setLocale("en");
  assert.ok(buttons[0].classList.contains("active") && !buttons[1].classList.contains("active"),
    "and EN again after switching back");
  console.log("12) The topbar toggle has its own class and handler, and lights the active language");
}

// ---- 13. switching language does not refetch the manager figures ----
// The manager statement is the one panel whose numbers come from the invoicing
// Worker over the network. Re-rendering it is necessary -- its labels are built
// through tr() and cannot be swapped in the DOM -- but refetching is not: the
// figures are already in managerPl. Without this, every click on the toggle
// would blank the panel and wait on another Worker.
{
  const app = loadApp("", page());
  const PANELS = ["renderOverview", "renderProperties", "renderOta", "renderTransactions",
                  "renderChecklists", "renderExpenses", "renderInventory", "renderReports",
                  "renderStatement", "renderManagerStatement", "loadManagerPl"];
  // Each of those is a top-level function declaration, so it is a property of
  // the sandbox global and can be swapped for a recorder.
  app.vmEval('DATA = { kind: "client" }; __calls = []; ' +
    JSON.stringify(PANELS) + '.forEach((n) => { globalThis[n] = () => __calls.push(n); });');
  app.vmEval("renderAll(); __first = __calls.slice();");
  assert.ok(app.vmEval("__first").includes("loadManagerPl"),
    "a normal load still fetches the manager figures");

  app.vmEval("__calls = [];");
  app.setLocale("es");
  const onSwitch = app.vmEval("__calls");
  assert.ok(onSwitch.includes("renderManagerStatement"),
    "a language switch repaints the manager panel, so its labels change");
  assert.ok(!onSwitch.includes("loadManagerPl"),
    "but does not go back to the invoicing Worker for figures it already has");
  assert.ok(onSwitch.includes("renderOverview") && onSwitch.includes("renderExpenses"),
    "and every other panel is rebuilt, since their labels are built in JS too");
  console.log("13) A language switch rebuilds every panel without refetching the manager figures");
}

// ---- 14. the panel will not print a margin it cannot know -----------
// Yari, 2026-10-05: the cleaner's rate "will depend on what the client is
// paying his employee or cleaning service. we can't set that." So an empty
// cleaner cost is the ordinary case, not a defect.
//
// The panel used to render "Paid to cleaners (US$0.00) / Kept on cleaning
// US$475.00" from a period where nothing was costed -- a figure nobody had the
// information to state, printed as the manager's profit. The Worker now sends
// marginKnown / marginIsCeiling / netIsCeiling; this asserts the panel obeys
// them, because the flags change nothing on their own.
{
  const render = (cleaning, extra = {}) => {
    const app = loadApp("?locationId=L1", page());
    app.vmEval(`
      DATA = { transactions: [], expenses: [] };
      managerPl = { month: "2026-09", loading: false, error: null, data: ${JSON.stringify({
        currency: "USD", income: 1000, expenses: 0, net: 1000, reimbursableOutstanding: 0,
        byCategory: [], excluded: [], undated: [], mixedIncomeCurrency: false,
        cleaning, ...extra,
      })} };
      renderManagerStatement();
      __html = $("#panel-managerstmt").innerHTML;
    `);
    return app.vmEval("__html");
  };

  const base = { collected: 300, byTurnover: [], unpaidCleaners: 0, unpaidCleanerJobs: 0 };

  // Nothing costed: there is no margin to give.
  const unknown = render({
    ...base, paidToCleaners: 0, margin: 300, jobsCounted: 0, costMissing: 2,
    marginKnown: false, marginIsCeiling: false,
    jobsWithoutCost: [{ id: "n1" }, { id: "n2" }],
  }, { netIsCeiling: true });
  const cleaningBlock = unknown.slice(unknown.indexOf("Cleaning fees collected"));
  assert.ok(unknown.includes("US$300.00"), "the fee collected is known, so it is still shown");
  assert.ok(!cleaningBlock.includes("US$0.00"),
    "nothing claims zero went to cleaners -- that is the fabrication being removed");
  assert.strictEqual((cleaningBlock.match(/US\$300\.00/g) || []).length, 1,
    "and the fee is not restated as what the manager kept");
  assert.match(unknown, /cannot be worked out/, "the panel says why the figure is blank");
  assert.match(unknown, /Net \(at most\)/, "and the bottom line admits the same doubt");

  // Partly costed: a figure, bounded.
  const ceiling = render({
    ...base, paidToCleaners: 100, margin: 200, jobsCounted: 1, costMissing: 1,
    marginKnown: true, marginIsCeiling: true, jobsWithoutCost: [{ id: "n" }],
  }, { netIsCeiling: true });
  assert.match(ceiling, /Kept on cleaning \(at most\)/, "the figure is given, and bounded");
  assert.ok(ceiling.includes("US$200.00"), "with the arithmetic unchanged");
  assert.match(ceiling, /the real figure is lower/);

  // Fully costed: nothing is in doubt, so nothing is qualified. This is the
  // case that catches a fix applied unconditionally.
  const exact = render({
    ...base, paidToCleaners: 100, margin: 200, jobsCounted: 2, costMissing: 0,
    marginKnown: true, marginIsCeiling: false, jobsWithoutCost: [],
  });
  assert.ok(!exact.includes("(at most)"), "a complete period carries no hedging at all");
  assert.ok(!exact.includes("cannot be worked out"));
  assert.ok(exact.includes("US$200.00") && exact.includes("(US$100.00)"),
    "just the figures, stated plainly");

  // An older Worker, or a cached response from before this shipped, sends no
  // flags. Undefined must read as "fine" rather than blanking a real margin.
  const legacy = render({ ...base, paidToCleaners: 100, margin: 200, jobsCounted: 2, jobsWithoutCost: [] });
  assert.ok(legacy.includes("US$200.00"), "a response without the flags still shows its margin");
  assert.ok(!legacy.includes("(at most)"));
  console.log("14) The manager panel states an exact margin, bounds a partial one, and blanks an unknowable one");
}

// ---- 15. and it says all of that in Spanish -------------------------
{
  const app = loadApp("?locationId=L1", page());
  app.vmEval(`
    DATA = { transactions: [], expenses: [] };
    managerPl = { month: "2026-09", loading: false, error: null, data: {
      currency: "USD", income: 1000, expenses: 0, net: 1000, reimbursableOutstanding: 0,
      byCategory: [], excluded: [], undated: [], mixedIncomeCurrency: false, netIsCeiling: true,
      cleaning: { collected: 300, paidToCleaners: 0, margin: 300, jobsCounted: 0, costMissing: 2,
                  marginKnown: false, marginIsCeiling: false, byTurnover: [],
                  jobsWithoutCost: [{ id: "a" }, { id: "b" }], unpaidCleaners: 0, unpaidCleanerJobs: 0 },
    } };
    renderManagerStatement();
  `);
  app.forceLocale("es");
  const html = app.document.querySelector("#panel-managerstmt").innerHTML;

  // These are built in JS, so they are swapped by the DOM pass rather than by
  // tr() -- which means they only translate if they are dictionary keys. Test 9
  // enforces that for every label the panel emits; this checks the new ones
  // specifically, since they are the ones a reader sees only when something is
  // wrong and would be the easiest to leave English.
  const dict = JSON.parse(app.vmEval("JSON.stringify(Object.keys(I18N.es))"));
  for (const added of ["Kept on cleaning (at most)", "Net (at most)"]) {
    assert.ok(dict.includes(added), `"${added}" has no Spanish, so it would stay English`);
  }
  assert.ok(dict.some((k) => k.startsWith("No cleaner cost is recorded")),
    "and so would the explanation of why the figure is blank");
  assert.ok(dict.some((k) => k.startsWith("At most: cleans with no cleaner cost")),
    "and the note bounding the figure");
  console.log("15) Every string the unknown-margin case introduces has a Spanish translation");
}

// ---- 16. localize() settles, or the dashboard freezes ---------------
// Yari, 2026-10-05: "this has been stuck like this since 102 merged." The
// dashboard never got past "Loading live data from GHL…" on DEMO-HOMS, which
// resolves to Spanish.
//
// The toggle's reversible localize() keys off each node's stored English
// original, and an original ALWAYS matches the dictionary -- so every pass
// rewrote every translated node. In a browser that write fires a characterData
// record even when the value is identical, the observer fires, localize() runs
// again, and nothing ever paints. Measured on the live page: a second pass at
// the same locale wrote 29 records.
//
// The version before the toggle was accidentally safe -- it matched on current
// text, which stopped matching once translated. This asserts that property
// deliberately, by counting writes rather than comparing text: every earlier
// case here passed throughout the freeze, because the text was correct. It was
// correct and rewritten forever.
{
  const body = page();
  const app = loadApp("", body);

  TEXT_WRITES = 0; ATTR_WRITES = 0;
  app.forceLocale("es");
  assert.ok(TEXT_WRITES > 0, "the first pass really did translate something to rewrite");

  TEXT_WRITES = 0; ATTR_WRITES = 0;
  app.vmEval("localize()");
  assert.strictEqual(TEXT_WRITES, 0,
    "a second pass at the same locale writes NOTHING -- any write re-enters the observer");
  assert.strictEqual(ATTR_WRITES, 0, "and that goes for placeholders and titles too");

  // Ten passes, as the observer would do. Still nothing.
  for (let i = 0; i < 10; i += 1) app.vmEval("localize()");
  assert.strictEqual(TEXT_WRITES, 0, "and it stays settled however many times it runs");

  // The same has to hold after switching back, where every node is restored
  // from its record rather than translated -- a different branch, same hazard.
  app.setLocale("en");
  TEXT_WRITES = 0; ATTR_WRITES = 0;
  for (let i = 0; i < 5; i += 1) app.vmEval("localize()");
  assert.strictEqual(TEXT_WRITES, 0, "an English page settles too, having nothing to restore twice");
  assert.strictEqual(ATTR_WRITES, 0);

  // And the text is still right -- settling by doing nothing at all would also
  // pass the counts above.
  app.setLocale("es");
  assert.ok(textsOf(body).includes("Resumen"), "while still actually being translated");
  console.log("16) localize() settles after one pass, so it cannot drive the observer that calls it");
}

// ---- 17. the panel asks for the period its label promises -----------
// Yari, 2026-10-05: "the all-time is not reflecting the 215 dop from july."
//
// The dropdown's "All time" entry sent no date range at all, so the Worker
// applied its 30-day default and the panel hid every older record under a label
// saying otherwise. The Worker now understands period=all; this asserts the
// page actually asks for it, which is the half that was wrong.
{
  const app = loadApp("?locationId=L1", page());
  const asked = [];
  app.fetch = async (url) => { asked.push(String(url)); return { ok: true, json: async () => ({}) }; };

  app.vmEval("managerPl.month = null; loadManagerPl();");
  await new Promise((r) => setTimeout(r, 0));
  const allTimeCall = asked.find((u) => u.includes("/api/manager-pl"));
  assert.ok(allTimeCall, "it called the manager P&L route");
  assert.match(allTimeCall, /period=all/,
    "with no month selected it asks for all time, rather than leaving the Worker to default to 30 days");

  // A chosen month must NOT carry period=all, or picking September would still
  // return everything and the dropdown would do nothing at all.
  asked.length = 0;
  app.vmEval('managerPl.month = "2026-09"; loadManagerPl();');
  await new Promise((r) => setTimeout(r, 0));
  const monthCall = asked.find((u) => u.includes("/api/manager-pl"));
  assert.ok(!/period=all/.test(monthCall), "a chosen month is a real window, not all time");
  assert.match(monthCall, /from=2026-09-01/);
  assert.match(monthCall, /to=2026-09-30/, "and ends on the last day of that month, inclusive");
  console.log("17) All time asks the Worker for all time; a chosen month asks for that month");
}

// ---- 18. an excluded expense says WHY, and names itself --------------
// Yari, 2026-10-05, reading "3 expense(s) are left out of the total": "is it
// safe to assume that any expense in dop will be left out of the total? that
// doesn't make sense if we are converting to usd."
//
// A fair reading of a count that explains nothing, and the wrong one -- they
// were unapproved, not foreign. The Worker's own HTML page had broken it down
// by reason all along; this panel, the thing anybody actually opens, collapsed
// every reason into one number and threw the rest away. The payload carried the
// reason and the name the whole time.
{
  const render = (excluded) => {
    const app = loadApp("?locationId=L1", page());
    app.vmEval(`
      DATA = { transactions: [], expenses: [] };
      managerPl = { month: null, loading: false, error: null, data: ${JSON.stringify({
        currency: "USD", income: 1000, expenses: 0, net: 1000, reimbursableOutstanding: 0,
        byCategory: [], undated: [], mixedIncomeCurrency: false, excluded,
        cleaning: { collected: 0, paidToCleaners: 0, margin: 0, jobsCounted: 0, costMissing: 0,
                    marginKnown: true, marginIsCeiling: false, byTurnover: [], jobsWithoutCost: [],
                    unpaidCleaners: 0, unpaidCleanerJobs: 0 },
      })} };
      renderManagerStatement();
      __html = $("#panel-managerstmt").innerHTML;
    `);
    return { app, html: app.vmEval("__html") };
  };

  // Her actual case: three unapproved expenses, all in DOP.
  const { html } = render([
    { id: "a", name: "RL Santana Refrigeración", issues: ["not_approved"] },
    { id: "b", name: "Test Villa 1 - Carpet Wash", issues: ["not_approved"] },
    { id: "c", name: "Test Villa 1 - Pest Control", issues: ["not_approved"] },
  ]);
  assert.match(html, /Needs Review/, "the panel says what is actually wrong with them");
  assert.match(html, /RL Santana Refrigeraci/, "and which records, so they can be found and fixed");
  assert.match(html, /Carpet Wash/);
  assert.ok(!/another currency/.test(html),
    "and does not mention currency, which is what she was left to guess at");

  // The reasons are reported separately, not merged into one count.
  const mixed = render([
    { id: "a", name: "Unapproved One", issues: ["not_approved"] },
    { id: "b", name: "No Rate One", issues: ["unconverted_currency"] },
  ]).html;
  assert.match(mixed, /Needs Review/);
  assert.match(mixed, /another currency/);
  assert.match(mixed, /Unapproved One/);
  assert.match(mixed, /No Rate One/);

  // A reason this build has never heard of must still surface. Otherwise a new
  // exclusion added to the Worker disappears from the page that reads it.
  const future = render([{ id: "z", name: "Something New", issues: ["invented_later"] }]).html;
  assert.match(future, /left out of the total/,
    "an unrecognised reason still reports the expense rather than hiding it");
  assert.match(future, /Something New|1/);

  // Spanish. The stub DOM keeps innerHTML as a string rather than parsing it
  // into nodes, so localize() cannot walk this panel here -- which is why case 9
  // checks dictionary membership rather than translated output. Same approach:
  // prove each reason CAN translate, and that a record name is not a label.
  const { app: dictApp } = render([{ id: "a", name: "RL Santana Refrigeración", issues: ["not_approved"] }]);
  const keys = new Set(JSON.parse(dictApp.vmEval("JSON.stringify(Object.keys(I18N.es))")));
  for (const phrase of [
    'expense(s) still say "Needs Review" and are not in the total yet:',
    "expense(s) are in another currency with no converted amount, and converting them by guesswork would be a wrong number that looks right:",
    "expense(s) have no amount, so there is nothing to count:",
  ]) {
    assert.ok(keys.has(phrase), `no Spanish for: ${phrase.slice(0, 48)}…`);
  }
  assert.ok(!keys.has("RL Santana Refrigeración"),
    "an expense's own name is the client's data and must never be a dictionary key");
  console.log("18) An excluded expense is reported with its reason and its name, in either language");
}

console.log("\nPASS — the dashboard renders in the account's language, switches both ways, settles after one pass, translates no data, asks for the period it names, says why it left anything out, and states no figure it cannot know.");
