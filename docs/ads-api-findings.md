# Phase 0 findings — HOMS Visibility Module (GHL Ad Manager)

**2026-11-15. GHL API surface by Forge; Meta and Google research by Scout** (attributed inline, from Meta developer docs and GHL help-centre articles).

Phase 0 of the Visibility Module brief: verify what
GHL's API actually exposes before any code is written. Read-only; nothing was
created, published or spent.

**Headline: the brief's core assumption is wrong, in our favour.** It says to
"assume **no**" on Ad Manager API access. GHL exposes a full `ad-publishing`
domain covering Facebook, Google and LinkedIn — including campaign reporting
**with spend**, and custom-audience membership writes. Three of the four code
phases get simpler.

Everything below is from live schema reads against HOMS
(`dytwzgmOP5v0Jh7gop4y`), not from documentation. Items I could not verify are
marked **UNVERIFIED** and are not to be built on.

---

## Q1 — Does the public API expose Ad Manager campaigns, stats or spend?

**Yes, all three.** Domain `ad-publishing`, scopes `adPublishing.readonly` /
`adPublishing.write`.

`GET /ad-publishing/facebook/reporting/campaign/{campaignId}` returns, as a flat
object:

> `spend`, `clicks`, `conversions`, `costPerConversion`, `costPerResult`,
> `costPerResultBreakdown`, `cpc`, `cpm`, `ctr`, `impressions`, `reach`,
> `frequency`, `leads`, `results`, `objective`, `publishingStatus`,
> `fbCampaignId`, `startTime`, `stopTime`, `dateStart`, `dateStop`

Also present: `fb-get-ad-accounts`, `fb-get-ad-account`,
`fb-get-campaign-publishing-progress`, `fb-get-custom-audiences`,
`fb-get-custom-audience-by-id`, and the Google equivalents
(`google-get-campaign-reporting`, `google-get-conversions`,
`google-get-conversion-goals`, `google-get-ad-accounts`,
`google-get-keyword-ideas`, `google-upsert-campaign`, `google-publish-ad`,
`google-get-reporting-progress`). LinkedIn exists too (`li-*`) and is out of
scope per the brief.

### Two findings that change the plan

**Phase 3's manual-spend fallback is unnecessary.** The brief says "if spend
data is available, show ROAS; if not, add a manual monthly spend entry using the
`expenses` object with category `ads`." Spend is available. Build the real thing;
keep manual entry only as a fallback for spend outside GHL-published campaigns.

**A "template" campaign cannot be reported on.** The reporting endpoint is
explicit: *"The campaign must be published — one without an `fbCampaignId` is
rejected."* The brief's §3 builds the library as **non-running template
campaigns** inside the snapshot. Those have no `fbCampaignId`, so they will
return an error rather than zeroes. The dashboard view must treat "template, not
yet published" as a distinct state, not an error and not zero spend.

**One honesty note for the reporting view**, straight from the endpoint's own
description: *"`results.lead` (Meta lead actions) and `leads` (CDP attributed
contacts) measure different things and routinely disagree."* Pick one per column
and label which. Showing both unlabelled will generate support tickets.

---

## Q2 — Can contacts be pushed to a Meta Custom Audience, or do we need the Meta Marketing API?

**GHL can do it, and it is better than the brief's design.**

```
PUT /ad-publishing/facebook/custom-audience/{customAudienceId}/member
body: { contactId, fbAdAccountId? }
```

> "The contact is resolved from `contactId` and **its identifiers are hashed
> before being sent to Meta**. Use the batch endpoint for more than one member."

Removal exists too (`fb-remove-custom-audience-member`), which the brief needs
for its "removals sync too" requirement.

**This deletes a requirement and a risk.** Phase 2 says "Hash PII (SHA-256)
before sending." We never hold the PII: we send a `contactId` and GHL hashes.
So drop the hashing work, and the Worker never becomes a place where guest
email and phone are assembled for an outbound third party. That is a smaller
privacy surface, not just less code.

**UNVERIFIED:** the batch endpoint's exact path and payload — the description
references it without naming it. Find it before building the nightly
reconciliation; adding members one call at a time across a whole guest list is
the wrong shape.

