// parlay.js: roll leg verdicts up into a lock verdict. Pure.
//
// A straight bet is the one-leg case of this same function. There is
// deliberately no separate code path for singles, and the selftest asserts
// that equivalence.

import { STATE } from './grade.js';
import { effectiveDecimal, totalReturnCents } from './odds.js';

/**
 * Combine leg states into the lock's state.
 *
 * legs: [{ state, oddsAmerican }]
 *
 * The precedence is load-bearing and each step is there for a reason:
 *
 *   1. Any LOST leg loses the lock immediately, whatever the other legs are
 *      doing. You do not wait for Sunday night to tell someone their parlay
 *      is dead, and no book does either. This is what makes the leaderboard
 *      feel live.
 *
 *   2. Otherwise any leg needing REVIEW holds the lock at needs_review and
 *      NO MONEY MOVES. This sits above `pending` on purpose: a lock with
 *      three winners and one unresolvable leg must not pay out on the
 *      strength of the three.
 *
 *   3. Otherwise any PENDING leg leaves the lock pending.
 *
 *   4. Otherwise every leg has settled as won, push or void:
 *        at least one won  -> won, priced over the surviving legs only
 *        none won          -> void, stake refunded
 *
 * Rule 1 above rule 2 is also deliberate. A confirmed loss is confirmed, and
 * freezing it behind an unrelated review would hold money hostage for no
 * reason.
 */
export function rollupParlay(legs) {
  const list = legs || [];
  const counts = { won: 0, lost: 0, push: 0, void: 0, pending: 0, review: 0 };
  for (const leg of list) {
    switch (leg.state) {
      case STATE.WON: counts.won++; break;
      case STATE.LOST: counts.lost++; break;
      case STATE.PUSH: counts.push++; break;
      case STATE.VOID: counts.void++; break;
      case STATE.REVIEW: counts.review++; break;
      default: counts.pending++; break;
    }
  }

  const surviving = list.filter((l) => l.state === STATE.WON);
  const out = {
    state: STATE.PENDING,
    final: false,
    counts,
    legCount: list.length,
    liveCount: counts.pending,
    survivingLegs: surviving,
  };

  if (!list.length) return { ...out, state: STATE.REVIEW, reason: 'lock has no legs' };
  if (counts.lost > 0) return { ...out, state: STATE.LOST, final: true };
  if (counts.review > 0) return { ...out, state: STATE.REVIEW };
  if (counts.pending > 0) return out;
  if (counts.won > 0) return { ...out, state: STATE.WON, final: true };
  return { ...out, state: STATE.VOID, final: true, reason: 'every leg pushed or voided' };
}

/**
 * Settle a lock: its state and what it returns to the bankroll.
 *
 * Pushed and voided legs drop out of the price, so a 4-leg parlay with one
 * push pays exactly what the other 3 legs would have paid on their own.
 *
 * Returns `returnCents: null` while the lock is unsettled, which callers must
 * treat as "do not touch the ledger" rather than as zero.
 */
export function settleParlay(legs, stakeCents) {
  const roll = rollupParlay(legs);
  let dec = null;
  let returnCents = null;

  if (roll.state === STATE.WON) {
    dec = effectiveDecimal(legs); // drops pushes and voids
    returnCents = totalReturnCents(stakeCents, dec);
  } else if (roll.state === STATE.VOID) {
    dec = 1;
    returnCents = stakeCents; // stake back
  } else if (roll.state === STATE.LOST) {
    dec = effectiveDecimal(legs);
    returnCents = 0;
  }

  return { ...roll, dec, stakeCents, returnCents, profitCents: returnCents === null ? null : returnCents - stakeCents };
}

/**
 * How close a lock is to cashing, for sorting the live board.
 *
 * Legs that have already won count fully; the rest contribute their own
 * progress. A dead or lost leg zeroes the whole thing, because the lock is
 * gone no matter how good the other legs look.
 */
export function lockProgress(legVerdicts) {
  const list = legVerdicts || [];
  if (!list.length) return { pct: 0, won: 0, total: 0, alive: false };
  if (list.some((v) => v.state === STATE.LOST || v.dead)) {
    return { pct: 0, won: 0, total: list.length, alive: false };
  }
  let sum = 0;
  let won = 0;
  for (const v of list) {
    const done = v.state === STATE.WON || v.clinched;
    if (done) { sum += 1; won += 1; } else sum += Math.max(0, Math.min(1, v.pct || 0));
  }
  return { pct: sum / list.length, won, total: list.length, alive: true };
}
