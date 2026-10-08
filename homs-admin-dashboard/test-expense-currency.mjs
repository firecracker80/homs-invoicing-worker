// An expense records which currency it is in, and converts if it has to.
// Run: node test-expense-currency.mjs
//
// handleCreateExpense never wrote the currency field. An untagged amount is
// read as the ACCOUNT's currency by both the dashboard (inAccountCurrency) and
// manager-pl.js, so a 16,246.63 peso bar tab entered on a USD account was
// counted as $16,246.63 -- about 59 times its real cost. Yari hit exactly that
// on 2026-10-08, the day after the form started accepting receipts.
//
// Writing the currency alone is not enough: manager-pl.js refuses a foreign
// record carrying no exchange rate, correctly, because adding pesos to dollars
// produces a number nobody can tell is wrong. So the rate is fetched and
// stored here, with the same helpers services.js uses for vendor invoices.
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const APP = fs.readFileSync("./public/app.js", "utf8");
const HTML = fs.readFileSync("./public/index.html", "utf8");
const SRC = fs.readFileSync("./src/index.js", "utf8");

const LOC = "ZghxU8I60bEm39JUbtCm";
const worker = (await import("./src/index.js")).default;

// ---- a Worker harness that records what reached GHL --------------------
let created, rateCalls, customValues, rateReply;
// The PIT is resolved from a NAMED secret on the Worker, not stored in KV.
const tenant = { label: "DEMO", kind: "client", ghlPitSecretName: "PIT_DEMO", currency: "USD" };

const env = {
  ADMIN_KEY: "k",
  PIT_DEMO: "pit",
  // getTenant asks for { type: "json" }, so the mock has to hand back the
  // OBJECT -- a JSON string makes tenant.ghlPitSecretName undefined and the
  // route 500s on a missing PIT.
  DASHBOARD_TENANTS: { get: async (k, o) => (o?.type === "json" ? tenant : JSON.stringify(tenant)) },
};

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });

  if (u.includes("/customValues")) return ok({ customValues });
  if (u.includes("/objects/custom_objects.expenses/records") && opts.method === "POST") {
    created = JSON.parse(opts.body).properties;
    return ok({ record: { id: "newrec1" } });
  }
  if (u.includes("/associations")) return ok({ associations: [] });
  // The FX provider. Recorded so the test can assert WHICH day was asked for.
  if (u.includes("frankfurter") || u.includes("exchangerate") || u.includes("fxrates") || /\d{4}-\d{2}-\d{2}/.test(u)) {
    rateCalls.push(u);
    return rateReply ? ok(rateReply) : { ok: false, status: 404, text: async () => "no" };
  }
  return ok({});
};

const post = async (body) => {
  created = undefined; rateCalls = [];
  const res = await worker.fetch(new Request("https://d.dev/api/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "homs_admin=k" },
    body: JSON.stringify({ locationId: LOC, ...body }),
  }), env);
  return { status: res.status, body: await res.json() };
};

// Deliberately in the past, and never derived from the clock.
const PAID_ON = "2026-03-14";
const base = { name: "Cerveceria", categoryKey: "miscellaneous", amount: "16246.63", paidBy: "manager", paidOn: PAID_ON };

// ---- 1. the currency is written at all --------------------------------
{
  customValues = [{ fieldKey: "custom_values.wcurrency", value: "DOP" }];
  rateReply = null;
  const out = await post({ ...base, currency: "dop" });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(created.currency, "dop",
    "nothing wrote this field before, so every expense entered here was untagged");
  assert.deepStrictEqual(created.amount, { value: 16246.63, currency: "default" });
  console.log("1) The expense records which currency it is in");
}

// ---- 2. same currency as the account: no conversion -------------------
// A DOP expense on a DOP account needs no rate, and inventing conversion
// fields for it would put a rate of 1 on every record for no reason.
{
  customValues = [{ fieldKey: "custom_values.wcurrency", value: "DOP" }];
  rateReply = null;
  const out = await post({ ...base, currency: "dop" });
  assert.strictEqual(created.currency, "dop");
  assert.ok(!("converted_amount" in created), "no conversion when there is nothing to convert");
  assert.ok(!("exchange_rate" in created));
  assert.strictEqual(rateCalls.length, 0, "and no rate is fetched");
  assert.strictEqual(out.body.conversion.applied, false);
  console.log("2) An expense already in the account's currency is not converted");
}

// ---- 3. foreign currency: converted, at the rate for the day paid -----
{
  customValues = [{ fieldKey: "custom_values.wcurrency", value: "USD" }];
  rateReply = { date: PAID_ON, dop: { usd: 0.0166 } };
  const out = await post({ ...base, currency: "dop" });

  assert.strictEqual(created.currency, "dop", "the original currency is still what it was");
  assert.deepStrictEqual(created.amount, { value: 16246.63, currency: "default" },
    "and the original amount is NOT overwritten with the converted one");
  assert.ok(created.converted_amount, "a converted figure is stored");
  assert.ok(created.exchange_rate > 0);
  assert.ok(created.rate_date);
  assert.match(created.rate_source, /1 USD = |1 DOP = /,
    "with a rate an accountant can read, not just a number");

  // The conversion lands in the right order of magnitude. 16,246.63 pesos is a
  // few hundred dollars; the bug being fixed reported it as sixteen thousand.
  const conv = created.converted_amount.value;
  assert.ok(conv > 100 && conv < 1000,
    `16,246.63 DOP should be a few hundred USD, got ${conv}`);
  assert.ok(conv < Number(base.amount) / 10,
    "and must be far smaller than the peso figure, which is the whole point");

  // The rate for the day the money moved, not today: an expense from March
  // must not be revalued every time a statement is run.
  assert.ok(rateCalls.every((u) => u.includes(PAID_ON)),
    `the rate must be asked for on paid_on (${PAID_ON}), not today; asked: ${rateCalls.join(" ")}`);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(!rateCalls.some((u) => u.includes(today)),
    "and specifically not for today -- an expense from March must not be revalued every time a statement runs");
  assert.strictEqual(out.body.conversion.applied, true);
  console.log(`3) A foreign expense is converted at the paid-on rate (${conv} USD from 16,246.63 DOP)`);
}

