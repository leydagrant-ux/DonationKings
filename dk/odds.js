// odds.js: pure odds and money math. No I/O, no DOM, no imports.
//
// Every amount is an integer number of cents. Nothing in this file ever
// produces a fractional cent, because a competition bankroll that drifts by a
// penny a week is a bug people will argue about.

export const CENTS = 100;

/** Round to the nearest integer, halves away from zero (not JS's half-up). */
export function roundCents(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Normalize whatever the slip said into an integer American price.
 * Accepts  '+250' | '250' | -110 | 'EVEN' | 'even' | '+100'.
 * Returns null for anything unparseable, so callers can flag it rather than
 * silently grading a leg at the wrong price.
 */
export function parseAmerican(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  if (s === 'EVEN' || s === 'EV' || s === 'PK') return 100;
  const m = /^([+-]?)(\d+)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[2], 10);
  if (!Number.isFinite(n)) return null;
  // There is no such thing as an American price between -100 and +100. A
  // value in that range means the cell was misread (a line like 2.5 picked up
  // as odds, say), and quietly accepting it would price the whole slip wrong.
  if (n < 100) return null;
  // Unsigned is ambiguous; American prices are written with a sign, so an
  // unsigned number is treated as the underdog and reconcile() catches it if
  // that guess was wrong.
  return m[1] === '-' ? -n : n;
}

/**
 * American -> decimal. -110 becomes 1.909..., +250 becomes 3.5, EVEN is 2.
 * American prices are always rational, so this is exact up to float precision.
 */
