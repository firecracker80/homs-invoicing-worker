# DEMO-HOMS snapshot inventory

**2026-11-16 (Forge).** Built from live reads against DEMO-HOMS
(`ZghxU8I60bEm39JUbtCm`) and from the repos. **Not from memory notes** — where a
note and the live read disagree, §8 says so. Read-only: nothing created, updated
or deleted.

Evidence tags: **[V]** live read today with the endpoint named · **[N]** not
readable, with the reason.

Reads used `GHL_PIT_DEMO_HOMS` over curl. (Python `urllib` is 403'd by GHL's
Cloudflare for every token, which looks exactly like a dead credential.)

---

## 1. Custom objects — 8 user-defined, 3 system

**[V] `GET /objects/?locationId=`** and **[V] `GET /custom-fields/object-key/{key}`**

| object | label | fields | type |
|---|---|---|---|
| `custom_objects.jobs_tmpl` | Cleaning Checklists | **21** | USER |
| `custom_objects.service_requests` | Service Requests | **18** | USER |
| `custom_objects.expenses` | Expenses | 13 | USER |
| `custom_objects.payments` | Revenue Streams | 12 | USER |
| `custom_objects.transactions` | Transactions | 11 | USER |
| `custom_objects.properties` | Properties | 10 | USER |
| `custom_objects.property_inventory` | Property Inventory | 9 | USER |
| `custom_objects.ota_channels` | OTA Channels | 8 | USER |
| `business` / `opportunity` / `contact` | — | — | SYSTEM |

**Who can switch it: NOBODY.** These ship in the snapshot and install into every
client account on creation. A Worker flag cannot un-ship an object. This is the
single most important fact for the plan split — see §7.

**[V]** Custom fields overall: **180** across all models — 73 on `contact`,
**only 5 on `opportunity`**, the rest on the custom objects above.

> Note the opportunity gap: DEMO-HOMS has 5 opportunity custom fields where HOMS
> has 23. The lodging-board and support fields live in HOMS, not the template —
> correct, since those are HOMS-side features, not client ones.

## 2. Pipelines — 4

**[V] `GET /opportunities/pipelines?locationId=`**

| pipeline | stages |
|---|---|
| **Reserva** | 9 — Reserva Pago Pendiente · Reserva Confirmada · Solicitud de Cancelación · Cancelación sin Excepción · Cancelación con Excepción · Reembolso Emitido · Reserva Reagendada · Checked-In · Checked-Out |
| **Survey** | 6 — Survey Sent · Positive Experience · Needs Attention · Follow-Up Positive · Follow-Up Negative · Cold / No Response |
| **Devolución** | 3 — Solicitud - Devolucion · Devolucion Confirmado · Devolucion Negado |
| **Review Request** | 3 — Review request sent · GBP Review Completed · Declined |

Switchable by: **nobody** (snapshot).

## 3. Custom values — 26, every one Worker config

**[V] `GET /locations/{id}/customValues`** — key names only; no values read or
recorded.

All 26 are `W*`-prefixed and exist to configure the Worker per tenant:
`wadmin_secret`, `wauthorization_pin`, `wbrand_name`, `wcancellation_policy`,
`wcurrency`, `wghl_cancelation_url`, `wghl_deposit_url`,
`wghl_inspeccion_url`, `wghl_payment_confirmation_url`,
`wghl_reschedule_url`, `wghl_solicitud_del_huesped_url`, `wlocale`,
`wlocation_id`, `wmanager`, `wmanager_notification_email`,
`wmanager_report_token`, `wmgr_paypal_email`, `wowner_paypal_email`,
`wowner_report_token`, `wowner_revenue_split`, `wpaypal_client_id`,
`wpaypal_secret_key`, `wpaypal_webhook`, `wproperty_owner`,
`wservice_cost_currency`, `wwebhook_secret`.

**This is the per-tenant configuration surface**, written by provisioning. Note
four `wghl_*_URL` values must hold GHL's own inbound-webhook trigger URLs, not
Worker endpoints — a pairing that has been reversed before.

**Five PayPal values remain** (`wpaypal_client_id`, `wpaypal_secret_key`,
`wpaypal_webhook`, `wmgr_paypal_email`, `wowner_paypal_email`) although the
Worker's own checkout was retired 2026-10-16 and both real tenants settle on the
PayPal path only in name. Candidates for removal; **not** removed here.

## 4. Tags — 21

**[V] `GET /locations/{id}/tags`**

