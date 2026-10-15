// The processing fee defaults to ZERO, and 6% is derived only from PayPal.
//
// It used to default to 6% in six separate copies, which is how Casa Bonita
// ended up adding a 6% "Cargo por procesamiento" line on top of GHL's own
// native 6% Additional Fee on INV-000031 -- compounding, because the Worker's
// basis includes the native fee. No single file was wrong about it.
import assert from "node:assert/strict";
import { processingFeePctFor, deriveProcessingFeePct, deriveInvoiceStrategy, PAYPAL_FEE_PCT } from "./src/policy.js";

console.log("1) no PayPal, nothing stated -> zero, not 6%");
assert.strictEqual(processingFeePctFor({}), 0);
assert.strictEqual(processingFeePctFor({ brandName: "Fresh Account" }), 0);
assert.strictEqual(processingFeePctFor(undefined), 0, "a missing tenant must not conjure a fee");

console.log("2) what the account states wins, including an explicit zero");
assert.strictEqual(processingFeePctFor({ processingFeePct: 0.06 }), 0.06);
assert.strictEqual(processingFeePctFor({ processingFeePct: 0 }), 0, "an explicit 0 is a value, not an absence");
assert.strictEqual(processingFeePctFor({ processingFeePct: 0.03 }), 0.03);

// A booking priced at 6% must keep being priced at 6% when it is rescheduled
// or its invoice reread, whatever the account says today. Otherwise changing
// the tenant rate silently re-rates every booking already taken.
console.log("3) the rate pinned on the booking beats the tenant's current rate");
assert.strictEqual(processingFeePctFor({ processingFeePct: 0 }, { charges: { feePct: 0.06 } }), 0.06);
assert.strictEqual(processingFeePctFor({ processingFeePct: 0.06 }, { charges: { feePct: 0 } }), 0,
  "a booking priced at zero stays at zero even once the account charges 6%");
assert.strictEqual(processingFeePctFor({ processingFeePct: 0.06 }, { charges: {} }), 0.06,
  "a snapshot with no pinned rate falls through to the tenant");
assert.strictEqual(processingFeePctFor({ processingFeePct: 0.06 }, {}), 0.06,
  "a snapshot with no charges at all falls through too");

console.log("4) derivation: a PayPal client ID means the fee has to be recovered");
assert.deepStrictEqual(deriveProcessingFeePct({ paypalClientId: "AX..." }, null).value, PAYPAL_FEE_PCT);
assert.strictEqual(deriveProcessingFeePct({}, null).value, 0);

// The client ID is mapped from a custom value, and a BLANK custom value is
// skipped rather than written -- so on a re-run where GHL's field is empty the
// signal lives only on the existing entry. Reading just `provisioned` would
// silently switch a PayPal account's fee off.
console.log("5) derivation sees the merged record, not just this run's custom values");
assert.strictEqual(deriveProcessingFeePct({}, { paypalClientId: "AX..." }).value, PAYPAL_FEE_PCT);

console.log("6) a stated rate is never overwritten by the derivation");
assert.strictEqual(deriveProcessingFeePct({ paypalClientId: "AX..." }, { processingFeePct: 0 }), null,
  "YV Guest Properties states 0 and must keep it");
assert.strictEqual(deriveProcessingFeePct({}, { processingFeePct: 0.06 }), null,
  "Luminara states 0.06 and must keep it");
assert.strictEqual(deriveProcessingFeePct({ processingFeePct: 0.04 }, null), null,
  "a rate arriving with this run is also somebody's decision");

// Payout addresses are where HOMS sends an owner their share. They say nothing
// about how a guest pays, and keying on them would put a 6% guest fee on an
// account that takes no PayPal at all. All three live tenants have them.
console.log("7) PayPal PAYOUT emails are not evidence a guest pays by PayPal");
assert.strictEqual(
  deriveProcessingFeePct({ ownerPaypalEmail: "o@x.com", managerPaypalEmail: "m@x.com" }, null).value, 0);

