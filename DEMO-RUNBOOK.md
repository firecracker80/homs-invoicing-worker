# Demo runbook — DEMO-HOMS

Two parts. The first is for whoever is presenting. The second is what to send
to someone trying it on their own.

Figures re-verified 2026-10-15 against the live tenant config: `ownerPct` 0.85,
`processingFeePct` 0.06, native deposit (the Worker adds none), cleaning to the
manager, cancellation policy `grace 24h/14d, 5d 1n+50%, 14d 25%, check-in 100%`.

---

# Part 1 — presenter script

## Numbers to expect

Test Villa 3 is $110/night, Test Villa 2 is $135/night, cleaning is $65 per
listing, processing is 6%. There is no security deposit on this account.

**A 3-night stay at Test Villa 3** — the booking to use, because every figure
is checkable:

| | |
|---|---|
| Rent, 3 × 110 | 330.00 |
| Cleaning | 65.00 |
| Processing, 6% of 395 | 23.70 |
| **Guest pays** | **418.70** |

And on the statements:

| | |
|---|---|
| Owner, 85% of 330 | 280.50 |
| Manager, 15% of 330 | 49.50 |
| Manager, cleaning | 65.00 |
| **Manager total** | **114.50** |

The $23.70 is the gateway's cut and appears on neither statement. That is worth
saying out loud — it is the question every prospect asks.

## Order

1. **The listing and the booking.** Book Test Villa 3 for 3 nights. Say what
   the guest is doing, not what the system is doing.
2. **The invoice.** It arrives itemised: the villa, the cleaning, the
   processing fee. $418.70. Point out the guest sees one invoice and one
   payment.
3. **Pay it.**
4. **The owner statement.** $280.50. This is the moment that sells — an owner
   opens their own link and sees their own money, with no spreadsheet and
   nobody sending it to them.
5. **The manager statement.** $114.50, and say why it is not $49.50: cleaning
   goes to whoever pays the cleaner, and that is configurable per account.
6. **Cancel a second booking.** Book another, pay it, cancel it three days
   before check-in. The policy keeps one night plus half the rest: **$220
   retained, $175 refunded.** The refund appears on the statements as a
   reversal, split the same way the income was.

Add-ons are optional in GHL now, so a guest who does not want one is never
charged for it — that is a demo in itself if someone asks. The pet fee is the
one to show.

## Do not

- **Do not set check-in more than 14 days out if you plan to cancel.** The
  grace window is "within 24h of booking **and** 14+ days before check-in", and
  it beats every tier — a full refund, and the tier story disappears. Three
  days out, as scripted above, is nowhere near it, so cancelling minutes after
  booking is fine.
- **Do not demo a reschedule that shortens a stay** unless you want to talk
  about manual refunds. On this gateway the refund is a person's job by design,
  and the notification says so.

## If something looks wrong

The statements are computed from D1, not from GHL, so a statement figure is the
truth even if a GHL record looks stale. If a number is wrong, it is wrong
everywhere and worth stopping for. If a GHL record looks wrong but the
statement is right, keep going and tell me afterwards.

---

# Part 2 — send this to someone trying it themselves

> You are a guest booking a holiday rental. Book **Test Villa 3 for 3 nights**
> and use your own email.
>
> You should get an invoice for **$418.70**, itemised: the stay, a cleaning fee
> and a processing fee. Pay it — it is a test account, so no real money moves.
>
> Then tell us:
>
> 1. Did anything take longer than you expected, or look like it had stalled?
> 2. Was there any point where you were not sure what to do next?
> 3. Did anything read oddly — a wrong language, a strange number, a label that
>    made no sense?
> 4. Did every email you expected actually arrive, and how long did it take?
> 5. Would you have trusted this with your own card? If not, what stopped you?
>
> Please do not cancel without telling us first.
>
> Anything that felt slow, confusing or unfinished is worth reporting even if
> it seems trivial. That is exactly what we are looking for.

## Why three people independently

They will each hit a different thing, and none of them will hit what we hit,
because we know where not to press. Their answers to 3 and 5 are the ones worth
the most — those are the ones testing cannot produce.

---

## Changelog

**2026-10-15** — four corrections, three of which made the demo *less* fragile
than this document claimed:

- **The pet fee is a native optional add-on.** The old "do not answer yes to
  pets unless you want to explain $300" is gone: the guest chooses it, the
  system prices it, and declining means no line at all. It is a feature to show
  rather than a landmine to avoid.
- **Bundled bookings notify correctly.** "Do not book two listings in one
  reservation" was true when a bundled cancellation sent nothing; it now
  notifies once for the reservation, with a test holding it there. Removed.
- **The grace rule was stated wrong.** It is not "do not cancel within 24h of
  booking" — grace needs *both* 24h of booking and 14+ days before check-in.
  The scripted cancellation is three days out, so it cannot trigger. The real
  constraint is how far ahead check-in is set.
- **Every figure above re-checked** against the live tenant record rather than
  carried forward.
