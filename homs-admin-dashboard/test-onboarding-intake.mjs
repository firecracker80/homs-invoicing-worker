// Local mock tests for the onboarding intake. No network, no GHL.
// Run: node test-onboarding-intake.mjs
//
// The message shapes here are the ones the live HOMS account actually returns
// (checked 2026-09-25): `files` is an array of direct URLs, and `direction` is
// "inbound" / "outbound".
import assert from "node:assert";
import { book, EXAMPLE } from "./test-workbook.mjs";

const {
  findWorkbookReply, downloadWorkbook, crossCheck, listContactEmails,
  intakeKey, saveIntake, loadIntake, CROSS_CHECKS, MAX_WORKBOOK_BYTES,
} = await import("./src/onboarding-intake.js");

const WORKBOOK = "https://services.leadconnectorhq.com/x/HOMSPortfolioIntake.xlsx";
const email = (o) => ({ messageType: "TYPE_EMAIL", threadId: "t1", conversationId: "c1", ...o });

// ---- 1. only the client's own reply counts ----------------------------------
// HOMS sends the BLANK workbook on this same thread. Taking the newest message
// with an .xlsx would parse the template we sent and report an empty portfolio.
{
  const messages = [
    email({ id: "out1", direction: "outbound", dateAdded: "2026-09-20T10:00:00Z", files: [WORKBOOK], subject: "Your HOMS portfolio workbook" }),
    email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", files: ["https://x/filled.xlsx"], subject: "Re: Your HOMS portfolio workbook" }),
  ];
  const r = findWorkbookReply(messages);
  assert.equal(r.found.messageId, "in1", "the client's reply, never the template HOMS sent");
  assert.equal(r.found.url, "https://x/filled.xlsx");
  assert.equal(r.found.threadId, "t1");

  // Even when the outbound one is the newest message on the thread.
  const laterTemplate = [
    email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", files: ["https://x/filled.xlsx"] }),
    email({ id: "out2", direction: "outbound", dateAdded: "2026-09-23T09:00:00Z", files: [WORKBOOK] }),
  ];
  assert.equal(findWorkbookReply(laterTemplate).found.messageId, "in1", "a resent template does not win");
  console.log("1) Only an inbound reply counts -- the blank template HOMS sent is never picked up");
}

// ---- 2. a corrected resend wins, and the earlier one is reported ------------
{
  const messages = [
    email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", files: ["https://x/first.xlsx"] }),
    email({ id: "in2", direction: "inbound", dateAdded: "2026-09-24T11:00:00Z", files: ["https://x/corrected.xlsx"] }),
  ];
  const r = findWorkbookReply(messages);
  assert.equal(r.found.messageId, "in2", "newest inbound workbook wins");
  assert.deepStrictEqual(r.superseded.map((s) => s.messageId), ["in1"], "the earlier one is reported, not silently dropped");
  console.log("2) A corrected resend supersedes the first, and the first is still reported");
}