**UNVERIFIED, and it is an onboarding question not a code one:** whether Meta
requires the **ad account owner** (our client) to accept Custom Audience Terms
in their own Business Manager before members can be added, and the minimum
audience size before Meta will deliver. Both asked of Scout. If terms must be
accepted per client, that is a checklist step in Phase 4, and audience sync will
fail silently-ish until it happens.

---

## Q3 — Does GHL's tracking fire Meta pixel / CAPI events for rental bookings?

**ANSWERED by Scout, 2026-11-15, from GHL's changelog and help centre. Yes —
GHL fires Meta events itself, in two separate ways.** Whether either fires on a
HOMS *booking* is the part still open.

**(a) The funnel/website builder fires them from the page:** `PageView` on every
page, `ViewContent` on store product/offer pages, `InitiateCheckout` on
1/2-step order forms and cart checkout, `AddPaymentInfo`, and `Purchase` on
order-confirmation / upsell / thank-you elements, using real order IDs. The
changelog says this runs "through both the Browser Pixel and Server-Side API
(CAPI)" but does **not** say which event takes which path, and does **not** say
the two share an `event_id`.

**(b) A workflow action, "Facebook Conversion API",** with Event Type Funnel
Event or Lead Event. GHL states deduplication "is handled automatically":
funnels mint an `eventId`, store it with the contact's attribution, and the
action sends that same id when available. It does not explain how the browser
pixel receives it.

**The thing that decides it:** GHL's page-fired `Purchase` is bound to GHL
**order-form / thank-you elements**. A HOMS booking is paid through the GHL
*invoice* flow, not an order form, so GHL's Purchase probably does not fire for
our bookings — but Scout could not verify that, and it is the difference between
"safe to fire our own" and "double-counts every booking".

**One trigger worth checking before assuming:** the workflow action's Funnel
Event triggers include **Customer Booked Appointment**. A HOMS rental booking
*is* a GHL calendar booking, so that action may already be reachable on a
booking without any Worker code. If it is, option (a) below may be the cheapest
correct answer.

### Decide one owner per event, then test

Scout's framing, which I agree with: exactly one thing may own each event.

1. **GHL's CAPI workflow action on the booking trigger, and no Worker Purchase.**
   Least code, and dedup is GHL's problem.
2. **The Worker fires Purchase, and no GHL Purchase element or CAPI action runs
   on that page.** Most control, needs the match-quality work below.
3. **Both, sharing an id:** browser pixel fired with `eventID` = booking id, and
   the Worker sends the same booking id as `event_id`.

Verify with Meta's Test Events before choosing. Not a decision to make from
documentation.

### A Phase 1 requirement the brief does not mention

A Worker firing on a **confirmed** booking runs server-side, after payment. It
has no `client_ip_address`, no `client_user_agent`, no `fbp` and no `fbc` unless
those were **captured at checkout and stored on the booking**. Without them Meta
match quality drops, which shows up as fewer attributed conversions — i.e. it
makes our own ads look worse than they are.

So options 2 and 3 require capturing `fbp`, `fbc`, user agent and IP at checkout
into the booking/transaction record. That is new work, and it belongs in Phase 1
alongside the `fbclid` custom field.

---

## Meta CAPI mechanics (Scout, from Meta's developer docs)

Needed before writing any CAPI call.

- **Required per event:** `event_name`, `event_time`, `user_data`,
  `action_source`. For website events, `event_source_url` and
  `client_user_agent` are also required. `event_id` is needed for dedup.
- **`event_time`** is Unix seconds, GMT, and may be up to **7 days** old. If
  **any** event in a request is older than 7 days, **the whole request errors
  and nothing is processed.** That matters for any replay or backfill: batch by
  age, or one stale row poisons the batch.
- **Purchase value/currency:** Meta's server-event page does not list them as
  required (its example puts both in `custom_data`). Send them anyway;
  **UNVERIFIED** whether they are enforced.
- **Hashing** — SHA-256 after normalising: `em` trimmed and lowercased; `ph`
  digits only, no leading zeros, **with country code even in a single-country
  market**; `fn`, `ln`; `db` as YYYYMMDD; `ge` f/m; `ct`, `st`, `zp`; `country`
  lowercase ISO alpha-2, **sent even for a single country**. `external_id`
  hashing recommended. **Do not hash** `client_ip_address`,
  `client_user_agent`, `fbc`, `fbp`.
