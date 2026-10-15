// The owner statement comes from the invoicing Worker, and is scoped by OWNER.
// Run: node test-owner-statement.mjs
//
// What it replaces computed the management commission here, as the sum of
// expense records categorised management_fee -- a category nothing writes -- so
// it printed $0.00 on every statement it ever produced. Villa Amarilla's
// October 2026 statement showed its owner keeping $4,303 of $4,430 gross on an
// account that takes 15% (Yari, 2026-10-13).
//
// It could not have been fixed in place. The split is two ledger rows per
// booking and the manager's half carries recipient='manager', so no
// owner-scoped view of THIS Worker's data contains it however it is written.
import assert from "node:assert";
import fs from "node:fs";

const CLIENT = "ZghxU8I60bEm39JUbtCm";
const tenants = new Map([[CLIENT, JSON.stringify({ label: "DEMO", ghlPitSecretName: "PIT_DEMO" })]]);

const baseEnv = {
  DASHBOARD_TENANTS: {
    async get(k, o) { const v = tenants.get(k); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { tenants.set(k, v); },
  },
  PIT_DEMO: "pit-token",
  ADMIN_KEY: "admin-key",
  INVOICING_WORKER_URL: "https://worker.example.dev",
  INVOICING_ADMIN_SECRET: "worker-admin-secret",
};

const STATEMENT = {
  currency: "USD", incomeTotal: 3765.50, expenseTotal: 127, expenseSum: -127,
  managerCommission: 664.50, grossRent: 4430, netIncome: 3638.50,
  availableOwners: [{ name: "carlos mendoza", entryCount: 7 }, { name: "elena marchetti", entryCount: 3 }],
  summary: [], detail: [],
};

let seen = [];
const serveWorker = (status, body) => {
  seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers || {} });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
};

const { default: worker } = await import("./src/index.js");
const call = (qs, env = baseEnv) => worker.fetch(
  new Request(`https://dash.example.dev/api/owner-statement?${qs}`, { headers: { Authorization: "Bearer admin-key" } }), env);

console.log("1) the statement is fetched from the invoicing Worker, not computed here");
{
  serveWorker(200, STATEMENT);
  const res = await call(`locationId=${CLIENT}&period=all`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1, "exactly one upstream call");
  assert.ok(seen[0].url.includes("/reports/owner-statement"), "the owner statement endpoint, not the manager one");
  assert.ok(seen[0].url.includes("format=json"));
  assert.equal(body.managerCommission, 664.50, "the commission is passed through untouched");
  assert.equal(body.grossRent, 4430);
}

// The bug this replaces, stated as an assertion so it cannot come back quietly.
console.log("2) the commission is never zero just because no expense record says otherwise");
{
  serveWorker(200, STATEMENT);
  const body = await (await call(`locationId=${CLIENT}&period=all`)).json();
  assert.notEqual(body.managerCommission, 0,
    "the old statement summed management_fee expense records, which nothing writes");
  assert.equal(body.netIncome, 3638.50);
  assert.notEqual(body.netIncome, 4303, "4303 is gross less expenses with NO commission -- the old number");
}

console.log("3) recipientName reaches the Worker, which is how one owner's statement is scoped");
{
  serveWorker(200, STATEMENT);
  await call(`locationId=${CLIENT}&period=all&recipientName=${encodeURIComponent("carlos mendoza")}`);
  // Read the param back rather than matching the raw string: a space may be
  // encoded as %20 or +, and asserting on one spelling would pass or fail for
  // reasons that have nothing to do with the scoping.
  const sentName = new URL(seen[0].url).searchParams.get("recipientName");
  assert.equal(sentName, "carlos mendoza",
    "without this every owner sees every other owner's money");
}

console.log("4) a missing locationId is refused before any upstream call");
{
  serveWorker(200, STATEMENT);
  const res = await call("period=all");
  assert.equal(res.status, 400);
  assert.equal(seen.length, 0);
}

