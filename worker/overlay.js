/* overlay.js: one read-only endpoint, for the TV overlay on the LAN.
 *
 * `FantasyOverlay/parlay.py` draws a parlay board on Grant's TV. It is a
 * Python script on the house wifi with no Firebase, so it cannot use the
 * app's own routes. This serves it the one thing it needs: his open locks,
 * with their legs already graded, in exactly the shape `dk/grade.js` emits.
 *
 * WHAT THIS IS ALLOWED TO DO, and nothing else:
 *
 *   - Read. There is no write path in this file, no INSERT, no UPDATE, and
 *     nothing that touches `ledger`, `locks.settled_state` or `grade_queue`.
 *     A bug here cannot move money or settle a bet.
 *   - For ONE person. The uid comes from `OVERLAY_UID`, a Worker secret, and
 *     is never taken from the request. There is no parameter that can point
 *     this at somebody else's locks, so the token cannot be turned into a way
 *     to read the league.
 *   - Behind its own token. `OVERLAY_TOKEN` is a long random string shared
 *     with the one machine on the LAN. It is checked in `index.js` before
 *     this runs, and it grants nothing anywhere else: every other route
 *     still demands a Firebase ID token.
 *
 * Grading is the same code the browser and the cron grader run, imported
 * rather than reimplemented, so the TV cannot disagree with the phone. The
 * overlay reads `clinched` and `dead` freely because it is a display; it is
 * never the thing that tells anyone they won money, and the ledger is not
 * written from here.
 *
 * COST. This is polled every 25 seconds while a game is on, and one NFL box
 * score is ~650KB of JSON whose parse is most of a Worker invocation's CPU
 * budget. So the work is bounded three ways: nothing is fetched at all when
 * there are no open locks, only STARTED games get a box score, and the
 * finished payload is cached in the isolate for a few seconds so a burst of
 * polls costs one computation.
 */

import { deriveLock } from '../dk/derive.js';
import { loadContext } from '../dk/feed.js';

/* Open locks to consider. A board that caps at four lines does not need more
 * than a handful, and every extra lock widens the set of games to fetch.
 * Inlined into the SQL rather than bound: a bound LIMIT returned zero rows
 * from the Worker against a database where the typed-out query returned two,
 * which cost the grader an afternoon. It is an internal constant. */
const MAX_LOCKS = 8;

/* Box scores per request. Six is already a lot of parsing; the point of the
 * cap is that a college Saturday cannot turn one poll into a timeout. */
const DEFAULT_MAX_SUMMARIES = 6;

/* The isolate keeps the last answer this long. ESPN serves its own feeds with
 * max-age=4 and `feed.js` holds live summaries for 20s, so a shorter window
 * here would only re-derive the same numbers. */
const CACHE_MS = 12000;

let cached = { key: '', at: 0, payload: null };

/** The stored lock, in the shape derive.js expects. Same mapping as the grader. */
function toStored(lock, legs, overrides) {
  return {
    id: lock.id,
    code: lock.code,
    uid: lock.uid,
    weekKey: lock.week_key,
    stakeCompCents: lock.stake_cents,
    payoutCents: lock.payout_cents === undefined ? null : lock.payout_cents,
    boostPct: lock.boost_pct,
    placedAt: lock.placed_ts * 1000,
    firstStartAt: lock.first_start_ts ? lock.first_start_ts * 1000 : null,
    eligible: !!lock.eligible,
    picks: legs.map((l) => ({ text: l.raw_text, league: l.league, odds: l.odds_american })),
    overrides,
  };
}

/**
 * One graded leg, exactly the keys `parlay.py` reads.
 *
 * `label` is the one place this does not pass the verdict straight through.
 * `grade.js` leaves it empty until it has a box score, which on screen reads
 * as a row of question marks before kickoff, so the leg as written stands in
 * until there is something better to say.
 */
function legOut(verdict, pick) {
  const written = String((pick && pick.text) || '').trim();
  return {
    state: verdict.state,
    clinched: !!verdict.clinched,
    dead: !!verdict.dead,
    current: verdict.current === undefined ? null : verdict.current,
    needed: verdict.needed === undefined ? null : verdict.needed,
    pct: Number(verdict.pct) || 0,
    overshoot: !!verdict.overshoot,
    render: verdict.render || 'bar',
    label: verdict.label || written || '?',
  };
}

/** A name for the board's source line. The schema has no title for a lock. */
function nameOf(lock, legCount) {
  const n = `${legCount}-leg`;
  const book = String(lock.book || '').trim().slice(0, 20);
  return book ? `${n} ${book}` : n;
}

/**
 * Grant's open locks with graded legs.
 *
 * Returns `{ parlays, week, generatedAt, errors }`. `parlays` is ordered
 * newest first and each entry carries `legs`, `stake_cents`, `payout_cents`,
 * a `name`, and `started`, which is false while every game on it is still to
 * kick off. The watcher uses `started` to keep a Saturday-night board empty
 * instead of showing five dashes against a game that is a day away.
 *
 * Never throws: the caller is a TV overlay, and a failure here should read as
 * "nothing on screen", not as a 500.
 */
