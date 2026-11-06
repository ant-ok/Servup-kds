-- When the Poster snapshot a check was last applied from was fetched. The open
-- poll, the full poll and webhook re-fetches run side by side; an older snapshot
-- arriving after a newer one must not undo it (that would cancel and re-create
-- portions that were already made).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fetched_at timestamptz;
