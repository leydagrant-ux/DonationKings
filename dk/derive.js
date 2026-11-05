// derive.js: stored lock + live data -> everything the UI and standings need.
//
// Pure, and deliberately free of any UI import: the Cloudflare Worker's
// scheduled grader imports this file directly, so the server and the browser
// settle a lock with exactly the same code and cannot disagree about who won.
// A lock's display title is presentation and belongs to the render layer. This is the seam between what is persisted (the legs as written, the
// money, the time) and what is computed fresh every render (resolution,
// verdicts, prices, progress). Nothing graded is ever stored, so a stale
// verdict cannot be believed later.

import { resolveLeg, AUTO_GRADE_MIN } from './resolve.js';
import { gradeLeg, STATE } from './grade.js';
import { settleParlay } from './parlay.js';
import { parlayDecimal, boostedReturnCents, promisedReturnCents, totalReturnCents, impliedProb } from './odds.js';

const OVERRIDABLE = new Set([STATE.WON, STATE.LOST, STATE.PUSH, STATE.VOID]);

/**
 * Grade and price one stored lock.
 *
 * ctx: { events, snapshots } straight from feed.loadContext.
 *
 * A settled lock keeps its stored result and its stored money: those were
 * written once, by whoever watched the games finish, and are not recomputed
 * here. Everything else about it is still derived, so it goes on being a
 * lock you can look at.
 *
 * `summaryOnly` means there is nothing to show but the result, which is the
 * case only when this device never received the legs. It used to be set for
 * ANY settled lock, on the assumption that a settled lock belonged to
 * somebody else. It does not: your own lock comes back from the server with
 * a result on it the moment it settles, and that assumption made every
 * parlay you won disappear from your own locks and out of your totals the
 * instant it won.
 */
export function deriveLock(stored, ctx) {
  const picks = stored.picks || [];

  if (stored.settledState && !picks.length) {
    return {
      ...stored,
      legs: [],
      roll: { state: stored.settledState, final: true, counts: {}, legCount: 0, liveCount: 0 },
      state: stored.settledState,
      returnCents: stored.settledReturnCents,
      summaryOnly: true,
    };
  }

  const byId = new Map((ctx.snapshots || []).map((s) => [s.eventId, s]));

  const legs = picks.map((pick, i) => {
    const pool = (ctx.snapshots || []).filter((s) => s.league === pick.league);
    const events = (ctx.events || []).filter((e) => e.league === pick.league);
    const leg = resolveLeg({ rawText: pick.text }, { league: pick.league, events, snapshots: pool });
    leg.oddsAmerican = pick.odds;

    const snapshot = leg.eventId ? byId.get(leg.eventId) || null : null;

    const blank = (state, reason) => ({
      state, clinched: false, dead: false, current: null, needed: leg.line ?? null,
      pct: 0, overshoot: false, render: 'bar', label: '', voidReason: null, reason,
    });

    // Is every game this leg could possibly belong to already over? Until
    // that is true, failing to place a player is not a failure at all: his
    // game simply has not kicked off, and a box score cannot list a player
    // before there is one.
    //
    // The old test was "do we hold ANY box score in this league", which is
    // a different question with the same answer only by accident. On a
    // Thursday it is true as soon as one game is running, so a prop on the
    // night game was declared unmatchable hours before kickoff.
    const anyToCome = events.some((e) => e.state === 'pre' || e.state === 'in');

    let verdict;
    if (snapshot) {
      verdict = gradeLeg(leg, snapshot);
    } else if (pool.length && !anyToCome) {
      // Every game is finished and the selection still cannot be placed, so
      // this will not resolve itself and needs a person.
      verdict = blank(STATE.REVIEW, leg.reason || 'could not match this selection to a game');
    } else {
      verdict = blank(STATE.PENDING, anyToCome ? 'waiting for the game to start' : 'waiting for game data');
    }

    // The engine refuses to grade below its confidence bar, whatever the
    // numbers happen to say.
    if (snapshot && leg.confidence !== undefined && leg.confidence < AUTO_GRADE_MIN && verdict.state !== STATE.REVIEW) {
      verdict = { ...verdict, state: STATE.REVIEW, reason: leg.reason || 'not sure which selection this is' };
    }

    // A person's call always wins and is never cleared by a later poll.
    const override = stored.overrides ? stored.overrides[i] : undefined;
    if (override && OVERRIDABLE.has(override)) {
      verdict = { ...verdict, state: override, overridden: true, reason: 'you graded this one' };
    }

    return { leg, snapshot, verdict, index: i };
  });

  const priced = legs.map((l) => ({ oddsAmerican: l.leg.oddsAmerican, state: l.verdict.state }));
  const settled = settleParlay(priced, stored.stakeCompCents);
  const fullDec = parlayDecimal(picks.map((p) => p.odds));

  // What it pays. The slip's own figure wins when there is one, because the
  // book's number is the money that actually changes hands and the leg
  // prices alone cannot reproduce it: a boost, a same-game price or plain
  // rounding all move it. `boostPct` is the older way of saying the same
  // thing and still settles locks saved before the payout was recorded.
  const hasPromise = stored.payoutCents !== null && stored.payoutCents !== undefined;
  const stake = stored.stakeCompCents;

  // A leg dropped out, so the parlay is no longer the one that was priced.
  const repriced = settled.counts.push > 0 || settled.counts.void > 0;

  // What it pays is decided by the RESULT, not by whether the leg prices
  // happened to be recorded. A player-prop slip carries no leg prices at
  // all: the book prints what was bought and what it pays, and those two
  // numbers are the whole of the arithmetic. Keying off whether a decimal
  // could be computed paid out null on a winning parlay.
  let paid;
  if (settled.state === STATE.LOST) {
    paid = 0;
  } else if (settled.state === STATE.VOID) {
    paid = stake; // every leg fell out; the stake comes back
  } else if (settled.state === STATE.WON) {
    if (hasPromise) {
      // With leg prices the promise is scaled around whatever dropped out.
      // Without them there is nothing to scale by, so the promise stands,
      // which is exactly right whenever nothing dropped out.
      paid = fullDec
        ? promisedReturnCents(stake, fullDec, settled.dec, stored.payoutCents)
        : stored.payoutCents;
    } else {
      paid = boostedReturnCents(stake, settled.dec, stored.boostPct);
    }
  } else {
    paid = null; // still running
  }

  // The one case the two money figures cannot answer on their own: a leg
  // fell out, so the book would have repriced, and without leg prices there
  // is no way to work out to what. Say so rather than quietly overpaying.
  const needsRepriceByHand = repriced && !fullDec && hasPromise && settled.state === STATE.WON;

  const eventIds = legs.map((l) => l.leg.eventId).filter(Boolean);

  // A stored result outranks anything worked out here. It was written once,
  // by whoever saw the games end, and it is what the standings already count.
  // Re-deriving it on a device that has since dropped those box scores would
  // walk a won parlay back to pending every time the app was reopened.
  const isSettled = !!stored.settledState;
  const roll = isSettled
    ? { ...settled, state: stored.settledState, final: true }
    : settled;

  return {
    ...stored,
    legs,
    roll,
    state: roll.state,
    returnCents: isSettled ? stored.settledReturnCents : paid,
    // The result is known but the individual legs may not be: settled locks
    // stop being polled, so a device that reopens later has no box scores
    // for them. The display leans on the result rather than on the legs.
    settledElsewhere: isSettled && !legs.some((l) => l.snapshot),
    // What it pays if every leg lands. The slip's figure is already that
    // number, so it is used as given rather than recomputed.
    toWinCents: hasPromise
      ? stored.payoutCents
      : boostedReturnCents(stored.stakeCompCents, fullDec, stored.boostPct),
    // True when the slip pays more than the leg prices alone would, which is
    // a boost, a promo, or a price the book set in your favour.
    boosted: hasPromise
      ? stored.payoutCents > (totalReturnCents(stored.stakeCompCents, fullDec) || 0)
      : !!stored.boostPct,
    // From the leg prices when there are any, otherwise from the two money
    // figures, which is the same sum: what you put in over what it pays.
    impliedPct: fullDec
      ? Math.round(impliedProb(fullDec) * 1000) / 10
      : (hasPromise && stake > 0 ? Math.round((stake / stored.payoutCents) * 1000) / 10 : undefined),
    // True when the money, not the prices, is what settles this one.
    pricedByBook: !fullDec && hasPromise,
    repricedByHand: needsRepriceByHand,
    live: !isSettled && legs.some((l) => l.snapshot && l.snapshot.state === 'in'),
    correlated: new Set(eventIds).size < eventIds.length,
    needsReview: !isSettled && (needsRepriceByHand || legs.some((l) => l.verdict.state === STATE.REVIEW)),
    settledAt: roll.final ? (stored.settledAt || null) : null,
  };
}

