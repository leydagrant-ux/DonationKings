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
 *   1. Scoreboards for every league the locks mention. Cheap, and they carry
 *      team names, start times and game state.
 *   2. Summaries for the games that matter. Games a team leg already points
 *      at come first; after that, any other started game on the slate, which
 *      is what lets a player-only lock resolve at all.
 *
 * `maxSummaries` caps the second pass. A college football Saturday is well
 * over a hundred games at roughly 650KB each, and a phone should not try to
 * pull the lot. Games already pointed at by a leg are never capped away.
 */
export async function loadContext(locks, { maxSummaries = 12, dates } = {}) {
  const leagues = [...new Set((locks || []).flatMap((l) => (l.picks || []).map((p) => p.league)).filter(Boolean))];
  const errors = [];

  const boards = await Promise.all(leagues.map(async (lg) => {
    const ev = await fetchScoreboard(lg, dates);
    if (!ev) errors.push(`could not load the ${lg.toUpperCase()} slate`);
    return [lg, ev || []];
  }));
  const events = boards.flatMap(([, ev]) => ev);
  const byLeague = new Map(boards);

  // Pass one: games a leg names outright, by matching team wording against
  // the scoreboard. This is the same normalization the resolver uses.
  const wanted = new Map(); // eventId -> league
  for (const lock of locks || []) {
    for (const pick of lock.picks || []) {
      const ev = byLeague.get(pick.league) || [];
      const text = String(pick.text || '').toLowerCase();
      for (const e of ev) {
        const named = [e.home, e.away].some((t) => t && t.names.some((n) => {
          const nn = String(n).toLowerCase();
          return nn.length >= 3 && text.includes(nn);
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
  const extra = events
    .filter((e) => (e.state === 'in' || e.state === 'post') && !wanted.has(e.eventId))
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

  return { events, snapshots: snaps.filter(Boolean), errors };
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
