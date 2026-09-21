# Onboarding a new client

One `TENANTS` KV entry per client, keyed by their GHL `locationId`. No code
changes, no redeploy — the same Worker deployment serves every tenant.

**Airtable retired.** This worker used to mirror bookings into an Airtable
base (`airtableBaseId`/`airtableToken`/`defaultPropertyRecId` in the tenant
KV entry). That's gone — `src/airtable.js` was deleted; `payment.js`,
`cancellation.js`, and `reschedule.js` now write straight to D1
(`src/ledger.js`) and sync to the client's own GHL `Transaction`/`Revenue` (key `custom_objects.payments`)
custom objects. Property matching, which used to resolve `defaultPropertyRecId`
against the Airtable base, now resolves against the client's GHL
`custom_objects.properties` object instead — matched by `property_name`
equal to the booking's `propertyCode` (see `ledger.js`'s `findRecordByName`
call). A new client just needs their Properties records to exist in GHL with
`property_name` values matching whatever `propertyCode` their booking form
sends — nothing to set up in the tenant KV for this.

## 1. Payment gateway
Either PayPal (`paypalApi`, `paypalClientId`, `paypalSecretName`) or Stripe
(`stripeSecretName`/`stripeSecret`), matching whichever this client uses —
set `gateway` accordingly.

**Put the PayPal secret in a Worker secret, not KV and not GHL:**
```
wrangler secret put PAYPAL_SECRET_<CLIENT>
```
then set `"paypalSecretName": "PAYPAL_SECRET_<CLIENT>"`. Inline `paypalSecret`
in KV still works (pilot fallback in `paypal.js`) but is readable by anyone
with KV access. Leave the `wpaypal_secret_key` Custom Value **blank** in GHL —
it's readable by every sub-account user, and provisioning never reads it.

## 2. GHL Private Integration Token
Settings → Private Integrations → Create New Integration, scoped to
`invoices.readonly` + `invoices.write`. This one `ghlPit` covers both invoice
enrichment and `ghl-calendar.js`'s calendar sync.

## 3. Admin secret — every client gets their own
Generate a fresh random secret per client (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
and set it as `adminSecret` in their KV entry. This is what gates
`/cancel`, `/reschedule`, `/deposit/refund`, and the `/reports/*` statement
endpoints.

**Don't rely on the global `ADMIN_SECRET` Worker secret once you have more
than one unrelated client.** `adminAuthorized` checks `tenant.adminSecret ||
env.ADMIN_SECRET` — the global one is a fallback shared across *every*
tenant that doesn't set their own, so it isn't scoped to a single client at
all. Knowing it unlocks admin actions on every client still relying on the
fallback, not just one. Treat the global secret as your own personal/
internal-testing fallback only — never hand it to a client's own tooling,
and never let two unrelated clients share one.

Whatever fires `/cancel`/`/reschedule` on this client's behalf (your own
internal automation, or theirs) needs this value — store it the same place
you'd store any other client credential, not just in this doc.

## 4. Webhook body merge tags
Confirm the `/booking-created` webhook action's JSON body includes:
```json
"bookingId": "{{contact.booking_id}}",
"userId": "{{user.id}}"
```
Both of these were missing on Luminara's first setup and caused real
failures (enrichment fell back to PayPal until each was added) — don't
assume they're already there.

## 5. Verify the rental calendar auto-creates a draft invoice
The invoice-enrichment path assumes GHL's rental module creates a rent-only
draft invoice at booking time. Check Payments → Invoices for this client
before flipping the flag on, rather than finding out via a live failure.

## 6. GHL inbound-webhook URLs (optional, per notification)
Each of these is a GHL **Inbound Webhook trigger** URL — only set the ones
where that workflow already exists in the client's sub-account:
- `ghlPaymentLinkUrl` — payment link ready
- `ghlPaymentConfirmedUrl` — payment confirmed
- `ghlCancellationUrl` — booking cancelled
- `ghlDepositRefundUrl` — deposit refunded
- `ghlRescheduleUrl` — booking rescheduled

## 7. The KV entry

