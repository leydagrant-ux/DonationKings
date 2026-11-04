"""Exercise worker/schema.sql against real SQLite.

D1 is SQLite, so this is a faithful test of the DDL, the CHECK constraints and
the triggers without needing a Cloudflare account. It is the cheapest place to
catch a schema mistake: the alternative is finding out after a migration has
already been applied to real data.

Run: python -I tools/schema_test.py
"""
import io
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.normpath(os.path.join(HERE, "..", "worker", "schema.sql"))

results = []


def check(name, fn):
    try:
        fn()
        results.append((True, name, ""))
    except AssertionError as e:
        results.append((False, name, str(e)))
    except Exception as e:  # noqa: BLE001
        results.append((False, name, "%s: %s" % (type(e).__name__, e)))


def refused(db, sql, args=(), because=""):
    """Assert the database rejects a write, which is the point of a guard."""
    try:
        db.execute(sql, args)
        db.commit()
        raise AssertionError("was allowed but should have been refused (%s)" % because)
    except sqlite3.IntegrityError:
        return
    except sqlite3.OperationalError as e:
        if "RAISE" in str(e) or "abort" in str(e).lower():
            return
        raise


def fresh():
    db = sqlite3.connect(":memory:")
    db.executescript(io.open(SCHEMA, encoding="utf-8").read())
    db.execute("PRAGMA foreign_keys = ON")
    return db


def seed(db):
    db.execute("INSERT INTO users (uid, display_name, created_ts) VALUES ('u1','Grant',1000)")
    db.execute("INSERT INTO users (uid, display_name, created_ts) VALUES ('u2','Ashtin',1000)")
    db.execute("INSERT INTO leagues (code, name, owner_uid, created_ts) VALUES ('DEGEN7','Sunday Degenerates','u1',1000)")
    db.execute("INSERT INTO league_members (code, uid, role, joined_ts) VALUES ('DEGEN7','u1','owner',1000)")
    db.execute("INSERT INTO league_members (code, uid, role, joined_ts) VALUES ('DEGEN7','u2','member',1100)")
    db.commit()


def add_lock(db, lock_id="L1", stake=2500, uid="u1", eligible=1):
    db.execute(
        "INSERT INTO locks (id, code, uid, week_key, stake_cents, placed_ts, submitted_ts, eligible, created_ts)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (lock_id, "DEGEN7", uid, "2026-W45", stake, 2000, 2000, eligible, 2000),
    )
    db.execute(
        "INSERT INTO legs (id, lock_id, idx, raw_text, league, odds_american) VALUES (?,?,?,?,?,?)",
        (lock_id + "-0", lock_id, 0, "Packers ML", "nfl", -165),
    )
    db.commit()


# --------------------------------------------------------------------------

def t_applies():
    db = fresh()
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    expected = {"users", "leagues", "league_members", "locks", "legs", "leg_overrides", "ledger", "audit"}
    missing = expected - names
    assert not missing, "missing tables: %s" % sorted(missing)


def t_idempotent():
    # Migrations get run twice by accident. IF NOT EXISTS everywhere means the
    # second run is a no-op rather than an error.
    db = fresh()
    db.executescript(io.open(SCHEMA, encoding="utf-8").read())


def t_strict():
    db = fresh()
    seed(db)
    ins = ("INSERT INTO locks (id, code, uid, week_key, stake_cents, placed_ts, submitted_ts, created_ts)"
           " VALUES (?,'DEGEN7','u1','2026-W45',?,1,1,1)")
    # What STRICT actually promises is narrower than it first looks: a value
    # must be of the column's type OR losslessly convertible to it. So '2500'
    # IS accepted and coerced, which is worth knowing before relying on STRICT
    # to catch a stringy number from the client. The Worker validates types
    # itself for that reason.
    db.execute(ins, ("Lnum", "2500"))
    db.commit()
    got = db.execute("SELECT stake_cents, typeof(stake_cents) FROM locks WHERE id='Lnum'").fetchone()
    assert got == (2500, "integer"), "expected a coerced integer, got %r" % (got,)
    # What it does refuse is anything that would lose information.
    refused(db, ins, ("Lbad", "abc"), because="stake is not a number at all")
    refused(db, ins, ("Lfrac", 25.5), because="a fractional cent cannot be an integer")


def t_checks():
    db = fresh()
    seed(db)
    refused(db, "INSERT INTO leagues (code, name, owner_uid, start_bankroll_cents, created_ts)"
                " VALUES ('X','n','u1',0,1)", because="zero bankroll")
    refused(db, "INSERT INTO leagues (code, name, owner_uid, created_ts) VALUES ('Y','','u1',1)",
            because="empty name")
    refused(db, "INSERT INTO league_members (code, uid, role, joined_ts) VALUES ('DEGEN7','u1','admin',1)",
            because="unknown role")
    add_lock(db)
    refused(db, "INSERT INTO legs (id, lock_id, idx, raw_text, league) VALUES ('z','L1',9,'x','cricket')",
            because="unknown league")
    refused(db, "UPDATE locks SET settled_state='maybe' WHERE id='L1'", because="unknown settle state")