// ---- 4. no rate available: saved anyway, and said so ------------------
// Losing the expense would be worse than storing it unconverted. It will show
// on a statement as unconverted rather than being netted.
{
  customValues = [{ fieldKey: "custom_values.wcurrency", value: "USD" }];
  rateReply = null;
  const out = await post({ ...base, currency: "dop" });
  assert.strictEqual(out.status, 200, "the expense is still created");
  assert.strictEqual(created.currency, "dop");
  assert.ok(!("converted_amount" in created), "with no invented conversion");
  assert.strictEqual(out.body.conversion.applied, false);
  assert.match(out.body.conversion.reason, /no DOP->USD rate/, "and the caller is told why");
  console.log("4) With no rate, the expense is saved unconverted and the reason is reported");
}

// ---- 5. a currency off the list is refused, not stored ----------------
// The field is SINGLE_OPTIONS with three keys. Anything else would be an
// invalid option on the record, and it arrives from a browser.
{
  customValues = [{ fieldKey: "custom_values.wcurrency", value: "USD" }];
  rateReply = null;
  for (const junk of ["gbp", "", "DOP DOP", "../usd", "dop;drop"]) {
    await post({ ...base, currency: junk });
    assert.ok(!("currency" in created), `${JSON.stringify(junk)} must not be stored`);
  }
  // And the record is still created -- an unrecognised currency is not a reason
  // to lose the expense, it is a reason to leave the field alone.
  assert.strictEqual(created.expense_name, "Cerveceria");

  // Case from a dropdown still works.
  await post({ ...base, currency: "USD" });
  assert.strictEqual(created.currency, "usd", "an uppercase code maps to the lowercase option key");
  console.log("5) A currency outside the field's three options is left unset, and the expense still saves");
}

// ---- 6. the form offers it, and says what the amount is in ------------
{
  assert.match(HTML, /<select id="aeCurrency" required><\/select>/, "the form has a required currency select");
  assert.ok(!/Amount \(\$\)/.test(HTML),
    'the amount label no longer hardcodes "$" beside a currency dropdown that may say DOP');
  assert.match(HTML, /id="aeAmountLabel"/, "it is rewritten to match the choice");

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

  // The three options are exactly the field's three option keys.
  const opts = JSON.parse(run(`JSON.stringify(EXPENSE_CURRENCIES.map(([k]) => k))`));
  assert.deepStrictEqual(opts, ["dop", "usd", "eur"]);

  // Preselected to the account's own currency, since most expenses are in it.
  const open = APP.slice(APP.indexOf("function openAddExpenseModal"));
  const body = open.slice(0, open.indexOf("\n}"));
  assert.match(body, /DATA\.accountCurrency/, "defaulted from the account, not to a constant");
  assert.match(body, /key\.toUpperCase\(\) === preferred/,
    "compared case-insensitively: the option keys are lowercase and WCurrency is upper");

  // Submitted.
  const sub = APP.slice(APP.indexOf("async function submitAddExpense"));
  assert.match(sub.slice(0, sub.indexOf("\nfunction ")), /currency: \$\("#aeCurrency"\)\.value/);

  // And every label has Spanish.
  const dict = JSON.parse(run(`JSON.stringify(I18N.es)`));
  for (const [, label] of JSON.parse(run(`JSON.stringify(EXPENSE_CURRENCIES)`))) {
    assert.ok(dict[label], `"${label}" has no Spanish`);
  }
  assert.ok(dict["Currency"]);
  console.log("6) The form offers the three currencies, defaults to the account's, and submits it");
}

// ---- 7. a receipt's own currency reaches the field --------------------
// This is the case the bug came from: a Dominican receipt read on a USD
// account. The reader already extracted the currency and had nowhere to put it.
{
  const fn = APP.slice(APP.indexOf("async function readReceiptIntoForm"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.match(body, /e\.currency && EXPENSE_CURRENCIES\.some/,
    "the read currency is checked against the field's options before being set");
  assert.match(body, /\$\("#aeCurrency"\)\.value = e\.currency/);
  assert.match(body, /paintAmountLabel\(\)/, "and the amount label follows it");
  console.log("7) A receipt read in pesos sets the currency to DOP");
}

// ---- 8. the dictionary has no duplicate keys -------------------------
// Three were added by the previous change and already existed in the manager
// P&L block above. Legal JS, last one wins, invisible -- until a patch tried to
// anchor on one and matched twice.
{
  const dictSrc = APP.slice(APP.indexOf("const I18N = {"));
  const keys = [...dictSrc.slice(0, dictSrc.indexOf("\n};")).matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
  const seen = new Set(), dupes = new Set();
  for (const k of keys) (seen.has(k) ? dupes : seen).add(k);
  assert.deepStrictEqual([...dupes], [], `duplicate translation keys: ${[...dupes].join(", ")}`);
  console.log(`8) All ${keys.length} translation keys are unique`);
}

console.log("\nPASS — an expense says which currency it is in, and converts at the rate for the day it was paid.");
