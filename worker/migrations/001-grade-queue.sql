-- Adds the scheduled grader's work queue.
--
-- Applied after the initial schema with:
--   cd worker; .\apply-schema.ps1 -Remote -File .\migrations\001-grade-queue.sql
-- (schema.sql also contains this, so a fresh database needs no migration.)

-- One row per lock waiting to be settled.
--
-- The queue holds LOCKS rather than events because a leg does not know its
-- event until it has been resolved, and resolving needs the slate, which is
-- the expensive thing this queue exists to ration.
--
-- `next_poll_ts` is what keeps the cost near zero: a lock placed on Thursday
-- for a Sunday game is not looked at until Sunday evening, so the grader does
-- nothing at all most of the time.
CREATE TABLE IF NOT EXISTS grade_queue (
  lock_id      TEXT PRIMARY KEY REFERENCES locks(id) ON DELETE CASCADE,
  next_poll_ts INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_grade_queue_due ON grade_queue(next_poll_ts);

-- Backfill anything already placed and unsettled, so turning the grader on
-- does not strand the locks that existed before it.
INSERT OR IGNORE INTO grade_queue (lock_id, next_poll_ts, attempts)
SELECT id, COALESCE(first_start_ts, placed_ts) + 10800, 0
  FROM locks
 WHERE settled_state IS NULL;
