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
- `GET /reports/owner-statement`, `GET /reports/manager-statement` — D1-backed statement, `?format=json` or the default branded HTML (admin-triggered, `X-Admin-Secret`)
- `GET /reports/reconcile` — diffs D1's income-bearing bookings against GHL's `list-transactions` for the same window (admin-triggered)

Settlement (`src/payment.js`) writes captures/fees to Payments, generates Transaction Ledger + Payout Ledger rows (85/15 rent-only split, cleaning fee per profile), materializes the same split into D1 (`src/ledger.js`, non-blocking), and notifies GHL via the tenant's `ghlPaymentConfirmedUrl` inbound webhook.

## Ledger + statements (D1)
`src/ledger.js` writes one `ledger_entries` row per money movement at settlement time — owner/manager rent split (`income`), cleaning fee (`income`, to whoever the profile names), security deposit (`liability`, held, never split), processing fee (`pass_through`, never split), and an optional `shadow` OTA-commission comparison if the tenant has `otaRate` configured (skipped entirely otherwise — never guesses a commission rate). Idempotent: a `UNIQUE(booking_id, entry_type)` index + `INSERT OR IGNORE` means a retried settlement writes zero duplicate rows. Schema in [schema/homs_ledger_schema.sql](./schema/homs_ledger_schema.sql).

`src/reports.js` serves the two statements as a plain `GROUP BY` + detail list over those rows — no split logic gets recomputed in SQL — and the reconciliation endpoint, which is only meaningful for `invoiceStrategy: "enrich"` bookings (a `paypal_url` booking never touches GHL's own transactions ledger, so it's correctly excluded rather than flagged as a false discrepancy).

Add `otaRate` to a tenant's KV entry (e.g. `0.15`) to enable the shadow-commission line on their owner statements.

## Invoice strategy (GHL invoice enrichment — additive, flag-gated)
`/booking-created` can, instead of generating a PayPal/Stripe checkout link, enrich and send the DRAFT invoice GHL's rental calendar already auto-creates at booking (rent line only): append cleaning + security deposit + processing-fee lines to it, stamp the invoice number, and send it via `send-invoice`. See `src/ghl-invoice.js` for the schema notes — several assumptions in an earlier draft didn't match the live GHL API (`update-invoice` requires the full body, not just `invoiceItems`; `send-invoice`'s real fields are `userId`/`action`/`liveMode`, not `sendTo`/`deliver`) and were corrected against `describe_operation` output before this shipped.

Controlled by `INVOICE_STRATEGY` (env var, default `"paypal_url"` — today's behavior, unchanged) with a per-tenant override (`tenant.invoiceStrategy` in the TENANTS KV entry, `"paypal_url"` or `"enrich"`). Any failure in the enrich path falls through to the existing PayPal-URL flow automatically — a guest never sees a broken booking because of it.

The correlation number stamped on the invoice IS `bookingId` itself — the real rental-calendar booking id, captured at the contact level and fed in via the `{{contact.booking_id}}` merge tag on the webhook body, not a HOMS-invented prefix. Likewise `send-invoice`'s required `userId` comes from `{{user.id}}` on the same webhook body, not tenant config — scales to every user on every account with zero per-client GHL-user setup.

Tenant KV additions this needs (per-client, alongside the existing PayPal/Airtable fields): `ghlPit` (or `ghlPitSecretName` for a Worker secret — a GHL Private Integration Token scoped to `invoices.readonly`+`invoices.write`), and optionally `ghlInvoiceSendAction` (`sms_and_email` default, or `email`/`sms`/`send_manually`) and `ghlInvoiceLiveMode` (default `true`).

See [ONBOARDING.md](./ONBOARDING.md) for the full new-client checklist.

## Deploys
Auto-deploys on push to `main` via Cloudflare Workers Builds.
Config lives in `wrangler.toml`. Tenant config and secrets live in the
TENANTS KV namespace (managed in the Cloudflare dashboard) — never commit them here.

## Local testing (optional, requires Node 18+)
    node test-worker.js              # full dry run, mocked PayPal/Stripe/Airtable
    node test-ghl-invoice.js         # invoice-enrichment schema + end-to-end flag/fallback tests
    node test-reschedule-unpaid.js   # rescheduling a never-paid booking re-prices + fresh idempotency key
    node test-ledger-reports.js      # ledger materialization, idempotency, /reports/* endpoints, reconciliation
    node test-deposit-rules.js       # deposit rule engine checks

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
    src/ghl-calendar.js     push new dates onto the actual GHL rental-calendar booking
    src/ghl-invoice.js      GHL invoice enrichment (additive, INVOICE_STRATEGY="enrich")
    src/ledger.js           materializes the settlement split into D1 (ledger_entries)
    src/reports.js          owner/manager statements + D1-vs-GHL reconciliation
