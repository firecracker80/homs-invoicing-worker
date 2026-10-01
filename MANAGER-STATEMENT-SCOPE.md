# Manager statement — scope

Yari, 2026-09-30: *"after this conference i want a manager statement like the one
we created for the owners on the dashboard, what we have is great but they
already have that in the transactions tab under payments."*

She is right, and the reason is worth stating precisely, because it decides what
to build.

---

## 1. What already exists

Three views overlap here, and they read three different data sources.

| | Where | Reads | Shows |
|---|---|---|---|
| **Transactions → payments** | Dashboard tab | GHL `transactions` object | One row per booking: guest, property, OTA channel, booking ref, stay dates, **booking total**, payment status |
| **`/reports/manager-statement`** | Worker URL | **D1 ledger** | One row per ledger entry, grouped by entry type |
| **`/reports/manager-pl`** | Worker URL | D1 income + GHL `expenses` | Income, expenses, net, expenses by category | 

The third one is the closest thing to a real manager statement and **nothing in
the dashboard links to it.** No menu item, no tab, no button. A manager can only
reach it if someone sends them the URL.

### Why the current manager statement reads as a duplicate

Both it and Transactions → payments are **lists of things that happened**, one
row per event, ordered by date. They differ in what the rows are, but to someone
reading them they answer the same question: *what went on this month?*

Neither answers the question a manager actually has.

---

## 2. The number that is missing

Transactions → payments shows **what guests paid**. It does not show what the
manager earned, and those are not close to the same figure.

From the live DEMO-HOMS ledger, all time:

| | |
|---|---|
| Rent commission (`rent_split_manager`) | 1,353.00 |
| Cleaning collected (`cleaning_fee`) — **gross, see §5.3** | 1,125.00 |
| Cancellation charges retained | 484.42 |
| Rent refunded back out | −899.25 |
| Cleaning refunded back out | −650.00 |
| Reschedule refund | −33.00 |
| **Net earned by the manager** | **1,380.17** |

Against that, one single booking in the transactions list shows a total of
1,754.30. A manager reading the payments tab sees large numbers that are mostly
other people's money. Nothing anywhere tells them their own.

**That gap is the product.** Everything below follows from it.

---

## 3. The structural difference from the owner panel

The owner panel (`renderStatement`) is scoped to **one property, one month**,
with a property picker. That is right for an owner: they own a specific property
and want to know what it earned them.

A manager does not work one property at a time. They run a portfolio. So the
manager statement should be **portfolio-wide for a period, broken down by
property** — the inverse of the owner panel's shape.

That inversion is also what stops it duplicating the payments tab. An
aggregation by property, of the manager's own economics, is something no list of
bookings can be squinted at to produce.

---

## 4. Proposed shape

Same chrome as the owner panel so it is instantly familiar — period picker,
EN/ES toggle, Print/PDF, Export CSV — with the property picker replaced by a
breakdown table.

```
Manager statement — <manager name>
<period>

  Commission earned                      1,353.00
  Cleaning collected                     1,125.00
    less paid to cleaners                 (xxx.xx)   ← needs §5.3 first
  Cancellation charges retained            484.42
  Less refunds issued                   (1,582.25)
  ─────────────────────────────────────────────────
  Gross earnings                           xxx.xx

  Less costs not recoverable from owners  (xxx.xx)
  ─────────────────────────────────────────────────
  Net to manager                          x,xxx.xx

By property
  Villa Amarilla    commission  cleaning  cancellations  refunds  net
  Vila Verde        ...
  Villa Azul        ...

Owner payouts due this period
  Elena Marchetti    x,xxx.xx
  Carlos Mendoza     x,xxx.xx
```

### The payout block is the part worth building first

"What do I owe each owner this period" exists nowhere in the system today. The
manager currently has to open each owner's statement one at a time and add them
up by hand. The ledger already holds every row needed — owner rows are scoped by
`recipient = 'owner'` and `recipient_name`, both of which are now populated on
every row (backfilled 2026-10-01).

If only one section ships, this is the one that earns its place.

---

## 5. Decisions needed before building

**1. Which data source.** The Worker's statements read D1; the dashboard's owner
panel reads the GHL `transactions` and `expenses` objects and computes
commission as *expenses categorised `management_fee`*. These are two different
definitions of the same number and they can disagree.

Recommend D1, because it is the authoritative ledger and already carries the
manager's own entry types. But that means the new panel does **not** match how
the existing owner panel on the same screen computes its figures — which is a
pre-existing inconsistency this will expose rather than create. Worth deciding
deliberately, and possibly worth moving the owner panel onto D1 too.

**2. One manager or several.** `propertyManagerNames` allows a different manager
per property. If an account ever has two, the statement must scope by
`recipient_name` the way the owner statement now does, and needs its own picker
or token per manager. Cheap to build in now, expensive to retrofit.

**3. ~~Is retained cleaning actually margin?~~ — ANSWERED, and it is a blocker.**

Yari, 2026-10-01: **the cleaner is paid out of the retained cleaning fee.** So
the 1,125.00 is gross revenue with a cost against it, not earnings.

That cost is currently recorded **nowhere**:

- The expenses object has ten categories and none of them is cleaner labour.
  `Cleaning Supplies` is materials.
- The whole account holds **three** expense records — a refrigeration repair, a
  carpet wash and a pest treatment. Not one cleaner payment, against 17 cleaning
  fees collected.

So a manager statement built on today's data would report 1,125.00 of cleaning
as earnings when most of it went to a cleaner. **That is worse than no
statement** — it is a confident wrong number about someone's own income, and the
manager is the one person who would know it is wrong, which costs trust in every
other figure on the page.

### Where the cost belongs

Not a new expense category. The **cleaning job object already carries everything
needed except the money**:

| Field | |
|---|---|
| `cleaner_name__service` | who cleaned |
| `completion_date` | when |
| `turnover_type` | standard / deep / mid-stay — rates usually differ by type |
| `property_name`, `booking_reference` | what it attaches to |

And it already has a field group named **`Financials`** — created with the
object, still empty. The intent was there; the fields were never added.

Proposal: add `cleaner_cost` (and probably `cleaner_paid_on`) to that existing
group. Then cleaning margin is per turnover, per property, per booking, and
joins to everything else without inventing a reconciliation. Deep cleans costing
more than standard turnovers falls out for free.

**This has to land before the statement, not after.** The statement is only as
honest as the cost capture underneath it, and backfilling 17 cleans later is
worse than capturing the next one correctly.

**4. What to do with `/reports/manager-pl`.** It already computes income less
non-recoverable expenses, with real warnings for mixed currency, unapproved and
undated costs. Options: surface it as this panel's cost section, link it from the
dashboard as-is, or fold it in and retire the standalone route. Building a third
thing beside it would repeat exactly the mistake this document exists to avoid.

---

## 6. Explicitly out of scope

- Changing any stored category or amount. This is a reporting view.
- Issuing payouts. The statement says what is owed; paying is manual on GHL by
  design, as established during the cancellation testing.
- Replacing Transactions → payments. It is a useful booking list; it is simply
  not a manager statement.
