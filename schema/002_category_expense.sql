-- Widen ledger_entries.category to allow 'expense'.
--
-- Phase 4 of EXPENSE-ATTRIBUTION-SCOPE.md. An expense the owner bears is a
-- charge against what they are owed. It is not income, not a liability, not a
-- pass-through and not shadow -- the four the CHECK allowed -- so without this
-- there is nowhere honest to put it.
--
-- The tempting shortcut was category 'income' with a negative amount, which
-- nets correctly and would have needed no migration. Rejected: the statement
-- already reads negative income as a REFUND (isRefund in reports.js), so an
-- expense would have arrived labelled as a refund of rent. Reusing a column's
-- meaning to dodge a migration is exactly how can_reimburse came to mean two
-- things at once.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. 125 rows
-- across one location at the time of writing; dump them first (see the PR) --
-- this drops the original table and a half-finished run leaves nothing behind.

CREATE TABLE ledger_entries_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id   TEXT NOT NULL,
  booking_id    TEXT NOT NULL,
  invoice_number TEXT,
  invoice_id    TEXT,
  recipient     TEXT NOT NULL CHECK (recipient IN ('owner','manager','guest','platform')),
  recipient_name TEXT,
  category      TEXT NOT NULL CHECK (category IN ('income','liability','pass_through','shadow','expense')),
  entry_type    TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  description   TEXT,
  source        TEXT NOT NULL DEFAULT 'payment_confirmed',
  reconciled    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reference     TEXT NOT NULL DEFAULT ''
);

INSERT INTO ledger_entries_new
  (id, location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name,
   category, entry_type, amount_minor, currency, description, source, reconciled, created_at, reference)
SELECT
   id, location_id, booking_id, invoice_number, invoice_id, recipient, recipient_name,
   category, entry_type, amount_minor, currency, description, source, reconciled, created_at, reference
FROM ledger_entries;

DROP TABLE ledger_entries;
ALTER TABLE ledger_entries_new RENAME TO ledger_entries;

-- Recreated exactly as they were. The unique index is what makes the expense
-- upsert safe: (booking_id, entry_type, reference) with booking_id namespaced
-- as "expense:<recordId>" and reference holding the record id, so one expense
-- can only ever own one row.
CREATE INDEX idx_ledger_location ON ledger_entries(location_id);
CREATE INDEX idx_ledger_location_recipient_category ON ledger_entries(location_id, recipient, category);
CREATE INDEX idx_ledger_created_at ON ledger_entries(created_at);
CREATE UNIQUE INDEX idx_ledger_booking_entry_type_reference
  ON ledger_entries(booking_id, entry_type, reference);