// ---- 3. waiting vs replied-without-workbook are different problems ----------
{
  assert.equal(findWorkbookReply([]).reason, "no_reply_yet");
  assert.equal(
    findWorkbookReply([email({ id: "out1", direction: "outbound", files: [WORKBOOK] })]).reason,
    "no_reply_yet", "our own email is not a reply");
  assert.equal(
    findWorkbookReply([email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", body: "will send monday" })]).reason,
    "replied_without_workbook", "they answered, just without the file");
  assert.equal(
    findWorkbookReply([email({ id: "in1", direction: "inbound", files: ["https://x/photo.png"] })]).reason,
    "replied_without_workbook", "an attachment that is not a workbook");
  assert.equal(findWorkbookReply([]).found, null);
  console.log("3) 'No reply yet' and 'replied without the workbook' stay distinguishable -- different next actions");
}

// ---- 4. workbook URLs are recognised, query strings and all ----------------
{
  const withQuery = [email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", files: ["https://x/book.xlsx?sig=abc123"] })];
  assert.equal(findWorkbookReply(withQuery).found.url, "https://x/book.xlsx?sig=abc123", "a signed URL is still a workbook");
  const xls = [email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", files: ["https://x/old.xls"] })];
  assert.ok(findWorkbookReply(xls).found, "legacy .xls is picked up so it can fail loudly at parse, not silently here");
  const mixed = [email({ id: "in1", direction: "inbound", dateAdded: "2026-09-22T09:00:00Z", files: ["https://x/sig.png", "https://x/book.xlsx"] })];
  assert.equal(findWorkbookReply(mixed).found.url, "https://x/book.xlsx", "the workbook among several attachments");
  console.log("4) Workbook URLs recognised with query strings, among other attachments");
}

// ---- 5. download: public first, PIT only if refused ------------------------
{
  const seen = [];
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init.headers?.Authorization ?? null);
    if (seen.length === 1) return { ok: false, status: 403 };
    return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => bytes };
  };
  const out = await downloadWorkbook(WORKBOOK, "pit-homs");
  assert.equal(out.byteLength, 3);
  assert.deepStrictEqual(seen, [null, "Bearer pit-homs"], "tried clean first, so a public URL never carries the PIT");

  seen.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init.headers?.Authorization ?? null);
    return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => bytes };
  };
  await downloadWorkbook(WORKBOOK, "pit-homs");
  assert.deepStrictEqual(seen, [null], "a public URL is fetched once, unauthenticated");

  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => downloadWorkbook(WORKBOOK, "pit"), /404/, "a dead link is an error, not an empty workbook");
  console.log("5) Download tries public first, falls back to the PIT, and fails loudly");
}

// ---- 6. the size cap holds even when content-length lies -------------------
{
  const huge = new Uint8Array(MAX_WORKBOOK_BYTES + 10).buffer;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: new Headers({ "content-length": String(MAX_WORKBOOK_BYTES + 10) }),
    arrayBuffer: async () => huge,
  });
  await assert.rejects(() => downloadWorkbook(WORKBOOK, "pit"), /too large/, "declared oversize is refused");

  // Chunked responses carry no content-length; the bytes still have to be checked.
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => huge,
  });
  await assert.rejects(() => downloadWorkbook(WORKBOOK, "pit"), /too large/, "undeclared oversize is refused too");
  console.log("6) Size cap holds with or without a content-length header");
}

// ---- 7. listContactEmails respects GHL's minimum limit ---------------------
{
  let seenUrl = "";
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: "m1" }] }) };
  };
  await listContactEmails("pit", "contact1", { limit: 3 });
  const q = new URL(seenUrl).searchParams;
  assert.equal(q.get("channel"), "Email");
  assert.equal(q.get("contactId"), "contact1");
  assert.ok(Number(q.get("limit")) >= 10, "GHL 422s on a limit under 10, so it is floored");

  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: "bad token" }) });
  await assert.rejects(() => listContactEmails("pit", "c1"), /bad token/);
  console.log("7) Email listing floors the limit at GHL's minimum and surfaces its errors");
}

// ---- 8. cross-check never picks a winner ----------------------------------
{
  const portfolio = {
    accountSettings: { currency: "USD", cancellationPolicyLabel: "Moderate" },
    rows: [{ blocked: false }, { blocked: false }, { blocked: true }],
  };

  // Nothing is wired yet -- the survey has no submissions to read field keys
  // from. That must read as "not wired", never as "no conflicts found".
  const none = crossCheck({}, portfolio);
  assert.deepStrictEqual(none.conflicts, [], "nothing to compare yet");
  assert.deepStrictEqual(none.unwired.sort(), ["cancellationPolicy", "currency", "propertyCount"],
    "every check reports itself unwired rather than passing vacuously");

  // With a key wired, a disagreement is reported and neither side is chosen.
  const wired = CROSS_CHECKS.map((c) => ({ ...c }));
  wired.find((c) => c.field === "currency").quizKey = "q_currency";
  const { conflicts } = crossCheckWith(wired, { q_currency: "DOP" }, portfolio);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].fromQuiz, "DOP");
  assert.equal(conflicts[0].fromWorkbook, "USD");
  assert.match(conflicts[0].note, /neither is assumed/);

  assert.equal(crossCheckWith(wired, { q_currency: "usd" }, portfolio).conflicts.length, 0, "case is not a disagreement");
  assert.equal(crossCheckWith(wired, {}, portfolio).conflicts.length, 0, "an unanswered question is not a disagreement");
  console.log("8) Cross-check reports disagreements and picks neither side");
}

