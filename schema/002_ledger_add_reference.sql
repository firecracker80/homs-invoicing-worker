-- 002_ledger_add_reference.sql
-- Adds a `reference` column so cancellation/reschedule entries can coexist
-- with settlement entries of the same entry_type on the same booking --
-- the original (booking_id, entry_type) unique index couldn't tell two
-- different refunds apart, only whether *a* row of that type existed yet.
-- Flagged as a known gap in the original schema file's own comments.
--
-- reference is NOT NULL DEFAULT '' (not nullable) because SQLite's UNIQUE
-- index treats every NULL as distinct from every other NULL -- a nullable
-- reference would silently stop enforcing uniqueness for any row that
-- omitted it. Existing settlement rows backfill to '', which stays unique
-- per (booking_id, entry_type) exactly as before, since settle() only ever
-- writes one row per type per booking.
--
-- Apply to staging first (homs-ledger-staging), verify, then production
-- (homs-ledger):
--   npx wrangler d1 execute homs-ledger-staging --remote --file=schema/002_ledger_add_reference.sql
--   npx wrangler d1 execute homs-ledger --remote --file=schema/002_ledger_add_reference.sql

ALTER TABLE ledger_entries ADD COLUMN reference TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS idx_ledger_booking_entry_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_booking_entry_type_reference
  ON ledger_entries(booking_id, entry_type, reference);
