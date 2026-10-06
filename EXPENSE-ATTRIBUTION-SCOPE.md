# Expense attribution — scope

**Status:** proposed, not started. Needs Yari's sign-off on the open questions below.
**Raised by:** Yari, 2026-10-05 — *"these should be expenses for the owner not the manager, manager expenses will likely be the cleaning staff, HOMS fee, things like that."*

## What is actually wrong

Three facts, each verified in the code rather than assumed:

1. **The ledger has no expense entry type.** `ledger_entries` knows 21 entry types, all of them booking money — rent splits, cleaning fee, deposits, cancellations, reschedules, processing fee. Nothing for a cost.
2. **The owner statement is built only from the ledger** (`queryStatement`). So an expense the owner bears — the fridge repair, the carpet wash — **never appears on the owner's statement at all.** The only place it surfaces is the *manager's* statement, as "Recoverable from owners".
3. **Nothing declares whose cost an expense is.** `Can Reimburse` is doing that job implicitly: set it to the full amount and the expense nets to zero for the manager. That is arithmetically what Yari described, but it is inferred, it is silent when the field is left blank, and it puts an owner's cost on the manager's page and nowhere else.

There is also no HOMS fee anywhere. `platform_fee` in the ledger is the payment-processing pass-through and is hardcoded to 0. The `management_fee` option on the Category field is a *category*, not an attribution, and does not mean "HOMS charged this".

## Decisions already made

Yari, 2026-10-05:

- **Attribution gets an explicit field**, not a heuristic read off `Can Reimburse`.
- **Owner-borne expenses get written to the ledger**, so the owner statement shows them and the ledger stays the one authoritative source.

## The field

New on `custom_objects.expenses`, which today has 15 fields and no attribution:

| | |
|---|---|
| key | `custom_objects.expenses.paid_by` |
| name | Paid By |
| type | `SINGLE_OPTIONS` |
| options | `owner` → Owner · `manager` → Manager |
| folder | Expense Details (`KG12f3cDzmXTagdwp19I` on DEMO-HOMS) |
| position | 750 (assigned by GHL) — see note below |

**Position:** the scope asked for 225, beside Can Reimburse. `create-custom-field` takes no position parameter, so GHL assigned 750 and the field sits at the END of the Expense Details folder, after Rate Source. Cosmetic, and only movable by hand in the UI.

**The labels stay English, deliberately.** Yari, 2026-10-05: *"custom objects/fields don't auto translate when the platform language changes to spanish."* So `Paid By`, `Owner` and `Manager` read English on a Spanish account — exactly like the other fifteen fields on this object, and like every option on Category and Review Status. One bilingual field among fifteen English ones reads worse than consistent English, so the field carries a bilingual **description** instead and the broader question is below.

**Unset is not guessed at.** An expense with no `Paid By` is reported the way an unapproved or unconverted one already is — named, with the reason, excluded from both totals until somebody says whose it is. This follows the rule the rest of the system already keeps: refuse rather than invent. It also means **every existing expense record is excluded on the day this ships** until the field is set, which is the migration below, not a surprise.

## The GHL translation limit, and what it costs

Platform language does not translate custom object or custom field labels.

The dashboard is unaffected: it reads field KEYS and renders its own labels, which do translate. But inside GHL a Spanish client sees English throughout these objects — Expense Name, Can Reimburse, Needs Review, Maintenance & Repairs, and now Paid By.

That is a product decision rather than a bug, and it is far bigger than this field. Relabelling means every field and every option on Expenses, Properties, Transactions, Cleaning Jobs and the rest, on every account, and it has to survive the snapshot. **Worth deciding before the snapshot is cut, for exactly the reason Paid By was** — doing it afterwards means doing it twice.

**Decided, Yari 2026-10-06:** *"keep the merge tags the same and only translate the label... when we go to create the snapshot, we will have to create one in es and one in en."*

Two snapshots, English and Spanish. **Field keys stay byte-identical between them; only labels differ.** That is what makes it safe: every merge tag, every workflow, the Worker and the dashboard all address fields by key, so a Spanish account is cosmetically different and functionally the same account. My earlier worry that forking the snapshot would make accounts diverge from the template was wrong — it only holds if the keys fork too, and they will not.

Not now. At snapshot-creation time.

**The standing cost, which is the part to remember:** there are two snapshots to keep in step from here on. Every field added later has to be added to both, with the same key and a different label. A field that reaches only one of them makes one language's accounts quietly incomplete, and nothing in GHL will say so. Worth a checklist entry wherever the snapshot build is written down.

## Sequencing — this blocks the snapshot

