// Whether GHL actually heard us has to be readable afterwards.
// Run: node test-notify-outcomes.mjs
//
// Two investigations on 2026-09-26 took hours largely because this was
// unknowable: a notify that 404'd and a notify that was never sent left exactly
// the same trace as one that succeeded, which is none.
import assert from "node:assert";

const { notifyGHL, recordNotification, notifyAndRecord } = await import("./src/cancellation.js");

const URL_OK = "https://services.leadconnectorhq.com/hooks/L1/webhook-trigger/abc";

function makeEnv() {
  const store = {};
  return {
    store,
    BOOKINGS: {
      put: async (k, v) => { store[k] = v; },
      get: async (k) => store[k] ?? null,
    },
  };
}
const snap = (over = {}) => ({ bookingId: "BK-1", locationId: "L1", ...over });

// ---- 1. a 404 is a failure, not a success -------------------------------
// fetch only rejects on a network error. GHL answering "no such webhook"
// resolves perfectly happily, and the old code counted that as delivered.
{
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const out = await notifyGHL(URL_OK, { event: "booking_cancelled" }, "booking_cancelled");
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 404);
  assert.strictEqual(out.reason, "rejected");
  assert.strictEqual(out.event, "booking_cancelled");
  console.log("1) A non-2xx response is reported as a failure, with its status");
}

// ---- 2. a missing URL is reported, not silently skipped -----------------
// The four wghl_* values are filled in by hand per account and unreadable by
// any API, so a blank is the ordinary failure mode for a new client.
{
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200 }; };
  const out = await notifyGHL("", { event: "booking_cancelled" });
  assert.strictEqual(called, false, "nothing is posted when there is no URL");
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, "no_url_configured");
  assert.ok(out.at, "and it is still timestamped, so the attempt is on the record");
  console.log("2) A tenant with no webhook URL records a failure instead of nothing at all");
}

// ---- 3. a network error is caught and reported -------------------------
{
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  const out = await notifyGHL(URL_OK, {}, "deposit_refunded");
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, "fetch_failed");
  assert.match(out.error, /ECONNREFUSED/);
  console.log("3) A network failure is caught, reported, and never thrown at the caller");
}

// ---- 4. success says so ------------------------------------------------
{
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  const out = await notifyGHL(URL_OK, {}, "payment_confirmed");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 200);
  console.log("4) A delivered notification is recorded as delivered");
}

// ---- 5. outcomes land on the booking ----------------------------------
{
  const env = makeEnv();
  const s = snap();
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  await notifyAndRecord(env, s, URL_OK, { event: "booking_cancelled" });

  const stored = JSON.parse(env.store["BK-1"]);
  assert.strictEqual(stored.notifications.length, 1);
  assert.strictEqual(stored.notifications[0].event, "booking_cancelled",
    "the event label comes from the payload, so it cannot disagree with what was sent");
  assert.strictEqual(stored.notifications[0].ok, false);
  assert.strictEqual(stored.notifyFailed, true, "greppable: this booking has an unheard notification");
  console.log("5) The outcome is written to the booking, and a failure raises notifyFailed");
}

// ---- 6. a success does not raise the failure flag ---------------------
{
  const env = makeEnv();
  const s = snap();
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  await notifyAndRecord(env, s, URL_OK, { event: "payment_confirmed" });
  const stored = JSON.parse(env.store["BK-1"]);
  assert.strictEqual(stored.notifications[0].ok, true);
  assert.strictEqual(stored.notifyFailed, undefined);
  console.log("6) A delivered notification leaves no failure flag");
}

// ---- 7. history accumulates and is capped -----------------------------
// A booking rescheduled repeatedly must not grow without limit.
{
  const env = makeEnv();
  const s = snap();
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  for (let i = 0; i < 25; i++) await notifyAndRecord(env, s, URL_OK, { event: `e${i}` });
  const stored = JSON.parse(env.store["BK-1"]);
  assert.strictEqual(stored.notifications.length, 20, "capped at 20");
  assert.strictEqual(stored.notifications[0].event, "e5", "oldest dropped, newest kept");
  assert.strictEqual(stored.notifications.at(-1).event, "e24");
  console.log("7) Notification history accumulates, newest kept, capped at 20");
}

// ---- 8. recording can never break the caller --------------------------
// The notification has already been attempted by the time this runs. Losing the
// record of it must not throw away the caller's own result -- a cancellation
// that refunded money must still return, even if KV is unavailable.
{
  const env = { BOOKINGS: { put: async () => { throw new Error("KV unavailable"); } } };
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  const out = await notifyAndRecord(env, snap(), URL_OK, { event: "booking_cancelled" });
  assert.strictEqual(out.ok, true, "the outcome is still returned even when it cannot be stored");
  console.log("8) A KV failure while recording never propagates to the caller");
}

// ---- 9. no snapshot, no crash -----------------------------------------
{
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  const out = await recordNotification(makeEnv(), null, { ok: true });
  assert.strictEqual(out.ok, true);
  console.log("9) Recording against no snapshot is a no-op, not a crash");
}

console.log("\nPASS — a notification GHL never heard is now a readable state, not silence.");
