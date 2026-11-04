// league.js: leagues, invite codes, ISO weeks and standings. Pure.
//
// A league is a group of friends with a weekly competition. Everyone starts
// each week with the same bankroll, a lock's stake comes off it when placed
// and the payout goes back when it settles. Hit zero with nothing live and
// your week is over.
//
// You can be in several leagues at once (one for the group chat, one for
// work) and each keeps its own bankroll, standings and history.
//
// `genCode`, `isoWeekKey` and `weekRange` are lifted from the poker bankroll
// app, where they are already proven across four years of weeks. The only
// change is the dash in weekRange's output.

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

/**
 * A 6-character invite code, which IS the league's id.
 *
 * Two deliberate details carried over: the alphabet omits 0/O/1/I/L so a code
 * read aloud or typed from a screenshot is unambiguous, and bytes at or above
 * 248 are rejected rather than taken modulo 31, because 256 is not a multiple
 * of 31 and plain modulo would make the first few letters more likely.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 characters
const CODE_LEN = 6;

export function genCode(rng) {
  const bytes = (n) => {
    if (rng) return rng(n);
    const buf = new Uint8Array(n);
    (globalThis.crypto || globalThis.msCrypto).getRandomValues(buf);
    return buf;
  };
  let c = '';
  while (c.length < CODE_LEN) {
    for (const b of bytes(CODE_LEN - c.length)) {
      if (b < 248) c += CODE_ALPHABET[b % 31]; // 248 = 8 * 31
    }
  }
  return c;
}

/** Codes are typed by humans, so accept lowercase and stray spaces. */
export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === CODE_LEN && [...s].every((ch) => CODE_ALPHABET.includes(ch)) ? s : null;
}

// ---------------------------------------------------------------------------
// ISO weeks, Monday to Sunday
// ---------------------------------------------------------------------------

const DAY = 86400000;

function asDate(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return new Date(v);
  }
  return new Date();
}

/**
 * '2026-W45'. The Thursday of the week decides which year it belongs to,
 * which is what makes the turn of the year behave.
 */