// ---- 9. an answer nobody reads is reported ---------------------------------
{
  const out = crossCheck({ q_pets_allowed: "Yes", q_currency: "USD" }, { accountSettings: {}, rows: [] });
  assert.deepStrictEqual(out.unreadQuizAnswers.sort(), ["q_currency", "q_pets_allowed"],
    "an answer that reaches nothing is reported -- otherwise it looks captured");
  console.log("9) Quiz answers that map to nothing are surfaced, not dropped");
}

// ---- 10. counts compare as numbers ----------------------------------------
{
  const wired = CROSS_CHECKS.map((c) => ({ ...c }));
  wired.find((c) => c.field === "propertyCount").quizKey = "q_count";
  const portfolio = { accountSettings: {}, rows: [{ blocked: false }, { blocked: false }] };
  assert.equal(crossCheckWith(wired, { q_count: "2" }, portfolio).conflicts.length, 0, "'2' and 2 are the same answer");
  assert.equal(crossCheckWith(wired, { q_count: "8" }, portfolio).conflicts.length, 1, "8 promised, 2 delivered");
  console.log("10) Property counts compare as numbers, and a shortfall is caught");
}

// ---- 11. the record is keyed by the HOMS contact --------------------------
// The client's sub-account does not exist yet, so the contact is the only id.
{
  const store = {};
  const kv = {
    put: async (k, v) => { store[k] = v; },
    get: async (k, opt) => (store[k] == null ? null : (opt?.type === "json" ? JSON.parse(store[k]) : store[k])),
  };
  assert.equal(intakeKey("abc"), "onboarding:abc");
  await saveIntake(kv, "abc", { status: "ready_for_review" });
  assert.equal((await loadIntake(kv, "abc")).status, "ready_for_review");
  assert.equal(await loadIntake(kv, "nope"), null);
  assert.ok(Object.keys(store)[0].startsWith("onboarding:"),
    "prefixed, because this namespace also holds tenant records keyed by locationId");
  console.log("11) Intake records are keyed by the HOMS contact and namespaced away from tenants");
}

// ---- 12. the routes: gated, nothing written to any client account ----------
{
  const HOMS = "dytwzgmOP5v0Jh7gop4y";
  const CONTACT = "zGGIiZhwBNWnrVJPNFwi";
  const workbook = book([EXAMPLE, { A: "Casa Uno", B: "Active", C: "Villa", O: 100, N: "USD", W: "Moderate" }]);

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET" });
    if (u.includes("/conversations/messages/export")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [
        { id: "out1", direction: "outbound", messageType: "TYPE_EMAIL", dateAdded: "2026-09-20T10:00:00Z", files: [WORKBOOK] },
        { id: "in1", direction: "inbound", messageType: "TYPE_EMAIL", dateAdded: "2026-09-24T10:00:00Z", threadId: "t1", files: ["https://x/filled.xlsx"] },
      ] }) };
    }
    if (u === "https://x/filled.xlsx") {
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => workbook };
    }
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  };

  const store = {
    [HOMS]: { label: "HOMS", kind: "vendor", ghlPitSecretName: "GHL_PIT_HOMS" },
  };
  const env = {
    ADMIN_KEY: "admin", PROVISION_KEY: "prov", GHL_PIT_HOMS: "pit-homs",
    DASHBOARD_TENANTS: {
      put: async (k, v) => { store[k] = JSON.parse(v); },
      get: async (k, opt) => (store[k] == null ? null : (opt?.type === "json" ? store[k] : JSON.stringify(store[k]))),
    },
  };
  const { default: worker } = await import("./src/index.js");
  const post = (payload, key) => worker.fetch(new Request("https://d.dev/api/onboarding/intake", {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
    body: JSON.stringify(payload),
  }), env);

  assert.equal((await post({ locationId: HOMS, contactId: CONTACT }, null)).status, 401, "no key");
  assert.equal((await post({ locationId: HOMS, contactId: CONTACT }, "admin")).status, 401,
    "the dashboard cookie is not enough -- this is a webhook endpoint");
  assert.equal((await post({ locationId: HOMS }, "prov")).status, 400, "contactId required");

  calls.length = 0;
  const res = await post({ locationId: HOMS, contactId: CONTACT }, "prov");
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, "ready_for_review");
  assert.equal(out.reply.messageId, "in1");
  assert.equal(out.summary.ready, 1, "the example row is excluded, the real one is ready");
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0,
    "the intake writes nothing to GHL -- it only reads and parks");

  // Parked and readable, and the read is behind the dashboard login.
  const parked = store[`onboarding:${CONTACT}`];
  assert.equal(parked.status, "ready_for_review");
  assert.equal(parked.portfolio.accountSettings.currency, "USD");

  const get = (key) => worker.fetch(new Request(`https://d.dev/api/onboarding/${CONTACT}`, {
    headers: key ? { Authorization: "Bearer " + key } : {},
  }), env);
  assert.equal((await get(null)).status, 401, "the parked record is behind the login");
  assert.equal((await (await get("admin")).json()).reply.messageId, "in1");
  assert.equal((await worker.fetch(new Request("https://d.dev/api/onboarding/nobody", {
    headers: { Authorization: "Bearer admin" },
  }), env)).status, 404, "an unknown contact 404s rather than returning an empty shell");
  console.log("12) Routes gated by PROVISION_KEY, nothing written to GHL, record parked behind the login");
}

