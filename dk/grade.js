// grade.js: decide a single leg. Pure: (leg, snapshot) -> verdict.
//
// The one rule that governs everything in this file:
//
//   `state` is a LEDGER fact. `clinched` and `dead` are DISPLAY facts.
//
// A leg whose outcome is already forced stays `pending` until the game is
// actually final, because a stat correction can still move it and money must
// never move on a projection. `clinched` exists so the live board can show a
// green bar; it must never credit a bankroll.

import { LEAGUES, normName } from './espn.js';

export const STATE = {
  PENDING: 'pending',
  WON: 'won',
  LOST: 'lost',
  PUSH: 'push',
  VOID: 'void',
  REVIEW: 'needs_review',
};

/**
 * Stats that can go DOWN as a game progresses. Clinch and dead logic is only
 * sound for stats that only ever rise, so these are excluded from it: a
 * plus-minus of +12 says nothing about where it ends, and neither does an
 * average or a rating.
 */
const NON_MONOTONE = new Set([
  'plusMinus',
  'passYardsPerAttempt',
  'rushYardsPerAttempt',
  'recYardsPerCatch',
]);

export function isMonotone(stat) {
  return !!stat && !NON_MONOTONE.has(stat);
}

/** How a leg should be drawn on the live board. */
export const RENDER = { BAR: 'bar', BINARY: 'binary', SCORE: 'score' };

// ---------------------------------------------------------------------------
// Reading a stat, and the zero-versus-void problem
// ---------------------------------------------------------------------------

/**
 * Read one stat for one player.
 *
 * `kind` is the important part of the return value:
 *
 *   'measured'     the stat is in the box score. Use it.
 *   'implied_zero' the player appears in some OTHER group for his team but
 *                  not this one, so he played and recorded none of this.
 *                  Grade it as 0. A receiver who appears only in kickReturns
 *                  had zero receptions, and the under on his receiving yards
 *                  has won.
 *   'dnp'          the player is listed but flagged as not having played.
 *                  This is a VOID, not a zero: every book voids a prop on a
 *                  player who never takes the field. Grading it as a loss
 *                  would be a straightforwardly wrong settlement.
 *   'unknown'      we cannot tell. Never graded; always asked.
 */
export function readStat(snapshot, athleteId, stat) {
  const p = snapshot.players.get(String(athleteId));
  if (!p) return { value: null, kind: 'unknown', reason: 'player not in this box score' };
  if (p.didNotPlay) return { value: null, kind: 'dnp', reason: p.dnpReason || 'did not play' };
  // An NBA row with no stats at all is a DNP that was not flagged.
  if (p.groups.size === 0) return { value: null, kind: 'dnp', reason: 'no stats recorded' };

  const v = p.stats[stat];
  if (v !== null && v !== undefined) return { value: v, kind: 'measured', player: p };
  return { value: 0, kind: 'implied_zero', player: p };
}

// ---------------------------------------------------------------------------
// Comparison primitives
// ---------------------------------------------------------------------------

/**
 * Settle a value against a line.
 *
 * A push is only possible on a whole-number line, which is why books hang
 * half-points off most markets. Alt lines ("2+") were already rewritten to
 * over N-0.5 upstream, so they correctly can never push.
 */
function settleOverUnder(value, line, side) {
  if (value > line) return side === 'over' ? STATE.WON : STATE.LOST;
  if (value < line) return side === 'over' ? STATE.LOST : STATE.WON;
  return STATE.PUSH;
}

