-- DonationKings D1 schema.
--
-- Conventions, applied everywhere:
--   * STRICT tables, so "100" arriving where 100 was meant is an error at the
--     boundary instead of a silent bug three screens later.
--   * All money is an INTEGER number of cents. No floats touch a balance.
--   * All times are INTEGER unix SECONDS (the client works in ms; the Worker
--     divides once on the way in).
--
-- Apply with:
--   npx wrangler d1 execute donationkings --file=./worker/schema.sql
--   npx wrangler d1 execute donationkings --local --file=./worker/schema.sql

PRAGMA foreign_keys = ON;

-- ============================== identity ==============================

CREATE TABLE IF NOT EXISTS users (
  uid          TEXT PRIMARY KEY,            -- Firebase claims.sub. Never from the client.
  display_name TEXT NOT NULL,
  created_ts   INTEGER NOT NULL,
  last_seen_ts INTEGER
) STRICT;

-- ============================== leagues ==============================

-- The invite code IS the id. It is unguessable (31-character alphabet, six
-- places, ambiguous letters removed) and that is the whole access model, which
-- is why there is deliberately no way to list leagues you are not in.
CREATE TABLE IF NOT EXISTS leagues (
  code                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  owner_uid            TEXT NOT NULL REFERENCES users(uid),
  start_bankroll_cents INTEGER NOT NULL DEFAULT 10000 CHECK (start_bankroll_cents > 0),
  tz                   TEXT NOT NULL DEFAULT 'America/Chicago',
  created_ts           INTEGER NOT NULL,
  archived_ts          INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS league_members (
  code      TEXT NOT NULL REFERENCES leagues(code) ON DELETE CASCADE,
  uid       TEXT NOT NULL REFERENCES users(uid),
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_ts INTEGER NOT NULL,
  left_ts   INTEGER,
  PRIMARY KEY (code, uid)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_members_uid ON league_members(uid, left_ts);

-- ============================== locks ==============================

CREATE TABLE IF NOT EXISTS locks (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL REFERENCES leagues(code) ON DELETE CASCADE,
  uid           TEXT NOT NULL REFERENCES users(uid),
  -- Fixed when the lock is placed, NEVER derived from when it settled. A
  -- Sunday night game graded at 3am Monday still belongs to Sunday's week;
  -- getting this from the settle time bleeds bankroll across every boundary.
  week_key      TEXT NOT NULL,
  stake_cents   INTEGER NOT NULL CHECK (stake_cents > 0),
  boost_pct     INTEGER NOT NULL DEFAULT 0 CHECK (boost_pct >= 0 AND boost_pct <= 500),
  book          TEXT,
  placed_ts     INTEGER NOT NULL,            -- what the slip said, or submit time
  submitted_ts  INTEGER NOT NULL,            -- server clock. Never trusted from the client.
  first_start_ts INTEGER,                    -- earliest kickoff across the legs
  -- 0 when the lock was submitted after its first game started. Those are
  -- still tracked, they just do not count for the competition. This is the
  -- whole anti-backdating story and it costs nothing, because the start time
  -- is already in the feed.
  eligible      INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0, 1)),
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'screenshot', 'tail')),
  -- Settlement, written once by whoever sees the games finish first.
  settled_state TEXT CHECK (settled_state IN ('won', 'lost', 'push', 'void')),
  settled_return_cents INTEGER,
  settled_ts    INTEGER,
  created_ts    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_locks_league_week ON locks(code, week_key);
CREATE INDEX IF NOT EXISTS idx_locks_uid ON locks(uid, created_ts DESC);
CREATE INDEX IF NOT EXISTS idx_locks_open ON locks(code) WHERE settled_state IS NULL;

