# Pushing a snapshot to a live account

What a snapshot load replaces, what it must not touch, and what has to be
re-wired by hand afterwards. Written for the Luminara workflow overhaul
(2026-09-29) but it applies to any push onto an account that already has real
bookings in it.

DEMO-HOMS is a test account and can absorb a bad push. Luminara cannot: she has
live guests, live invoices and a D1 ledger with real money in it.

---

## The one that breaks payments silently

**A snapshot load mints new UUIDs for every Inbound Webhook trigger and every
form.** Those UUIDs are not readable through any API — the workflows endpoint
returns no trigger data, which is why six custom values carry `policy: "manual"`
and the reconciler is forbidden from writing them.

So after the push, these six point at triggers that no longer exist:

| custom value | what stops |
|---|---|
| `WGHL Payment Confirmation URL` | the Worker cannot tell GHL a payment landed |
| `WGHL Cancelation URL` | no cancellation notification, to guest or manager |
| `WGHL Reschedule URL` | no reschedule notification |
| `WGHL Deposit URL` | no deposit-refund notification |
| `WGHL Solicitud del Huesped URL` | the guest request form link is dead |
| `WGHL Inspeccion URL` | the inspection form link is dead |

None of these fail loudly. The Worker POSTs, gets a 404 or a 200 from nothing,
records `ok:false` on the snapshot, and carries on — settlement still succeeds
and the guest hears nothing.

**After the push, open each new workflow, copy its trigger URL, and paste it
into the matching custom value.** That is the single highest-risk step and it is
entirely manual.

---

## Must survive the push

### Generated secrets — clobbering any of these breaks a live account

| value | what breaks if it changes |
|---|---|
| `WWebhook Secret` | the Worker rejects every booking webhook |
| `WAdmin Secret` | cancel and reschedule stop working |
| `WOwner Report Token` | the owner cannot open their statement |
| `WManager Report Token` | the manager cannot open theirs |
| `WAuthorization PIN` | the guest-request form stops authorising |

The reconciler mints these **only when blank** and never rotates over a value.
A snapshot load is not the reconciler, so check each one still holds its
pre-push value.

### Client configuration — re-entering these by hand is the cost of getting it wrong

Brand name, property owner, manager, locale, currency, cleaning fee, owner
revenue split, both PayPal emails, PayPal client ID, PayPal webhook ID,
cancellation policy, service cost currency, manager notification email.

### Not in GHL at all, and therefore safe — but must match the new wiring

- The invoicing Worker's KV tenant record (`TENANTS`)
- The dashboard's registry entry (`DASHBOARD_TENANTS`)
- Worker secrets: the PIT, the PayPal secret key
- D1 ledger rows

A snapshot cannot touch these. They can still be left pointing at the old
wiring, which is the same failure by another route.

### Records, not schemas

Properties, transactions, expenses, inventory, contacts, and the rental
calendars with their iCal links. **Confirm the snapshot carries schemas and not
records before pushing** — a snapshot that includes calendar definitions would
land on top of her real listings.

---

## Luminara-specific

### She is the legacy tenant, and a policy pushed to her is ignored

Her KV holds `depositPolicy: "tiered_legacy"`. `cancellationTier` branches on
that **before** reading `tenant.cancellationPolicy`, so the legacy hardcoded
tiers (100% checked-in / 50% under 24h / 30% under 5d / 20% over) win.

Provisioning maps `WCancellation Policy` → `tenant.cancellationPolicy` in KV.
So if the push gives her that custom value and it gets filled, **the account
will display one policy and the Worker will apply another**, with nothing
reporting the difference. Decide before the push whether she is moving off the
legacy policy; if she is, `depositPolicy` has to change in KV at the same time.

The same flag drives deposits: legacy means her deposit rule is honoured, and
everyone else is `disabled`.

### She has 19 custom values, DEMO-HOMS has 23

The push would add Group E: cancellation policy, service cost currency, manager
notification email, and the two form URLs. The first three are wanted. The
manager notification email matters more than it looks — the address used to be
written into a workflow email action where no API can read it, so a cloned
account kept the template address and the real manager heard nothing.

### `optionalAddOns` is Worker KV, not a custom value

If Luminara gets the same early check-in / late check-out fees, they need an
`optionalAddOns` entry in her KV tenant record or the "No" answer will not
remove the charge. Nothing in the snapshot does this.

---

## Order that avoids the worst of it

1. Record the current value of all 23 custom values on Luminara. This is the
   backup, and there is no other one.
2. Confirm the snapshot's contents: schemas yes, records no, calendars no.
3. Push.
4. Re-enter the six `manual` URLs from the newly minted triggers.
5. Check the five generated secrets still hold their pre-push values.
6. Re-check the client configuration values against step 1.
7. Send one real booking through end to end — booking, invoice, payment,
   cancellation — and confirm each notification actually arrives. Every failure
   mode above is silent, so the only proof is a message landing.
