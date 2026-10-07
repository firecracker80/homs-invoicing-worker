# Client mobile web app — scope

**Status:** proposed, nothing started. Two questions below decide the shape; one finding below blocks any release regardless of the answers.

**Asked for by Yari, 2026-10-07:** *"a mobile friendly web-app that will allow the client to have access to their backend, but only the operations specific parts, including their admin dashboard."*

## The finding that blocks everything

**The admin dashboard has one password for every client.**

`handleLogin` compares against a single `ADMIN_KEY` secret and sets a cookie carrying that key. Nothing after that point checks *which* tenant the caller is allowed to see — `?locationId=` selects the account, and any authenticated caller can pass any id. That is why switching tenants is a URL change rather than a UI.

That is fine today, because exactly one person holds the key. **It is fatal the moment a client is given access**: handing a client the key hands them Luminara's revenue, Cruce's guests and every other account on the deployment.

So per-tenant authentication is not a feature of this project — it is the precondition. Nothing client-facing can ship before it exists, and no amount of hiding tabs in the UI substitutes for it, because the API is reachable directly.

## What already exists and can be reused

- A multi-tenant Worker serving the dashboard, with per-tenant PITs in `DASHBOARD_TENANTS` KV and a `kind` discriminator (`client` / `vendor`) that already changes what renders.
- Ten panels: overview, properties, OTA channels, transactions, cleaning checklists, expenses, inventory, reports, owner statement, manager statement.
- A working English/Spanish toggle, so a Spanish client is already served.
- A per-tenant `adminSecret`, used today for the invoicing Worker's reports. Close to what per-tenant login needs, but it authenticates a *Worker*, not a person.
- Statement report tokens (`ownerReportToken`, `managerReportToken`) — a precedent for a per-tenant, per-recipient credential that already exists in the tenant record.

## Why this and not the GHL mobile app

Yari, 2026-10-07: *"objects are still not accessible on mobile app."* Everything HOMS models — properties, transactions, cleaning jobs, expenses, inventory — is a custom object, so GHL's own app shows a client none of it. A form submission works on a phone browser; browsing what was submitted does not. That gap is the whole reason this exists.

## Questions that change the design

### 1. Who logs in?

The answer changes the auth model, not just the menu.

- **The account holder only** — one credential per account. Simplest: per-tenant login, everything behind it scoped to that tenant.
- **Their staff too** (cleaners, a maintenance person) — now there are roles within a tenant, and a cleaner must see today's jobs without seeing revenue. That is a second axis and roughly doubles the work.
- **Owners too** — a third audience who should see their own properties and statements and nothing else, including nothing about other owners on the same account. Report tokens already do a narrow version of this.

### 2. What counts as "operations"?

Operations plausibly means the day-to-day: today's arrivals and departures, cleaning checklists, service requests, capturing an expense with a receipt. Statements and reports are the other half, and "including their admin dashboard" suggests they are wanted too — but a cleaner seeing a P&L is a different decision from the account holder seeing one, which folds back into question 1.

## Shape, once those are answered

Phases, each independently useful:

1. **Per-tenant login.** A credential per tenant, verified against that tenant's record, with every `/api/*` route checking that the session's tenant matches the `locationId` being asked for. This is the blocker and is worth doing even if the app never ships, because it also closes the cross-tenant hole for the dashboard as it stands.
2. **Roles, only if question 1 needs them.** Skip entirely if it is account-holder-only.
3. **A phone layout.** The dashboard is already responsive down to ~900px; phone width is narrower than anything it has been checked at. Tables are the hard part — ten columns do not fit, and a card per row usually beats a horizontally scrolling table.
4. **Installable (PWA).** A manifest and an icon make it an app on the home screen without an app store. Cheap, and it is most of what "feels like an app" means.
5. **Offline-tolerant capture, if cleaners are users.** A cleaner in a basement with no signal still needs to submit a checklist. This is genuinely harder than the rest and should not be assumed in.

## What this is not

- Not a native app. A web app installed to the home screen avoids two app stores, two review processes and a release cycle per fix.
- Not a second codebase. It is the same Worker and the same API, with auth that distinguishes callers and a layout that fits a phone.
- Not a reason to weaken the admin dashboard's own access. Yari's operator view keeps the full cross-tenant reach it has now; the client's is a narrower door into the same building.
