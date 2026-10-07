// Every path that creates an expense says whose cost it is.
// Run: node test-expense-writers.mjs
//
// Phase 3 added Paid By and taught the READERS to use it. It did not touch the
// WRITERS, so for a day every expense created through the dashboard arrived
// unattributed -- excluded from the manager's total and flagged on the
// statement. Yari, 2026-10-07, asking after the capture paths is what surfaced
// it: "what happened to the capture of csv, receipts and pdf for expenses?"
//
// The answer turned out to be that CSV and receipts were fine and the other two
// were not, which is the sort of thing only a test across all four can keep
// true.
import assert from "node:assert";

const DEMO = "ZghxU8I60bEm39JUbtCm";
const EXP = "custom_objects.expenses";

const created = [];
const jsonRes = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

function serveGhl() {
  created.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === `/objects/${EXP}/records` && (init.method || "GET") === "POST") {
      created.push(body.properties);
      return jsonRes(201, { record: { id: `new${created.length}` } });
    }
    if (u.pathname.endsWith("/associations")) return jsonRes(200, { associations: [] });
    return jsonRes(200, { records: [], record: {} });
  };
}

const envFor = (kind = "client") => ({
  DASHBOARD_TENANTS: {
    get: async (k, o) => {
      const v = { label: "DEMO", kind, ghlPitSecretName: "PIT_DEMO" };
      return o?.type === "json" ? v : JSON.stringify(v);
    },
  },
  PIT_DEMO: "pit-token",
  ADMIN_KEY: "admin-key",
});