The HOMS snapshot has not been applied to YV Guest Properties yet. Adding `Paid By` after the snapshot is cut means cutting it again, and means every account provisioned in between is missing the field.

**Do the field first, then the snapshot.** If the snapshot is urgent, say so and this waits — but it should not be done twice.

## Phases

Each phase is independently mergeable and leaves the system working.

### 1. The field (GHL write — Yari's approval, per account)
**Done on DEMO-HOMS, 2026-10-06.** Field id `06Y5EtK8tWvpbyztZVAx`, confirmed present on the object with `showInForms: true`. Nothing reads it yet, so no number anywhere has moved.

Still to confirm by eye, because the API only proves the field exists: that it renders in the Expenses form and on a record in the GHL UI.

### 2. Set it on what already exists (GHL write) — DONE on DEMO-HOMS 2026-10-06
All three records set to `paid_by = owner`, confirmed in each response:

| record | id | amount | |
|---|---|---|---|
| RL Santana Refrigeración | `6aa945f0491c584adfd0c0f0` | 150 DOP | owner |
| Test Villa 1 – Carpet Wash | `6aa042d133150a79d5b8b077` | 180 DOP | owner |
| Test Villa 1 – Pest Control | `6aa042c7178735d831dd57b6` | 35 DOP | owner |

All three also now read `review_status: approved` — Yari approved them between 2026-10-05 and this write. So the manager statement's "3 expense(s) still say Needs Review" warning is gone, and each one contributes US$0.00 to Expenses because `Can Reimburse` covers the full amount. Recoverable from owners stays US$6.20 / RD$365.00.

**Still outstanding: every other account.** No live client account has been touched, and none has been counted. Phase 3 must not ship before that count exists — see the warning on phase 3.

### 3. The Worker reads it (no GHL write)
`managerExpenseOf` gains `paidBy`, and `not_attributed` joins the issue list beside `not_approved` / `unconverted_currency` / `no_amount`. The manager P&L counts only `paid_by = manager`. The dashboard already renders exclusion reasons by name as of #106, so this needs one new phrase and its translation.

**Do not ship this before counting expenses on live accounts.** Unset `Paid By` is reported rather than guessed, which is the right rule and also means every expense on every account that has not had phase 2 run against it drops out of the manager's total the moment this deploys. On DEMO-HOMS that is now zero records. On Luminara, Cruce and the rest it is unknown, and unknown is not a safe number to deploy against.

**Effect on today's numbers:** the manager's Expenses line stops carrying owner costs. On DEMO-HOMS that figure is already US$0.00 because `Can Reimburse` covers the full amount, so nothing visibly moves — which makes this phase safe but also means it proves nothing on its own. Phase 4 is where it becomes visible.

### 4. Owner expenses reach the owner statement (ledger write)
A new entry type — proposed `expense_owner`, category `expense`, **negative** `amount_minor` against the owner, so it reduces what the owner is owed rather than appearing as income.

Open, and the reason this phase is not already written:

- **What triggers the write.** Nothing in the system reads the Expenses object on a schedule or on change. Candidates: a GHL workflow on the Expenses object firing an inbound webhook to the Worker on approval; a sweep endpoint; or writing at the moment the dashboard's Add Expense modal saves. The first matches how Payment Confirmed already works and keeps GHL as the trigger surface.
- **Idempotency.** An expense can be edited, unapproved and re-approved. The ledger is append-only and authoritative, so a re-post must not double-charge the owner. Needs a stable key on the expense record id and an upsert, or a reversing entry.
- **Which currency is stored.** Ledger amounts are minor units in one currency per row. A DOP expense should post in DOP with its own rate recorded, not be flattened to USD at write time — the conversion belongs at read time, where #104 already does it.

### 5. Backfill
Existing approved owner expenses posted to the ledger once, with the same idempotency key, so phase 4's trigger and the backfill cannot both post the same row.

### 6. HOMS fee (separate, not blocked by the above)
Currently modelled nowhere. Needs its own decision: is it a per-account subscription, a per-booking cut, or a line the manager records as an expense like any other? Until that is answered it is not a build, it is a question.

## What this does not change

- `Can Reimburse` keeps its current meaning and keeps driving "Recoverable from owners". It answers *how much comes back*, which stays a different question from *whose cost it was*. An owner-borne expense the manager fronted is both.
- The cleaner cost on cleaning jobs is already the manager's cost and is already handled. It does not move into the Expenses object.
- `Already Reimbursed` is still ignored, so "Recoverable from owners" still cannot decrease when an owner settles. Separate, still open, still needs Yari's settlement process.
