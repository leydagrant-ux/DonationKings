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
import { parlayDecimal, boostedReturnCents, impliedProb } from './odds.js';

const OVERRIDABLE = new Set([STATE.WON, STATE.LOST, STATE.PUSH, STATE.VOID]);

/**
 * Grade and price one stored lock.
 *
 * ctx: { events, snapshots } straight from feed.loadContext.
 *
 * A lock carrying `settledState` is a summary row for somebody else, whose
 * legs this device never fetched. It is passed through as settled rather than
 * graded, because grading it would need a box score per game they bet.
 */
export function deriveLock(stored, ctx) {
  if (stored.settledState) {
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
  const picks = stored.picks || [];

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

    let verdict;
    if (snapshot) {
      verdict = gradeLeg(leg, snapshot);
    } else if (pool.length) {
      // We had box scores for this league and still could not place the leg,
      // so this is a resolution failure, not a game that has yet to start.
      // Those two look identical from here and must not: one resolves itself
      // at kickoff, the other never will until a person weighs in.
      verdict = blank(STATE.REVIEW, leg.reason || 'could not match this selection to a game');
    } else {
      verdict = blank(STATE.PENDING, 'waiting for the game to start');
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

  // A boost lifts profit only, over whatever price survived pushed legs.
  const paid = settled.returnCents === null || settled.returnCents === 0
    ? settled.returnCents
    : boostedReturnCents(stored.stakeCompCents, settled.dec, stored.boostPct);

  const eventIds = legs.map((l) => l.leg.eventId).filter(Boolean);

  return {
    ...stored,
    legs,
    roll: settled,
    state: settled.state,
    returnCents: paid,
    toWinCents: boostedReturnCents(stored.stakeCompCents, fullDec, stored.boostPct),
    impliedPct: fullDec ? Math.round(impliedProb(fullDec) * 1000) / 10 : undefined,
    live: legs.some((l) => l.snapshot && l.snapshot.state === 'in'),
    correlated: new Set(eventIds).size < eventIds.length,
    needsReview: legs.some((l) => l.verdict.state === STATE.REVIEW),
    settledAt: settled.final ? (stored.settledAt || null) : null,
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
