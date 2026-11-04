// store.js: everything the app remembers, and how it is persisted.
//
// The state shape and its migrations are pure functions over a plain object;
// the only impure part is `load`/`save`, which take a storage object so the
// selftest can pass a fake one instead of touching real localStorage.
//
// Hard rule carried over from the poker app: never change KEY or the shape
// without a migration. People have real locks in here and a silent wipe is
// indistinguishable from a bug.

import { newMembership, addLeague, createLeague, initialsOf } from './league.js';

export const KEY = 'donationkings.state.v1';
export const SCHEMA = 1;

/** Ids only have to be unique on this device until there is a backend. */
export function uid(prefix = 'u') {
  const r = globalThis.crypto && globalThis.crypto.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${r}`;
}

export function freshState(name = 'You') {
  const me = { uid: uid('u'), name, initials: initialsOf(name) };
  return {
    schema: SCHEMA,
    me,
    membership: newMembership(),
    locks: [],
    ui: { tab: 'League', mode: 'week', formMode: 'join', showForms: false },
  };
}

/**
 * Bring a stored object up to the current schema.
 *
 * Unknown or missing schema means we cannot reason about the contents, so it
 * is discarded rather than guessed at. Discarding is the honest failure here:
 * a half-understood state renders wrong numbers, which is worse than starting
 * over, and `exportState` exists so nothing is ever trapped.
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schema !== SCHEMA) return null;
  if (!raw.me || !raw.me.uid) return null;
  return {
    schema: SCHEMA,
    me: { uid: raw.me.uid, name: raw.me.name || 'You', initials: raw.me.initials || initialsOf(raw.me.name) },
    membership: {
      leagues: (raw.membership && raw.membership.leagues) || {},
      activeCode: (raw.membership && raw.membership.activeCode) || null,
    },
    locks: Array.isArray(raw.locks) ? raw.locks : [],
    ui: { ...freshState().ui, ...(raw.ui || {}) },
  };
}

/**
 * Read state back.
 *
 * Every failure mode here is normal rather than exceptional: private windows
 * throw on access, cleared site data returns null, and a half-written value
 * fails to parse. All three mean "start fresh", and none should take the app
 * down, so this never throws.
 */
export function load(storage) {
  try {
    const text = storage.getItem(KEY);
    if (!text) return null;
    return migrate(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Returns false rather than throwing when storage is unavailable or full. */
export function save(storage, state) {
  try {
    storage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clear(storage) {
  try {
    storage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** A plain-text backup, so no one's history is ever locked inside a browser. */
export function exportState(state) {
  return JSON.stringify(state, null, 1);
}

export function importState(text) {
  try {
    return migrate(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/**
 * The stored shape of a lock. Only what cannot be recomputed is kept: the
 * legs as written, the money, and when it was placed. Verdicts, prices and
 * progress are all derived from live data every render, so a stale grade can
 * never be persisted and then believed.
 */
export function newLock({ code, uid: ownerUid, stakeCents, picks, placedAt, boostPct, book }) {
  const at = placedAt === undefined ? Date.now() : placedAt;
  return {
    id: uid('L'),
    code,
    uid: ownerUid,
    stakeCompCents: stakeCents,
    boostPct: boostPct || 0,
    book: book || null,
    placedAt: at,
    // Fixed at placement, never recomputed from the settle time: a Sunday
    // night game graded at 3am Monday still belongs to Sunday's week.
    weekKey: null, // filled by the caller, which knows the league's week
    picks: picks.map((p) => ({ text: p.text, league: p.league, odds: p.odds })),
    // Manual overrides, keyed by leg index, for anything the engine refuses
    // to grade. Written only by a person, and never cleared by the engine.
    overrides: {},
    eligible: true,
  };
}

export function addLock(state, lock) {
  return { ...state, locks: [lock, ...state.locks] };
}

export function removeLock(state, id) {
  return { ...state, locks: state.locks.filter((l) => l.id !== id) };
}

export function updateLock(state, id, patch) {
  return { ...state, locks: state.locks.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function setOverride(state, id, legIndex, verdict) {
  return {
    ...state,
    locks: state.locks.map((l) => (l.id === id
      ? { ...l, overrides: { ...l.overrides, [legIndex]: verdict } }
      : l)),
  };
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

/**
 * `?demo` fills the app with a plausible league and locks so every screen can
 * be reviewed without entering anything. Lifted in spirit from the poker
 * app's demo mode, which is why that project could verify its screens without
 * touching live infrastructure.
 */
export function demoState(weekKey) {
  const state = freshState('Grant');
  const me = state.me.uid;

  let degen = createLeague({ name: 'Sunday Degenerates', ownerUid: me, ownerName: 'Grant', code: 'DEGEN7', now: Date.now() - 86400000 * 30 });
  for (const [u, n] of [['u-ck', 'ckirby'], ['u-ash', 'Ashtin'], ['u-dw', 'Dalton Ward']]) {
    degen.members.push({ uid: u, name: n, role: 'member', joinedAt: Date.now() - 86400000 * 20 });
  }
  const work = createLeague({ name: 'Work League', ownerUid: 'u-boss', ownerName: 'Marcus Hale', code: 'MCGH42', now: Date.now() - 86400000 * 9 });
  work.members.push({ uid: me, name: 'Grant', role: 'member', joinedAt: Date.now() - 86400000 * 8 });
  work.members.push({ uid: 'u-tj', name: 'TJ Nelson', role: 'member', joinedAt: Date.now() - 86400000 * 7 });

  let membership = newMembership();
  membership = addLeague(membership, work);
  membership = addLeague(membership, degen);

  const mk = (picks, stakeCents, ago, extra) => ({
    ...newLock({ code: 'DEGEN7', uid: me, stakeCents, picks, placedAt: Date.now() - ago }),
    weekKey,
    ...extra,
  });

  const locks = [
    mk([
      { text: 'Packers ML', league: 'nfl', odds: -165 },
      { text: 'Tucker Kraft Anytime TD', league: 'nfl', odds: 260 },
      { text: 'Jordan Love Anytime TD', league: 'nfl', odds: 750 },
      { text: 'Josh Jacobs 2+ Rushing TDs', league: 'nfl', odds: 420 },
    ], 1000, 86400000 * 2),
    mk([
      { text: 'Josh Jacobs Anytime TD', league: 'nfl', odds: -115 },
      { text: 'Tucker Kraft Anytime TD', league: 'nfl', odds: 260 },
    ], 2470, 86400000 * 2 + 3600000, { boostPct: 10 }),
    // A live one, so the progress bars have something to show.
    mk([
      { text: 'Zips ML', league: 'cfb', odds: -140 },
      { text: 'Total Points Over 30.5', league: 'cfb', odds: -110 },
      { text: 'Bobcats Team Total Over 12.5', league: 'cfb', odds: -105 },
    ], 500, 5400000),
    mk([
      { text: 'Brooks Barnhizer Over 5.5 Points', league: 'nba', odds: -120 },
      { text: 'Thunder ML', league: 'nba', odds: -135 },
    ], 1500, 86400000, { eligible: false }),
  ];

  // Everyone else's week, as settled summaries. These are not graded because
  // grading them would need a fixture per game; they exist so the standings
  // have other people in them.
  const others = [
    ['u-ck', 2000, 'won', 5600], ['u-ck', 1500, 'lost', 0], ['u-ck', 1000, 'lost', 0],
    ['u-ash', 3000, 'lost', 0], ['u-ash', 2500, 'lost', 0], ['u-ash', 1200, 'won', 2900],
    ['u-dw', 4000, 'lost', 0], ['u-dw', 6000, 'lost', 0],
  ].map(([u, stake, state_, ret]) => ({
    id: uid('L'), code: 'DEGEN7', uid: u, weekKey,
    stakeCompCents: stake, settledState: state_, settledReturnCents: ret,
    placedAt: Date.now() - 86400000, settledAt: Date.now() - 3600000,
    picks: [], overrides: {}, eligible: true, boostPct: 0,
  }));

  return { ...state, membership, locks: [...locks, ...others] };
}