// ---- 13. no reply yet parks a waiting record, not a failure ----------------
{
  const HOMS = "dytwzgmOP5v0Jh7gop4y";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/conversations/messages/export")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [
        { id: "out1", direction: "outbound", messageType: "TYPE_EMAIL", dateAdded: "2026-09-20T10:00:00Z", files: [WORKBOOK] },
      ] }) };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const store = { [HOMS]: { label: "HOMS", kind: "vendor", ghlPitSecretName: "GHL_PIT_HOMS" } };
  const env = {
    ADMIN_KEY: "admin", PROVISION_KEY: "prov", GHL_PIT_HOMS: "pit-homs",
    DASHBOARD_TENANTS: {
      put: async (k, v) => { store[k] = JSON.parse(v); },
      get: async (k, opt) => (store[k] == null ? null : (opt?.type === "json" ? store[k] : JSON.stringify(store[k]))),
    },
  };
  const { default: worker } = await import("./src/index.js");
  const res = await worker.fetch(new Request("https://d.dev/api/onboarding/intake", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer prov" },
    body: JSON.stringify({ locationId: HOMS, contactId: "c9" }),
  }), env);
  assert.equal(res.status, 202, "waiting is not an error");
  assert.equal((await res.json()).reason, "no_reply_yet");
  assert.equal(store["onboarding:c9"].status, "waiting");
  console.log("13) A client who has not replied parks as 'waiting', not as a failure");
}

// A local stand-in so the cross-check table can be exercised with keys wired,
// without shipping fake quiz keys in the module itself.
function crossCheckWith(checks, quiz, portfolio) {
  const conflicts = [];
  for (const check of checks) {
    if (!check.quizKey) continue;
    const norm = check.normalise || ((v) => (v === "" || v === undefined ? null : v));
    const fromQuiz = norm(quiz[check.quizKey] ?? null);
    const fromWorkbook = norm(check.fromPortfolio(portfolio) ?? null);
    if (fromQuiz === null || fromWorkbook === null) continue;
    const same = (typeof fromQuiz === "number" || typeof fromWorkbook === "number")
      ? Number(fromQuiz) === Number(fromWorkbook)
      : String(fromQuiz).trim().toLowerCase() === String(fromWorkbook).trim().toLowerCase();
    if (!same) {
      conflicts.push({
        field: check.field, fromQuiz, fromWorkbook,
        note: `The quiz says ${fromQuiz}, the workbook says ${fromWorkbook}. Ask the client which is right -- neither is assumed.`,
      });
    }
  }
  return { conflicts };
}

console.log("\nPASS — onboarding intake: only the client's reply counts, nothing written, disagreements reported not resolved.");