export function deriveAll(locks, ctx) {
  return (locks || []).map((l) => deriveLock(l, ctx));
}

/**
 * The shape the standings want. Deliberately narrow: the league module should
 * know about money and state, not about legs or box scores.
 */
export function toLedgerRows(derived) {
  return derived.map((d) => ({
    id: d.id,
    code: d.code,
    uid: d.uid,
    weekKey: d.weekKey,
    stakeCompCents: d.stakeCompCents,
    returnCents: d.returnCents,
    state: d.state,
    settledAt: d.settledAt,
    eligible: d.eligible,
  }));
}

/** Sort for the live board: closest to cashing first, dead ones last. */
export function byCloseness(a, b) {
  const score = (d) => {
    if (d.state === STATE.LOST) return -1;
    if (d.state !== STATE.PENDING) return -0.5;
    const legs = d.legs || [];
    if (!legs.length) return 0;
    let sum = 0;
    for (const l of legs) {
      const v = l.verdict;
      sum += v.state === STATE.WON || v.clinched ? 1 : Math.max(0, Math.min(1, v.pct || 0));
    }
    return sum / legs.length;
  };
  return score(b) - score(a);
}

/**
 * Is this lock still running?
 *
 * Needing review is not a result. The money has not moved, and often the
 * games have not even started, so a lock waiting on a person is every bit
 * as live as one waiting on a fourth quarter.
 *
 * This lives here rather than in the views because six of them asked the
 * question separately and all six answered it as `state === PENDING`. That
 * dropped a lock out of the Live tab, the league board and its owner's row
 * the moment any single leg could not be placed, and it stopped the poll
 * timer as well, so nothing ever came back to put it right.
 */
export function isOpenLock(d) {
  return !!d && (d.state === STATE.PENDING || d.state === STATE.REVIEW);
}
