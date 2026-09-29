// Add-ons GHL charges every time, taken off when the guest said no.
// Run: node test-optional-add-ons.mjs
//
// GHL has no way to mark a listing's add-on optional in the booking widget
// (Yari, 2026-09-29) -- configure it on the listing and every booking is
// charged it. So the account configures it, the booking form asks, and the
// line comes off here when the answer is no. That is the pet-fee mechanism,
// which has worked since the beginning; this generalises it to everything
// else an account sells.
//
// Configuring it on the LISTING rather than having the Worker add the line is
// what makes attribution free: GHL names a per-listing fee after its listing
// ("Pet Fee - Test Villa 2"), which multi-listing.js reads to credit the right
// property. So the matcher here has to see through that suffix, since one
// configured entry covers every listing that charges it.
import assert from "node:assert";

const { optionalAddOnsToRemove, matchesAddOnName } = await import("./src/ghl-invoice.js");

const tenant = {
  optionalAddOns: [
    { field: "hasPets", name: "Pet Fee" },
    { field: "wantsLateCheckout", name: "Late Checkout" },
    { field: "wantsTransfer", name: "Airport Transfer" },
  ],
};

// ---- 1. only an explicit no takes a charge off --------------------
{
  const { declined, unanswered } = optionalAddOnsToRemove(tenant, {
    hasPets: "No", wantsLateCheckout: "Yes", wantsTransfer: "no",
  });
  assert.deepStrictEqual(declined, ["Pet Fee", "Airport Transfer"]);
  assert.deepStrictEqual(unanswered, [], "every question was answered");
  console.log("1) The add-ons the guest declined are named, and the ones they chose are left alone");
}

// ---- 2. the forms of yes and no GHL actually sends ----------------
// Dropdowns send human values, and a checkbox sends a single-element array.
{
  const no = (v) => optionalAddOnsToRemove({ optionalAddOns: [{ field: "f", name: "Pet Fee" }] }, { f: v }).declined.length === 1;
  for (const v of ["No", "no", "NO", " no ", "false", "0", "off", "n", ["No"]]) {
    assert.strictEqual(no(v), true, `"${JSON.stringify(v)}" is a no`);
  }
  for (const v of ["Yes", "si", "sí", "true", "1", "on", ["Yes"]]) {
    assert.strictEqual(no(v), false, `"${JSON.stringify(v)}" is not a no`);
  }
  console.log("2) Every shape of yes and no a GHL form sends is read correctly");
}

// ---- 3. silence charges, and says so ------------------------------
// Overcharging is visible to the guest and recoverable. Dropping a charge
// nobody notices is neither. But an optional add-on that was never asked about
// is a form that has drifted from the listing, so it is recorded rather than
// left to be inferred from an absence.
{
  const { declined, unanswered } = optionalAddOnsToRemove(tenant, { hasPets: "No" });
  assert.deepStrictEqual(declined, ["Pet Fee"]);
  assert.deepStrictEqual(unanswered, ["Late Checkout", "Airport Transfer"],
    "charged as configured, and named so the drift is legible");

  // An unresolved merge tag arrives as null (normalizePayload nulls them), so
  // a workflow that failed to populate the field reads as unanswered rather
  // than as a no. Getting that backwards would silently stop charging.
  assert.deepStrictEqual(
    optionalAddOnsToRemove({ optionalAddOns: [{ field: "f", name: "Pet Fee" }] }, { f: null }).declined,
    [], "a field that did not resolve is not a no"
  );
  console.log("3) An unanswered add-on is still charged, and is recorded rather than passed over");
}

// ---- 4. one entry covers every listing that charges it ------------
// On a booking with more than one listing GHL names the fee after the listing.
// The account configures "Pet Fee" once, not once per property.
{
  assert.strictEqual(matchesAddOnName("Pet Fee", "Pet Fee"), true, "a single-listing booking's plain line");
  assert.strictEqual(matchesAddOnName("Pet Fee - Test Villa 2", "Pet Fee"), true);
  assert.strictEqual(matchesAddOnName("Pet Fee - Test Villa 3", "Pet Fee"), true,
    "so declining pets takes it off every listing, not just the first");

  // Accents and case, because clients start in the DR.
  assert.strictEqual(matchesAddOnName("tarifa por mascota", "Tarifa por Mascota"), true);
  assert.strictEqual(matchesAddOnName("Limpieza - Villa Azúl", "Limpieza"), true);
  console.log("4) One configured add-on matches its line on every listing that charges it");
}

// ---- 5. and does not claim a different add-on --------------------
// Matched on the separator, not as a bare prefix. "Late Checkout" removing
// "Late Checkout Premium" would drop a charge the guest did agree to.
{
  assert.strictEqual(matchesAddOnName("Late Checkout Premium", "Late Checkout"), false);
  assert.strictEqual(matchesAddOnName("Late Checkout Premium - Test Villa 2", "Late Checkout"), false,
    "including when it carries a listing suffix of its own");
  assert.strictEqual(matchesAddOnName("Pet Fee", "Fee"), false, "and not a fragment of the name either");
  assert.strictEqual(matchesAddOnName("", "Pet Fee"), false);
  assert.strictEqual(matchesAddOnName("Pet Fee", ""), false);
  console.log("5) An add-on does not claim the line of another whose name starts the same way");
}

// ---- 6. an account with none of this configured ------------------
// Which is every account today. The pet fee stays hard-wired beside this, so
// nothing changes for them until they configure something.
{
  assert.deepStrictEqual(optionalAddOnsToRemove({}, { hasPets: "No" }), { declined: [], unanswered: [] });
  assert.deepStrictEqual(optionalAddOnsToRemove({ optionalAddOns: [] }, {}), { declined: [], unanswered: [] });
  assert.deepStrictEqual(optionalAddOnsToRemove({ optionalAddOns: "not a list" }, {}), { declined: [], unanswered: [] });

  // A half-written entry is ignored rather than throwing mid-booking.
  assert.deepStrictEqual(
    optionalAddOnsToRemove({ optionalAddOns: [{ field: "f" }, { name: "Pet Fee" }, null] }, { f: "No" }),
    { declined: [], unanswered: [] },
    "an entry missing its field or its name cannot remove anything"
  );
  console.log("6) An account with nothing configured, or something half-configured, is unaffected");
}

console.log("\nPASS — an add-on GHL charges every time comes off when the guest said no.");
