# What this Worker can stop doing

GHL has gained native invoicing, payments, additional fees and security
deposits since this Worker was written. Yari asked (2026-10-13) whether parts of
it can now be retired. This is the answer, grounded in what the three live
tenants actually use rather than in what the code can do.

State as of 2026-10-15:

| | strategy | deposit | gateway | fee |
|---|---|---|---|---|
| Casa Bonita (DEMO) | enrich | GHL native | paypal (via GHL) | 6% |
| Luminara | enrich | `tiered_legacy` | paypal (via GHL) | 6% |
| YV Guest Properties | enrich | GHL native | Stripe (via GHL) | 0 |

Every account is `enrich`: the guest pays a **GHL invoice**, and the Worker adds
lines to it. Nothing routes payment through the Worker any more.

Scale, for judging how much any of this costs to undo: 130 booking snapshots in
KV and 132 ledger rows. This is still demo and test volume.

---

## Tier 1 — dead today, nothing uses it

### The Worker's own checkout (`paypal_url`)

`paypal.js` (68 lines), `stripe.js` (101 lines), the `/paypal/*` and `/stripe/*`
return and cancel routes, and ~10 `paypal_url` branches across `index.js` and
`reschedule.js`.

This is the original flow: the Worker created a PayPal order or Stripe Checkout
session and sent the guest a link, and GHL never saw an invoice. Since #142 the
default is `enrich` and **no tenant states `paypal_url`**.

`stripe.js` is the cleaner case — **no tenant has ever had `gateway: "stripe"`**.
YV takes Stripe payments through GHL's own connection, which this code never
touches.

**Before deleting:** old bookings may still carry a PayPal `captureId`, and
`refundPayPalPartial()` in `reschedule.js` uses it to issue a real refund. Those
live on the booking snapshots in the **BOOKINGS KV** namespace
(`snapshot.captures[*].captureId`, `snapshot.securityDeposit.paypalCaptureId`),
not in D1 — the ledger records amounts, never gateway references. There are 130
snapshots in total, so the audit is a minutes-long job, not a migration.

The order-creation path has no such dependency and can go first; the refund path
waits on that count being zero.

### The no-pets fee strip — `ghl-invoice.js:686`

```js
!(noPets && isPetFeeName(i?.name, tenant)) &&
```

Add-ons became optional in GHL (Yari, 2026-10-09), so a guest without pets is
not charged a pet fee in the first place and there is nothing to strip.

**Keep `isPetFeeName` itself.** It is used a second time at `ghl-invoice.js:449`
inside `isFeeLine()`, where it stops a fee line being mistaken for a property
name. Deleting the function would break that.

### The shadow OTA commission rows

`ledger.js:212-217` writes an informational "what an OTA would have charged" row
when `tenant.otaRate > 0`. **No tenant sets `otaRate`**, so this has never
written a row on a live account. Either set it on an account that wants the
comparison or remove it; leaving dead config in the ledger invites someone to
trust a number that was never produced.

### Stale Airtable comments

Airtable is gone from the code — `ghl.js` replaced `airtable.js`. Five comments
in `booking-composer.js`, `ghl-invoice.js`, `ghl.js` and `reschedule.js` still
describe it as current. Comments only, no behaviour.

---

## Tier 2 — retirable, but one account is holding it

### `deposit-engine.js` (83 lines) and `depositPolicy: "tiered_legacy"`

`policy.js` already defaults every account to `{ rule: "disabled" }` — GHL's
native Security Deposit collects it and the Worker adds nothing. The engine runs
for **Luminara only**, which asked for the graduated model (deposit sized up to
a full stay's rent).

Retire when Luminara moves to GHL's native deposit, or keep it as the
"client asked for something GHL cannot do" exception it was written to be. Not a
cleanup decision — a client conversation.

---

## Tier 3 — not retirable; this is what the Worker is for

GHL has no equivalent for any of these, and together they are ~85% of the code.

**The ledger and the statements.** `ledger.js`, `reports.js`, `manager-pl.js` —
1,900 lines. The 85/15 commission split exists nowhere else: GHL's transactions
object carries `booking_total`, `platform_fee` and `net_payout` and nothing
more. No cleaning margin, no owner/manager split, no per-recipient statement.
The admin dashboard tried to compute an owner statement from GHL's data alone
and printed `$0.00` commission on every one it ever produced (#139, #140).

**Cancellation and reschedule repricing.** `cancellation.js`, `reschedule.js` —
1,860 lines. GHL cannot reprice a booking against a tiered policy, work out what
is owed either way, void or re-issue an invoice, and keep the ledger consistent
with it. The `/cancel` and `/reschedule` endpoints are the system.

**Invoice enrichment.** `ghl-invoice.js` — 856 lines. GHL's rental calendar
creates a rent-only draft; the deposit line, the processing fee, the property
resolution and the pass-through classification are all added here. The
processing fee specifically **cannot** move to a GHL native additional fee:
those bill on the rental base price, while PayPal takes its cut of the whole
captured amount, so a native fee under-recovers — worst on the bookings with the
largest deposits. That is why the native route was rejected outright.

**Expense attribution.** `expenses.js` — owner-borne costs become ledger rows
that reduce that owner's payout. GHL has an Expenses object but no notion of
whose cost it is.

**Multi-listing bundling.** `multi-listing.js` — one reservation across several
listings, priced and cancelled as a unit. GHL has no concept of it.

**Provisioning and schema verification.** `provision.js`, `webhook-seed.js`, and
the dashboard's schema fingerprint. This is what makes a new client account
reproducible.

---

## Recommended order

1. **Delete `stripe.js` and the `/stripe/*` routes.** Zero users, ever. No
   migration, no data to check.
2. **Remove the no-pets strip** (one line) and refresh the Airtable comments.
3. **Decide on `otaRate`** — use it or lose it.
4. **Audit the BOOKINGS KV for outstanding PayPal captures**, then delete the
   Worker's checkout path.
5. **Ask Luminara about the deposit model.** Everything else waits on that.

Steps 1–3 are a single afternoon and remove roughly 150 lines with no behaviour
change on any live account. Step 4 is the big one — a few hundred lines — and
needs the capture audit first. Step 5 is a client conversation, not a code task.

Nothing here touches the ledger, the statements, the repricing or the
enrichment, which is where the Worker's value actually is.
