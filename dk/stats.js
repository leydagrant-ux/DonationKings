// stats.js: what your betting record actually looks like.
//
// Pure, like the rest of the engine: it takes already-derived locks and
// returns numbers. No UI, no network, no storage.
//
// The weekly $100 game is a scoreboard for a competition. This file is the
// other half, and the more honest one: across every week, what has actually
// been wagered, what came back, and what that works out to. An app about
// parlays that only showed the game would be hiding the part that matters.
//
// Two rules run through all of it:
//
//   1. **ROI counts settled money only.** A lock still running has had its
//      stake committed but has returned nothing, and dividing by it would
//      show a loss that has not happened. Open stakes are reported on their
//      own as money at risk.
//   2. **Nothing is counted twice.** A parlay spanning two sports is not
//      filed under both; it goes in its own bucket. Otherwise the rows add
//      up to more than was ever bet, and every number on the page is wrong
//      in a way that looks plausible.

const SETTLED = new Set(['won', 'lost', 'push', 'void']);

/**
 * The record for a set of locks.
 *
 * `profitCents` is returns minus the stakes that produced them, so it is
 * money actually won or lost, not a paper figure including live bets.
 */
export function recordOf(locks) {
  const list = locks || [];
  let staked = 0;
  let returned = 0;
  let atRisk = 0;
  let won = 0;
  let lost = 0;
  let push = 0;
  let open = 0;
  let best = null;
  let worst = null;

  for (const l of list) {
    const stake = l.stakeCompCents || 0;
    staked += stake;

    if (!SETTLED.has(l.state)) {
      open++;
      atRisk += stake;
      continue;
    }

    const ret = l.returnCents || 0;
    returned += ret;
    const pl = ret - stake;

    if (l.state === 'won') {
      won++;
      if (!best || pl > best.profitCents) best = { lock: l, profitCents: pl };
    } else if (l.state === 'lost') {
      lost++;
      if (!worst || pl < worst.profitCents) worst = { lock: l, profitCents: pl };
    } else {
      push++; // a push or a void returns the stake and is not a result
    }
  }

  const settledStake = staked - atRisk;
  const decided = won + lost; // pushes are not a win or a loss either way

  return {
    bets: list.length,
    stakedCents: staked,
    returnedCents: returned,
    atRiskCents: atRisk,
    settledStakeCents: settledStake,
    profitCents: returned - settledStake,
    roi: settledStake > 0 ? (returned - settledStake) / settledStake : null,
    won,
    lost,
    push,
    open,
    winRate: decided > 0 ? won / decided : null,
    best,
    worst,
  };
}

/**
 * Which sport a lock belongs to, or 'mixed' when it spans more than one.
 *
 * A four-leg parlay with three NFL legs and one NBA leg is not an NFL bet
 * and is not an NBA bet. Filing it under both would double count the stake.
 */
export function sportOf(lock) {
  const leagues = [...new Set(((lock && lock.picks) || []).map((p) => p.league).filter(Boolean))];
  if (!leagues.length) return null;
  return leagues.length === 1 ? leagues[0] : 'mixed';
}

/** Which size bucket a lock falls in. Six and up share one row. */
export function legBucketOf(lock) {
  const n = ((lock && lock.picks) || []).length;
  if (!n) return null;
  return n >= 6 ? '6+' : String(n);
}

function groupBy(locks, keyFn) {
  const m = new Map();
  for (const l of locks || []) {
    const k = keyFn(l);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  }
  return [...m.entries()].map(([key, ls]) => ({ key, ...recordOf(ls) }));
}

export const bySport = (locks) => groupBy(locks, sportOf);
export const byLegCount = (locks) => groupBy(locks, legBucketOf);
export const byLeague = (locks) => groupBy(locks, (l) => l.code || null);
export const byWeek = (locks) => groupBy(locks, (l) => l.weekKey || null);

/**
 * Sort breakdown rows by a column.
 *
 * Rows with nothing settled have no ROI and no win rate. They sort to the
 * bottom whichever way the column is pointing, because a row with no data
 * is not the best performer and is not the worst one either.
 */
export function sortRows(rows, key = 'stakedCents', dir = 'desc') {
  const val = (r) => {
    if (key === 'key') return r.key;
    const v = r[key];
    return v === null || v === undefined ? null : v;
  };
  const out = [...(rows || [])];
  out.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1; // always last
    if (y === null) return -1;
    if (typeof x === 'string' || typeof y === 'string') {
      const c = String(x).localeCompare(String(y));
      return dir === 'asc' ? c : -c;
    }
    return dir === 'asc' ? x - y : y - x;
  });
  return out;
}

/**
 * The longest run of wins and of losses, newest lock last.
 *
 * Pushes break nothing: a returned stake is not a result, so a win, a push
 * and another win is a streak of two.
 */
export function streaks(locks) {
  const settled = (locks || [])
    .filter((l) => l.state === 'won' || l.state === 'lost')
    .sort((a, b) => (a.settledAt || a.placedAt || 0) - (b.settledAt || b.placedAt || 0));

  let bestWin = 0;
  let worstLoss = 0;
  let runW = 0;
  let runL = 0;
  for (const l of settled) {
    if (l.state === 'won') { runW++; runL = 0; } else { runL++; runW = 0; }
    if (runW > bestWin) bestWin = runW;
    if (runL > worstLoss) worstLoss = runL;
  }

  // The current run is whatever the last settled lock is still part of.
  const last = settled[settled.length - 1];
  const current = !last ? 0 : (last.state === 'won' ? runW : -runL);
  return { longestWin: bestWin, longestLoss: worstLoss, current };
}

/**
 * Everything the stats screen needs, in one pass.
 */
export function report(locks) {
  const list = locks || [];
  return {
    overall: recordOf(list),
    sports: bySport(list),
    legCounts: byLegCount(list),
    weeks: byWeek(list),
    streaks: streaks(list),
  };
}