// gateway reads "paypal" on every live tenant, including the one that takes no
// PayPal, and invoiceStrategy is "enrich" on all of them. Neither discriminates.
console.log("8) neither gateway nor invoiceStrategy is allowed to decide this");
assert.strictEqual(deriveProcessingFeePct({ gateway: "paypal", invoiceStrategy: "enrich" }, null).value, 0,
  "gateway alone must not switch the fee on");
assert.strictEqual(
  deriveProcessingFeePct({ paypalClientId: "AX...", gateway: "stripe" }, null).value, PAYPAL_FEE_PCT,
  "and it must not switch it off either");

console.log("9) every derivation says why, so provisioning can report it");
for (const [p, e] of [[{ paypalClientId: "AX..." }, null], [{}, null]]) {
  const d = deriveProcessingFeePct(p, e);
  assert.ok(d.reason && d.reason.length > 20, "a derived money setting must explain itself");
}

// Reproduces the three live records as of 2026-10-13. If the rule cannot
// reproduce the accounts it is about to govern, it is the wrong rule.
// Writing an account's PayPal Custom Values is the moment it becomes a paying
// account. Both settings it needs are derived then, so neither is a step
// somebody has to remember (Yari, 2026-10-15).
console.log("11) a provisioned account gets enrich, not the legacy paypal_url");
{
  const d = deriveInvoiceStrategy({}, null);
  assert.strictEqual(d.value, "enrich");
  assert.ok(d.reason && d.reason.length > 20, "a derived money setting must explain itself");
}

console.log("12) PayPal values give enrich AND the fee, in the same run");
{
  const provisioned = { paypalClientId: "AX...", paypalWebhookId: "WH..." };
  assert.strictEqual(deriveInvoiceStrategy(provisioned, null).value, "enrich");
  assert.strictEqual(deriveProcessingFeePct(provisioned, null).value, PAYPAL_FEE_PCT);
}

// Stripe accounts pass fees to the guest through GHL's own toggle, so the
// Worker must add nothing -- but they still take payment through a GHL invoice.
console.log("13) an account with no PayPal is still enrich, just without the fee");
{
  assert.strictEqual(deriveInvoiceStrategy({}, null).value, "enrich");
  assert.strictEqual(deriveProcessingFeePct({}, null).value, 0);
}

console.log("14) a stated strategy is never overwritten, including a deliberate paypal_url");
{
  assert.strictEqual(deriveInvoiceStrategy({}, { invoiceStrategy: "paypal_url" }), null,
    "an account deliberately on the legacy path must survive a re-provision");
  assert.strictEqual(deriveInvoiceStrategy({}, { invoiceStrategy: "enrich" }), null);
  assert.strictEqual(deriveInvoiceStrategy({ invoiceStrategy: "paypal_url" }, null), null,
    "a strategy arriving with this run is also somebody's decision");
}

// All three live tenants state "enrich", so flipping the runtime default moves
// none of them -- the same property that made the fee default safe to flip.
console.log("15) the derivation reproduces all three live tenants");
for (const existing of [
  { invoiceStrategy: "enrich", paypalClientId: "AX..." },              // Casa Bonita
  { invoiceStrategy: "enrich", paypalClientId: "AX...", processingFeePct: 0.06 }, // Luminara
  { invoiceStrategy: "enrich", processingFeePct: 0 },                  // YV, Stripe
]) {
  assert.strictEqual(deriveInvoiceStrategy({}, existing), null, "nothing to derive: each states its own");
}

console.log("10) the rule reproduces all three live tenants");
const live = [
  { name: "Casa Bonita", existing: { paypalClientId: "AX..." }, want: PAYPAL_FEE_PCT },
  { name: "Luminara", existing: { paypalClientId: "AX...", processingFeePct: 0.06 }, want: 0.06 },
  { name: "YV Guest Properties", existing: { processingFeePct: 0 }, want: 0 },
];
for (const t of live) {
  const d = deriveProcessingFeePct({}, t.existing);
  const effective = d ? d.value : processingFeePctFor(t.existing);
  assert.strictEqual(effective, t.want, `${t.name} should end up at ${t.want}, got ${effective}`);
}

console.log("\nall processing-fee tests passed");
