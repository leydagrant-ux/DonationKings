/* grader.js: settle finished locks on a schedule, so a result does not wait
 * for somebody to open the app.
 *
 * It imports the SAME engine the browser uses (../dk/derive.js and what that
 * pulls in), so the server and a phone cannot reach different verdicts about
 * who won. That is the whole reason derive.js carries no UI import.
 *
 * The binding constraint is Worker CPU, not the database. One NFL summary is
 * roughly 650KB of JSON and parsing it is most of a free-tier invocation's
 * budget, and there is no way to parse JSON partially. So a tick does a
 * strictly bounded amount of work: a couple of locks, a handful of fetches,
 * and it stops. A minute later it does a bit more. Nothing here tries to
 * settle a whole Sunday in one go.
 */

import { deriveLock } from '../dk/derive.js';
import { eventsFromScoreboard, snapshotFromSummary, LEAGUES } from '../dk/espn.js';
import { STATE } from '../dk/grade.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/* Tuned low on purpose. Raise only after measuring real CPU with
 * `wrangler tail`; one summary parse is already most of the budget. */
export const LIMITS = {
  locksPerTick: 2,
  summariesPerTick: 3,
  maxAttempts: 60, // roughly two days of backoff before giving up
};

/* How long after a game starts it is worth looking. Football is the long
 * one at a bit over three hours; checking sooner just burns a fetch. */
const SETTLE_DELAY_SEC = 3 * 3600;

/** Backoff: start at 10 minutes, double, cap at an hour. */
function nextPoll(attempts) {
  const mins = Math.min(60, 10 * (2 ** Math.min(attempts, 3)));
  return Math.floor(Date.now() / 1000) + mins * 60;
}