def t_foreign_keys():
    db = fresh()
    seed(db)
    refused(db, "INSERT INTO locks (id, code, uid, week_key, stake_cents, placed_ts, submitted_ts, created_ts)"
                " VALUES ('Lz','NOPE99','u1','2026-W45',100,1,1,1)", because="league does not exist")
    refused(db, "INSERT INTO league_members (code, uid, role, joined_ts) VALUES ('DEGEN7','ghost','member',1)",
            because="user does not exist")


def t_legs_immutable():
    db = fresh()
    seed(db)
    add_lock(db)
    # Rewriting what somebody bet is never legitimate.
    refused(db, "UPDATE legs SET raw_text='Bears ML' WHERE id='L1-0'", because="leg text")
    refused(db, "UPDATE legs SET odds_american=-110 WHERE id='L1-0'", because="leg price")
    # Resolution fields are NOT frozen: the server fills those in.
    db.execute("UPDATE legs SET event_id='401873023', event_start_ts=2500 WHERE id='L1-0'")
    db.commit()
    got = db.execute("SELECT event_id FROM legs WHERE id='L1-0'").fetchone()[0]
    assert got == "401873023", "resolution should still be writable, got %r" % got


def t_lock_core_immutable():
    db = fresh()
    seed(db)
    add_lock(db)
    refused(db, "UPDATE locks SET stake_cents=1 WHERE id='L1'", because="stake")
    refused(db, "UPDATE locks SET week_key='2026-W46' WHERE id='L1'", because="week")
    refused(db, "UPDATE locks SET uid='u2' WHERE id='L1'", because="owner")
    refused(db, "UPDATE locks SET submitted_ts=1 WHERE id='L1'", because="submitted time")
    # Settling is allowed, once.
    db.execute("UPDATE locks SET settled_state='won', settled_return_cents=9000, settled_ts=3000 WHERE id='L1'")
    db.commit()


def t_settle_once():
    db = fresh()
    seed(db)
    add_lock(db)
    db.execute("UPDATE locks SET settled_state='won', settled_return_cents=9000 WHERE id='L1'")
    db.commit()
    # A second, different settlement must be refused: a correction is a
    # compensating ledger row, not a quiet rewrite of history.
    refused(db, "UPDATE locks SET settled_state='lost' WHERE id='L1'", because="already settled")
    # Re-writing the SAME state is a harmless retry and must not blow up.
    db.execute("UPDATE locks SET settled_state='won', settled_ts=4000 WHERE id='L1'")
    db.commit()


def t_ledger_idempotent():
    db = fresh()
    seed(db)
    add_lock(db)
    db.execute("INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
               " VALUES ('g1','DEGEN7','u1','2026-W45','L1','stake',-2500,'stake:L1',2000)")
    db.commit()
    # THE guard: a double tap or a cron rerun cannot pay twice.
    refused(db, "INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
                " VALUES ('g2','DEGEN7','u1','2026-W45','L1','stake',-2500,'stake:L1',2100)",
            because="same idempotency key")
    # A different key for the same lock is fine: stake and payout are two rows.
    db.execute("INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
               " VALUES ('g3','DEGEN7','u1','2026-W45','L1','payout',9000,'payout:L1',3000)")
    db.commit()


def t_ledger_append_only():
    db = fresh()
    seed(db)
    add_lock(db)
    db.execute("INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
               " VALUES ('g1','DEGEN7','u1','2026-W45','L1','stake',-2500,'stake:L1',2000)")
    db.commit()
    refused(db, "UPDATE ledger SET delta_cents=0 WHERE id='g1'", because="ledger update")
    # Before settlement a stake row is a hold, so withdrawing an unsettled
    # lock must be able to release it. That is the one delete allowed.
    db.execute("DELETE FROM ledger WHERE id='g1'")
    db.commit()
    # Once the lock has settled, the rows are the record of money that moved.
    db.execute("INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
               " VALUES ('g9','DEGEN7','u1','2026-W45','L1','stake',-2500,'stake:L1b',2000)")
    db.execute("UPDATE locks SET settled_state='won', settled_return_cents=9000 WHERE id='L1'")
    db.commit()
    refused(db, "DELETE FROM ledger WHERE id='g9'", because="settled money")
    # An UPDATE matching no rows never fires a BEFORE UPDATE trigger, so the
    # audit guard has to be tested against a row that actually exists.
    db.execute("INSERT INTO audit (id, code, actor_uid, action, created_ts)"
               " VALUES ('a1','DEGEN7','u1','lock.create',1)")
    db.commit()
    refused(db, "UPDATE audit SET action='x' WHERE id='a1'", because="audit update")
    refused(db, "DELETE FROM audit WHERE id='a1'", because="audit delete")