/** Progress fraction for a bar, clamped. */
function pctOf(current, needed) {
  if (!(needed > 0)) return current > 0 ? 1 : 0;
  const p = current / needed;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

function base(leg) {
  return {
    state: STATE.PENDING,
    clinched: false,
    dead: false,
    current: null,
    needed: leg.line === undefined ? null : leg.line,
    pct: 0,
    overshoot: false,
    render: RENDER.BAR,
    label: '',
    voidReason: null,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// The grader
// ---------------------------------------------------------------------------

/**
 * Grade one resolved leg against one game snapshot.
 *
 * `leg` is the output of resolveLeg: { market, side, line, stat, teamAbbr,
 * athleteId, confidence }. `snapshot` is from espn.snapshotFromSummary.
 */
export function gradeLeg(leg, snapshot) {
  const out = base(leg);
  if (!snapshot) return { ...out, state: STATE.REVIEW, reason: 'no game data' };

  const sport = (LEAGUES[snapshot.league] || {}).sport || 'football';
  const final = snapshot.completed === true;

  // A game that stopped without finishing (postponed, canceled, suspended)
  // voids every leg on it. Keying off `completed` rather than a status string
  // means this works for statuses we have never seen.
  if (snapshot.state === 'post' && !final) {
    return { ...out, state: STATE.VOID, voidReason: 'game_void', reason: snapshot.detail || 'game did not finish' };
  }

  // A quarter-point line implies Asian half-win settlement, which is out of
  // scope. Refuse rather than silently rounding someone's money.
  if (leg.line !== null && leg.line !== undefined && Math.abs(leg.line * 2 - Math.round(leg.line * 2)) > 1e-9) {
    return { ...out, state: STATE.REVIEW, reason: `quarter lines are not supported (${leg.line})` };
  }

  switch (leg.market) {
    case 'moneyline':
      return gradeMoneyline(leg, snapshot, out, final);
    case 'spread':
      return gradeSpread(leg, snapshot, out, final);
    case 'game_total':
      return gradeTotal(leg, snapshot, out, final, null);
    case 'team_total':
      return gradeTotal(leg, snapshot, out, final, leg.teamAbbr);
    case 'player_ou':
    case 'player_yes_no':
      return gradePlayer(leg, snapshot, out, final, sport);
    case 'first_td':
      return gradeFirstTd(leg, snapshot, out, final);
    default:
      return { ...out, state: STATE.REVIEW, reason: `market "${leg.market}" is not supported` };
  }
}

function sides(snapshot, teamAbbr) {
  const mine = snapshot.home && snapshot.home.abbr === teamAbbr ? snapshot.home
    : snapshot.away && snapshot.away.abbr === teamAbbr ? snapshot.away : null;
  const theirs = !mine ? null : (mine === snapshot.home ? snapshot.away : snapshot.home);
  return { mine, theirs };
}

function gradeMoneyline(leg, snapshot, out, final) {
  const { mine, theirs } = sides(snapshot, leg.teamAbbr);
  out.render = RENDER.SCORE;
  if (!mine || !theirs) return { ...out, state: STATE.REVIEW, reason: `team ${leg.teamAbbr} is not in this game` };
  out.current = mine.score;
  out.needed = theirs.score;
  out.label = `${mine.abbr} ${mine.score ?? 0} - ${theirs.score ?? 0} ${theirs.abbr}`;

  // A moneyline never clinches early. A three-score lead in the fourth is not
  // a mathematical certainty, and this engine does not do probability.
  if (!final) return out;

  if (mine.winner === true) return { ...out, state: STATE.WON };
  if (theirs.winner === true) return { ...out, state: STATE.LOST };
  // Nobody marked a winner on a finished game: an NFL tie. Books void the
  // moneyline. (CFB and NBA cannot tie, so this is NFL-only in practice.)
  return { ...out, state: STATE.VOID, voidReason: 'tie', reason: 'game ended in a tie' };
}

function gradeSpread(leg, snapshot, out, final) {
  const { mine, theirs } = sides(snapshot, leg.teamAbbr);
  out.render = RENDER.SCORE;
  if (!mine || !theirs) return { ...out, state: STATE.REVIEW, reason: `team ${leg.teamAbbr} is not in this game` };
  const a = mine.score;
  const b = theirs.score;
  const margin = a === null || b === null ? null : a + leg.line - b;
  out.current = margin;
  out.needed = 0;
  out.label = `${mine.abbr} ${leg.line > 0 ? '+' : ''}${leg.line} (${a ?? 0} - ${b ?? 0})`;
  if (!final) return out; // no mid-game clinch, same reasoning as the moneyline
  if (margin === null) return { ...out, state: STATE.REVIEW, reason: 'no final score' };
  if (margin > 0) return { ...out, state: STATE.WON };
  if (margin < 0) return { ...out, state: STATE.LOST };
  return { ...out, state: STATE.PUSH };
}

function gradeTotal(leg, snapshot, out, final, teamAbbr) {
  let current;
  let label;
  if (teamAbbr) {
    const { mine } = sides(snapshot, teamAbbr);
    if (!mine) return { ...out, state: STATE.REVIEW, reason: `team ${teamAbbr} is not in this game` };
    current = mine.score;
    label = `${mine.abbr} ${current ?? 0}`;
  } else {
    current = snapshot.totalScore;
    label = `total ${current ?? 0}`;
  }
  out.current = current;
  out.needed = leg.line;
  out.render = RENDER.BAR;
  out.label = `${label} of ${leg.line}`;
  if (current === null) return out;
  out.pct = pctOf(current, leg.line);

  // Scores only rise, so a total behaves like a monotone stat: an over is
  // safe once it is past the line and an under is gone at the same moment.
  if (current > leg.line) {
    if (leg.side === 'over') out.clinched = true;
    else { out.dead = true; out.overshoot = true; }
  }
  if (!final) return out;
  return { ...out, state: settleOverUnder(current, leg.line, leg.side) };
}

/* How close to the line a fantasy score has to be before a person is asked.
 * Two points, because that is what a single fumble lost is worth and the
 * feed does not report those at all. */
const FANTASY_MARGIN = 2;

function gradePlayer(leg, snapshot, out, final, sport) {
  const binary = leg.stat === 'anytimeTd' || leg.market === 'player_yes_no';
  out.render = binary ? RENDER.BINARY : RENDER.BAR;

  if (!leg.athleteId) return { ...out, state: STATE.REVIEW, reason: 'player not resolved' };
  if (!leg.stat) return { ...out, state: STATE.REVIEW, reason: 'stat not resolved' };

  const read = readStat(snapshot, leg.athleteId, leg.stat);
  const who = read.player ? read.player.display : leg.subjectRaw;

  if (read.kind === 'dnp') {
    return { ...out, state: STATE.VOID, voidReason: 'dnp', reason: `${who} did not play (${read.reason})`, label: `${who}: did not play` };
  }
  if (read.kind === 'unknown') {
    // Football has no did-not-play flag and lists only players who recorded
    // something, so this is genuinely undecidable from the feed. Asking is
    // the only correct move: guessing zero loses bets that should be voided,
    // and guessing void voids bets that should lose.
    return {
      ...out,
      state: STATE.REVIEW,
      reason: sport === 'football'
        ? `cannot tell whether ${who} played; the NFL feed omits inactive players`
        : `no stats found for ${who}`,
    };
  }

  const value = read.value;
  // A yes/no market is just an over/under on 0.5, so one rule covers both.
  const side = leg.market === 'player_yes_no' ? (leg.side === 'no' ? 'under' : 'over') : leg.side;
  const line = leg.line === null || leg.line === undefined ? 0.5 : leg.line;

  out.current = value;
  out.needed = line;
  out.pct = pctOf(value, line);
  out.label = binary
    ? `${who}: ${value > 0 ? 'yes' : 'no'}`
    : `${who} ${value} of ${line}`;

  if (isMonotone(leg.stat) && value > line) {
    if (side === 'over') out.clinched = true;
    else { out.dead = true; out.overshoot = true; }
  }

  if (!final) return out;

  // A reconstructed number does not get to settle a close call.
  //
  // A fantasy score is not published by anybody: it is computed here from
  // the box score with the ordinary full-PPR weights. A book's own weights
  // differ in small ways, and one fumble lost, which the feed does not
  // report at all, moves it two points. None of that matters when the
  // result is clear, and all of it matters when it lands beside the line,
  // where a tenth of a point decides the money. So the clear ones settle
  // and the close ones go to a person.
  if (leg.stat === 'fantasyScore' && Math.abs(value - line) <= FANTASY_MARGIN) {
    return {
      ...out,
      state: STATE.REVIEW,
      reason: `${who} finished on ${value} against a line of ${line}. A fantasy score is worked out here, not published, so a result this close has to be confirmed against your app.`,
    };
  }

  return { ...out, state: settleOverUnder(value, line, side) };
}

/**
 * First touchdown scorer. The only market that needs the play text, because
 * the box score has no ordering.
 *
 * This one resolves the whole way to a verdict before the game ends, in both
 * directions: once anybody scores the first touchdown the market is decided.
 * If it was our player the leg is clinched; if it was someone else the leg is
 * dead. `state` still waits for the final whistle like every other leg.
 *
 * Confidence on this market should be held lower than on anytime-TD, because
 * it rests on matching a name parsed out of free text rather than on a
 * numeric column.
 */
function gradeFirstTd(leg, snapshot, out, final) {
  out.render = RENDER.BINARY;
  out.needed = 1;
  if (!leg.athleteId) return { ...out, state: STATE.REVIEW, reason: 'player not resolved' };

  const player = snapshot.players.get(String(leg.athleteId));
  const scorer = snapshot.firstTdScorerName;

  if (!scorer) {
    // No touchdown in the game yet. Still live for everyone.
    out.current = 0;
    out.label = 'no touchdown yet';
    if (!final) return out;
    // A finished game with no touchdown at all voids the market at most books.
    return { ...out, state: STATE.VOID, voidReason: 'game_void', reason: 'no touchdown was scored' };
  }

  const want = normName(scorer);
  const hit = !!player && (player.fullNorm === want || player.lastNorm === normName(scorer).split(' ').pop());
  out.current = hit ? 1 : 0;
  out.label = `first TD: ${scorer}`;
  if (hit) out.clinched = true;
  else out.dead = true; // somebody else got there first; this can never win

  if (!final) return out;
  return { ...out, state: hit ? STATE.WON : STATE.LOST };
}