`abnb`, `active-guest`, `booking-cancelled`, `booking-modified`,
`booking-rescheduled`, `cancel-needs-manual-refund`, `deposito-devuelto`,
`deposito-retenido`, `fridge-stock-add-on`, `huesped-activo`,
`manager review needed`, `pago-pendiente`, `pago_confirmado`,
`payment-confirmed`, `property-owner`, `reschedule-needs-manual-refund`,
`reserva-cancelada`, `reserva-confirmada`, `reserva-extension`,
`reserva-no-confirmado`, `reserva-reagendada`.

**Mixed language and mixed convention**, with apparent ES/EN duplicates
(`pago_confirmado` / `payment-confirmed`, `reserva-confirmada` /
`booking-modified` family) and one with spaces (`manager review needed`). Worth
a tidy, but each is probably referenced by a workflow, so **do not delete
without checking** — and workflow definitions are not API-readable (§6).

## 5. Products — 23, with duplicates and one that causes a known bug

**[V] `GET /products/?locationId=`**

Listings: Villa Azul ×2, Villa Amarilla, Vila Verde *(sic — likely "Villa")*,
Arpel 07, Residencial Vivas I.
Fees: **Processing Fee**, Pet Fee ×2, Cleaning Fee, Security Deposit,
Additional Guests, Add Person(s), Early Check-In / Early Check-in,
Late Check-out ×2.
Experiences: Imprescindibles Para la Nevera, Catamarán Boca Chica, Experiencia
Gastronómica Zona Colonial, Decoración Para Ocasiones Especiales, Transporte
Aeropuerto, Airport Shuttle.

**Three things here are defects, not inventory:**

1. **A product literally named `Processing Fee`** — capital F. This is the live
   source of the bug PR #175 fixed: the Worker writes `Processing fee`, matched
   exactly, so the product was treated as a native charge, got 6% charged on top
   of itself and collected a second fee line. Confirmed present, so #175 is not
   theoretical.
2. **Near-duplicate pairs**: `Early Check-In` / `Early Check-in`,
   `Late Check-out` ×2, `Pet Fee` ×2, `Villa Azul` ×2, and
   `Additional Guests` / `Add Person(s)` / `Airport Shuttle` /
   `Transporte Aeropuerto` doing the same jobs in two languages.
3. **`Vila Verde`** is probably a typo for Villa Verde, and it is guest-facing.

## 6. Workflows — 27, and Scout's 403 was narrower than reported

**[V] `GET /workflows/?locationId=`** — this **worked**. 27 workflows with name,
status and version.

**Correction worth carrying:** the 403
`WORKFLOW_API_NOT_ENABLED_FOR_LOCATION` applies to the **v2 workflow API**
(`/workflows/search`, `/workflows/{id}/definition`, `/workflows/step-types`), not
the legacy list endpoint. So names, statuses and versions need **no browser
pass**. Trigger types and actions still do.

**Published (20):** Booking Check-In Status Tracking · Booking Platform Guests ·
Booking Received / Payment Window · Checkout Cleaning Notification · Cleaning
Checklist Submitted - Notify Manager · Confirmed Rental Booking · Deposit
Refunded · GHL Invoice Url · Guest Cancel/Reschedule Request · Payment Confirmed
· Process Cancellation *(v30)* · Process Deposit · Process Reschedule · Refund
Determined *(v28)* · Rescheduled Payment Difference · Reservation Cancelled ·
Security Deposit Return Flip · **Sofia Inicia** · Task Complete · Unsub from
email

**Draft (7):** Add-On Fulfillment Alerts · Add-On Payment Confirmed · Guest
Survey · Last-Minute Add-On Alerts · Pre-Arrival Upsells · Review Request ·
**`New Workflow : 1792259649864`**

**[N] Trigger types and actions** — not readable; the v2 API is disabled for this
location. Needs a UI pass by Yari or Mara if the plan split depends on them.

**Flags:** `New Workflow : 1792259649864` is junk and should be deleted. The
whole **add-on and upsell family is in draft** (Add-On Fulfillment, Add-On
Payment Confirmed, Last-Minute Add-On Alerts, Pre-Arrival Upsells), as are
Guest Survey and Review Request — so if any plan is sold on upsells, surveys or
review requests, **those are not running today**.

## 7. Worker and dashboard routes, with gateability

**[V] from `src/index.js` in both repos.**

### Invoicing Worker

| route | gateable? |
|---|---|
| `/booking-created`, `/ghl-invoice-paid`, `/cancel`, `/reschedule`, `/deposit/refund` | **No — this is the product.** Gating means branching inside pricing and settlement paths. |
| `/reports/owner-statement`, `/reports/manager-statement`, `/reports/manager-pl`, `/reports/reconcile` | **Yes, cheaply** — own prefix, no shared logic |
| `/ghl-expense-approved` | Yes, cheaply |
| `/admin/provision-tenant`, `/admin/seed-webhooks` | Operator-only, not a client feature |

