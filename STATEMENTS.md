# Owner/manager statement delivery

How `/reports/owner-statement` and `/reports/manager-statement` ([reports.js](src/reports.js))
get in front of an actual owner or manager, without building a login system
of our own.

## Why not GHL's Client Portal

Checked directly (Luminara, 2026-08-31): the Client Portal (Suscripciones →
Portal del cliente) is a fixed suite of built-in apps — Comunidades, Cursos,
Afiliados, Facturación y suscripción, Contratos, Estimación, Archivos
compartidos, Appointments. No custom-page or iframe slot exists there, and
there's no write API to push a file into a contact's "Archivos compartidos"
either. Ruled out.

## What actually works: Custom Menu Link

GHL's **Custom Menu Link** (a sub-account's main nav, not the contact-facing
portal) supports an iframe, and is access-controlled per sub-account. Set
one up per tenant with the iframe `src` pointing at the statement URL.

## Auth: a token in the URL, not the admin secret

An iframe can't send the `X-Admin-Secret` header `/cancel` and `/reschedule`
use. So the two statement routes *also* accept `?token=`, checked against a
**separate, low-privilege** per-tenant secret:

- `tenant.ownerReportToken` — gates `/reports/owner-statement`
- `tenant.managerReportToken` — gates `/reports/manager-statement`

Deliberately not `adminSecret`: that token ends up sitting in an iframe src
(browser history, possibly referrer headers), and a leak of it should only
expose *one* recipient's statement — never the ability to cancel a booking.
Owner and manager get separate tokens so one can't view the other's numbers
just by swapping the URL path. Generate with the same one-liner as
`adminSecret` (see [ONBOARDING.md](ONBOARDING.md) step 4).

## Scoping to a specific person: `recipientName`

`recipient` (`owner`/`manager`) alone scopes to the whole tenant/location —
fine for a tenant with exactly one owner and one manager. A tenant with
several owners or managers across different properties (see ONBOARDING.md
step 9 for the `ownerName`/`managerName`/`propertyOwnerNames`/
`propertyManagerNames` config) needs `&recipientName=<name>` on the URL to
narrow to just that person's rows.

Each individual owner/manager therefore needs their **own** Custom Menu
Link (or their own direct link, sent to them rather than shown in a shared
nav item) — GHL's Custom Menu Link access control is per-sub-account, not
per-logged-in-user, so there's no way for one shared menu item to show
different content to different people automatically.

## Example URL

```
https://homs-invoicing-worker-0e0e.yari-058.workers.dev/reports/owner-statement
  ?locationId=wLGDbGcQ4QSG3nlT3Sis
  &token=<tenant.ownerReportToken>
  &recipientName=Marco        (omit for a single-owner tenant)
  &format=html
```