-- Legs are the text as the user confirmed it, plus the price. Nothing graded
-- is stored: verdicts are recomputed from live data every time, so a stale
-- grade can never be persisted and later believed.
CREATE TABLE IF NOT EXISTS legs (
  id       TEXT PRIMARY KEY,
  lock_id  TEXT NOT NULL REFERENCES locks(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  league   TEXT NOT NULL CHECK (league IN ('nfl', 'cfb', 'nba', 'cbb', 'nhl', 'mlb')),
  odds_american INTEGER,
  event_id TEXT,                              -- filled in once resolved
  event_start_ts INTEGER,                     -- resolved SERVER-SIDE, never client-supplied
  UNIQUE (lock_id, idx)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_legs_lock ON legs(lock_id, idx);

-- A person's call on a leg the engine refused to grade. Separate from `legs`
-- so the engine never needs to UPDATE legs at all, which is what lets legs be
-- categorically immutable, and so a machine pass can never clobber a human.
CREATE TABLE IF NOT EXISTS leg_overrides (
  lock_id   TEXT NOT NULL REFERENCES locks(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('won', 'lost', 'push', 'void')),
  actor_uid TEXT NOT NULL REFERENCES users(uid),
  reason    TEXT,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (lock_id, idx)
) STRICT;

-- ============================== money ==============================

-- The source of truth for every bankroll. Append-only: a balance is the sum
-- of its rows, never a column somebody can edit. The UNIQUE idempotency key
-- is what makes a double tap or a cron rerun physically unable to pay twice.
CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL REFERENCES leagues(code) ON DELETE CASCADE,
  uid         TEXT NOT NULL REFERENCES users(uid),
  week_key    TEXT NOT NULL,                  -- copied from the lock, not from now()
  lock_id     TEXT REFERENCES locks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('stake', 'payout', 'refund', 'adjustment')),
  delta_cents INTEGER NOT NULL,               -- signed
  idem_key    TEXT NOT NULL UNIQUE,           -- 'stake:{lock}' | 'payout:{lock}'
  note        TEXT,
  actor_uid   TEXT REFERENCES users(uid),     -- NULL means the engine wrote it
  created_ts  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_balance ON ledger(code, week_key, uid);
CREATE INDEX IF NOT EXISTS idx_ledger_lock ON ledger(lock_id);

-- ============================== the grader's queue ==============================

-- One row per lock waiting to be settled by the scheduled grader.
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

-- ============================== audit ==============================

CREATE TABLE IF NOT EXISTS audit (
  id         TEXT PRIMARY KEY,
  code       TEXT,
  lock_id    TEXT,
  actor_uid  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,                            -- small JSON blob
  created_ts INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_league ON audit(code, created_ts DESC);

-- ============================== guards ==============================
--
-- Three layers, because in a money app one is not enough: structural (no
-- engine column lives in `legs`, so the grader never needs to write there),
-- these triggers, and the ledger's UNIQUE idempotency key.

-- Legs are frozen once their lock exists. There is no legitimate reason to
-- rewrite what somebody bet.
CREATE TRIGGER IF NOT EXISTS legs_immutable
BEFORE UPDATE OF raw_text, odds_american, league, idx, lock_id ON legs
BEGIN
  SELECT RAISE(ABORT, 'a leg cannot be changed after the lock is placed');
END;

-- The money and the week can never move, at any point.
CREATE TRIGGER IF NOT EXISTS locks_core_immutable
BEFORE UPDATE OF stake_cents, week_key, uid, code, placed_ts, submitted_ts ON locks
BEGIN
  SELECT RAISE(ABORT, 'stake, week and owner are fixed when a lock is placed');
END;

-- Settlement is written once. A correction goes in as a compensating ledger
-- row, so the original settlement stays visible rather than being quietly
-- rewritten.
CREATE TRIGGER IF NOT EXISTS locks_settle_once
BEFORE UPDATE OF settled_state ON locks
WHEN OLD.settled_state IS NOT NULL AND NEW.settled_state IS NOT OLD.settled_state
BEGIN
  SELECT RAISE(ABORT, 'this lock is already settled');
END;

-- A ledger row is never edited. Not once, not by anyone.
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;

-- Deletion is narrower than "never", and the distinction is deliberate.
--
-- Once a lock has settled, its rows are the record of money that actually
-- moved and erasing them would be rewriting history. Before it settles, the
-- stake row is a hold rather than a result, and withdrawing a lock before its
-- first game starts has to be able to release that hold.
--
-- A blanket no-delete rule reads stricter but makes withdrawing an unsettled
-- lock impossible, which is a thing people legitimately need to do thirty
-- seconds after fat-fingering a stake.
CREATE TRIGGER IF NOT EXISTS ledger_no_delete_settled BEFORE DELETE ON ledger
WHEN (SELECT settled_state FROM locks WHERE id = OLD.lock_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'money that has already settled cannot be erased'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;

-- Exactly one owner per league, and the owner row cannot be demoted by a
-- membership edit that forgets to move ownership with it.
CREATE TRIGGER IF NOT EXISTS members_owner_matches
BEFORE UPDATE OF role ON league_members
WHEN NEW.role = 'owner' AND NEW.uid IS NOT (SELECT owner_uid FROM leagues WHERE code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'the owner role must match the league owner');
END;