export function americanToDecimal(american) {
  const a = parseAmerican(american);
  if (a === null) return null;
  if (Math.abs(a) === 100) return 2;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

/** decimal -> American, rounded to the nearest whole price. */
export function decimalToAmerican(dec) {
  if (!(dec > 1)) return null;
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

/** Implied probability of a decimal price. Also the break-even hit rate. */
export function impliedProb(dec) {
  return dec > 0 ? 1 / dec : null;
}

// ---------------------------------------------------------------------------
// Parlays
// ---------------------------------------------------------------------------

/** Leg states that remove a leg from the price without killing the bet. */
const DROPPED = new Set(['push', 'void']);

/**
 * The price a parlay actually pays, given each leg's own price and state.
 *
 * Pushed and voided legs drop out, which is why this recomputes the product
 * from the surviving legs rather than dividing the original price by the
 * pushed leg. Dividing accumulates error and, worse, needs the original leg
 * price to still be around after it was voided.
 *
 * legs: [{ oddsAmerican, state }]
 * Returns 1 when every leg dropped (the whole bet pushes and the stake comes
 * back), or null if any surviving leg has an unparseable price.
 */
export function effectiveDecimal(legs) {
  let dec = 1;
  for (const leg of legs || []) {
    if (DROPPED.has(leg.state)) continue;
    const d = americanToDecimal(leg.oddsAmerican);
    if (d === null) return null;
    dec *= d;
  }
  return dec;
}

/** Convenience: price of a slip where every leg stands. */
export function parlayDecimal(americanList) {
  return effectiveDecimal((americanList || []).map((o) => ({ oddsAmerican: o })));
}

/** Total money back on a win: stake plus profit. */
export function totalReturnCents(stakeCents, dec) {
  if (dec === null) return null;
  return roundCents(stakeCents * dec);
}

/** Profit only, which is what some books print as "To Win". */
export function profitCents(stakeCents, dec) {
  const t = totalReturnCents(stakeCents, dec);
  return t === null ? null : t - stakeCents;
}

/**
 * Apply a profit boost.
 *
 * A boost lifts the PROFIT, never the stake: a 10% boost on a $10 bet paying
 * $100 returns $109, not $110. Applying it to the total return instead is the
 * classic off-by-a-stake error and it overpays every boosted slip.
 */
export function boostedReturnCents(stakeCents, dec, boostPct) {
  const total = totalReturnCents(stakeCents, dec);
  if (total === null) return null;
  if (!boostPct) return total;
  return stakeCents + roundCents((total - stakeCents) * (1 + boostPct / 100));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * True when two or more legs are on the same game, which makes the slip a
 * same-game parlay. Worth detecting on its own account, because it changes
 * how the price can be checked at all.
 */
export function isCorrelated(legs) {
  const seen = new Set();
  for (const leg of legs || []) {
    const id = leg.eventId;
    if (!id) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/**
 * Cross-check the price we parsed off the slip against the payout the slip
 * printed. This is the cheapest possible guard against a misread leg price,
 * and it runs on every ingested bet.
 *
 * Two things make this subtler than multiplying the legs out.
 *
 * First, books disagree about whether the big number on a slip is "To Win"
 * (profit) or "Total Payout" (stake plus profit), and the vision model will
 * not reliably tell us which. Both readings are tried and the one that
 * reconciles is reported.
 *
 * Second, and more important: **a same-game parlay's price is not the product
 * of its legs.** The book prices correlated legs jointly, usually well below
 * the independent product. So for an SGP the leg product is meaningless and
 * checking against it would flag every single SGP as a misread. For those
 * slips the only honest check is against the total price the slip itself
 * printed, and with no printed price there is nothing to verify.
 *
 * verdict:
 *   'match'         agrees within the absolute tolerance
 *   'rounding'      agrees within the relative tolerance; the book quoted a
 *                   rounded parlay price. Keep our computed figure.
 *   'boost'         the slip pays MORE than the price implies, which is a
 *                   boost or promo. Trust the slip and record the boost.
 *   'mismatch'      the slip pays LESS than the price implies, which nearly
 *                   always means a leg price was misread. Block the save and
 *                   send the user back to the correction screen.
 *   'unverifiable'  no usable price to check against (an SGP with no printed
 *                   total). Not an error: save it and mark it unverified.
 */
export function reconcile({
  stakeCents,
  legs,
  claimedCents,
  slipAmerican = null,
  correlated = null,
  tolCents = 2,
  relTol = 0.02,
}) {
  const sgp = correlated === null ? isCorrelated(legs) : !!correlated;
  const slipDec = slipAmerican === null ? null : americanToDecimal(slipAmerican);
  const legDec = effectiveDecimal(legs);

  // An SGP must be priced from the slip's own total, never from the legs.
  const dec = sgp ? slipDec : (legDec !== null ? legDec : slipDec);
  const basis = sgp ? 'slip' : (legDec !== null ? 'legs' : 'slip');

  const base = { verdict: 'unverifiable', basis, correlated: sgp, dec, interpretation: null, totalCents: null, profitCents: null, deltaCents: null };
  if (dec === null || !(stakeCents > 0)) return base;

  const total = totalReturnCents(stakeCents, dec);
  const profit = total - stakeCents;
  const out = { ...base, verdict: 'match', dec, totalCents: total, profitCents: profit, deltaCents: 0 };

  if (claimedCents === null || claimedCents === undefined) {
    return { ...out, verdict: 'unverifiable' }; // priced, but nothing to check against
  }

  const readings = [
    { interpretation: 'total', delta: claimedCents - total, ref: total },
    { interpretation: 'profit', delta: claimedCents - profit, ref: profit },
  ];
  // Absolute match on either reading wins outright.
  for (const r of readings) {
    if (Math.abs(r.delta) <= tolCents) {
      return { ...out, verdict: 'match', interpretation: r.interpretation, deltaCents: r.delta };
    }
  }
  // Then a relative match, which is the book having quoted a rounded price.
  for (const r of readings) {
    if (r.ref > 0 && Math.abs(r.delta) / r.ref <= relTol) {
      return { ...out, verdict: 'rounding', interpretation: r.interpretation, deltaCents: r.delta };
    }
  }

  // Neither reading reconciles. Report against the nearer one and let the
  // direction decide whether this looks like a boost or a misread.
  const nearer = Math.abs(readings[0].delta) <= Math.abs(readings[1].delta) ? readings[0] : readings[1];
  return {
    ...out,
    verdict: nearer.delta > 0 ? 'boost' : 'mismatch',
    interpretation: nearer.interpretation,
    deltaCents: nearer.delta,
  };
}

// ---------------------------------------------------------------------------
// The honest part
// ---------------------------------------------------------------------------

/**
 * Expected return per dollar on an n-leg parlay, ASSUMING each leg carries a
 * typical two-way hold. This is a model, not a measurement: a bet slip shows
 * one side of each market, and you cannot de-vig one side alone. Label it as
 * an assumption wherever it is displayed.
 *
 * 4.5% is the standard hold on a -110/-110 market.
 */
export function expectedReturnAtHold(nLegs, holdPerLeg = 0.045) {
  if (!(nLegs > 0)) return null;
  return Math.pow(1 - holdPerLeg, nLegs);
}

/** Same idea, phrased as the loss rate people recognize. */
export function expectedLossAtHold(nLegs, holdPerLeg = 0.045) {
  const r = expectedReturnAtHold(nLegs, holdPerLeg);
  return r === null ? null : 1 - r;
}

// ---------------------------------------------------------------------------
// Competition bankroll
// ---------------------------------------------------------------------------

/**
 * Apply the pool's bankroll rule to a slip.
 *
 * The real stake is whatever was actually risked. The competition stake is
 * capped at what is left in the bankroll, with the payout scaled by the same
 * ratio, so a friend whose real stakes run bigger than the weekly bankroll
 * still has a playable week and an honest real-money record.
 */
export function compStake(realStakeCents, bankrollCents) {
  const capped = Math.max(0, Math.min(realStakeCents, bankrollCents));
  return {
    stakeCompCents: capped,
    scale: realStakeCents > 0 ? capped / realStakeCents : 0,
    capped: capped < realStakeCents,
  };
}

/**
 * What a settled bet returns to the competition bankroll.
 * A push or a fully voided bet returns the stake. A loss returns nothing.
 */
export function settledReturnCents(state, stakeCompCents, dec) {
  switch (state) {
    case 'won':
      return totalReturnCents(stakeCompCents, dec);
    case 'push':
    case 'void':
      return stakeCompCents;
    case 'lost':
      return 0;
    default:
      return null; // still pending
  }
}