const worker = (await import("./src/index.js")).default;
const post = async (path, body, env = envFor()) => {
  const res = await worker.fetch(new Request(`https://d.dev${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not every response is JSON */ }
  return { status: res.status, body: parsed };
};

const EXPENSE = {
  locationId: DEMO, name: "Pest control", categoryKey: "pest_control",
  paidOn: "2026-10-01", amount: 35,
};

// ---- 1. the Add Expense form will not create an unattributed expense ----
// Required with no default, by Yari's choice. This is the one path where a
// person is already looking at a form, so it is the cheapest moment to ask --
// and a default here would mean a rushed entry silently charging an owner.
{
  serveGhl();
  const missing = await post("/api/expenses", EXPENSE);
  assert.strictEqual(missing.status, 400, "no Paid By, no expense");
  assert.match(missing.body.error, /paidBy is required/);
  assert.strictEqual(created.length, 0, "and nothing reached GHL");
  console.log("1) The Add Expense form refuses to create an expense that says nothing about whose it is");
}

// ---- 2. and writes what it was told ---------------------------------
{
  for (const whose of ["owner", "manager"]) {
    serveGhl();
    const ok = await post("/api/expenses", { ...EXPENSE, paidBy: whose });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].paid_by, whose);
    assert.strictEqual(created[0].review_status, "needs_review",
      "still reviewed before it counts anywhere");
  }

  // Anything else is a refusal, not a guess. "Owner " with a space, a typo, a
  // boolean from a mis-wired form -- none of them attribute money.
  for (const junk of ["", "both", "Owner ", "yes", true, 1, null]) {
    serveGhl();
    const bad = await post("/api/expenses", { ...EXPENSE, paidBy: junk });
    assert.strictEqual(bad.status, 400, `"${junk}" must not be accepted`);
    assert.strictEqual(created.length, 0);
  }

  // Case is forgiven, because a GHL option key is lowercase and a form or an
  // integration may not be.
  serveGhl();
  assert.strictEqual((await post("/api/expenses", { ...EXPENSE, paidBy: "OWNER" })).status, 200);
  assert.strictEqual(created[0].paid_by, "owner", "and is normalised to the key GHL stores");
  console.log("2) It writes exactly owner or manager, forgives case, and refuses everything else");
}

// ---- 3. the CSV and receipt paths are vendor-only, which is why they
//         were never affected -------------------------------------------
// Yari asked what happened to them: nothing. They write into a vendor book
// (DTCS, HOMS), whose P&L never reads Paid By. The guard that keeps them there
// is what makes that true, so it is asserted rather than assumed -- if it ever
// loosened, those imports would start producing unattributed client expenses
// in bulk and nothing else would notice.
{
  for (const path of ["/api/expenses/import", "/api/expenses/parse-file"]) {
    serveGhl();
    const onClient = await post(path, { locationId: DEMO, rows: [] }, envFor("client"));
    assert.strictEqual(onClient.status, 400, `${path} must refuse a client account`);
    assert.strictEqual(created.length, 0);
  }
  console.log("3) CSV import and receipt capture still refuse client accounts, which is why Paid By never applied to them");
}

// ---- 4. a service request attributes its own expense ----------------
// Nobody is at a keyboard when this fires, so it is the one place a default is
// right. A vendor fixing something at a property is the owner's cost.
{
  const src = (await import("node:fs")).readFileSync("./src/services.js", "utf8");
  const block = src.slice(src.indexOf("const expenseProps = {"));
  const props = block.slice(0, block.indexOf("};"));
  assert.match(props, /paid_by: "owner"/,
    "a service-request expense attributes itself, or every one arrives flagged");
  assert.match(props, /review_status: "needs_review"/,
    "and is still reviewed first, so the default is seen before it deducts from anybody");
  console.log("4) A service request creates its expense as the owner's, still pending review");
}

// ---- 5. no writer left behind ---------------------------------------
// The actual defect was not a missing line, it was that nobody related the
// readers to the writers. This fails if a new path starts creating expenses
// without saying whose they are.
{
  const fs = await import("node:fs");

  // Vendor books (DTCS, HOMS) have no owner dimension at all and their P&L
  // never reads Paid By, so these two are exempt by design rather than by
  // oversight. Case 3 asserts the guard that keeps them vendor-only, which is
  // what makes the exemption safe.
  const VENDOR_ONLY = new Set(["vendor.js", "expenses-import.js"]);

  const offenders = [];
  for (const f of fs.readdirSync("./src").filter((n) => n.endsWith(".js"))) {
    if (VENDOR_ONLY.has(f)) continue;
    // Comments stripped first. The check is about code, and a window measured
    // in characters is otherwise at the mercy of how much prose sits inside the
    // literal -- a comment explaining WHY an expense is attributed was enough to
    // push paid_by out of range and fail a file that was perfectly correct.
    const src = fs.readFileSync(`./src/${f}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Each place a record is built for the Expenses object, then a window after
    // it. Matching the whole literal is not worth it -- amounts are nested
    // objects, so any brace-counting regex stops at `{ value, currency }` and
    // reports a truncated block that never contained paid_by anyway.
    for (const m of src.matchAll(/expense_name:/g)) {
      const window = src.slice(m.index, m.index + 800);
      if (!/paid_by/.test(window)) {
        offenders.push(`${f}: ${window.slice(0, 60).replace(/\s+/g, " ")}…`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these create an expense without saying whose it is: ${JSON.stringify(offenders, null, 1)}`);
  console.log("5) Every client-account expense writer sets Paid By, and a new one that forgets fails here");
}

// ---- 6. the form can actually send it -------------------------------
// Cases 1 and 2 prove the ROUTE refuses an unattributed expense. They say
// nothing about whether the page can satisfy it: delete the field from the form
// and every one of them still passes, while the only human-facing path becomes
// impossible to complete. Checked against the source because the modal needs a
// real document to submit, and a stub DOM proving a stub form works would prove
// nothing at all.
{
  const fs = await import("node:fs");
  const html = fs.readFileSync("./public/index.html", "utf8");
  const app = fs.readFileSync("./public/app.js", "utf8");

  assert.match(html, /<select id="aePaidBy" required>/, "the field exists and is required by the browser too");
  assert.match(html, /<option value="owner">/, "with the two values the route accepts");
  assert.match(html, /<option value="manager">/);
  assert.match(html, /<option value="">/, "and no pre-selected default, which was the point of asking");

  const submit = app.slice(app.indexOf("async function submitAddExpense"));
  const payload = submit.slice(0, submit.indexOf("};"));
  assert.match(payload, /paidBy: \$\("#aePaidBy"\)\.value/,
    "and the submitted payload carries it, keyed exactly as the route reads it");

  // The labels are rendered by the browser from markup, so localize() swaps them
  // like any other chrome -- which only works if they are dictionary keys.
  const dict = app.slice(app.indexOf("const I18N"), app.indexOf("let LOCALE"));
  for (const label of ["Paid By", "Owner", "Manager"]) {
    assert.ok(dict.includes(`"${label}":`), `"${label}" has no Spanish`);
  }
  console.log("6) The form has the field, sends it under the right key, and translates its labels");
}

console.log("\nPASS — no path creates a client expense without saying whose cost it is.");