export async function overlayParlays(env, opts = {}) {
  const db = env.DB;
  const uid = String(env.OVERLAY_UID || '').trim();
  const out = { parlays: [], week: opts.week || null, generatedAt: Date.now(), errors: [] };
  if (!db || !uid) {
    out.errors.push('overlay is not configured');
    return out;
  }

  const key = `${uid}|${opts.week || ''}`;
  if (cached.payload && cached.key === key && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.payload, cached: true };
  }

  /* His own unsettled locks. `uid = ?` is the whole of the scoping and the
   * uid is a secret, not a parameter, so there is no request that reads
   * anyone else. Unsettled rather than "this week" on purpose: an ISO week
   * boundary falls on Monday morning, in the middle of nothing, while a
   * Thursday lock is still running on Sunday. An explicit ?week= still
   * narrows it for anyone who wants that. */
  const where = opts.week ? 'AND l.week_key = ?' : '';
  const binds = opts.week ? [uid, opts.week] : [uid];
  const { results: locks } = await db.prepare(
    `SELECT l.id AS id, l.code AS code, l.uid AS uid, l.week_key AS week_key,
            l.stake_cents AS stake_cents, l.payout_cents AS payout_cents,
            l.boost_pct AS boost_pct, l.book AS book, l.placed_ts AS placed_ts,
            l.first_start_ts AS first_start_ts, l.eligible AS eligible
       FROM locks l
      WHERE l.uid = ? AND l.settled_state IS NULL ${where}
      ORDER BY l.placed_ts DESC
      LIMIT ${MAX_LOCKS}`,
  ).bind(...binds).all();

  // Nothing open: answer without touching the network at all. Most polls
  // during the week land here, and they cost one indexed query.
  if (!locks.length) return finish(key, out);

  const ids = locks.map((l) => l.id);
  const marks = ids.map(() => '?').join(',');
  const { results: legRows } = await db.prepare(
    `SELECT lock_id, idx, raw_text, league, odds_american FROM legs
      WHERE lock_id IN (${marks}) ORDER BY lock_id, idx`,
  ).bind(...ids).all();
  const { results: ovRows } = await db.prepare(
    `SELECT lock_id, idx, state FROM leg_overrides WHERE lock_id IN (${marks})`,
  ).bind(...ids).all();

  const legsBy = new Map(ids.map((id) => [id, []]));
  for (const r of legRows) legsBy.get(r.lock_id).push(r);
  const ovBy = new Map();
  for (const r of ovRows) {
    if (!ovBy.has(r.lock_id)) ovBy.set(r.lock_id, {});
    ovBy.get(r.lock_id)[r.idx] = r.state;
  }

  const stored = locks
    .map((l) => toStored(l, legsBy.get(l.id) || [], ovBy.get(l.id) || {}))
    .filter((s) => s.picks.length);
  if (!stored.length) return finish(key, out);

  const maxSummaries = Number(env.OVERLAY_MAX_SUMMARIES) > 0
    ? Number(env.OVERLAY_MAX_SUMMARIES) : DEFAULT_MAX_SUMMARIES;

  /* `startedOnly` is what keeps this cheap on a Saturday night. Without it a
   * five-leg slip naming five different fixtures pulls five box scores of a
   * game that has not kicked off, which cannot grade anything. */
  const ctx = await loadContext(stored, { maxSummaries, startedOnly: true });
  out.errors = (ctx.errors || []).slice(0, 4);

  const startedIds = new Set();
  for (const e of ctx.events || []) {
    if (e.state === 'in' || e.state === 'post') startedIds.add(e.eventId);
  }

  const byLock = new Map(locks.map((l) => [l.id, l]));
  for (const s of stored) {
    const lock = byLock.get(s.id);
    let derived;
    try {
      derived = deriveLock(s, ctx);
    } catch (e) {
      out.errors.push(`could not grade ${s.id}`);
      continue;
    }
    const legs = (derived.legs || []).map((l) => legOut(l.verdict, s.picks[l.index]));
    out.parlays.push({
      id: s.id,
      name: nameOf(lock, legs.length),
      week: s.weekKey,
      stake_cents: s.stakeCompCents,
      // What it pays if it all lands. `toWinCents` is the slip's own figure
      // when there is one, which is the number on the board.
      payout_cents: derived.toWinCents === null || derived.toWinCents === undefined
        ? null : derived.toWinCents,
      // The lock's own rollup, for anything that wants it. The board works
      // off the legs; this is here so a reader does not have to re-derive it.
      state: derived.state,
      // False while every game on it is still to come, so the watcher can
      // leave the screen alone until there is something to watch.
      started: (derived.legs || []).some(
        (l) => l.leg && l.leg.eventId && startedIds.has(l.leg.eventId)),
      legs,
    });
  }

  return finish(key, out);
}

function finish(key, payload) {
  cached = { key, at: Date.now(), payload };
  return payload;
}

/** Drop the memo. Tests use it; nothing in production needs it. */
export function clearOverlayCache() {
  cached = { key: '', at: 0, payload: null };
}
