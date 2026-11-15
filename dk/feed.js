// feed.js: the only module that touches the network.
//
// Everything else in this app is a pure function over already-fetched data,
// which is what makes the engine testable. Keeping fetching in one file also
// means a change to ESPN's hosting is a change to one file.
//
// Nothing here throws. A failed fetch returns null and is reported, because a
// dropped request on a phone is normal and must never take the app down or,
// worse, read as "the player recorded nothing".

import { LEAGUES, snapshotFromSummary, eventsFromScoreboard } from './espn.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// ESPN serves these with Cache-Control max-age=4, so short lifetimes are both
// polite and accurate. Finished games are cached far longer: they cannot
// change, and re-fetching a 650KB payload to learn that is wasteful.
const TTL_SCOREBOARD = 30000;
const TTL_LIVE = 20000;
const TTL_FINAL = 3600000;

const cache = new Map(); // url -> { at, data, final }

export function clearCache() { cache.clear(); }

export function cacheStats() {
  let live = 0;
  let final = 0;
  for (const v of cache.values()) (v.final ? final++ : live++);
  return { entries: cache.size, live, final };
}

async function getJSON(url, ttl) {
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.at < (hit.final ? TTL_FINAL : ttl)) return hit.data;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return hit ? hit.data : null; // stale beats nothing
    const data = await res.json();
    cache.set(url, { at: now, data, final: false });
    return data;
  } catch {
    return hit ? hit.data : null;
  }
}

/** Mark a url's cached payload as final so it stops being re-fetched. */
function markFinal(url) {
  const hit = cache.get(url);
  if (hit) hit.final = true;
}

const pathOf = (league) => (LEAGUES[league] || {}).path;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
//
// A scoreboard asked for no date at all answers with the CURRENT week, and
// that is the whole of bug one: a lock placed in week nine was still being
// graded against whatever was on today's board, so once the board rolled over
// its games were simply unreachable and every leg sat on "waiting for the
// game to start" for ever. Worse, when a team of the same name played again
// the leg bound to the NEW game and could settle off it.
//
// `?dates=YYYYMMDD` still returns a finished day months later, so a lock whose
// games are in the past is graded against its OWN day instead.

/**
 * The scoreboard day a kickoff belongs to, as ESPN buckets them: US Eastern.
 *
 * Eastern rather than UTC because a Sunday night game kicking at 20:20 ET is
 * 01:20 UTC on Monday and sits on SUNDAY's board. Verified: `?dates=20261108`
 * returns the Bears game dated 2026-11-09T01:20Z.
 *
 * A fixed -5 is right for every real kickoff. Kickoffs run from about midday
 * to 20:30 Eastern, so the hour that separates EST from EDT never moves one
 * across midnight; only a game STARTING after midnight Eastern could, and
 * none do.
 */
export function dateKeyOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms - 5 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

const DAY = 86400000;

/** The day a key names, as ms, so keys can be stepped and compared. */
function keyToMs(key) {
  const s = String(key);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) + 5 * 3600000 + 12 * 3600000;
}

/**
 * How far forward of a lock's own day to look for its games.
 *
 * Four days covers a football week: a lock placed on the Thursday night game
 * can also hold a leg on the Monday nighter. It is deliberately not longer,
 * because seven days would reach the same fixture one week on, which is the
 * mis-binding this is here to prevent.
 */
const STALE_DAYS = 4;

/**
 * The day a lock's games live on: its first kickoff when that is known,
 * otherwise when it was placed.
 *
 * `firstStartAt` is the better anchor by far and is why the entry form now
 * works it out properly (see bug two). `placedAt` is the fallback for locks
 * written before that, which is exactly the week nine ones.
 */