def t_balance_is_the_sum():
    db = fresh()
    seed(db)
    add_lock(db, "L1", 2500)
    add_lock(db, "L2", 1000)
    rows = [
        ("g1", "L1", "stake", -2500, "stake:L1"),
        ("g2", "L1", "payout", 9000, "payout:L1"),
        ("g3", "L2", "stake", -1000, "stake:L2"),
    ]
    for gid, lock, kind, delta, key in rows:
        db.execute("INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
                   " VALUES (?,?,?,?,?,?,?,?,?)", (gid, "DEGEN7", "u1", "2026-W45", lock, kind, delta, key, 1))
    db.commit()
    total = db.execute("SELECT SUM(delta_cents) FROM ledger WHERE code='DEGEN7' AND week_key='2026-W45' AND uid='u1'").fetchone()[0]
    assert total == 5500, "expected 5500, got %r" % total
    start = db.execute("SELECT start_bankroll_cents FROM leagues WHERE code='DEGEN7'").fetchone()[0]
    assert start + total == 15500, "bankroll should be start plus the ledger"


def t_cascades():
    db = fresh()
    seed(db)
    add_lock(db)
    db.execute("DELETE FROM locks WHERE id='L1'")
    db.commit()
    left = db.execute("SELECT COUNT(*) FROM legs WHERE lock_id='L1'").fetchone()[0]
    assert left == 0, "legs should go with their lock, %d left" % left


def t_owner_role_consistent():
    db = fresh()
    seed(db)
    # Promoting someone to owner in the membership table without moving
    # ownership on the league itself would leave two sources of truth.
    refused(db, "UPDATE league_members SET role='owner' WHERE code='DEGEN7' AND uid='u2'",
            because="role out of step with leagues.owner_uid")
    db.execute("UPDATE leagues SET owner_uid='u2' WHERE code='DEGEN7'")
    db.execute("UPDATE league_members SET role='owner' WHERE code='DEGEN7' AND uid='u2'")
    db.execute("UPDATE league_members SET role='member' WHERE code='DEGEN7' AND uid='u1'")
    db.commit()


def t_standings_query():
    # The query the Worker actually runs for a week's standings.
    db = fresh()
    seed(db)
    add_lock(db, "L1", 2500, "u1")
    add_lock(db, "L2", 10000, "u2")
    db.execute("UPDATE locks SET settled_state='won', settled_return_cents=9000 WHERE id='L1'")
    db.execute("UPDATE locks SET settled_state='lost', settled_return_cents=0 WHERE id='L2'")
    for gid, lock, uid, kind, delta, key in [
        ("g1", "L1", "u1", "stake", -2500, "stake:L1"), ("g2", "L1", "u1", "payout", 9000, "payout:L1"),
        ("g3", "L2", "u2", "stake", -10000, "stake:L2"), ("g4", "L2", "u2", "payout", 0, "payout:L2"),
    ]:
        db.execute("INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts)"
                   " VALUES (?,?,?,?,?,?,?,?,?)", (gid, "DEGEN7", uid, "2026-W45", lock, kind, delta, key, 1))
    db.commit()
    rows = db.execute("""
        SELECT m.uid, u.display_name,
               l.start_bankroll_cents + COALESCE(SUM(g.delta_cents), 0) AS bankroll
          FROM league_members m
          JOIN users u ON u.uid = m.uid
          JOIN leagues l ON l.code = m.code
          LEFT JOIN ledger g ON g.uid = m.uid AND g.code = m.code AND g.week_key = '2026-W45'
         WHERE m.code = 'DEGEN7' AND m.left_ts IS NULL
         GROUP BY m.uid
         ORDER BY bankroll DESC
    """).fetchall()
    assert [r[2] for r in rows] == [16500, 0], "expected [16500, 0], got %r" % [r[2] for r in rows]
    assert rows[0][1] == "Grant", "Grant should lead"


for name, fn in [
    ("the schema applies cleanly", t_applies),
    ("and applying it twice is a no-op", t_idempotent),
    ("STRICT coerces losslessly and refuses the rest", t_strict),
    ("CHECK constraints hold", t_checks),
    ("foreign keys hold", t_foreign_keys),
    ("a leg cannot be rewritten, but can be resolved", t_legs_immutable),
    ("stake, week and owner are frozen", t_lock_core_immutable),
    ("a lock settles once", t_settle_once),
    ("the ledger cannot pay twice", t_ledger_idempotent),
    ("the ledger and audit are append-only", t_ledger_append_only),
    ("a bankroll is the sum of its ledger", t_balance_is_the_sum),
    ("deleting a lock takes its legs", t_cascades),
    ("the owner role stays in step", t_owner_role_consistent),
    ("the standings query returns the right order", t_standings_query),
]:
    check(name, fn)

passed = sum(1 for ok, _, _ in results if ok)
for ok, name, detail in results:
    print("  %s %s%s" % ("ok  " if ok else "FAIL", name, "" if ok else "  <- " + detail))
print("\n%d passed, %d failed, %d checks" % (passed, len(results) - passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