// An upstream 401 passed through as a 401 makes the page open its admin-key
// prompt, so the reader is asked to re-enter a key that cannot help.
console.log("5) an upstream 401 becomes a 502 naming the real problem");
{
  serveWorker(401, { error: "Unauthorized" });
  const res = await call(`locationId=${CLIENT}&period=all`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.ok(/credential/i.test(body.error));
  assert.ok(/session is fine/i.test(body.detail));
}

console.log("6) the Worker's own 404 is passed through, not reshaped");
{
  serveWorker(404, { error: "Unknown locationId" });
  const res = await call(`locationId=${CLIENT}&period=all`);
  assert.equal(res.status, 404, "an unknown account says so rather than looking like an outage");
}

// A param this route forgets to forward does not fail -- it silently reverts to
// a default. `period` was dropped exactly this way on 2026-10-05: the page asked
// for all time, the Worker understood all time, and the panel showed 30 days
// under an All time label.
console.log("7) every param the page sends survives the proxy");
{
  const src = fs.readFileSync("./public/app.js", "utf8");
  // The params moved into their own pure function; scan that, not the fetch.
  const fn = src.slice(src.indexOf("function ownerStatementParams("), src.indexOf("function renderStatement()"));
  const sent = [...fn.matchAll(/params\.set\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length >= 3, "the loader should be setting several params");
  // Pinned, not derived. The scan above takes its expectations FROM the loader,
  // so on its own it cannot notice the loader dropping something -- deleting a
  // params.set() just shrinks what it checks for. These are named here so that
  // losing one fails, and recipientName is the one that matters: without it
  // every owner's statement silently aggregates every other owner's money.
  for (const required of ["recipientName", "from", "to"]) {
    assert.ok(sent.includes(required), `loadOwnerStatement must send ${required}`);
  }
  assert.ok(fn.includes('params.set("period", "all")'),
    "no month selected means all time and has to say so -- sending nothing gets the Worker's 30-day default");


  serveWorker(200, STATEMENT);
  const qs = new URLSearchParams({ locationId: CLIENT });
  for (const k of sent) qs.set(k, k === "period" ? "all" : "x");
  await call(qs.toString());
  for (const k of sent) {
    assert.ok(seen[0].url.includes(`${k}=`), `the page sends ${k} and this route drops it`);
  }
}

// The ledger has no property_id -- its rows are per booking -- so the money
// cannot be grouped by property at all. A property picker over these figures
// would put one property's name above another number entirely.
console.log("8) the page scopes by owner, with no property selector left behind");
{
  const src = fs.readFileSync("./public/app.js", "utf8");
  assert.ok(src.includes('id="stmtOwner"'), "there has to be an owner selector");
  assert.ok(!src.includes('id="stmtProperty"'), "the property selector must be gone, not hidden");
  assert.ok(!src.includes("statementState.propertyId"), "and nothing may still read propertyId");
}

// recipientName is matched with = in SQL, so a name that differs by case or a
// letter selects nothing and renders a statement of zeros that looks real.
console.log("9) the owner picker is built from the Worker's own names");
{
  const src = fs.readFileSync("./public/app.js", "utf8");
  const fn = src.slice(src.indexOf("function renderStatement()"));
  assert.ok(fn.includes("availableOwners"),
    "the picker must use the ledger's stored spellings, not DATA.properties' owner names");
}

// Executed, not scanned. A source scan can prove a line is PRESENT but not that
// it is reached -- wrapping params.set("period","all") in if(false) leaves the
// text exactly where it was. The window maths deserves better than that: it is
// where the manager panel spent a week showing 30 days under an "All time"
// label, and where a local-time Date would roll a month boundary back a day in
// the DR.
console.log("10) the params the loader actually builds, run rather than read");
{
  const src = fs.readFileSync("./public/app.js", "utf8");
  const start = src.indexOf("function ownerStatementParams(");
  const end = src.indexOf("async function loadOwnerStatement");
  assert.ok(start > -1 && end > start, "ownerStatementParams must exist as its own function");
  const build = new Function(src.slice(start, end) + "; return ownerStatementParams;")();

  const noMonth = build({ month: null, ownerName: null }, "L1");
  assert.equal(noMonth.get("period"), "all", "no month selected has to SAY all time, not send nothing");
  assert.equal(noMonth.get("from"), null);

  const oct = build({ month: "2026-10", ownerName: "carlos mendoza" }, "L1");
  assert.equal(oct.get("from"), "2026-10-01");
  assert.equal(oct.get("to"), "2026-10-31", "the whole month, inclusive of its last day");
  assert.equal(oct.get("period"), null, "an explicit range must not also claim all time");
  assert.equal(oct.get("recipientName"), "carlos mendoza");

  // February, and a leap February, because month lengths are exactly what
  // Date.UTC(y, m, 0) is being trusted for.
  assert.equal(build({ month: "2026-02" }, "L1").get("to"), "2026-02-28");
  assert.equal(build({ month: "2028-02" }, "L1").get("to"), "2028-02-29");
  // December is the rollover: month 12 means Date.UTC(y, 12, 0), the last day
  // of December and not the first of January.
  assert.equal(build({ month: "2026-12" }, "L1").get("to"), "2026-12-31");
  assert.equal(build({ month: "2026-01" }, "L1").get("from"), "2026-01-01");

  // The reader's own clock must not change the window. new Date(y, m, 0) is
  // local midnight, which toISOString() pushes into the previous day east of
  // Greenwich -- so this passes in Santo Domingo and silently loses the last
  // day of every month in Madrid.
  const tz = process.env.TZ;
  for (const zone of ["UTC", "America/Santo_Domingo", "Europe/Madrid", "Asia/Tokyo"]) {
    process.env.TZ = zone;
    const b = new Function(src.slice(start, end) + "; return ownerStatementParams;")();
    assert.equal(b({ month: "2026-10" }, "L1").get("to"), "2026-10-31", `window end wrong in ${zone}`);
  }
  process.env.TZ = tz;
}

console.log("\nPASS — one definition of the owner's money, scoped by owner, fetched not recomputed.");