async function getJSON(url, budget) {
  if (budget.fetches <= 0) return null;
  budget.fetches -= 1;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Load just enough of the slate to grade one lock.
 *
 * Scoreboards first, which are cheap and say which games are finished. Then
 * summaries, but ONLY for games that are actually complete: a game still in
 * progress cannot settle a lock, so fetching its 650KB box score would be
 * spending the entire CPU budget to learn nothing.
 */
async function contextFor(legs, budget, cache, attempts = 0) {
  const leagues = [...new Set(legs.map((l) => l.league).filter((lg) => LEAGUES[lg]))];
  const events = [];

  for (const lg of leagues) {
    if (!cache.boards.has(lg)) {
      const raw = await getJSON(`${BASE}/${LEAGUES[lg].path}/scoreboard`, budget);
      cache.boards.set(lg, raw ? eventsFromScoreboard(raw, lg) : []);
    }
    events.push(...cache.boards.get(lg));
  }

  // Which of today's finished games does this lock plausibly mention?
  const wanted = [];
  for (const ev of events) {
    if (ev.state !== 'post') continue;
    const named = legs.some((leg) => {
      const text = String(leg.raw_text || '').toLowerCase();
      return [ev.home, ev.away].some((t) => t && t.names.some((n) => {
        const nn = String(n).toLowerCase();
        return nn.length >= 3 && text.includes(nn);
      }));
    });
    if (named) wanted.push(ev);
  }

  /* A player-only lock names no team, so there is nothing to scope by and the
   * only option is to look through the finished games. The per-tick cap stops
   * that being expensive, but a cap alone would mean a lock whose game sits
   * past the cap is never reached, on this tick or any other.
   *
   * So successive attempts start further down the slate. Each tick covers a
   * different slice and the lock is settled within a few of them, instead of
   * being stuck forever behind the same first few games. */
  const all = wanted.length ? wanted : events.filter((e) => e.state === 'post');
  const offset = wanted.length ? 0 : (attempts * LIMITS.summariesPerTick) % Math.max(1, all.length);
  const pool = offset ? [...all.slice(offset), ...all.slice(0, offset)] : all;

  const snapshots = [];
  for (const ev of pool) {
    if (snapshots.length >= LIMITS.summariesPerTick) break;
    if (cache.snaps.has(ev.eventId)) {
      snapshots.push(cache.snaps.get(ev.eventId));
      continue;
    }
    const raw = await getJSON(`${BASE}/${LEAGUES[ev.league].path}/summary?event=${ev.eventId}`, budget);
    if (!raw) continue;
    const snap = snapshotFromSummary(raw, ev.league);
    cache.snaps.set(ev.eventId, snap);
    snapshots.push(snap);
  }

  return { events, snapshots };
}

/** The stored lock, in the shape derive.js expects. */
function toStored(lock, legs, overrides) {
  return {
    id: lock.id,
    code: lock.code,
    uid: lock.uid,
    weekKey: lock.week_key,
    stakeCompCents: lock.stake_cents,
    boostPct: lock.boost_pct,
    placedAt: lock.placed_ts * 1000,
    eligible: !!lock.eligible,
    picks: legs.map((l) => ({ text: l.raw_text, league: l.league, odds: l.odds_american })),
    overrides,
  };
}

/**
 * One scheduled run.
 *
 * Returns a small summary rather than logging freely, so `wrangler tail`
 * shows one line per tick and the cost of a tick stays visible.
 */
export async function runGrader(env, now = Math.floor(Date.now() / 1000)) {
  const db = env.DB;
  const out = { looked: 0, settled: 0, pending: 0, dropped: 0, errors: [] };
  const budget = { fetches: LIMITS.summariesPerTick + 4 };
  const cache = { boards: new Map(), snaps: new Map() };

  const { results: due } = await db.prepare(
    `SELECT q.lock_id, q.attempts, l.*
       FROM grade_queue q JOIN locks l ON l.id = q.lock_id
      WHERE q.next_poll_ts <= ? AND l.settled_state IS NULL
      ORDER BY q.next_poll_ts
      LIMIT ?`,
  ).bind(now, LIMITS.locksPerTick).all();

  for (const lock of due) {
    out.looked += 1;
    try {
      const { results: legs } = await db.prepare(
        'SELECT idx, raw_text, league, odds_american FROM legs WHERE lock_id = ? ORDER BY idx',
      ).bind(lock.id).all();
      if (!legs.length) {
        await db.prepare('DELETE FROM grade_queue WHERE lock_id = ?').bind(lock.id).run();
        out.dropped += 1;
        continue;
      }

      const { results: ov } = await db.prepare(
        'SELECT idx, state FROM leg_overrides WHERE lock_id = ?',
      ).bind(lock.id).all();
      const overrides = {};
      for (const o of ov) overrides[o.idx] = o.state;

      const ctx = await contextFor(legs, budget, cache, lock.attempts || 0);
      const derived = deriveLock(toStored(lock, legs, overrides), ctx);

      if (!derived.roll || !derived.roll.final) {
        // Not finished, or a leg needs a person. Either way, try later.
        out.pending += 1;
        await db.prepare('UPDATE grade_queue SET next_poll_ts = ?, attempts = attempts + 1, last_error = NULL WHERE lock_id = ?')
          .bind(nextPoll(lock.attempts), lock.id).run();
        if (lock.attempts + 1 >= LIMITS.maxAttempts) {
          await db.prepare('DELETE FROM grade_queue WHERE lock_id = ?').bind(lock.id).run();
          out.dropped += 1;
        }
        continue;
      }

      // Settle. The same idempotency key the app's own settle route uses, so
      // whichever gets there first wins and the other is a harmless no-op.
      const ret = derived.returnCents === null ? 0 : derived.returnCents;
      await db.batch([
        db.prepare('UPDATE locks SET settled_state = ?, settled_return_cents = ?, settled_ts = ? WHERE id = ? AND settled_state IS NULL')
          .bind(derived.state, ret, now, lock.id),
        db.prepare(
          'INSERT OR IGNORE INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts) VALUES (?,?,?,?,?,?,?,?,?)',
        ).bind(`g-${crypto.randomUUID()}`, lock.code, lock.uid, lock.week_key, lock.id, 'payout', ret, `payout:${lock.id}`, now),
        db.prepare('INSERT INTO audit (id, code, lock_id, actor_uid, action, detail, created_ts) VALUES (?,?,?,?,?,?,?)')
          .bind(`a-${crypto.randomUUID()}`, lock.code, lock.id, null, 'lock.settle.cron',
            JSON.stringify({ state: derived.state, returnCents: ret }), now),
        db.prepare('DELETE FROM grade_queue WHERE lock_id = ?').bind(lock.id),
      ]);
      out.settled += 1;
    } catch (e) {
      out.errors.push(`${lock.id}: ${String(e && e.message).slice(0, 100)}`);
      await db.prepare('UPDATE grade_queue SET next_poll_ts = ?, attempts = attempts + 1, last_error = ? WHERE lock_id = ?')
        .bind(nextPoll(lock.attempts), String(e && e.message).slice(0, 200), lock.id).run();
    }
  }

  return out;
}

/** Put a newly placed lock in the queue, due once its games should be over. */
export function enqueueStatement(db, lockId, firstStartTs, placedTs) {
  const base = firstStartTs || placedTs || Math.floor(Date.now() / 1000);
  return db.prepare('INSERT OR REPLACE INTO grade_queue (lock_id, next_poll_ts, attempts) VALUES (?,?,0)')
    .bind(lockId, base + SETTLE_DELAY_SEC);
}

export { STATE };