### Dashboard

| route group | gateable? |
|---|---|
| `/api/expenses/*` (8 routes, incl. Claude receipt reading) | **Yes, cheaply** |
| `/api/owner-statement`, `/api/manager-pl` | **Yes, cheaply** |
| `/api/support` | Yes, cheaply |
| `/api/host/*` (board) | **Already gated** — `hostBoard.enabled` / `hostBoard.canPost` |
| `/api/onboarding/*`, `/api/provision`, `/api/schema/*`, `/api/portfolio/*` | Operator-only |
| `/api/data` | The dashboard itself; not a feature |

### Who can switch what — the honest answer

**[V]** Grepped both repos for `tenant.modules`, `features`, `plan`, `tier`,
`entitlement`: **none exist**. The only per-tenant flags in the entire codebase
are `tenant.bookingWorkerEnabled` and the board's two. **Everything else is on
for every tenant.**

**And the structural limit:** a Worker flag can only gate what the Worker or
dashboard *serves*. Objects, pipelines, tags, products and workflows ship in the
snapshot and are visible in the client's own GHL account regardless. So
"features only" works for statements, expenses, support and the board — and
cannot work for Cleaning Checklists or Service Requests unless Yari accepts that
lower tiers see them, or returns to per-tier snapshots.

## 8. Where a document or note disagrees with the live read

| claim | live read | status |
|---|---|---|
| Tier-gating via a `modules` array on the tenant record | No such field anywhere in either repo | **Plan, never built** |
| Service Requests object "centralized in the real HOMS account" | It is in **DEMO-HOMS** (18 fields). HOMS has only `expenses`. | **Contradicted** — asked of Yari 11/13, unanswered |
| Calendars | **[N]** `GET /calendars/?locationId=` returns 200 with **count 0** | **Not an empty account** — rental calendars are a known API dead end. Do not read 0 as "no calendars". |
| Email templates | **[N]** `GET /emails/locations/{id}/templates` → **404** with this PIT (the same path returns 21 templates on HOMS via the connector) | Likely a scope issue surfacing as 404; unresolved |

## 9. Other reads

**[V]** Forms (10): Cleaning Checklist Submission · Guest Request · Solicitud del
Huésped · Inspection · Inspección · Check Out · Check In · Booking Form ·
Formulario de Reserva. *(ES/EN pairs — Inspection/Inspección, Booking
Form/Formulario de Reserva.)*

**[V]** Surveys / trigger links (8): Guest Survey - ES · Check in link · Manage
Booking · Google Review Link · Inspección · Pos-Limpieza · Check out link ·
Unsub - ES.

**[V]** Funnels/sites (2): `Ejemplo` (funnel) and **`Luminara Hospitality`
(website)**.

> **Flag: a real client's website is sitting in the template account.** If
> DEMO-HOMS clones to new clients, every new client may inherit Luminara's site.
> Worth checking before the next provisioning.

**[V]** Users (3): three admins, all Yari (two spellings of her name — duplicate
user records).

**[N]** Conversation AI agents — `GET /conversations/providers` returns 400 with
this PIT. **Sofia exists** (workflow `Sofia Inicia`, published), but the agent
configuration is not API-readable here. Needs a UI pass.

## 10. GHL native features: used vs available

**[V] used by the snapshot:** opportunities/pipelines, custom objects, contacts
and custom fields, tags, products, invoices and payments, forms, surveys,
trigger links, funnels/websites, workflows, Conversation AI (Sofia), custom
values, native cancellations *(per Yari 2026-10-16; not independently verified
here)*.

**[N] on the account but apparently unused by the snapshot** — I could not
enumerate "enabled features" from the API, so this is **not** a verified list
and is the main gap left for a browser pass: memberships/courses, communities,
social planner *(used by DTCS, not seen in this snapshot)*, reputation
management, affiliate manager, blogs, proposals/documents, Ad Manager
*(see `docs/ads-api-findings.md`)*, QR codes, email campaigns.

**Those are the sellable surface Yari asked about**, and the honest answer is
that identifying them needs the UI, not the API.

---

## What is left for a browser pass

1. Workflow **trigger types and actions** — v2 API disabled.
2. **Conversation AI agent config** (Sofia's prompt, model, channels).
3. **Which GHL native features are enabled** on the sub-account.
4. **Calendars / rental services** — API dead end.
5. Whether **email templates** exist here at all, or the 404 is a scope artefact.