function anchorOf(lock) {
  const first = Number.isFinite(lock.firstStartAt) ? lock.firstStartAt : null;
  return first || (Number.isFinite(lock.placedAt) ? lock.placedAt : null);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchScoreboard(league, yyyymmdd) {
  const path = pathOf(league);
  if (!path) return null;
  const q = yyyymmdd ? `?dates=${yyyymmdd}` : '';
  const raw = await getJSON(`${BASE}/${path}/scoreboard${q}`, TTL_SCOREBOARD);
  return raw ? eventsFromScoreboard(raw, league) : null;
}

export async function fetchSummary(league, eventId) {
  const path = pathOf(league);
  if (!path || !eventId) return null;
  const url = `${BASE}/${path}/summary?event=${eventId}`;
  const raw = await getJSON(url, TTL_LIVE);
  if (!raw) return null;
  const snap = snapshotFromSummary(raw, league);
  // A finished game is finished. Stop paying for it on every poll.
  if (snap.completed) markFinal(url);
  return snap;
}

// ---------------------------------------------------------------------------
// Loading what a set of locks needs
// ---------------------------------------------------------------------------

/**
 * Fetch enough to grade and display the given locks.
 *
 * Two passes, because resolution and fetching depend on each other: a team
 * leg names its game, but a player leg does not, and a player can only be
 * found in a box score we have already fetched.
 *
 *   1. Scoreboards. The current board, which is what a lock placed this week
 *      needs, plus the lock's OWN day for any lock whose games are already
 *      behind the current board.
 *   2. Summaries for the games that matter. Games a team leg already points
 *      at come first; after that, any other started game on the slate, which
 *      is what lets a player-only lock resolve at all.
 *
 * `maxSummaries` caps the second pass. A college football Saturday is well
 * over a hundred games at roughly 650KB each, and a phone should not try to
 * pull the lot. Games already pointed at by a leg are never capped away.
 *
 * The returned context carries `scope`: lock id -> the set of event ids that
 * lock is allowed to be graded against, which is the games on ITS days. That
 * is what stops a week nine leg binding to week ten's fixture between the
 * same two teams; `derive.js` applies it. A lock with no entry in `scope` is
 * unrestricted, so a caller that does not build one behaves as before.
 */
export async function loadContext(locks, { maxSummaries = 12, dates, maxBoards = 8 } = {}) {
  const open = (locks || []).filter((l) => (l.picks || []).length);
  const leagues = [...new Set(open.flatMap((l) => (l.picks || []).map((p) => p.league)).filter(Boolean))];
  const errors = [];

  // key -> events. The current board is keyed `*`: asked for no date it
  // answers with the whole of the current week, which is more than one day
  // and is exactly what a live lock wants.
  const boards = new Map();
  const load = async (lg, key) => {
    const id = `${lg}:${key}`;
    if (boards.has(id)) return boards.get(id);
    const ev = await fetchScoreboard(lg, key === '*' ? dates : key);
    if (!ev) errors.push(`could not load the ${lg.toUpperCase()} slate${key === '*' ? '' : ` for ${key}`}`);
    boards.set(id, ev || []);
    return ev || [];
  };

  await Promise.all(leagues.map((lg) => load(lg, '*')));

  /* The first kickoff the current board knows about, per league. A lock whose
   * games are older than that is one the current board cannot answer for, so
   * it gets its own day fetched. This is a question about the DATA rather
   * than about the clock, which matters because when a board rolls over to
   * the next week is ESPN's business, not ours. */
  const boardStart = new Map();
  for (const lg of leagues) {
    const starts = (boards.get(`${lg}:*`) || []).map((e) => e.startAt).filter(Number.isFinite);
    boardStart.set(lg, starts.length ? Math.min(...starts) : null);
  }

  // Which days each lock needs, and so which boards to fetch.
  const keysFor = new Map(); // lock id -> Set(key)
  let budget = maxBoards;
  for (const lock of open) {
    const keys = new Set();
    const anchor = anchorOf(lock);
    for (const lg of new Set((lock.picks || []).map((p) => p.league).filter(Boolean))) {
      const start = boardStart.get(lg);
      const stale = anchor !== null && start !== null && anchor < start;
      if (!stale || dates) { keys.add('*'); continue; }
      // Its own day, forward to the day before the current board begins.
      // Never past that: the next board holds the SAME fixtures a week on,
      // which is the mis-binding this whole path exists to prevent. At least
      // its own day, for a lock placed only hours before the board's first
      // game.
      const last = Math.max(anchor, Math.min(anchor + STALE_DAYS * DAY, start - DAY));
      let got = 0;
      for (let t = anchor; t <= last; t += DAY) {
        const key = dateKeyOf(t);
        if (!key || keys.has(key)) continue;
        if (keyToMs(key) >= start) break;
        const fresh = !boards.has(`${lg}:${key}`);
        if (fresh && budget <= 0) break;
        if (fresh) budget -= 1;
        keys.add(key);
        got += 1;
        await load(lg, key);
      }
      // Nothing fetched for this league at all leaves the lock with no games
      // to grade against, which on screen reads as "still waiting" again.
      // Fall back to the current board and say what happened.
      if (!got) {
        keys.add('*');
        errors.push(`could not load the ${lg.toUpperCase()} slate for the day this lock was placed`);
      }
    }
    keysFor.set(lock.id, keys);
  }

  // Everything fetched, deduplicated, plus a per-lock view of it.
  const byId = new Map();
  for (const ev of boards.values()) for (const e of ev) byId.set(e.eventId, e);
  const events = [...byId.values()];

  const scope = new Map();
  for (const lock of open) {
    const ids = new Set();
    for (const lg of new Set((lock.picks || []).map((p) => p.league).filter(Boolean))) {
      for (const key of keysFor.get(lock.id) || []) {
        for (const e of boards.get(`${lg}:${key}`) || []) ids.add(e.eventId);
      }
    }
    scope.set(lock.id, ids);
  }

  // Pass one: games a leg names outright, by matching team wording against
  // the scoreboard, and only within that lock's own days.
  const wanted = new Map(); // eventId -> league
  for (const lock of open) {
    const ids = scope.get(lock.id);
    for (const pick of lock.picks || []) {
      const text = String(pick.text || '').toLowerCase();
      for (const e of events) {
        if (e.league !== pick.league || (ids && !ids.has(e.eventId))) continue;
        const named = [e.home, e.away].some((t) => t && t.names.some((n) => {
          const nn = String(n).toLowerCase();
          // Whole words only. A raw substring let a three-letter
          // abbreviation match inside a player's surname, so a prop on
          // "Barrett Carter" pulled Carolina's box score.
          return nn.length >= 3 && new RegExp(`(^|[^a-z0-9])${nn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text);
        }));
        if (named) wanted.set(e.eventId, pick.league);
      }
    }
  }

  // Games a leg named outright are never dropped, however many there are.
  const named = [...wanted.entries()];

  // Pass two: other started games, so a player-only lock can resolve. These
  // are what the cap applies to. Live games first: a finished game can be
  // fetched on a later poll, a live one is what the board is for.
  const inScope = new Set([...scope.values()].flatMap((s) => [...s]));
  const extra = events
    .filter((e) => (e.state === 'in' || e.state === 'post') && !wanted.has(e.eventId)
      && (!inScope.size || inScope.has(e.eventId)))
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'in' ? -1 : 1))
    .map((e) => [e.eventId, e.league]);

  const room = Math.max(0, maxSummaries - named.length);
  const capped = [...named, ...extra.slice(0, room)];
  if (extra.length > room) {
    errors.push(`${extra.length - room} more games on the slate were not loaded`);
  }

  const snaps = await Promise.all(capped.map(async ([id, lg]) => {
    const s = await fetchSummary(lg, id);
    if (!s) errors.push(`could not load game ${id}`);
    return s;
  }));

  return { events, snapshots: snaps.filter(Boolean), errors, scope };
}

/**
 * The committed fixtures, as a context.
 *
 * `?demo` uses this instead of the live slate so every screen can be reviewed
 * without entering anything and without depending on what happens to be
 * playing today. Pointing demo mode at the live feed looks like it works and
 * then shows nothing but pending legs, because the demo's locks name games
 * that finished last week.
 */
const DEMO_FIXTURES = [
  ['nfl_final_car_gb.json', 'nfl'],
  ['nba_final_okc.json', 'nba'],
  ['cfb_labels_keys_mismatch.json', 'cfb'],
];

export async function loadFixtureContext(base = './fixtures/') {
  const snapshots = [];
  const errors = [];
  for (const [file, lg] of DEMO_FIXTURES) {
    try {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(String(res.status));
      snapshots.push(snapshotFromSummary(await res.json(), lg));
    } catch {
      errors.push(`demo fixture ${file} is missing`);
    }
  }
  // The committed scoreboards are from another date, so events are derived
  // from the snapshots themselves rather than loaded separately.
  const events = snapshots.map((s) => ({
    eventId: s.eventId, league: s.league, startAt: s.startAt,
    state: s.state, home: s.home, away: s.away,
  }));
  return { events, snapshots, errors };
}

/**
 * Today's games for some leagues, with their betting lines, and nothing else.
 *
 * Scoreboards only: no box scores, so this is cheap. It exists because the
 * entry form needs the slate to quote a price, and a brand new league has no
 * locks yet to have loaded one. Without this, the first lock anybody ever
 * writes is the one with no price offered.
 */
export async function loadSlates(leagues) {
  const want = [...new Set((leagues || []).filter((lg) => LEAGUES[lg]))];
  const events = [];
  const errors = [];
  await Promise.all(want.map(async (lg) => {
    const ev = await fetchScoreboard(lg);
    if (ev) events.push(...ev);
    else errors.push(`could not load the ${lg.toUpperCase()} slate`);
  }));
  return { events, errors };
}

/** True when anything on the slate is still running, so polling should continue. */
export function anyLive(snapshots, events) {
  return (snapshots || []).some((s) => s.state === 'in')
    || (events || []).some((e) => e.state === 'in');
}
