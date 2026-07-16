# HOMS Invoicing Worker

Booking/invoicing worker for the HOMS platform. Receives GHL reservation
webhooks, computes rent + cleaning + processing fee + tiered security deposit,
creates an itemized PayPal or Stripe checkout, mirrors records to Airtable,
and returns the payment link to GHL.

## Endpoints
- `POST /booking-created` — main entry (GHL Webhook action)
- `GET /paypal/return|cancel`, `GET /stripe/return|cancel` — stubs (payment worker phase)

## Deploys
Auto-deploys on push to `main` via Cloudflare Workers Builds.
Config lives in `wrangler.toml`. Tenant config and secrets live in the
TENANTS KV namespace (managed in the Cloudflare dashboard) — never commit them here.

## Local testing (optional, requires Node 18+)
    node test-worker.js         # full dry run, mocked PayPal/Stripe/Airtable
    node test-deposit-rules.js  # deposit rule engine checks

## Structure
    src/index.js            worker entry, routing, tenant dispatch
    src/booking-composer.js invoice math + snapshot
    src/deposit-engine.js   deposit rules: tiered / fixed / per-night / % / disabled
    src/paypal.js           PayPal Orders v2
    src/stripe.js           Stripe Checkout Sessions
    src/airtable.js         Orders / Order Items / Payments records
