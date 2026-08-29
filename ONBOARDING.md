# Onboarding a new client

One `TENANTS` KV entry per client, keyed by their GHL `locationId`. No code
changes, no redeploy — the same Worker deployment serves every tenant.

## 1. Airtable
Duplicate the base template for the new client. Grab:
- `airtableBaseId` (the `app...` segment of the base URL)
- `airtableToken` — Personal Access Token scoped to `data.records:read` +
  `data.records:write` on that base only
- `defaultPropertyRecId` — the property record's `rec...` ID

## 2. Payment gateway
Either PayPal (`paypalApi`, `paypalClientId`, `paypalSecret`) or Stripe
(`stripeSecretName`/`stripeSecret`), matching whichever this client uses —
set `gateway` accordingly.

## 3. GHL Private Integration Token
Settings → Private Integrations → Create New Integration, scoped to
`invoices.readonly` + `invoices.write`. This one `ghlPit` covers both invoice
enrichment and `ghl-calendar.js`'s calendar sync.

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
Cloudflare dashboard → Workers & Pages → homs-invoicing-worker-0e0e →
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
  "defaultPropertyRecId": "rec...",
  "airtableBaseId": "app...",
  "airtableToken": "pat...",
  "paypalApi": "https://api-m.sandbox.paypal.com",
  "paypalClientId": "...",
  "paypalSecret": "...",
  "ghlPit": "pit-...",
  "invoiceStrategy": "enrich"
}
```

Everything else (`checkInHour`/`checkOutHour`/`tzOffsetHours`, `webhookSecret`,
`adminSecret`, `locale`, `defaultLanguage`, `invoiceDueHours`, `thankYouUrl`,
`properties`, `ghlInvoiceSendAction`, `ghlInvoiceLiveMode`) has a sane
default — only set it if this client needs something different.

## 8. Ledger + statements (optional)
Add `"otaRate": 0.15` (or whatever their real comparison rate is) if you
want the owner statement to show what an OTA commission would have cost on
this client's bookings. Omit it entirely and that line just doesn't appear —
never guess a rate on a client's behalf.

## 9. Test
Fire one real booking through their form, watch Cloudflare → Logs → Begin
log stream. `invoiceEnrichError` in the response body and GHL's actual
validation message in the log (via `ghlFetch`) should make any tenant-
specific issue fast to diagnose without another round of guessing. Check
`/reports/owner-statement?locationId=...&format=json` afterward to confirm
the ledger picked it up.
