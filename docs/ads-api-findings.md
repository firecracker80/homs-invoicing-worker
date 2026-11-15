# Phase 0 findings — HOMS Visibility Module (GHL Ad Manager)

**2026-11-15 (Forge).** Phase 0 of the Visibility Module brief: verify what
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

**UNVERIFIED — asked of Scout, and this one gates Phase 1.**

What I can say from the API surface: nothing in `ad-publishing` exposes event
sending, so if GHL fires pixel events it does so from the page, not through an
endpoint we can call or inspect.

**Why it must be settled before writing Phase 1.** The brief has the Worker fire
a server-side Meta Conversions API `Purchase` on confirmed booking, deduplicated
with the browser pixel by `event_id`. If GHL's own tracking already fires
`Purchase` from the booking page, and we fire CAPI with an `event_id` GHL never
saw, **every booking is counted twice** — and the failure is invisible in our
logs because both calls succeed. The symptom appears in the client's Meta
reporting as inflated conversions, which is exactly the number they would use to
judge whether HOMS ads work.

So: do not build Phase 1's `Purchase` event until it is known whether GHL fires
one, and if it does, whether its `event_id` is reachable.

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
| Phase 1 tracking | **Hold the `Purchase` event** until Q3 is answered. Add an `fbclid` custom field; `gclid` and UTMs need no work. |
| Phase 2 audiences | **Simpler.** Use GHL's member endpoints with `contactId`; delete the SHA-256 hashing requirement. Find the batch endpoint. Treat Custom Audience Terms as an onboarding step. |
| Phase 3 reporting | **Spend and ROAS are real**, not a manual fallback. Handle "template, unpublished" as its own state. Label `leads` vs `results.lead`. |
| Phase 4 ops | Add "accept Meta Custom Audience Terms" to the onboarding checklist if Scout confirms it is required. |

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