**Fast path — auto-provision from GHL's Custom Values.** If you've already
filled in the client's Custom Values when cloning the snapshot (steps 1-6
cover most of the same fields), you can skip typing everything a second
time. See [provision.js](src/provision.js) — hit it as a GET first (dry
run, never writes) to sanity-check the mapping, then POST to actually write:
```
GET  https://homs-invoicing-worker-0e0e.yari-058.workers.dev/admin/provision-tenant?locationId=...&ghlPit=...&paypalSecretName=PAYPAL_SECRET_<CLIENT>
POST https://homs-invoicing-worker-0e0e.yari-058.workers.dev/admin/provision-tenant?locationId=...&ghlPit=...&paypalSecretName=PAYPAL_SECRET_<CLIENT>
```
Set the Worker secret (step 1) **before** calling this. `paypalSecretName` is
the secret's *name*, never its value. Without it, `gateway` is not inferred;
if the named secret isn't set on the Worker, the response carries a
`warnings` entry telling you the `wrangler secret put` to run.
`X-Admin-Secret` header = the **global** `ADMIN_SECRET` Worker secret (not a
tenant's own — the tenant doesn't exist yet). Check `unmappedCustomValues`
in the response for anything it didn't recognize, `mappedFromCustomValues`
for what it did, `skippedSensitive` for credentials it deliberately ignored,
and `warnings`. It only covers what's mappable from Custom Values — the
gateway's live credentials beyond client ID/secret, `invoiceStrategy`, and
anything under step 8 still need filling in by hand afterward. Re-running it
against an already-provisioned tenant requires `&force=true` and merges
rather than overwrites (a hand-set field like `otaRate` survives; provisioned
fields refresh).

**Manual path.** Cloudflare dashboard → Workers & Pages → homs-invoicing-worker-0e0e →
Storage & Databases → KV → **TENANTS** → Add entry, key = the client's
`locationId`:

```json
{
  "brandName": "Client Name",
  "currency": "USD",
  "ownerPct": 0.85,
  "processingFeePct": 0.06,
  "defaultCleaningFee": 69,
  "cleaningFeeRecipient": "manager",
  "gateway": "paypal",
  "deposit": { "rule": "tiered" },
  "bookingWorkerEnabled": true,
  "paypalApi": "https://api-m.sandbox.paypal.com",
  "paypalClientId": "...",
  "paypalSecretName": "PAYPAL_SECRET_CLIENT",
  "ghlPit": "pit-...",
  "adminSecret": "...",
  "invoiceStrategy": "enrich"
}
```

Everything else (`checkInHour`/`checkOutHour`/`tzOffsetHours`, `webhookSecret`,
`locale`, `defaultLanguage`, `invoiceDueHours`, `thankYouUrl`, `properties`,
`ghlInvoiceSendAction`, `ghlInvoiceLiveMode`) has a sane default — only set
it if this client needs something different. `adminSecret` is the one
exception to "has a sane default" — see step 3, it doesn't have one on
purpose.

## 8. Ledger + statements (optional)
Add `"otaRate": 0.15` (or whatever their real comparison rate is) if you
want the owner statement to show what an OTA commission would have cost on
this client's bookings. Omit it entirely and that line just doesn't appear —
never guess a rate on a client's behalf.

**Multiple owners or managers under one tenant.** A tenant with just one
owner and one manager total doesn't need anything here — `/reports/owner-statement`
and `/reports/manager-statement` already scope to the whole location.
A tenant managing several properties for *different* owners (or a manager
who only handles some of them) needs a name on each row to tell them apart:
```json
"ownerName": "Jane Doe",
"managerName": "Property Co",
"propertyOwnerNames": { "PROP-B": "Marco" },
"propertyManagerNames": { "PROP-B": "Diego" }
```
`ownerName`/`managerName` are the tenant-wide default; `propertyOwnerNames`/
`propertyManagerNames` (keyed by `propertyCode`) override it per property.
Then pass `&recipientName=Marco` on the statement URL to scope to just that
person — see [reports.js](src/reports.js) and [STATEMENTS.md](STATEMENTS.md)
for the iframe/token delivery mechanism. This only affects bookings created
*after* the name config is set — it isn't backfilled onto already-written
ledger rows.

## 9. Test
Fire one real booking through their form, watch Cloudflare → Logs → Begin
log stream. `invoiceEnrichError` in the response body and GHL's actual
validation message in the log (via `ghlFetch`) should make any tenant-
specific issue fast to diagnose without another round of guessing. Check
`/reports/owner-statement?locationId=...&format=json` afterward to confirm
the ledger picked it up.