export function isoWeekKey(when) {
  const t = asDate(when);
  t.setHours(12, 0, 0, 0); // midday, so a DST shift cannot move the day
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  const wn = 1 + Math.round(((t - week1) / DAY - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${String(wn).padStart(2, '0')}`;
}

/** The Monday a week key starts on. */
export function weekStart(key) {
  const [y, w] = String(key).split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  const mon = new Date(jan4);
  mon.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

/** 'Nov 3 to Nov 9' for a header. */
export function weekRange(key) {
  const mon = weekStart(key);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(mon)} to ${f(sun)}`;
}

export const currentWeekKey = (now) => isoWeekKey(now === undefined ? new Date() : now);

/** Weeks move forward, so sort keys descending for a history list. */
export function sortWeekKeysDesc(keys) {
  return [...new Set(keys)].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

// ---------------------------------------------------------------------------
// The league itself
// ---------------------------------------------------------------------------

export const ROLE = { OWNER: 'owner', MEMBER: 'member' };
export const DEFAULT_BANKROLL_CENTS = 10000; // $100

export function createLeague({ name, ownerUid, ownerName, startBankrollCents, code, now }) {
  const at = now === undefined ? Date.now() : now;
  return {
    code: code || genCode(),
    name: String(name || 'New League').trim().slice(0, 60),
    ownerUid,
    startBankrollCents: startBankrollCents || DEFAULT_BANKROLL_CENTS,
    createdAt: at,
    archived: false,
    members: [{ uid: ownerUid, name: ownerName || 'Owner', role: ROLE.OWNER, joinedAt: at }],
  };
}

export const isOwner = (league, uid) => !!league && league.ownerUid === uid;
export const isMember = (league, uid) => !!league && league.members.some((m) => m.uid === uid);
export const memberOf = (league, uid) => (league ? league.members.find((m) => m.uid === uid) : null);

/** Join is idempotent: tapping an invite link twice must not duplicate you. */
export function joinLeague(league, { uid, name, now }) {
  if (!league) return { ok: false, reason: 'no such league' };
  if (isMember(league, uid)) return { ok: true, league, already: true };
  const members = [...league.members, { uid, name: name || 'Player', role: ROLE.MEMBER, joinedAt: now === undefined ? Date.now() : now }];
  return { ok: true, league: { ...league, members } };
}

/**
 * Leaving. The owner cannot simply walk out of a league that still has other
 * people in it, because nobody would be left who can manage it; they hand it
 * over or archive it instead.
 */
export function leaveLeague(league, uid) {
  if (!league || !isMember(league, uid)) return { ok: false, reason: 'not a member' };
  const others = league.members.filter((m) => m.uid !== uid);
  if (isOwner(league, uid) && others.length) {
    return { ok: false, reason: 'hand the league to someone else first' };
  }
  return { ok: true, league: { ...league, members: others } };
}

/** Owner-only actions, each refusing rather than silently doing nothing. */
export function transferOwnership(league, fromUid, toUid) {
  if (!isOwner(league, fromUid)) return { ok: false, reason: 'only the owner can do that' };
  if (!isMember(league, toUid)) return { ok: false, reason: 'that person is not in this league' };
  return {
    ok: true,
    league: {
      ...league,
      ownerUid: toUid,
      members: league.members.map((m) => ({ ...m, role: m.uid === toUid ? ROLE.OWNER : ROLE.MEMBER })),
    },
  };
}

export function removeMember(league, actorUid, targetUid) {
  if (!isOwner(league, actorUid)) return { ok: false, reason: 'only the owner can remove people' };
  if (targetUid === league.ownerUid) return { ok: false, reason: 'the owner cannot be removed' };
  if (!isMember(league, targetUid)) return { ok: false, reason: 'that person is not in this league' };
  return { ok: true, league: { ...league, members: league.members.filter((m) => m.uid !== targetUid) } };
}

/**
 * Changing the starting bankroll is only fair before anyone has placed a
 * lock, because it silently rewrites every standing that came before it.
 */
export function setStartBankroll(league, actorUid, cents, locks) {
  if (!isOwner(league, actorUid)) return { ok: false, reason: 'only the owner can do that' };
  if (!(cents > 0)) return { ok: false, reason: 'bankroll must be more than zero' };
  if ((locks || []).some((l) => l.code === league.code)) {
    return { ok: false, reason: 'locks have already been placed in this league' };
  }
  return { ok: true, league: { ...league, startBankrollCents: cents } };
}

export function renameLeague(league, actorUid, name) {
  if (!isOwner(league, actorUid)) return { ok: false, reason: 'only the owner can rename it' };
  const n = String(name || '').trim();
  if (!n) return { ok: false, reason: 'name cannot be empty' };
  return { ok: true, league: { ...league, name: n.slice(0, 60) } };
}

/** A shareable link. The app reads `?join=CODE` on load. */
export function inviteLink(code, base) {
  const root = base || (typeof location !== 'undefined' ? location.origin + location.pathname : '');
  return `${root}?join=${code}`;
}

export function readJoinCode(search) {
  const s = String(search || '');
  const m = /[?&]join=([^&]+)/.exec(s);
  return m ? normalizeCode(decodeURIComponent(m[1])) : null;
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

const SETTLED = new Set(['won', 'lost', 'push', 'void']);

/**
 * One member's week.
 *
 * Bankroll is start, minus every stake, plus every settled return. A lock
 * that is still live has had its stake taken but has returned nothing yet,
 * which is what `atRisk` reports.
 *
 * Busting is NOT simply a zero balance: staking your last $20 leaves you at
 * zero with a live lock, and you are not out until that lock settles against
 * you. So a bust needs an empty bankroll AND nothing still running.
 */
export function memberWeek(uid, locks, startCents) {
  let staked = 0;
  let returned = 0;
  let atRisk = 0;
  let won = 0;
  let lost = 0;
  let pushed = 0;
  let open = 0;
  let lastSettleAt = null;

  for (const l of locks || []) {
    if (l.uid !== uid) continue;
    if (l.eligible === false) continue; // tracked, but outside the competition
    const stake = l.stakeCompCents || 0;
    staked += stake;
    if (SETTLED.has(l.state)) {
      returned += l.returnCents || 0;
      if (l.state === 'won') won++;
      else if (l.state === 'lost') lost++;
      else pushed++;
      if (l.settledAt && (lastSettleAt === null || l.settledAt > lastSettleAt)) lastSettleAt = l.settledAt;
    } else {
      open++;
      atRisk += stake;
    }
  }

  const bankroll = startCents - staked + returned;
  const settledStake = staked - atRisk;
  return {
    uid,
    startCents,
    bankrollCents: Math.max(0, bankroll),
    stakedCents: staked,
    returnedCents: returned,
    atRiskCents: atRisk,
    profitCents: returned - settledStake,
    roi: settledStake > 0 ? (returned - settledStake) / settledStake : null,
    won,
    lost,
    pushed,
    open,
    bust: bankroll <= 0 && atRisk === 0 && staked > 0,
    bustAt: bankroll <= 0 && atRisk === 0 ? lastSettleAt : null,
  };
}

/**
 * Rank a league for one week.
 *
 * Busted players sort to the bottom regardless of their number, because a
 * bust is the end of a week and a tidy $0 should not sit above someone still
 * alive with a dollar left.
 */
export function standings(league, locks, weekKey) {
  if (!league) return [];
  const inWeek = (locks || []).filter((l) => l.code === league.code && (!weekKey || l.weekKey === weekKey));
  const rows = league.members.map((m) => {
    const w = memberWeek(m.uid, inWeek, league.startBankrollCents);
    return { ...w, name: m.name, role: m.role, initials: initialsOf(m.name) };
  });
  rows.sort((a, b) => {
    if (a.bust !== b.bust) return a.bust ? 1 : -1;
    if (b.bankrollCents !== a.bankrollCents) return b.bankrollCents - a.bankrollCents;
    return b.profitCents - a.profitCents;
  });
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * All-time across every week. Bankroll resets weekly, so the meaningful
 * all-time number is cumulative profit, not a balance.
 */
export function allTimeStandings(league, locks) {
  if (!league) return [];
  const mine = (locks || []).filter((l) => l.code === league.code);
  const rows = league.members.map((m) => {
    const w = memberWeek(m.uid, mine, 0);
    const weeks = new Set(mine.filter((l) => l.uid === m.uid).map((l) => l.weekKey));
    return {
      ...w, name: m.name, role: m.role, initials: initialsOf(m.name),
      weeks: weeks.size,
      bankrollCents: w.profitCents, // the column the leaderboard renders
      bust: false,
    };
  });
  rows.sort((a, b) => b.profitCents - a.profitCents);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Every week this league has locks for, newest first. */
export function leagueWeeks(league, locks) {
  if (!league) return [];
  return sortWeekKeysDesc((locks || []).filter((l) => l.code === league.code).map((l) => l.weekKey));
}

/** Who won each past week, for a history list. */
export function weekHistory(league, locks) {
  return leagueWeeks(league, locks).map((key) => {
    const rows = standings(league, locks, key);
    const top = rows.find((r) => !r.bust) || rows[0] || null;
    return { weekKey: key, range: weekRange(key), winner: top, rows };
  });
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// Membership across several leagues
// ---------------------------------------------------------------------------

/**
 * The shape the app keeps in storage: every league you are in, plus which one
 * you are currently looking at. Being in several at once is the normal case,
 * not an edge case, so the active league is explicit state rather than
 * something inferred.
 */
export function newMembership() {
  return { leagues: {}, activeCode: null };
}

export function addLeague(membership, league) {
  return {
    leagues: { ...membership.leagues, [league.code]: league },
    activeCode: league.code,
  };
}

export function removeLeague(membership, code) {
  const leagues = { ...membership.leagues };
  delete leagues[code];
  const left = Object.keys(leagues);
  return { leagues, activeCode: membership.activeCode === code ? (left[0] || null) : membership.activeCode };
}

export function setActive(membership, code) {
  return membership.leagues[code] ? { ...membership, activeCode: code } : membership;
}

export const activeLeague = (membership) => (membership && membership.activeCode ? membership.leagues[membership.activeCode] || null : null);

/** Ordered for the switcher: your own leagues first, then by name. */
export function leagueList(membership, uid) {
  return Object.values(membership.leagues || {}).sort((a, b) => {
    const ao = isOwner(a, uid) ? 0 : 1;
    const bo = isOwner(b, uid) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}
