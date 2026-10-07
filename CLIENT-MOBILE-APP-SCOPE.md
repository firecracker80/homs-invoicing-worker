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

## Decided, Yari 2026-10-07

**The account holder only.** No staff logins, no owner logins. One credential per account, everything behind it scoped to that account. Roles inside a tenant are not in scope, which removes most of the work this could have been — and widening it later does not require redoing it, because a session that names a tenant is the thing a role would hang off.

**The whole admin dashboard, plus the day-to-day.** Not a reduced subset: the account holder is the person the dashboard was already built for, so the question is only whether it fits on a phone, not what to remove.

**Expense capture is already done, natively, and needs nothing here.** Yari: *"the expense capture form is ready, i did see it in the object once an expense name is added."* GHL's own object form takes the receipt photo or PDF. Building a second capture path in this app would be a worse copy of something that already works, so the app links to that form rather than reimplementing it.

That leaves three phases, and the first is the only hard one.

### 1. Per-tenant login — the blocker

A credential per tenant, held in that tenant's own record, and a session that names which tenant it is for.

- `POST /api/login` takes `{ locationId, key }` rather than `{ key }`, and verifies the key against that tenant's record. The operator's `ADMIN_KEY` keeps working and keeps reaching every tenant, because Yari's view must not narrow.
- The cookie stops carrying the key. It carries a signed token naming the tenant and an expiry, so possession of a cookie proves a login happened for *that* account and nothing more.
- Every `/api/*` route then checks the session's tenant against the `locationId` being asked for, and refuses a mismatch. This belongs in the one default-deny gate rather than in each route — a route that forgets is exactly how the current hole would come back.

Two things worth settling as it is built:

- **A client key is a password a person types.** It needs to be rotatable per tenant without touching anyone else, and revocable the day a client leaves.
- **A mismatch is a 403, not a 404.** Telling a caller that another tenant exists is not a leak worth engineering around, and a 404 would send a legitimately confused client chasing a bug that is not there.

### 2. A phone layout

The dashboard is responsive to roughly 900px; phone width is narrower than anything it has been checked at. The tables are the real work — ten columns do not fit, and a card per row generally beats a horizontally scrolling table. Everything else mostly already reflows.

### 3. Installable

A manifest and an icon make it an app on the home screen with no app store, no review and no release cycle per fix. Cheap, and it is most of what "feels like an app" actually means.

### Not in scope, and why

- **Roles.** Account holder only, by the decision above.
- **An expense capture form.** GHL's object form already does it, including the receipt.
- **Offline capture.** That mattered for cleaners in basements with no signal. No cleaners log in, so it goes.

## What this is not

- Not a native app. A web app installed to the home screen avoids two app stores, two review processes and a release cycle per fix.
- Not a second codebase. It is the same Worker and the same API, with auth that distinguishes callers and a layout that fits a phone.
- Not a reason to weaken the admin dashboard's own access. Yari's operator view keeps the full cross-tenant reach it has now; the client's is a narrower door into the same building.
