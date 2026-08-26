# HOMS Invoicing Worker

Booking/invoicing worker for the HOMS platform. Receives GHL reservation
webhooks, computes rent + cleaning + processing fee + tiered security deposit,
creates an itemized PayPal or Stripe checkout, mirrors records to Airtable,
and returns the payment link to GHL.

## Endpoints
- `POST /booking-created` — main entry (GHL Webhook action)
- `GET /paypal/return`, `POST /paypal/webhook` — captures both purchase units, verifies signature, settles the booking
- `GET /stripe/return`, `POST /stripe/webhook` — verifies session/HMAC, settles the booking
- `POST /reschedule` — moves a paid booking to new dates, handles delta charge/refund (admin-triggered, `X-Admin-Secret`)
- `POST /cancel` — tiered cancellation charge (admin-triggered)
- `POST /deposit/refund` — post-checkout deposit refund (admin-triggered)
- `GET /paypal/cancel`, `GET /stripe/cancel` — guest-cancelled-checkout landing

Settlement (`src/payment.js`) writes captures/fees to Payments, generates Transaction Ledger + Payout Ledger rows (85/15 rent-only split, cleaning fee per profile), and notifies GHL via the tenant's `ghlPaymentConfirmedUrl` inbound webhook.

## Invoice strategy (GHL invoice enrichment — additive, flag-gated)
`/booking-created` can, instead of generating a PayPal/Stripe checkout link, enrich and send the DRAFT invoice GHL's rental calendar already auto-creates at booking (rent line only): append cleaning + security deposit + processing-fee lines to it, stamp a `CC-{bookingId}` correlation number, and send it via `send-invoice`. See `src/ghl-invoice.js` for the schema notes — several assumptions in an earlier draft didn't match the live GHL API (`update-invoice` requires the full body, not just `invoiceItems`; `send-invoice`'s real fields are `userId`/`action`/`liveMode`, not `sendTo`/`deliver`) and were corrected against `describe_operation` output before this shipped.

Controlled by `INVOICE_STRATEGY` (env var, default `"paypal_url"` — today's behavior, unchanged) with a per-tenant override (`tenant.invoiceStrategy` in the TENANTS KV entry, `"paypal_url"` or `"enrich"`). Any failure in the enrich path falls through to the existing PayPal-URL flow automatically — a guest never sees a broken booking because of it.

Tenant KV additions this needs (per-client, alongside the existing PayPal/Airtable fields): `ghlToken` (or `ghlTokenSecretName` for a Worker secret), `ghlUserId` (the GHL user id `send-invoice` sends as), and optionally `ghlInvoiceSendAction` (`sms_and_email` default, or `email`/`sms`/`send_manually`) and `ghlInvoiceLiveMode` (default `true`).

## Deploys
Auto-deploys on push to `main` via Cloudflare Workers Builds.
Config lives in `wrangler.toml`. Tenant config and secrets live in the
TENANTS KV namespace (managed in the Cloudflare dashboard) — never commit them here.

## Local testing (optional, requires Node 18+)
    node test-worker.js         # full dry run, mocked PayPal/Stripe/Airtable
    node test-ghl-invoice.js    # invoice-enrichment schema + end-to-end flag/fallback tests
    node test-deposit-rules.js  # deposit rule engine checks

## Structure
    src/index.js            worker entry, routing, tenant dispatch, GHL payload normalization
    src/booking-composer.js invoice math + snapshot
    src/deposit-engine.js   deposit rules: tiered / fixed / per-night / % / disabled
    src/paypal.js           PayPal Orders v2
    src/stripe.js           Stripe Checkout Sessions
    src/airtable.js         Orders / Order Items / Payments / ledger records
    src/payment.js          capture, settlement, ledgers, GHL payment-confirmed notify
    src/cancellation.js     tiered cancellation charges + deposit refunds
    src/reschedule.js       move a paid booking to new dates (delta charge/refund)
    src/ghl-invoice.js      GHL invoice enrichment (additive, INVOICE_STRATEGY="enrich")