- **Dedup, method 1 (recommended):** the pixel's `eventID` must equal the CAPI
  `event_id` **and** the event names must match. Window is **48 hours** from
  the first event carrying that id. Method 2 (`event_name` + `fbp`/
  `external_id`) only works when the **browser** event arrives first.
- **Two server-only events are never deduped against each other.** So Meta's
  dedup does not protect us from our own retries: the Worker must be idempotent
  itself and not send a second Purchase for a booking it already sent. That is
  our problem, not Meta's.
- **Token:** generated per pixel/dataset in Events Manager → the pixel's
  Settings → Conversions API → Generate access token (the link appears only for
  users with developer privileges on the business), or via a system user with
  the pixel assigned. Meta says no App Review needed. **Treat as per-pixel**,
  therefore **per client** — so it is a per-tenant secret, not one HOMS-wide
  token.
- **UNVERIFIED:** the exact endpoint path, `test_event_code`, and max events per
  request.

---

## Custom Audience terms and size (Scout, from Meta's docs and the Custom Audience Terms)

**Terms acceptance is a real onboarding step, and it is the client's to do.**
The Customer List Custom Audience Terms are accepted by whoever uploads or uses
the audience, on that ad account. The API error is **200 / 1870090 "Custom
Audience Terms Not Accepted"**. The API user also needs edit permission on the
ad account. Acceptance being *per ad account* is a third-party claim, not stated
in the page Scout opened.

**Terms §9 binds us if we upload on a client's behalf** (the `ads_managed`
tier): an agency may upload only where it has authority to disclose and use that
data for the advertiser, the uploader warrants all rights and legal grounds,
people who opt out must be removed, and no sensitive audiences (health,
finance). Practical consequences:

- each client needs a privacy notice covering this use of guest data;
- a guest opt-out must trigger `fb-remove-custom-audience-member`, not just stop
  future adds. The brief already says "removals sync too" — this is the legal
  reason it is not optional.
- for EEA/UK personal data the **uploader** is the controller.

**Minimum audience size: UNVERIFIED, and do not promise a number.** Meta's
openable pages state none; third-party sources conflict (20, 100, ~1,000) and
say the count is **after matching** — so a 5,000-row list can match 80 and never
deliver. Sales-facing consequence: do not tell a prospect their past-guest list
is big enough to retarget.

**Onboarding timing risk:** per a search snippet of Meta's help page (not
openable), new or recently linked ad accounts may wait **weeks** before they can
create a customer-list audience. A brand-new client may not be able to use this
on day one.

Upload mechanics, if we ever bypass GHL: up to 10,000 users per request to
`/{audience_id}/users`, SHA-256 lowercase hex. We should not need this — GHL
hashes on its own endpoints.

---

## Google is the weaker half, and one deadline has already passed

**Offline conversions have no booking trigger.** GHL's "Add to Google Ads"
action sends offline conversions keyed by the contact's stored click id (GCLID;
GBRAID/WBRAID only with Many-Per-Click), and per GHL's article it "only works"
with: Form Submission, Order Purchase, Number Pool Calling, Survey Submission,
Chat Widget. **There is no booking-confirmed, tag or stage trigger.** So a HOMS
booking cannot drive a Google conversion through that action without being
routed via a form/order trigger, or an upload path of our own.

The conversion name must match Google's exactly. Logs show "Executed" = sent,
"Skipped" = missing click id or name mismatch, and there is no way to test
directly.

**Enhanced Conversions and Customer Match: treat as unsupported.** Not
mentioned in anything Scout read; an old ideas-board request says workflows
cannot send Enhanced Conversions natively.

**THE ONE TO RAISE WITH GHL BEFORE BUILDING ANYTHING ON GOOGLE.** Per a search
snippet of Google's support pages (not opened, so **UNVERIFIED**): from
**15 June 2026**, offline-conversion and enhanced-conversions-for-leads uploads
move to the Data Manager API and are **blocked in the Google Ads API**. That
date is **five months in the past**. So this is not a deadline to plan around —
if GHL has not migrated, GHL's Google offline conversions may be broken right
now, silently, with "Executed" in the logs. One support question answers it, and
it should be asked before any Google work is scoped.

`google-get-conversions` reads the list "synced from your connected Google Ads
account", so it reflects Google-side conversion actions rather than only GHL
records; GHL also creates actions in Google Ads through the API. Changes in
Google Ads can take time to appear. `google-get-conversion-goals`: no
documentation found, **UNVERIFIED**.

---

## Q4 — Which UTM / attribution fields does GHL capture automatically?

**Verified on a live contact record.** GHL captures **two** attribution objects
per contact, not one: `attributionSource` (first touch) and
`lastAttributionSource` (last touch). Each carries:

| field | notes |
|---|---|
| `sessionSource` | e.g. "Direct traffic" |
| `url`, `referrer` | landing URL |
| `utmSource`, `utmMedium`, `utmContent`, `utmTerm`, `utmKeyword`, `utmMatchtype` | the full UTM set |
| `gclid`, `gbraid`, `wbraid` | Google click ids, all three |
| `gaClientId`, `gaSessionId` | GA linkage |
| `medium`, `mediumId` | GHL's own source id, e.g. `…::pilot-application` |
| `adName`, `adGroupId`, `adId` | populated for ads traffic |
| `userAgent`, `ip` | |

**First-touch AND last-touch come free**, which is better than the brief
assumes and worth using: "which campaign got them first" and "which closed
them" are different answers an owner will ask for.

### The one real gap

**There is no `fbclid` field.** Google's click ids are native; Facebook's is
not. The brief's Phase 1 says "capture UTMs + `fbclid`/`gclid` on the contact" —
`gclid` is already there, `fbclid` needs a custom contact field plus capture on
the booking page. Without it, Meta-sourced bookings can still be attributed by
UTM, but click-level matching and CAPI match quality are weaker.

---

## What this means for the brief, concretely

| brief phase | change |
|---|---|
| Phase 1 tracking | **Decide one owner per event first**, and test it in Meta Test Events — GHL already fires Purchase on its own order elements. Add an `fbclid` custom field. **New work the brief missed:** capture `fbp`, `fbc`, user agent and IP at checkout onto the booking, or server-side match quality drops. Make the Worker idempotent per booking — Meta does not dedupe two server events. |
| Phase 2 audiences | **Simpler.** GHL's member endpoints take a `contactId` and hash for us; delete the SHA-256 requirement. Find the batch endpoint. **Terms acceptance is a client onboarding step** (error 200/1870090), opt-out removal is a legal requirement not a nicety, and **promise no minimum audience size**. |
| Phase 3 reporting | **Spend and ROAS are real**, not a manual fallback. Handle "template, unpublished" as its own state. Label `leads` vs `results.lead`. |
| Phase 4 ops | Onboarding checklist gains: accept Meta Custom Audience Terms, generate a **per-pixel** CAPI token, and allow for a possible multi-week wait before a new ad account can create a customer-list audience. |
| **Google** | **Scope it last, and ask GHL one question first** — see below. No booking trigger, no Enhanced Conversions, and a migration deadline that has already passed. |

## Scope requirements, and a live blocker

Every operation above needs `adPublishing.readonly` or `adPublishing.write` on
the PIT. **No HOMS PIT currently has them** — and note the separate, already-open
issue that `GHL_PIT_HOMS` lacks even `opportunities.readonly`, which is why the
dashboard's Support tab returns 401 today. Any ads work will need those scopes
ticked per account in Settings → Private Integrations, and that is Yari's to do.

The connector's own search reported `scopeFilteredCount: 3` on the ad-publishing
query, meaning some ad operations are filtered from its OAuth scopes too. So the
MCP connector is not a substitute for a properly scoped PIT here.

## Not done, deliberately

- No campaign, audience or ad account was created, published or modified.
- No live reporting call was made: it requires a published campaign with an
  `fbCampaignId`, and none exists in any HOMS account.
- No Meta or Google credential was touched. Per the brief, agents never handle
  budgets or spend.
