// selftest.js: the regression suite for every pure module.
//
// Two kinds of check live here, and the distinction matters:
//
//   * INVARIANTS, where the expected value is forced by a formula or a
//     round trip. These are the ones that actually prove something.
//   * FIXTURE FACTS, where the expected value was read out of a real ESPN
//     payload committed under fixtures/.
//
// Hard rule carried over from the sibling projects: never write an expected
// value from memory. If a number appears below, it is either derived in the
// assertion itself or it was read off a real response. Three "failures" in an
// earlier project turned out to be bad expectations rather than bugs.
//
// Run in a browser via selftest.html, or under node:
//   node tools/selftest.mjs

import * as O from './odds.js';
import * as E from './espn.js';
import * as R from './resolve.js';
import * as G from './grade.js';
import * as P from './parlay.js';
import * as L from './league.js';
import * as ST from './store.js';
import * as DV from './derive.js';
import * as SL from './slip.js';
import * as STS from './stats.js';
import { lockTitle as UI_lockTitle, pipState as UI_pipState } from './ui.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness() {
  const results = [];
  let section = '';
  const api = {
    section(name) { section = name; },
    ok(name, cond, detail) {
      results.push({ section, name, pass: !!cond, detail: cond ? '' : (detail || '') });
    },
    eq(name, got, want) {
      const same = JSON.stringify(got) === JSON.stringify(want);
      results.push({ section, name, pass: same, detail: same ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}` });
    },
    near(name, got, want, tol = 1e-9) {
      const same = typeof got === 'number' && Math.abs(got - want) <= tol;
      results.push({ section, name, pass: same, detail: same ? '' : `got ${got} want ~${want} (tol ${tol})` });
    },
    throws(name, fn) {
      let threw = false;
      try { fn(); } catch { threw = true; }
      results.push({ section, name, pass: threw, detail: threw ? '' : 'did not throw' });
    },
    results,
  };
  return api;
}

/** Shallow-clone a snapshot with overrides, for synthetic game states. */
function patch(snap, over) {
  return { ...snap, ...over };
}
function patchTeam(snap, side, over) {
  return { ...snap, [side]: { ...snap[side], ...over } };
}

// ---------------------------------------------------------------------------
// odds.js
// ---------------------------------------------------------------------------

function testOdds(t) {
  t.section('odds: parsing');
  t.eq('EVEN is +100', O.parseAmerican('EVEN'), 100);
  t.eq('PK is +100', O.parseAmerican('pk'), 100);
  t.eq('+250 parses', O.parseAmerican('+250'), 250);
  t.eq('-110 parses', O.parseAmerican('-110'), -110);
  t.eq('spaces tolerated', O.parseAmerican(' + 250 '), 250);
  t.eq('number passes through', O.parseAmerican(-115), -115);
  // There is no American price between -100 and +100, so a value in that band
  // is a misread cell and must be refused rather than priced.
  t.eq('-99 is refused', O.parseAmerican('-99'), null);
  t.eq('+99 is refused', O.parseAmerican('+99'), null);
  t.eq('a line read as odds is refused', O.parseAmerican('2'), null);
  t.eq('zero is refused', O.parseAmerican('0'), null);
  t.eq('junk is refused', O.parseAmerican('abc'), null);
  t.eq('empty is refused', O.parseAmerican(''), null);

  t.section('odds: conversion');
  // Both signs of 100 mean an even-money bet, so both are decimal 2.
  t.eq('+100 -> 2.0', O.americanToDecimal(100), 2);
  t.eq('-100 -> 2.0', O.americanToDecimal(-100), 2);
  // -110 is exactly 1 + 100/110 = 21/11. Asserted as the fraction, not as a
  // decimal typed from memory.
  t.near('-110 is exactly 21/11', O.americanToDecimal(-110), 21 / 11);
  t.near('+250 is exactly 7/2', O.americanToDecimal(250), 7 / 2);
  // decimal 2 is ambiguous in sign; the convention is to return the positive.
  t.eq('decimal 2 round-trips to +100', O.decimalToAmerican(2), 100);

  // The real proof: a full sweep. This is what catches a wrong branch on the
  // d < 2 side, which a handful of spot checks would miss.
  let sweepFails = [];
  for (let a = 100; a <= 2000; a++) {
    for (const s of [1, -1]) {
      const v = s * a;
      if (v === -100) continue; // -100 and +100 are the same price; +100 wins
      const back = O.decimalToAmerican(O.americanToDecimal(v));
      if (back !== v) sweepFails.push(`${v}->${back}`);
    }
  }
  t.ok(`american/decimal round trip over 3801 prices`, sweepFails.length === 0, sweepFails.slice(0, 6).join(' '));

  t.section('odds: parlays');
  // Identity: an empty parlay is a multiplier of 1, which is what makes the
  // all-legs-voided case return the stake without a special branch.
  t.eq('empty parlay is 1.0', O.parlayDecimal([]), 1);
  // Three -110 legs is (21/11)^3 = 9261/1331 exactly.
  t.near('3x -110 is (21/11)^3', O.parlayDecimal([-110, -110, -110]), Math.pow(21 / 11, 3));
  t.near('3x -110 as a fraction', O.parlayDecimal([-110, -110, -110]), 9261 / 1331);
  t.eq('3x -110 in American terms', O.decimalToAmerican(O.parlayDecimal([-110, -110, -110])), Math.round((9261 / 1331 - 1) * 100));
  t.eq('a bad leg price poisons the parlay', O.parlayDecimal([-110, 'oops']), null);

  t.section('odds: payouts');
  const stake = 2500; // $25.00
  const dec3 = O.parlayDecimal([-110, -110, -110]);
  t.eq('total return is stake x decimal, rounded once', O.totalReturnCents(stake, dec3), Math.round(stake * dec3));
  t.eq('profit is total minus stake', O.profitCents(stake, dec3), O.totalReturnCents(stake, dec3) - stake);
  t.eq('roundCents sends halves away from zero', [O.roundCents(0.5), O.roundCents(-0.5)], [1, -1]);

  // The single most important assertion in the module: a pushed leg drops out
  // and the slip pays exactly what the surviving legs would have paid alone.
  const four = [
    { oddsAmerican: -110, state: 'won' },
    { oddsAmerican: +150, state: 'won' },
    { oddsAmerican: -200, state: 'push' },
    { oddsAmerican: +120, state: 'won' },
  ];
  const three = [-110, 150, 120];
  t.near('a push drops out of the price', O.effectiveDecimal(four), O.parlayDecimal(three));
  t.eq('and out of the payout', O.totalReturnCents(stake, O.effectiveDecimal(four)), O.totalReturnCents(stake, O.parlayDecimal(three)));
  t.eq('every leg pushed means a multiplier of 1', O.effectiveDecimal([{ oddsAmerican: -110, state: 'push' }, { oddsAmerican: 150, state: 'void' }]), 1);

  t.section('odds: profit boosts');
  // A boost lifts the profit, never the stake. Applying it to the total
  // return overpays every boosted slip by a fraction of the stake.
  const bStake = 1000;
  const bDec = 11; // $10 returns $110, so $100 profit
  t.eq('an unboosted return is untouched', O.boostedReturnCents(bStake, bDec, 0), O.totalReturnCents(bStake, bDec));
  t.eq('a 10% boost lifts profit only', O.boostedReturnCents(bStake, bDec, 10), bStake + (O.totalReturnCents(bStake, bDec) - bStake) * 1.1);
  t.ok('which is less than boosting the total', O.boostedReturnCents(bStake, bDec, 10) < O.totalReturnCents(bStake, bDec) * 1.1);
  // At decimal 2 the profit equals the stake, so a 50% boost adds half a
  // stake on top. Derived rather than typed, which is the whole rule here.
  const evenProfit = O.totalReturnCents(bStake, 2) - bStake;
  t.eq('an even-money boost adds half a stake', O.boostedReturnCents(bStake, 2, 50), bStake + O.roundCents(evenProfit * 1.5));
  t.eq('and the stake itself is never multiplied', O.boostedReturnCents(bStake, 2, 50) - bStake, O.roundCents(evenProfit * 1.5));

  t.section('odds: settlement');
  t.eq('a win returns stake x price', O.settledReturnCents('won', stake, 2), 5000);
  t.eq('a push returns the stake', O.settledReturnCents('push', stake, 2), stake);
  t.eq('a void returns the stake', O.settledReturnCents('void', stake, 2), stake);
  t.eq('a loss returns nothing', O.settledReturnCents('lost', stake, 2), 0);
  t.eq('pending returns null, not zero', O.settledReturnCents('pending', stake, 2), null);

  t.section('odds: competition bankroll');
  t.eq('a stake inside the bankroll is untouched', O.compStake(2500, 10000), { stakeCompCents: 2500, scale: 1, capped: false });
  const capped = O.compStake(20000, 10000);
  t.eq('a stake over the bankroll is capped', capped.stakeCompCents, 10000);
  t.near('and scaled proportionally', capped.scale, 0.5);
  t.ok('and flagged as capped', capped.capped === true);
  t.eq('a busted bankroll stakes nothing', O.compStake(5000, 0).stakeCompCents, 0);

  t.section('odds: reconciliation');
  const legs2 = [{ oddsAmerican: -110, eventId: 'A' }, { oddsAmerican: 150, eventId: 'B' }];
  const dec2 = O.parlayDecimal([-110, 150]);
  const tot2 = O.totalReturnCents(10000, dec2);
  t.eq('matches on the total-payout reading', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: tot2 }).verdict, 'match');
  t.eq('and reports which reading matched', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: tot2 }).interpretation, 'total');
  t.eq('matches on the to-win reading too', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: tot2 - 10000 }).interpretation, 'profit');
  t.eq('a rounded book price reads as rounding', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: Math.round(tot2 * 1.01) }).verdict, 'rounding');
  t.eq('paying more than the price is a boost', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: tot2 * 2 }).verdict, 'boost');
  t.eq('paying less than the price is a misread', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: Math.round(tot2 * 0.5) }).verdict, 'mismatch');
  t.eq('no claimed payout is unverifiable', O.reconcile({ stakeCents: 10000, legs: legs2, claimedCents: null }).verdict, 'unverifiable');

  // Same-game parlays: the book prices correlated legs jointly, so the leg
  // product is NOT the slip price. Checking against it would flag every SGP
  // as a misread, so the leg product must be ignored for these.
  const sgpLegs = [{ oddsAmerican: -110, eventId: 'A' }, { oddsAmerican: 150, eventId: 'A' }];
  t.ok('an SGP is detected from repeated event ids', O.isCorrelated(sgpLegs) === true);
  t.ok('independent legs are not correlated', O.isCorrelated(legs2) === false);
  const sgpNoPrice = O.reconcile({ stakeCents: 10000, legs: sgpLegs, claimedCents: 50000 });
  t.eq('an SGP with no printed price is unverifiable, not a mismatch', sgpNoPrice.verdict, 'unverifiable');
  t.ok('and it does not fall back to the leg product', sgpNoPrice.dec === null);
  const sgpPriced = O.reconcile({ stakeCents: 10000, legs: sgpLegs, slipAmerican: 400, claimedCents: O.totalReturnCents(10000, O.americanToDecimal(400)) });
  t.eq('an SGP checks against its own printed price', sgpPriced.verdict, 'match');
  t.eq('and says so', sgpPriced.basis, 'slip');

  t.section('odds: the honest part');
  const r1 = O.expectedReturnAtHold(1);
  const r6 = O.expectedReturnAtHold(6);
  t.ok('more legs means a worse expected return', r6 < r1);
  t.near('one leg is just the hold', r1, 1 - 0.045);
  t.near('six legs compounds it', r6, Math.pow(1 - 0.045, 6));
  t.near('loss is one minus return', O.expectedLossAtHold(6), 1 - Math.pow(1 - 0.045, 6));
}

// ---------------------------------------------------------------------------
// espn.js
// ---------------------------------------------------------------------------

function testEspn(t, fx) {
  t.section('espn: value parsing');
  t.eq('a comma thousands separator', E.num('1,024'), 1024);
  // '--' and '' mean absent, which is NOT zero. Reading them as zero would
  // grade an unplayed prop as a loss.
  t.eq('double dash is absent, not zero', E.num('--'), null);
  t.eq('empty is absent, not zero', E.num(''), null);
  t.eq('a real zero is zero', E.num('0'), 0);
  t.eq('a signed value', E.num('-14'), -14);

  t.section('espn: name folding');
  t.eq('suffixes drop', E.normName('Ron Harper Jr.'), 'ron harper');
  t.eq('roman suffixes drop', E.normName('Luther Burden III'), 'luther burden');
  t.eq('apostrophes fold', E.normName("T'Vondre Sweat"), 'tvondre sweat');
  t.eq('accents fold', E.normName('Nikola Vučević'), 'nikola vucevic');
  t.eq('initials keep their letter', E.normName('P. George'), 'p george');

  t.section('espn: name fields are derived when the feed omits them');
  // Regression: the NBA box score returns firstName and lastName as null and
  // only populates displayName. Without a fallback, first-initial matching
  // silently never fired for basketball, so every shared surname went to
  // manual review instead of resolving.
  const nbaForNames = E.snapshotFromSummary(fx.nba, 'nba');
  const nbaPlayers = [...nbaForNames.players.values()];
  t.ok('the NBA feed really does omit firstName', nbaPlayers.some((p) => p.first === null), 'fixture no longer exercises this');
  t.ok('yet every player has a usable first name', nbaPlayers.every((p) => p.firstNorm.length > 0));
  t.ok('and a usable surname', nbaPlayers.every((p) => p.lastNorm.length > 0));
  t.ok('football populates them directly', [...E.snapshotFromSummary(fx.nfl, 'nfl').players.values()].some((p) => p.first !== null));

  const nfl = E.snapshotFromSummary(fx.nfl, 'nfl');
  const nba = E.snapshotFromSummary(fx.nba, 'nba');
  const cfb = E.snapshotFromSummary(fx.cfb, 'cfb');

  t.section('espn: the stats/labels alignment trap');
  // Verified empirically: stats[] always matches labels[], while keys[] does
  // not (CFB passing has 5 labels and 6 keys). Aligning on keys would shift
  // every column in that group. A clean parse here is the proof.
  const align = [...nfl.warnings, ...nba.warnings, ...cfb.warnings].filter((w) => w.includes('length mismatch'));
  t.eq('no fixture misaligns when zipping to labels', align, []);

  // Rather than pinning a player's numbers (which drift whenever a live
  // fixture is re-captured), re-derive every parsed value straight from the
  // raw cell it came from. If the parser ever zipped to the wrong array, the
  // parsed number would stop matching its own source cell.
  const checkAlignment = (rawDoc, snap, label, group, keyA, keyB) => {
    let checked = 0;
    let bad = [];
    for (const teamBlock of rawDoc.boxscore.players) {
      for (const g of teamBlock.statistics) {
        if ((g.name || '_all') !== group) continue;
        const i = (g.labels || []).indexOf(label);
        if (i < 0) continue;
        for (const row of g.athletes || []) {
          const cell = (row.stats || [])[i];
          if (cell === undefined) continue;
          const p = snap.players.get(String(row.athlete.id));
          if (!p) continue;
          const [a, b] = String(cell).split(/[/-]/);
          checked++;
          if (p.stats[keyA] !== E.num(a) || p.stats[keyB] !== E.num(b)) {
            bad.push(`${p.display}: cell "${cell}" vs ${p.stats[keyA]}/${p.stats[keyB]}`);
          }
        }
      }
    }
    return { checked, bad };
  };

  const cfbPass = checkAlignment(fx.cfb, cfb, 'C/ATT', 'passing', 'completions', 'passAttempts');
  t.ok('the CFB fixture has passing rows to check', cfbPass.checked > 0, 'none found');
  t.ok(`CFB C/ATT parses from its own cell (${cfbPass.checked} rows)`, cfbPass.bad.length === 0, cfbPass.bad.slice(0, 3).join(' '));
  const nflPass = checkAlignment(fx.nfl, nfl, 'C/ATT', 'passing', 'completions', 'passAttempts');
  t.ok(`NFL C/ATT parses from its own cell (${nflPass.checked} rows)`, nflPass.bad.length === 0, nflPass.bad.slice(0, 3).join(' '));
  const nbaFg = checkAlignment(fx.nba, nba, '3PT', '_all', 'threesMade', 'threesAttempted');
  t.ok(`NBA 3PT parses from its own cell (${nbaFg.checked} rows)`, nbaFg.bad.length === 0, nbaFg.bad.slice(0, 3).join(' '));

  t.section('espn: a passing TD is thrown, not scored');
  const love = [...nfl.players.values()].find((p) => p.lastNorm === 'love');
  const kraft = [...nfl.players.values()].find((p) => p.lastNorm === 'kraft');
  const jacobs = [...nfl.players.values()].find((p) => p.lastNorm === 'jacobs');
  t.eq('the quarterback threw three', love && love.stats.passTd, 3);
  // The whole trap in one assertion: the passer must NOT accumulate an
  // anytime touchdown. Summing every TD column would give him three.
  t.eq('but scored none', love && love.stats.anytimeTd, undefined);
  t.eq('the receiver scored one', kraft && kraft.stats.recTd, 1);
  t.eq('and it counts as an anytime TD', kraft && kraft.stats.anytimeTd, 1);
  // A player with both a rushing and a receiving score sums to two.
  t.eq('rush plus receive sums', jacobs && jacobs.stats.anytimeTd, (jacobs.stats.rushTd || 0) + (jacobs.stats.recTd || 0));
  t.eq('totalTd does include the passer', love && love.stats.totalTd, 3);

  t.section('espn: first TD scorer from play text');
  // The play text names two players ("X Yd pass from Y") and only the first
  // scored. Cutting at the first digit keeps the scorer and drops the passer.
  t.eq('the scorer, not the passer', nfl.firstTdScorerName, 'Tucker Kraft');
  t.ok('the passer is not credited', nfl.firstTdScorerName !== 'Jordan Love');

  t.section('espn: did-not-play');
  const dnp = [...nba.players.values()].filter((p) => p.didNotPlay);
  t.ok('the NBA fixture flags inactive players', dnp.length > 0, 'no didNotPlay rows');
  t.ok('a flagged player has no stat groups', dnp.every((p) => p.groups.size === 0));
  t.ok('and carries a reason', dnp.every((p) => !!p.dnpReason));
  // Football has no such flag anywhere, which is the ambiguity grade.js asks about.
  t.ok('football has no did-not-play flag at all', [...nfl.players.values()].every((p) => p.didNotPlay === false));

  t.section('espn: composite cells');
  const anyNba = [...nba.players.values()].find((p) => p.stats.threesAttempted > 0);
  t.ok('NBA splits made-attempted on a dash', anyNba && anyNba.stats.threesMade !== undefined && anyNba.stats.threesAttempted !== undefined);
  t.ok('made never exceeds attempted', [...nba.players.values()].every((p) => p.stats.threesMade === undefined || p.stats.threesMade <= p.stats.threesAttempted));
  t.ok('NFL splits completions on a slash', love && love.stats.completions <= love.stats.passAttempts);

  t.section('espn: derived sums');
  t.eq('scrimmage yards is rush plus receive',
    jacobs && jacobs.stats.scrimmageYards,
    (jacobs.stats.rushYards || 0) + (jacobs.stats.recYards || 0));
  const scorer = [...nba.players.values()].find((p) => p.stats.points > 0);
  t.eq('points+rebounds+assists sums',
    scorer && scorer.stats.pra,
    (scorer.stats.points || 0) + (scorer.stats.rebounds || 0) + (scorer.stats.assists || 0));

  t.section('espn: game state');
  t.ok('the NFL fixture is final', nfl.completed === true && nfl.state === 'post');
  t.eq('total score is the sum of both sides', nfl.totalScore, nfl.home.score + nfl.away.score);
  t.ok('exactly one side is the winner', (nfl.home.winner ? 1 : 0) + (nfl.away.winner ? 1 : 0) === 1);
  t.ok('the CFB fixture was captured mid-game', cfb.state === 'in' && cfb.completed === false);

  t.section('espn: per-period scores');
  // Needed for the quarter-by-quarter box score table in the UI.
  t.eq('regulation period count comes from the feed', nfl.regulationPeriods, 4);
  t.ok('both sides carry per-period scores', nfl.home.periods.length > 0 && nfl.away.periods.length > 0);
  // The periods must add up to the final score, which is the check that
  // catches a mis-parsed or truncated linescore array.
  const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
  t.eq('home periods sum to the home score', sum(nfl.home.periods), nfl.home.score);
  t.eq('away periods sum to the away score', sum(nfl.away.periods), nfl.away.score);
  t.eq('a regulation game has exactly four quarters', nfl.home.periods.length, nfl.regulationPeriods);
  t.ok('both sides report the same number of periods', nfl.home.periods.length === nfl.away.periods.length);

  t.section('espn: scoreboard');
  const events = E.eventsFromScoreboard(fx.nflBoard, 'nfl');
  t.ok('events come back', events.length > 0);
  const ev = events[0];
  t.ok('each event has a start time', events.every((e) => typeof e.startAt === 'number'));
  t.ok('each side carries several names to match on', ev.home.names.length >= 3);
  t.ok('the abbreviation is among them', ev.home.names.includes(ev.home.abbr));

  return { nfl, nba, cfb, events };
}

// ---------------------------------------------------------------------------
// resolve.js
// ---------------------------------------------------------------------------

function testResolve(t, snaps) {
  const { nfl, nba, events } = snaps;

  t.section('resolve: stat vocabulary');
  // Ordering matters: a more specific phrase has to win over a general one.
  t.eq('passing touchdowns is not the anytime market', R.matchStat('Passing Touchdowns', 'football'), 'passTd');
  t.eq('bare touchdown is the anytime market', R.matchStat('Anytime Touchdown', 'football'), 'anytimeTd');
  t.eq('receiving yards', R.matchStat('Receiving Yards', 'football'), 'recYards');
  t.eq('rushing yards', R.matchStat('Rush Yds', 'football'), 'rushYards');
  t.eq('receptions', R.matchStat('Receptions', 'football'), 'receptions');
  t.eq('combined rush and receive', R.matchStat('Rush + Rec Yards', 'football'), 'scrimmageYards');
  t.eq('three-stat combo beats points', R.matchStat('Points + Rebounds + Assists', 'basketball'), 'pra');
  t.eq('two-stat combo beats points', R.matchStat('Pts + Reb', 'basketball'), 'pointsRebounds');
  t.eq('bare points', R.matchStat('Points', 'basketball'), 'points');
  // Regression: books write this market three different ways and the hyphen
  // form was silently unmatched, which would have sent every threes prop to
  // manual review.
  t.eq('threes made, hyphenated', R.matchStat('3-Pointers Made', 'basketball'), 'threesMade');
  t.eq('threes made, spaced', R.matchStat('3 Pointers Made', 'basketball'), 'threesMade');
  t.eq('threes made, abbreviated', R.matchStat('Made Threes', 'basketball'), 'threesMade');
  // A slash is a combo separator, not whitespace. Folding it to a space would
  // leave "rush rec yards", which falls through to plain receiving yards and
  // silently mis-grades the bet.
  t.eq('a slash separates a combo', R.matchStat('Rush/Rec Yards', 'football'), 'scrimmageYards');
  t.eq('and does so for three-part combos', R.matchStat('Pts/Reb/Ast', 'basketball'), 'pra');
  t.ok('a slashed combo is never read as its last part', R.matchStat('Rush/Rec Yards', 'football') !== 'recYards');
  // A '+' must NOT be folded away either, for the same reason.
  t.eq('plus still separates a combo', R.matchStat('Pts + Ast', 'basketball'), 'pointsAssists');

  t.section('resolve: leg text');
  const total = R.parseLegText('Over 47.5');
  t.eq('a game total', [total.market, total.side, total.line], ['game_total', 'over', 47.5]);
  t.eq('a short-form under', R.parseLegText('U 210.5').side, 'under');
  const sp = R.parseLegText('Green Bay Packers -3.5');
  t.eq('a spread', [sp.market, sp.line], ['spread', -3.5]);
  t.eq('a spread keeps its team', sp.subjectRaw, 'Green Bay Packers');
  const ml = R.parseLegText('Packers ML');
  t.eq('a moneyline', [ml.market, ml.subjectRaw], ['moneyline', 'Packers']);
  const pou = R.parseLegText('Jordan Love Over 249.5 Passing Yards');
  t.eq('a player over', [pou.market, pou.stat, pou.side, pou.line], ['player_ou', 'passYards', 'over', 249.5]);
  t.eq('and keeps the player', pou.subjectRaw, 'Jordan Love');
  // "N+" is rewritten to over N-0.5 so one rule grades both, and so an alt
  // line correctly becomes unpushable.
  const alt = R.parseLegText('Josh Jacobs 2+ Rushing TDs');
  t.eq('an alt line becomes an over', [alt.market, alt.stat, alt.side], ['player_ou', 'rushTd', 'over']);
  t.eq('2+ is over 1.5', alt.line, 1.5);
  t.ok('and is marked as an alt line', alt.altLine === true);
  const atd = R.parseLegText('Tucker Kraft Anytime TD');
  t.eq('anytime touchdown', [atd.market, atd.stat, atd.side, atd.line], ['player_yes_no', 'anytimeTd', 'yes', 0.5]);
  t.eq('and keeps the player', atd.subjectRaw, 'Tucker Kraft');
  const pra = R.parseLegText('Shai Gilgeous-Alexander Over 29.5 Pts + Reb + Ast', 'basketball');
  t.eq('a basketball combo', [pra.market, pra.stat, pra.line], ['player_ou', 'pra', 29.5]);
  t.eq('unparseable text yields no market', R.parseLegText('???').market, null);

  t.section('resolve: teams');
  t.eq('by nickname', R.resolveTeam('Packers', events).teamAbbr, 'GB');
  t.eq('by city', R.resolveTeam('Green Bay', events).teamAbbr, 'GB');
  t.eq('by abbreviation', R.resolveTeam('GB', events).teamAbbr, 'GB');
  t.eq('by full name', R.resolveTeam('Green Bay Packers', events).teamAbbr, 'GB');
  t.eq('all four agree on one game', new Set(['Packers', 'Green Bay', 'GB', 'Green Bay Packers'].map((n) => R.resolveTeam(n, events).eventId)).size, 1);
  t.eq('an unknown team does not resolve', R.resolveTeam('Sheffield Wednesday', events).confidence, R.C.NONE);

  t.section('resolve: players');
  const exact = R.resolvePlayerInSnapshot('Tucker Kraft', nfl);
  t.eq('a full name is exact', exact.confidence, R.C.EXACT);
  const initial = R.resolvePlayerInSnapshot('T. Kraft', nfl);
  t.eq('an initial plus surname resolves', initial.athleteId, exact.athleteId);
  t.ok('at slightly lower confidence', initial.confidence === R.C.INITIAL || initial.confidence === R.C.EXACT);
  const lastOnly = R.resolvePlayerInSnapshot('Kraft', nfl);
  t.eq('a unique surname alone resolves', lastOnly.athleteId, exact.athleteId);

  // The NBA fixture really does contain two players surnamed Williams, which
  // makes this the honest ambiguity test rather than a fabricated one.
  const williams = (nba.byLast.get('williams') || []);
  t.ok('the NBA fixture has a shared surname', williams.length >= 2, `found ${williams.length}`);
  const amb = R.resolvePlayerInSnapshot('Williams', nba);
  t.eq('a shared surname is refused, not guessed', amb.confidence, R.C.AMBIGUOUS);
  t.ok('and the candidates come back for a human', (amb.candidates || []).length >= 2);
  const jWilliams = R.resolvePlayerInSnapshot('J. Williams', nba);
  t.ok('an initial disambiguates it', !!jWilliams.athleteId, jWilliams.reason || '');
  t.eq('at initial-level confidence', jWilliams.confidence, R.C.INITIAL);
  t.eq('and picks the right one of the two', nba.players.get(jWilliams.athleteId).firstNorm[0], 'j');
  t.ok('the other initial picks the other player',
    R.resolvePlayerInSnapshot('K. Williams', nba).athleteId !== jWilliams.athleteId);
  // Two players share a surname across opposing teams here, which is the
  // case that a per-game lookup has to handle rather than a per-team one.
  t.ok('a surname shared across both teams is also refused',
    R.resolvePlayerInSnapshot('Mitchell', nba).confidence === R.C.AMBIGUOUS);
  t.ok('and a full name still resolves it',
    !!R.resolvePlayerInSnapshot('Donovan Mitchell', nba).athleteId);
  t.ok('a wrong first name is refused', !R.resolvePlayerInSnapshot('Zebediah Kraft', nfl).athleteId);

  t.section('resolve: whole legs');
  const legML = R.resolveLeg({ rawText: 'Packers ML' }, { league: 'nfl', events });
  t.eq('a moneyline leg resolves to a team and game', [legML.market, legML.teamAbbr], ['moneyline', 'GB']);
  t.ok('above the auto-grade bar', legML.confidence >= R.AUTO_GRADE_MIN);
  const legProp = R.resolveLeg({ rawText: 'Tucker Kraft Over 40.5 Receiving Yards' }, { league: 'nfl', events, snapshots: [nfl] });
  t.eq('a prop leg resolves to a player and stat', [legProp.market, legProp.stat], ['player_ou', 'recYards']);
  t.ok('and finds the athlete', !!legProp.athleteId);
  // Before kickoff there is no box score, so player legs cannot resolve yet.
  // That is a normal state, not an error, and it must not auto-grade.
  const legPre = R.resolveLeg({ rawText: 'Tucker Kraft Over 40.5 Receiving Yards' }, { league: 'nfl', events, snapshots: [] });
  t.ok('a prop cannot resolve before the game starts', legPre.confidence < R.AUTO_GRADE_MIN);
  t.ok('and says why', /box score/.test(legPre.reason || ''));
}

// ---------------------------------------------------------------------------
// grade.js
// ---------------------------------------------------------------------------

function testGrade(t, snaps) {
  const { nfl, nba } = snaps;
  const home = nfl.home.abbr; // GB, the winner in this fixture
  const away = nfl.away.abbr; // CAR
  const margin = nfl.home.score - nfl.away.score;
  const total = nfl.totalScore;

  const love = [...nfl.players.values()].find((p) => p.lastNorm === 'love');
  const kraft = [...nfl.players.values()].find((p) => p.lastNorm === 'kraft');

  t.section('grade: moneyline');
  t.eq('the winner wins', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, nfl).state, G.STATE.WON);
  t.eq('the loser loses', G.gradeLeg({ market: 'moneyline', teamAbbr: away }, nfl).state, G.STATE.LOST);
  t.eq('a team not in the game is refused', G.gradeLeg({ market: 'moneyline', teamAbbr: 'ZZZ' }, nfl).state, G.STATE.REVIEW);
  // An NFL tie voids the moneyline. Synthesized by clearing both winner flags
  // on a finished game, which is exactly what the feed shows for a tie.
  const tied = patchTeam(patchTeam(nfl, 'home', { winner: false, score: 20 }), 'away', { winner: false, score: 20 });
  t.eq('a tie voids rather than losing', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, tied).state, G.STATE.VOID);
  t.eq('and records why', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, tied).voidReason, 'tie');

  t.section('grade: spread');
  // Expected sides are derived from the fixture's own margin, not asserted
  // from a remembered score.
  t.eq('covering a smaller spread wins', G.gradeLeg({ market: 'spread', teamAbbr: home, line: -(margin - 0.5) }, nfl).state, G.STATE.WON);
  t.eq('failing a bigger spread loses', G.gradeLeg({ market: 'spread', teamAbbr: home, line: -(margin + 0.5) }, nfl).state, G.STATE.LOST);
  t.eq('the exact margin pushes', G.gradeLeg({ market: 'spread', teamAbbr: home, line: -margin }, nfl).state, G.STATE.PUSH);
  t.eq('the dog covers the mirror line', G.gradeLeg({ market: 'spread', teamAbbr: away, line: margin + 0.5 }, nfl).state, G.STATE.WON);

  t.section('grade: totals');
  t.eq('over a lower number wins', G.gradeLeg({ market: 'game_total', side: 'over', line: total - 0.5 }, nfl).state, G.STATE.WON);
  t.eq('over a higher number loses', G.gradeLeg({ market: 'game_total', side: 'over', line: total + 0.5 }, nfl).state, G.STATE.LOST);
  t.eq('the exact total pushes', G.gradeLeg({ market: 'game_total', side: 'over', line: total }, nfl).state, G.STATE.PUSH);
  t.eq('under mirrors over', G.gradeLeg({ market: 'game_total', side: 'under', line: total + 0.5 }, nfl).state, G.STATE.WON);
  t.eq('a team total reads one side only', G.gradeLeg({ market: 'team_total', teamAbbr: home, side: 'over', line: nfl.home.score - 0.5 }, nfl).state, G.STATE.WON);

  t.section('grade: player props');
  const py = love.stats.passYards;
  t.eq('over a lower line wins', G.gradeLeg({ market: 'player_ou', athleteId: love.id, stat: 'passYards', side: 'over', line: py - 0.5 }, nfl).state, G.STATE.WON);
  t.eq('under a lower line loses', G.gradeLeg({ market: 'player_ou', athleteId: love.id, stat: 'passYards', side: 'under', line: py - 0.5 }, nfl).state, G.STATE.LOST);
  t.eq('a whole-number line can push', G.gradeLeg({ market: 'player_ou', athleteId: love.id, stat: 'passYards', side: 'over', line: py }, nfl).state, G.STATE.PUSH);

  t.section('grade: the anytime-TD trap, end to end');
  // The passer threw three touchdowns and scored none. A "yes" on his anytime
  // market must LOSE. This is the assertion that would have caught the
  // sum-every-TD-column bug, and it is the most important test in the file.
  const loveAnytime = G.gradeLeg({ market: 'player_yes_no', athleteId: love.id, stat: 'anytimeTd', side: 'yes', line: 0.5 }, nfl);
  t.eq('the passer did not score', loveAnytime.state, G.STATE.LOST);
  t.eq('his anytime count reads zero', loveAnytime.current, 0);
  t.eq('the receiver did score', G.gradeLeg({ market: 'player_yes_no', athleteId: kraft.id, stat: 'anytimeTd', side: 'yes', line: 0.5 }, nfl).state, G.STATE.WON);
  t.eq('a no on the receiver loses', G.gradeLeg({ market: 'player_yes_no', athleteId: kraft.id, stat: 'anytimeTd', side: 'no', line: 0.5 }, nfl).state, G.STATE.LOST);

  t.section('grade: zero versus void');
  // A player present in one group but not another played and recorded nothing
  // there, so the stat is a real zero and the under has won.
  const noRush = [...nfl.players.values()].find((p) => p.groups.size > 0 && !p.groups.has('rushing'));
  const z = G.readStat(nfl, noRush.id, 'rushYards');
  t.eq('absent from a group means zero', [z.kind, z.value], ['implied_zero', 0]);
  t.eq('and the under on it wins', G.gradeLeg({ market: 'player_ou', athleteId: noRush.id, stat: 'rushYards', side: 'under', line: 10.5 }, nfl).state, G.STATE.WON);

  // A flagged did-not-play VOIDS the prop. Grading it as a loss would be a
  // straightforwardly wrong settlement, since every book refunds it.
  const dnp = [...nba.players.values()].find((p) => p.didNotPlay);
  const dz = G.readStat(nba, dnp.id, 'points');
  t.eq('a did-not-play is not a zero', dz.kind, 'dnp');
  const dnpLeg = G.gradeLeg({ market: 'player_ou', athleteId: dnp.id, stat: 'points', side: 'over', line: 5.5 }, nba);
  t.eq('a did-not-play voids the leg', dnpLeg.state, G.STATE.VOID);
  t.eq('and records why', dnpLeg.voidReason, 'dnp');
  t.ok('the under does not win off it either', G.gradeLeg({ market: 'player_ou', athleteId: dnp.id, stat: 'points', side: 'under', line: 5.5 }, nba).state === G.STATE.VOID);

  // A player we cannot find at all is undecidable in football, and asking is
  // the only correct move.
  const unknown = G.gradeLeg({ market: 'player_ou', athleteId: 'definitely-not-a-real-id', stat: 'recYards', side: 'over', line: 20.5 }, nfl);
  t.eq('an unfindable player is asked about, not guessed', unknown.state, G.STATE.REVIEW);

  t.section('grade: clinched and dead are not settled');
  // THE rule: money moves on `state`, never on `clinched`. A leg whose
  // outcome is forced mid-game stays pending, because a stat correction can
  // still move it before the final whistle.
  const live = patch(nfl, { state: 'in', completed: false, detail: '3rd Quarter' });
  const clinched = G.gradeLeg({ market: 'player_ou', athleteId: love.id, stat: 'passYards', side: 'over', line: py - 50 }, live);
  t.ok('an over past its line is clinched', clinched.clinched === true);
  t.eq('but is still pending', clinched.state, G.STATE.PENDING);
  const dead = G.gradeLeg({ market: 'player_ou', athleteId: love.id, stat: 'passYards', side: 'under', line: py - 50 }, live);
  t.ok('the matching under is dead', dead.dead === true);
  t.eq('and also still pending', dead.state, G.STATE.PENDING);
  t.ok('a dead leg marks the overshoot', dead.overshoot === true);
  const notYet = G.gradeLeg({ market: 'player_ou', athleteId: love.id, stat: 'passYards', side: 'over', line: py + 50 }, live);
  t.ok('a leg short of its line is neither', notYet.clinched === false && notYet.dead === false);
  t.ok('and reports partial progress', notYet.pct > 0 && notYet.pct < 1);

  // A spread or moneyline must never clinch. A big lead is not a mathematical
  // certainty, and this engine does not do probability.
  t.ok('a spread never clinches mid-game', G.gradeLeg({ market: 'spread', teamAbbr: home, line: -1.5 }, live).clinched === false);
  t.ok('a moneyline never clinches mid-game', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, live).clinched === false);
  t.eq('and neither settles mid-game', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, live).state, G.STATE.PENDING);
  // A total behaves like a monotone stat, because scores only rise.
  t.ok('a game total can clinch', G.gradeLeg({ market: 'game_total', side: 'over', line: total - 10 }, live).clinched === true);

  t.section('grade: non-monotone stats never clinch');
  t.ok('plus-minus is not monotone', G.isMonotone('plusMinus') === false);
  t.ok('an average is not monotone', G.isMonotone('recYardsPerCatch') === false);
  t.ok('a counting stat is monotone', G.isMonotone('recYards') === true);
  const pm = [...nba.players.values()].find((p) => typeof p.stats.plusMinus === 'number' && p.stats.plusMinus > 0);
  if (pm) {
    const liveNba = patch(nba, { state: 'in', completed: false });
    t.ok('so a leading plus-minus does not clinch',
      G.gradeLeg({ market: 'player_ou', athleteId: pm.id, stat: 'plusMinus', side: 'over', line: pm.stats.plusMinus - 1 }, liveNba).clinched === false);
  } else {
    t.ok('so a leading plus-minus does not clinch (no sample in fixture)', true);
  }

  t.section('grade: games that did not finish');
  // Postponed, canceled and suspended games all void. Keying off `completed`
  // rather than a status string means this works for statuses never seen.
  const abandoned = patch(nfl, { state: 'post', completed: false, detail: 'Postponed' });
  t.eq('an unfinished game voids its legs', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, abandoned).state, G.STATE.VOID);
  t.eq('and records why', G.gradeLeg({ market: 'game_total', side: 'over', line: 1 }, abandoned).voidReason, 'game_void');

  t.section('grade: unsupported shapes are refused');
  t.eq('a quarter line is refused', G.gradeLeg({ market: 'spread', teamAbbr: home, line: -3.25 }, nfl).state, G.STATE.REVIEW);
  t.eq('an unknown market is refused', G.gradeLeg({ market: 'player_period_ou', athleteId: love.id, stat: 'points' }, nfl).state, G.STATE.REVIEW);
  t.eq('missing game data is refused', G.gradeLeg({ market: 'moneyline', teamAbbr: home }, null).state, G.STATE.REVIEW);

  t.section('grade: first touchdown scorer');
  t.eq('the actual first scorer wins', G.gradeLeg({ market: 'first_td', athleteId: kraft.id }, nfl).state, G.STATE.WON);
  t.eq('anyone else loses', G.gradeLeg({ market: 'first_td', athleteId: love.id }, nfl).state, G.STATE.LOST);
  // Once somebody else has scored, the market is decided even mid-game.
  t.ok('and is dead the moment someone else scores', G.gradeLeg({ market: 'first_td', athleteId: love.id }, live).dead === true);
}

// ---------------------------------------------------------------------------
// parlay.js
// ---------------------------------------------------------------------------

function testParlay(t) {
  const W = { state: G.STATE.WON, oddsAmerican: -110 };
  const L = { state: G.STATE.LOST, oddsAmerican: -110 };
  const Pd = { state: G.STATE.PENDING, oddsAmerican: -110 };
  const Ps = { state: G.STATE.PUSH, oddsAmerican: -110 };
  const V = { state: G.STATE.VOID, oddsAmerican: -110 };
  const Rv = { state: G.STATE.REVIEW, oddsAmerican: -110 };
  const stake = 5000;

  t.section('parlay: rollup precedence');
  // A confirmed loss settles immediately. Nobody waits for the late game to
  // find out their parlay is dead, and no book makes them.
  t.eq('one loss kills the lock at once', P.rollupParlay([W, L, Pd]).state, G.STATE.LOST);
  t.ok('and the lock is final', P.rollupParlay([W, L, Pd]).final === true);
  // Review outranks pending, so three winners plus one unresolvable leg must
  // not pay out on the strength of the three.
  t.eq('an unresolved leg holds the lock', P.rollupParlay([W, W, W, Rv]).state, G.STATE.REVIEW);
  t.ok('and the lock is not final', P.rollupParlay([W, W, W, Rv]).final === false);
  // But a loss still outranks review: no reason to freeze a dead lock.
  t.eq('a loss outranks a review', P.rollupParlay([L, Rv]).state, G.STATE.LOST);
  t.eq('a live leg keeps it pending', P.rollupParlay([W, Pd]).state, G.STATE.PENDING);
  t.eq('all winners wins', P.rollupParlay([W, W, W]).state, G.STATE.WON);
  t.eq('all pushed voids', P.rollupParlay([Ps, Ps]).state, G.STATE.VOID);
  t.eq('pushes and voids together still void', P.rollupParlay([Ps, V]).state, G.STATE.VOID);
  t.eq('an empty lock is refused', P.rollupParlay([]).state, G.STATE.REVIEW);

  t.section('parlay: settlement');
  const won3 = P.settleParlay([W, W, W], stake);
  t.eq('a winner pays stake x price', won3.returnCents, O.totalReturnCents(stake, O.parlayDecimal([-110, -110, -110])));
  t.eq('a loser returns nothing', P.settleParlay([W, L], stake).returnCents, 0);
  t.eq('a fully voided lock refunds the stake', P.settleParlay([Ps, Ps], stake).returnCents, stake);
  t.eq('an unsettled lock returns null, not zero', P.settleParlay([W, Pd], stake).returnCents, null);
  // The reduced-odds recompute: a 4-leg lock with one push pays exactly what
  // the surviving 3 legs would have paid alone.
  t.eq('a push reprices to the surviving legs',
    P.settleParlay([W, W, Ps, W], stake).returnCents,
    P.settleParlay([W, W, W], stake).returnCents);

  t.section('parlay: a single is the one-leg case');
  // Deliberately no separate code path for straight bets.
  t.eq('a single winner', P.settleParlay([W], stake).returnCents, O.totalReturnCents(stake, O.americanToDecimal(-110)));
  t.eq('a single loser', P.settleParlay([L], stake).returnCents, 0);
  t.eq('a single push refunds', P.settleParlay([Ps], stake).returnCents, stake);

  t.section('parlay: live progress');
  t.near('all legs won is complete', P.lockProgress([{ state: G.STATE.WON }, { state: G.STATE.WON }]).pct, 1);
  t.eq('a dead leg zeroes the lock', P.lockProgress([{ state: G.STATE.WON }, { dead: true, pct: 0.9 }]).pct, 0);
  t.ok('and marks it not alive', P.lockProgress([{ dead: true }]).alive === false);
  t.near('half-done reads as half', P.lockProgress([{ state: G.STATE.WON }, { pct: 0 }]).pct, 0.5);
  t.eq('a clinched leg counts as done', P.lockProgress([{ clinched: true }, { clinched: true }]).won, 2);
}

// ---------------------------------------------------------------------------
// league.js
// ---------------------------------------------------------------------------

function testLeague(t) {
  t.section('league: invite codes');
  // A fixed byte feed makes the generator deterministic, which is the only
  // way to actually test the rejection sampling rather than hope.
  const feed = (arr) => { let i = 0; return (n) => Uint8Array.from({ length: n }, () => arr[i++ % arr.length]); };
  t.eq('a code is six characters', L.genCode(feed([0])).length, 6);
  // 256 is not a multiple of 31, so bytes at 248 and above must be thrown
  // away rather than taken modulo, or the early letters get favoured.
  t.eq('bytes above the fold are rejected, not folded', L.genCode(feed([250, 0])), 'AAAAAA');
  t.eq('byte 30 maps to the last letter', L.genCode(feed([30])), '999999');
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  t.eq('the alphabet has 31 characters', alphabet.length, 31);
  for (const ch of '0O1IL') t.ok(`the alphabet omits ${ch}`, !alphabet.includes(ch));
  // A real code should still be well formed.
  const real = L.genCode();
  t.ok('a generated code normalizes to itself', L.normalizeCode(real) === real);

  t.section('league: reading a typed code');
  t.eq('lowercase is accepted', L.normalizeCode('abc234'), 'ABC234');
  t.eq('spaces and dashes are stripped', L.normalizeCode(' ab c-234 '), 'ABC234');
  t.eq('a wrong length is refused', L.normalizeCode('ABC23'), null);
  t.eq('an ambiguous character is refused', L.normalizeCode('ABC01O'), null);
  t.eq('junk is refused', L.normalizeCode('!!!!!!'), null);
  t.eq('an invite link round-trips', L.readJoinCode(`?join=${real}`), real);
  t.eq('a link with other params still works', L.readJoinCode(`?x=1&join=${real}&y=2`), real);
  t.eq('no code in the link', L.readJoinCode('?x=1'), null);

  t.section('league: ISO weeks');
  // The real proof is a sweep, not spot checks: for every day across four
  // years the key's Monday must be a Monday and must contain that day.
  let bad = [];
  const d = new Date(2024, 0, 1);
  for (let i = 0; i < 365 * 4; i++) {
    const key = L.isoWeekKey(d);
    const start = L.weekStart(key);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    if (start.getDay() !== 1) bad.push(`${key} starts on day ${start.getDay()}`);
    else if (!(d >= start && d < end)) bad.push(`${d.toDateString()} outside ${key}`);
    d.setDate(d.getDate() + 1);
  }
  t.ok('every day of four years lands in a Monday week containing it', bad.length === 0, bad.slice(0, 3).join(' '));

  // The two rules that define ISO weeks, checked across many years rather
  // than remembered for one.
  let jan4 = [];
  let dec28 = [];
  for (let y = 2020; y <= 2035; y++) {
    if (!L.isoWeekKey(new Date(y, 0, 4)).endsWith('W01')) jan4.push(y);
    const k = L.isoWeekKey(new Date(y, 11, 28));
    const nextYearWeek1 = L.isoWeekKey(new Date(y + 1, 0, 4));
    if (!k.startsWith(String(y)) || k === nextYearWeek1) dec28.push(y);
  }
  t.ok('Jan 4 is always in week 01', jan4.length === 0, jan4.join(','));
  t.ok('Dec 28 is always in its own year’s last week', dec28.length === 0, dec28.join(','));

  // A week runs Monday to Sunday, so those two share a key and Monday starts a new one.
  const mon = new Date(2026, 10, 2);
  const sun = new Date(2026, 10, 8);
  const nextMon = new Date(2026, 10, 9);
  t.eq('Monday and the following Sunday share a week', L.isoWeekKey(mon), L.isoWeekKey(sun));
  t.ok('the next Monday starts a new week', L.isoWeekKey(nextMon) !== L.isoWeekKey(sun));
  t.ok('the range reads as a date span', /^[A-Z][a-z]{2} \d+ to [A-Z][a-z]{2} \d+$/.test(L.weekRange(L.isoWeekKey(mon))));
  t.eq('weeks sort newest first', L.sortWeekKeysDesc(['2026-W02', '2026-W10', '2025-W51']), ['2026-W10', '2026-W02', '2025-W51']);

  t.section('league: membership');
  let lg = L.createLeague({ name: 'Sunday Degenerates', ownerUid: 'u1', ownerName: 'Grant', code: 'ABC234', now: 1000 });
  t.eq('the creator owns it', lg.ownerUid, 'u1');
  t.ok('and is a member', L.isMember(lg, 'u1'));
  t.eq('with the owner role', L.memberOf(lg, 'u1').role, L.ROLE.OWNER);
  t.eq('the default bankroll is $100', lg.startBankrollCents, 10000);

  lg = L.joinLeague(lg, { uid: 'u2', name: 'Ashtin', now: 2000 }).league;
  lg = L.joinLeague(lg, { uid: 'u3', name: 'ckirby', now: 3000 }).league;
  t.eq('joining adds a member', lg.members.length, 3);
  // Tapping an invite link twice must not clone you into the standings.
  const again = L.joinLeague(lg, { uid: 'u2', name: 'Ashtin' });
  t.ok('joining twice is idempotent', again.already === true && again.league.members.length === 3);

  t.section('league: who may do what');
  t.ok('a member cannot remove anyone', L.removeMember(lg, 'u2', 'u3').ok === false);
  t.ok('the owner can', L.removeMember(lg, 'u1', 'u3').ok === true);
  t.ok('but not themselves', L.removeMember(lg, 'u1', 'u1').ok === false);
  t.ok('a member cannot rename it', L.renameLeague(lg, 'u2', 'Nope').ok === false);
  t.eq('the owner can', L.renameLeague(lg, 'u1', 'Work League').league.name, 'Work League');
  t.ok('an empty name is refused', L.renameLeague(lg, 'u1', '   ').ok === false);
  // The owner walking out would leave nobody able to manage the league.
  t.ok('the owner cannot just leave', L.leaveLeague(lg, 'u1').ok === false);
  t.ok('an ordinary member can', L.leaveLeague(lg, 'u2').ok === true);
  const handed = L.transferOwnership(lg, 'u1', 'u2');
  t.eq('ownership can be handed over', handed.league.ownerUid, 'u2');
  t.eq('and the roles follow', L.memberOf(handed.league, 'u2').role, L.ROLE.OWNER);
  t.ok('the old owner can now leave', L.leaveLeague(handed.league, 'u1').ok === true);
  t.ok('ownership cannot go to a non-member', L.transferOwnership(lg, 'u1', 'nobody').ok === false);

  t.section('league: the bankroll cannot move under people');
  const placed = [{ code: 'ABC234', uid: 'u2', weekKey: '2026-W45', stakeCompCents: 500, state: 'lost', returnCents: 0 }];
  t.ok('changing it is fine before any locks', L.setStartBankroll(lg, 'u1', 20000, []).ok === true);
  t.ok('and refused once locks exist', L.setStartBankroll(lg, 'u1', 20000, placed).ok === false);
  t.ok('a member cannot change it at all', L.setStartBankroll(lg, 'u2', 20000, []).ok === false);
  t.ok('zero is refused', L.setStartBankroll(lg, 'u1', 0, []).ok === false);

  t.section('league: a member’s week');
  const W = '2026-W45';
  const mk = (uid, stake, state, ret) => ({ code: 'ABC234', uid, weekKey: W, stakeCompCents: stake, state, returnCents: ret, settledAt: 5000 });
  const start = 10000;

  const flat = L.memberWeek('u1', [], start);
  t.eq('no locks means the starting bankroll', flat.bankrollCents, start);
  t.eq('and no ROI to report', flat.roi, null);
  t.ok('and is not a bust', flat.bust === false);

  const oneWin = L.memberWeek('u1', [mk('u1', 2000, 'won', 6000)], start);
  t.eq('a win is start minus stake plus return', oneWin.bankrollCents, start - 2000 + 6000);
  t.eq('profit is return minus stake', oneWin.profitCents, 4000);
  t.near('ROI follows', oneWin.roi, 4000 / 2000);

  const pushed = L.memberWeek('u1', [mk('u1', 2000, 'push', 2000)], start);
  t.eq('a push leaves the bankroll alone', pushed.bankrollCents, start);
  t.eq('and counts as neither a win nor a loss', [pushed.won, pushed.lost, pushed.pushed], [0, 0, 1]);

  const live = L.memberWeek('u1', [{ ...mk('u1', 3000, 'pending'), returnCents: null }], start);
  t.eq('a live lock has its stake taken', live.bankrollCents, start - 3000);
  t.eq('and reports what is at risk', live.atRiskCents, 3000);
  t.eq('with no ROI yet', live.roi, null);

  t.section('league: busting');
  const broke = L.memberWeek('u1', [mk('u1', 10000, 'lost', 0)], start);
  t.ok('losing everything is a bust', broke.bust === true);
  // THE rule: staking your last dollar is not busting. You are not out until
  // that lock settles against you.
  const allIn = L.memberWeek('u1', [{ ...mk('u1', 10000, 'pending'), returnCents: null }], start);
  t.eq('staking it all leaves nothing in the bankroll', allIn.bankrollCents, 0);
  t.ok('but that is not a bust while it is still live', allIn.bust === false);
  t.eq('because it is all at risk', allIn.atRiskCents, 10000);
  const survived = L.memberWeek('u1', [mk('u1', 10000, 'won', 25000)], start);
  t.ok('and it may yet come back', survived.bust === false && survived.bankrollCents === 25000);
  t.ok('a bankroll can never read below zero', L.memberWeek('u1', [mk('u1', 10000, 'lost', 0), mk('u1', 5000, 'lost', 0)], start).bankrollCents === 0);

  t.section('league: locks outside the competition');
  const late = [{ ...mk('u1', 5000, 'won', 15000), eligible: false }];
  t.eq('an ineligible lock does not move the bankroll', L.memberWeek('u1', late, start).bankrollCents, start);
  t.eq('nor the record', L.memberWeek('u1', late, start).won, 0);

  t.section('league: standings');
  let lg2 = L.createLeague({ name: 'Test', ownerUid: 'a', ownerName: 'Ann', code: 'ABC234', now: 0 });
  lg2 = L.joinLeague(lg2, { uid: 'b', name: 'Bob' }).league;
  lg2 = L.joinLeague(lg2, { uid: 'c', name: 'Cal' }).league;
  const locks = [
    mk('a', 2000, 'won', 8000), // ann: 10000-2000+8000 = 16000
    mk('b', 1000, 'lost', 0), //  bob: 9000
    mk('c', 10000, 'lost', 0), //  cal: 0, busted
  ];
  const rows = L.standings(lg2, locks, W);
  t.eq('ranked by profit', rows.map((r) => r.name), ['Ann', 'Bob', 'Cal']);
  t.eq('ranks are one-based', rows.map((r) => r.rank), [1, 2, 3]);
  // Worth stating, because it is why swapping the sort from bankroll to
  // profit changed no order: within a week everyone starts from the same
  // figure, so bankroll IS the start plus profit and the two always agree.
  t.ok(
    'bankroll is the start plus profit, so the two sorts cannot disagree',
    rows.every((r) => r.bankrollCents === Math.max(0, r.startCents + r.profitCents)),
  );
  // Level on money, the one who risked less to get there is ahead.
  let lgT = L.createLeague({ name: 'Tie', ownerUid: 'x', ownerName: 'Xan', code: 'TIE234', now: 0 });
  lgT = L.joinLeague(lgT, { uid: 'y', name: 'Yas' }).league;
  const tied = [
    mk('x', 1000, 'won', 3000), // +2000 off 1000 staked
    mk('y', 8000, 'won', 10000), // +2000 off 8000 staked
  ];
  t.eq('a tie on profit goes to whoever risked less', L.standings(lgT, tied, W).map((r) => r.name), ['Xan', 'Yas']);
  t.eq('the leader’s bankroll is computed, not stored', rows[0].bankrollCents, start - 2000 + 8000);
  t.ok('the busted player is flagged', rows[2].bust === true);
  // A tidy zero must not outrank someone still alive with a dollar left.
  const lg3 = L.joinLeague(lg2, { uid: 'd', name: 'Dee' }).league;
  const withTiny = [...locks, mk('d', 9999, 'lost', 0)]; // dee left with 1 cent
  const rows2 = L.standings(lg3, withTiny, W);
  t.eq('a survivor on one cent still beats a bust', rows2[rows2.length - 1].name, 'Cal');
  t.ok('and the survivor is not marked busted', rows2.find((r) => r.name === 'Dee').bust === false);
  t.eq('a different week sees nothing', L.standings(lg2, locks, '2026-W44').every((r) => r.bankrollCents === start), true);

  t.section('league: all time and history');
  const twoWeeks = [
    { ...mk('a', 2000, 'won', 8000), weekKey: '2026-W44' },
    { ...mk('a', 2000, 'lost', 0), weekKey: '2026-W45' },
    { ...mk('b', 1000, 'won', 9000), weekKey: '2026-W45' },
  ];
  const all = L.allTimeStandings(lg2, twoWeeks);
  t.eq('all time ranks on cumulative profit', all[0].name, 'Bob');
  t.eq('and sums across weeks', all.find((r) => r.name === 'Ann').profitCents, (8000 - 2000) + (0 - 2000));
  t.eq('weeks are listed newest first', L.leagueWeeks(lg2, twoWeeks), ['2026-W45', '2026-W44']);
  const hist = L.weekHistory(lg2, twoWeeks);
  t.eq('history covers every week played', hist.length, 2);
  t.eq('and names each week’s winner', hist.find((h) => h.weekKey === '2026-W44').winner.name, 'Ann');

  t.section('league: being in several at once');
  let ms = L.newMembership();
  const home = L.createLeague({ name: 'Home', ownerUid: 'me', ownerName: 'Me', code: 'AAA222' });
  const work = L.createLeague({ name: 'Work', ownerUid: 'boss', ownerName: 'Boss', code: 'BBB333' });
  ms = L.addLeague(ms, home);
  ms = L.addLeague(ms, work);
  t.eq('both are kept', Object.keys(ms.leagues).length, 2);
  t.eq('the newest becomes active', ms.activeCode, 'BBB333');
  t.eq('and can be switched', L.setActive(ms, 'AAA222').activeCode, 'AAA222');
  t.eq('switching to one you are not in is ignored', L.setActive(ms, 'ZZZ999').activeCode, 'BBB333');
  t.eq('the active league resolves to an object', L.activeLeague(ms).name, 'Work');
  const dropped = L.removeLeague(ms, 'BBB333');
  t.eq('leaving one picks another to show', dropped.activeCode, 'AAA222');
  t.eq('leaving the last one leaves nothing active', L.removeLeague(dropped, 'AAA222').activeCode, null);
  // Leagues you run come first, so the one you manage is a tap away.
  t.eq('your own leagues sort first', L.leagueList(ms, 'me').map((l) => l.name), ['Home', 'Work']);
  t.eq('and otherwise alphabetically', L.leagueList(ms, 'nobody').map((l) => l.name), ['Home', 'Work']);

  t.section('league: initials');
  t.eq('two names give two letters', L.initialsOf('Grant Leyda'), 'GL');
  t.eq('one name gives two letters', L.initialsOf('ckirby'), 'CK');
  t.eq('a middle name is skipped', L.initialsOf('Mary Jane Watson'), 'MW');
  t.eq('nothing gives a placeholder', L.initialsOf(''), '?');
}

// ---------------------------------------------------------------------------
// store.js and derive.js
// ---------------------------------------------------------------------------

/** A localStorage stand-in, including the ways a real one misbehaves. */
function fakeStorage({ throwOnGet = false, throwOnSet = false } = {}) {
  const map = new Map();
  return {
    getItem(k) { if (throwOnGet) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (throwOnSet) throw new Error('full'); map.set(k, v); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function testStore(t, snaps) {
  t.section('store: round trip');
  const s1 = ST.freshState('Grant Leyda');
  t.eq('a fresh state carries initials', s1.me.initials, 'GL');
  t.ok('and a unique id', /^u-/.test(s1.me.uid));
  t.eq('with no locks', s1.locks.length, 0);

  const store = fakeStorage();
  t.ok('saving reports success', ST.save(store, s1) === true);
  const back = ST.load(store);
  t.eq('and the state comes back', back.me.uid, s1.me.uid);
  t.eq('with its ui settings', back.ui.tab, s1.ui.tab);

  t.section('store: storage that misbehaves');
  // All three of these are ordinary on a phone, not exceptional, so none of
  // them may throw: a private window, cleared data, a half-written value.
  t.eq('an empty store reads as nothing', ST.load(fakeStorage()), null);
  t.eq('a blocked store reads as nothing', ST.load(fakeStorage({ throwOnGet: true })), null);
  t.ok('a full store reports failure instead of throwing', ST.save(fakeStorage({ throwOnSet: true }), s1) === false);
  const corrupt = fakeStorage();
  corrupt.setItem(ST.KEY, '{not json');
  t.eq('unparseable data reads as nothing', ST.load(corrupt), null);

  t.section('store: migration refuses to guess');
  // A state we cannot reason about is discarded rather than half-read: wrong
  // numbers are worse than starting over, and export exists as the way out.
  t.eq('a future schema is refused', ST.migrate({ ...s1, schema: 99 }), null);
  t.eq('a missing schema is refused', ST.migrate({ me: s1.me }), null);
  t.eq('a state with no user is refused', ST.migrate({ schema: ST.SCHEMA }), null);
  t.ok('a valid state survives', ST.migrate(JSON.parse(JSON.stringify(s1))).me.uid === s1.me.uid);
  t.ok('missing ui keys are filled in', ST.migrate({ ...JSON.parse(JSON.stringify(s1)), ui: {} }).ui.tab !== undefined);
  t.eq('export and import round-trip', ST.importState(ST.exportState(s1)).me.uid, s1.me.uid);

  t.section('store: locks');
  const lock = ST.newLock({ code: 'ABC234', uid: 'u1', stakeCents: 1000, picks: [{ text: 'Packers ML', league: 'nfl', odds: -165 }] });
  t.ok('a lock gets an id', /^L-/.test(lock.id));
  t.eq('and keeps the leg as written', lock.picks[0].text, 'Packers ML');
  t.eq('with no overrides yet', Object.keys(lock.overrides).length, 0);
  // Nothing graded is ever stored, so a stale verdict cannot be believed.
  t.ok('no verdict is stored on a lock', lock.state === undefined && lock.legs === undefined);

  let withLock = ST.addLock(s1, lock);
  t.eq('adding puts it at the top', withLock.locks[0].id, lock.id);
  t.eq('overrides are set per leg', ST.setOverride(withLock, lock.id, 0, 'won').locks[0].overrides[0], 'won');
  t.eq('and removing works', ST.removeLock(withLock, lock.id).locks.length, 0);

  t.section('derive: grading a stored lock');
  const ctx = { events: [], snapshots: Object.values(snaps).filter((s) => s && s.players) };
  const nflEvents = [{
    eventId: snaps.nfl.eventId, league: 'nfl', startAt: snaps.nfl.startAt,
    state: snaps.nfl.state, home: snaps.nfl.home, away: snaps.nfl.away,
  }];
  const full = { events: nflEvents, snapshots: [snaps.nfl] };

  const winner = ST.newLock({
    code: 'ABC234', uid: 'u1', stakeCents: 1000,
    picks: [{ text: 'Tucker Kraft Anytime TD', league: 'nfl', odds: 260 }],
  });
  const dWin = DV.deriveLock(winner, full);
  t.eq('a real winner grades as won', dWin.state, G.STATE.WON);
  t.eq('and prices from the stored odds', dWin.returnCents, O.totalReturnCents(1000, O.americanToDecimal(260)));
  // derive.js carries no presentation: the Worker's scheduled grader imports
  // it, and dragging the render layer onto the server would be both wasteful
  // and a way for the two to drift apart.
  t.eq('no display title is derived', dWin.title, undefined);
  t.eq('the title is the render layer’s job', UI_lockTitle(1), 'Single Lock');
  t.eq('and it counts legs', UI_lockTitle(4), '4 Leg Lock');

  // The trap again, this time all the way through storage and derivation.
  const loser = ST.newLock({
    code: 'ABC234', uid: 'u1', stakeCents: 1000,
    picks: [{ text: 'Jordan Love Anytime TD', league: 'nfl', odds: 750 }],
  });
  t.eq('the passer still loses his anytime leg', DV.deriveLock(loser, full).state, G.STATE.LOST);
  t.eq('and returns nothing', DV.deriveLock(loser, full).returnCents, 0);

  t.section('derive: not started versus not identifiable');
  // Before a game starts there is nothing to grade, and that must read as
  // pending rather than as a loss.
  const early = DV.deriveLock(winner, { events: [], snapshots: [] });
  t.eq('a lock with no game data is pending', early.state, G.STATE.PENDING);
  t.eq('and returns null, not zero', early.returnCents, null);

  // But a leg we cannot place DESPITE having the box scores is a different
  // thing, and must ask rather than sit there looking like it is waiting for
  // kickoff. These two were conflated and a bogus player read as pending
  // forever, which is the one outcome that silently never resolves.
  const bogus = ST.newLock({
    code: 'ABC234', uid: 'u1', stakeCents: 1000,
    picks: [{ text: 'Reginald Nobody Anytime TD', league: 'nfl', odds: 400 }],
  });
  const dBogus = DV.deriveLock(bogus, full);
  t.eq('an unidentifiable selection asks for review', dBogus.state, G.STATE.REVIEW);
  t.ok('and says why', /no player matched/.test(dBogus.legs[0].verdict.reason || ''));
  t.ok('and the lock is flagged as needing review', dBogus.needsReview === true);
  t.eq('no money moves on it', dBogus.returnCents, null);
  // One tap settles it, and that call sticks.
  t.eq('a human call resolves it', DV.deriveLock({ ...bogus, overrides: { 0: 'won' } }, full).state, G.STATE.WON);

  t.section('derive: a human override wins');
  const withOverride = { ...loser, overrides: { 0: 'won' } };
  const dOver = DV.deriveLock(withOverride, full);
  t.eq('an override flips the leg', dOver.legs[0].verdict.state, G.STATE.WON);
  t.ok('and is marked as a person’s call', dOver.legs[0].verdict.overridden === true);
  t.eq('so the lock follows it', dOver.state, G.STATE.WON);
  // A later poll must never quietly undo someone's call.
  t.eq('re-deriving keeps the override', DV.deriveLock(withOverride, full).state, G.STATE.WON);

  t.section('derive: summary rows pass through');
  const summary = {
    id: 'L-x', code: 'ABC234', uid: 'u2', weekKey: '2026-W45',
    stakeCompCents: 2000, settledState: 'won', settledReturnCents: 5600, picks: [],
  };
  const dSum = DV.deriveLock(summary, full);
  t.eq('a settled summary is not re-graded', dSum.state, 'won');
  t.eq('and keeps its return', dSum.returnCents, 5600);
  t.ok('and is flagged as summary only', dSum.summaryOnly === true);

  t.section('derive: feeding the standings');
  const rows = DV.toLedgerRows([dWin, dSum]);
  t.ok('ledger rows carry only money and state', rows.every((r) => r.legs === undefined && r.picks === undefined));
  t.eq('and enough for the standings', Object.keys(rows[0]).sort().join(','),
    'code,eligible,id,returnCents,settledAt,stakeCompCents,state,uid,weekKey');

  t.section('derive: ordering the live board');
  const dead = { state: G.STATE.LOST, legs: [] };
  const close = { state: G.STATE.PENDING, legs: [{ verdict: { state: G.STATE.WON } }, { verdict: { pct: 0.9 } }] };
  const far = { state: G.STATE.PENDING, legs: [{ verdict: { pct: 0.1 } }, { verdict: { pct: 0 } }] };
  const sorted = [dead, far, close].sort(DV.byCloseness);
  t.eq('closest to cashing comes first', sorted[0], close);
  t.eq('and a lost lock sinks to the bottom', sorted[2], dead);

  t.section('store: demo mode');
  const demo = ST.demoState('2026-W45');
  t.eq('demo has two leagues', Object.keys(demo.membership.leagues).length, 2);
  t.ok('with one Grant runs', L.isOwner(demo.membership.leagues.DEGEN7, demo.me.uid));
  t.ok('and one he only belongs to', !L.isOwner(demo.membership.leagues.MCGH42, demo.me.uid));
  t.ok('and locks for several people', new Set(demo.locks.map((l) => l.uid)).size > 1);
  t.ok('every demo lock names its week', demo.locks.every((l) => l.weekKey === '2026-W45'));
}

// ---------------------------------------------------------------------------
// slip.js
// ---------------------------------------------------------------------------

/* These transcripts are what a vision model would produce from real slips.
 * The content is taken from actual DraftKings screenshots, so the layout,
 * wording and line order are the real thing rather than something invented to
 * suit the parser. */

const LOST_COMBO = `4 Pick Combo | 2.6%
Lost
CLE Browns, BAL Ravens, MIN Vikings, ATL Falcons
Bought: $1.19
Position Information
CLE Browns
To Win
Final
CLE Browns 0 6 0 0 6
PIT Steelers 7 13 7 0 27
BAL Ravens
To Win
Final
BAL Ravens 7 0 3 0 10
BUF Bills 10 6 7 13 36`;

const WON_COMBO = `DRAFTKINGS
2 Pick Combo | 36%
Won
Derrick Henry, Josh Allen
Bought: $24.70 | Paid: $69.03
10% Boost
Position Information
Derrick Henry
Anytime TD Scorer
Josh Allen
Anytime TD Scorer
Final
BAL Ravens 7 0 3 0 10
BUF Bills 10 6 7 13 36
Share
Hide Legs
Trade
Placed: Nov 1, 2026 at 8:36:23 AM`;

const PRICED_LEGS = `3 Leg Parlay
Wager $25.00
To Win $212.50
Jordan Love Over 249.5 Passing Yards  -115
Tucker Kraft Anytime TD  +260
Total Points Over 44.5
-110`;

function testSlip(t) {
  t.section('slip: money');
  t.eq('a plain amount', SL.parseMoney('$24.70'), 2470);
  t.eq('thousands separators', SL.parseMoney('$1,234.56'), 123456);
  t.eq('no dollar sign', SL.parseMoney('25'), 2500);
  t.eq('no cents', SL.parseMoney('$100'), 10000);
  t.eq('nothing there', SL.parseMoney('no money here'), null);

  t.section('slip: headline numbers');
  t.eq('leg count from "4 Pick Combo"', SL.declaredLegCount('4 Pick Combo | 2.6%'), 4);
  t.eq('leg count from "3 Leg Parlay"', SL.declaredLegCount('3 Leg Parlay'), 3);
  t.eq('no count to find', SL.declaredLegCount('Single'), null);
  t.eq('a boost badge', SL.declaredBoost('10% Boost'), 10);
  t.eq('the other wording', SL.declaredBoost('Profit Boost 25%'), 25);
  t.eq('no boost', SL.declaredBoost('2 Pick Combo'), null);

  t.section('slip: guessing the league');
  t.eq('football words', SL.guessLeague('Anytime TD Scorer, Passing Yards'), 'nfl');
  t.eq('a named NBA team', SL.guessLeague('Celtics ML'), 'nba');
  t.eq('basketball stats', SL.guessLeague('Over 29.5 Points + Rebounds + Assists'), 'nba');
  t.eq('college football', SL.guessLeague('CFB: Zips ML'), 'cfb');

  t.section('slip: a real losing combo');
  const lost = SL.parseSlip(LOST_COMBO);
  t.eq('the stake is read', lost.stakeCents, 119);
  t.eq('and the leg count the slip declares', lost.declaredLegs, 4);
  // Each team appears twice: once as a selection and once in the box score.
  // The box score rows carry scores, so only the selections should parse.
  t.ok('the selections are found', lost.picks.length >= 2, `got ${lost.picks.length}`);
  t.ok('and they are the teams, not the score lines',
    lost.picks.every((p) => !/\d\s+\d/.test(p.text)), JSON.stringify(lost.picks.map((p) => p.text)));
  t.ok('Browns is among them', lost.picks.some((p) => /browns/i.test(p.text)));
  // The slip says four picks; if fewer were read, say so rather than
  // quietly saving a three-leg lock.
  t.ok('a miscount is reported, not hidden',
    lost.picks.length === 4 || lost.warnings.some((w) => /missing leg/.test(w)),
    JSON.stringify(lost.warnings));

  t.section('slip: a real winning combo');
  const won = SL.parseSlip(WON_COMBO);
  t.eq('the stake', won.stakeCents, 2470);
  t.eq('the payout', won.payoutCents, 6903);
  t.eq('the boost', won.boostPct, 10);
  t.eq('two picks', won.picks.length, 2);
  t.ok('both are the players', won.picks.every((p) => /henry|allen/i.test(p.text)),
    JSON.stringify(won.picks.map((p) => p.text)));
  t.eq('read as football', won.league, 'nfl');
  // Chrome lines must not become legs.
  t.ok('Share and Hide Legs are ignored',
    !won.picks.some((p) => /share|hide|placed|draftkings/i.test(p.text)));
  t.ok('the box score rows are ignored',
    !won.picks.some((p) => /ravens 7|bills 10/i.test(p.text)));

  t.section('slip: prices on the leg lines');
  const priced = SL.parseSlip(PRICED_LEGS);
  t.eq('the stake', priced.stakeCents, 2500);
  t.eq('the payout', priced.payoutCents, 21250);
  t.eq('three legs', priced.picks.length, 3);
  t.eq('a trailing price is taken off the selection', priced.picks[0].odds, -115);
  t.ok('and not left in the text', !/-115/.test(priced.picks[0].text), priced.picks[0].text);
  t.eq('the second price', priced.picks[1].odds, 260);
  // The third leg's price is on the NEXT line, which books do constantly.
  t.eq('a price on the following line is picked up', priced.picks[2].odds, -110);
  t.ok('the yardage line survives in the text', /249\.5/.test(priced.picks[0].text), priced.picks[0].text);

  t.section('slip: what a real model actually returned');
  // Verbatim from a live Workers AI run against one of Grant's own
  // DraftKings screenshots, markdown fence and all. Models wrap transcripts
  // in a fence even when told not to, so it is stripped rather than argued
  // with in the prompt.
  const REAL = '```\n6:55\n1h\nTrades\nBets\nPick\'Em\nHorse Bets\nPools\nAll\nOpen\nLive\nSettled\nWon\n'
    + 'DRAFTKINGS\nTHE CROWN IS YOURS\n2 Pick Combo | 36%\nDerrick Henry, Josh Allen\n'
    + 'Bought: $24.70 | Paid: $69.03\n10% Boost\nPosition Information\nDerrick Henry\nAnytime TD Scorer\n'
    + 'Josh Allen\nAnytime TD Scorer\nFinal\nBAL Ravens\n7 0 3 0 10\nBUF Bills\n10 6 7 13 36\n'
    + 'Share\nHide Legs\nTrade\nHome\nLive\nMy Activity\nSearch\nRewards\n```';
  const real = SL.parseSlip(REAL);
  t.eq('the stake survives the chrome', real.stakeCents, 2470);
  t.eq('and the payout', real.payoutCents, 6903);
  t.eq('and the boost', real.boostPct, 10);
  t.eq('exactly the two real selections', real.picks.length, 2);
  t.eq('with their markets attached', real.picks.map((p) => p.text),
    ['Derrick Henry Anytime TD Scorer', 'Josh Allen Anytime TD Scorer']);
  t.eq('matching the count the slip states', real.declaredLegs, 2);
  // The app's own navigation was in the screenshot and must not become bets.
  t.ok('tab bar and filter chips are not legs',
    !real.picks.some((p) => /trades|pick.em|rewards|settled|my activity|horse/i.test(p.text)));
  t.ok('and neither is the box score', !real.picks.some((p) => /ravens|bills/i.test(p.text)));
  t.ok('a fenced transcript parses the same as an unfenced one',
    SL.parseSlip(REAL.replace(/```/g, '')).picks.length === real.picks.length);

  t.section('slip: saying so when it is unsure');
  const empty = SL.parseSlip('DraftKings\nMy Bets\nSettled');
  t.eq('nothing recognized', empty.picks.length, 0);
  t.ok('and it says so', empty.warnings.some((w) => /No selections/.test(w)));
  t.ok('a missing stake is reported', empty.warnings.some((w) => /stake/.test(w)));
  t.ok('missing prices are reported',
    SL.parseSlip('2 Pick Combo\nBought: $5.00\nPackers ML\nTo Win').warnings.some((w) => /price/.test(w)));
  t.eq('junk in, nothing out', SL.parseSlip('').picks.length, 0);
  t.eq('and it does not throw', typeof SL.parseSlip(null).warnings, 'object');

  t.section('slip: handing over to the entry form');
  const draft = SL.slipToDraft(won, 'ABC234');
  t.eq('the league code comes along', draft.code, 'ABC234');
  t.eq('the stake carries over', draft.stakeCents, 2470);
  t.eq('the boost carries over', draft.boostPct, 10);
  t.eq('the picks become editable rows', draft.picks.length, 2);
  t.ok('odds are strings the form can show', draft.picks.every((p) => typeof p.odds === 'string'));
  // An unreadable slip still opens a usable form rather than a dead end.
  const blank = SL.slipToDraft(SL.parseSlip('nothing here'), 'ABC234');
  t.eq('an empty slip still gives one row to type into', blank.picks.length, 1);
  t.ok('with a sensible default stake', blank.stakeCents > 0);
}

// ---------------------------------------------------------------------------
// A player-prop slip, which carries no leg prices at all
// ---------------------------------------------------------------------------

// The same three-leg parlay as the book prints it two different ways: the
// share card, which puts the matchup under every selection, and the bet card,
// which does not. Neither shows a price per leg, because there is not one to
// show: the book prices the combination and prints what it cost and what it
// pays. Transcribed from real screenshots.
const PROP_SHARE_CARD = [
  'Trade Placed', '29%',
  '3 Pick Combo',
  'Bhayshul Tuten', 'JAX Jaguars @ BAL Ravens', 'Anytime TD Scorer',
  '60+', 'JAX Jaguars @ BAL Ravens', 'Bhayshul Tuten Rushing Yards',
  '40+', 'JAX Jaguars @ BAL Ravens', 'Derrick Henry Rushing Yards',
  'Total', '$22.21',
  'Payout', '$72.00',
].join('\n');

const PROP_BET_CARD = [
  '3 Pick Combo | 29%', 'Open',
  'Bhayshul Tuten, 60+, 40+',
  'Bought: $22.21 | To Pay: $72.00',
  'Sell',
  'Bhayshul Tuten', 'Anytime TD Scorer',
  '60+', 'Bhayshul Tuten Rushing Yards',
  '40+', 'Derrick Henry Rushing Yards',
  'JAX Thu 7:15 PM BAL',
  'Share', 'Hide Legs',
  'Trade', 'Placed: Nov 4, 2026 at 10:00:00 PM',
].join('\n');

function testPropSlip(t) {
  for (const [name, text] of [['share card', PROP_SHARE_CARD], ['bet card', PROP_BET_CARD]]) {
    const s = SL.parseSlip(text);

    t.section(`prop slip: the money (${name})`);
    // The two figures that matter most: they settle the lock between them.
    t.eq('what it cost', s.stakeCents, 2221);
    t.eq('and what it pays', s.payoutCents, 7200);

    t.section(`prop slip: the legs (${name})`);
    t.eq('all three are read', s.picks.length, 3);
    t.eq('and the slip agrees', s.declaredLegs, 3);
    t.eq('the legs, in order', s.picks.map((p) => p.text), [
      'Bhayshul Tuten Anytime TD Scorer',
      'Bhayshul Tuten 60+ Rushing Yards',
      'Derrick Henry 40+ Rushing Yards',
    ]);
    // A threshold prints on its own line above the player, so putting it back
    // in the wrong place files the bet under a player who does not exist.
    const second = R.parseLegText(s.picks[1].text, 'football');
    t.eq('the 60+ leg keeps its whole player name', second.subjectRaw, 'Bhayshul Tuten');
    t.eq('and asks for the right stat', second.stat, 'rushYards');
    t.eq('with the alt line read as over 59.5', second.line, 59.5);
    const first = R.parseLegText(s.picks[0].text, 'football');
    t.eq('the anytime TD leg is a yes/no', first.market, 'player_yes_no');
    t.eq('on the right player', first.subjectRaw, 'Bhayshul Tuten');

    t.section(`prop slip: no leg prices is fine (${name})`);
    t.ok('none of the legs carry one', s.picks.every((p) => p.odds === null));
    t.ok('and that is not complained about', !s.warnings.some((w) => /leg prices/i.test(w)));
    t.ok('nor is anything else', s.warnings.length === 0);
  }

  t.section('prop slip: as the vision model actually returns it');
  // The live model puts a blank line between every line it reads. Captured
  // from a real run against the deployed worker, so the suite is checking
  // the shape the app really gets rather than a tidied-up version of it.
  const doubleSpaced = PROP_SHARE_CARD.split('\n').join('\n\n');
  const live = SL.parseSlip(doubleSpaced);
  t.eq('the blank lines change nothing', live.picks.map((p) => p.text), [
    'Bhayshul Tuten Anytime TD Scorer',
    'Bhayshul Tuten 60+ Rushing Yards',
    'Derrick Henry 40+ Rushing Yards',
  ]);
  t.eq('and the money still reads', live.stakeCents, 2221);
  t.eq('both figures', live.payoutCents, 7200);
  t.ok('with nothing to warn about', live.warnings.length === 0);

  t.section('prop slip: the matchup line is context, not a selection');
  // Read as a selection it became the subject of the leg below it, and the
  // player's name was thrown away.
  t.ok(
    'no leg is named after the fixture',
    SL.parseSlip(PROP_SHARE_CARD).picks.every((p) => !/Jaguars|Ravens/i.test(p.text)),
  );

  t.section('prop slip: it reaches the form intact');
  const draft = SL.slipToDraft(SL.parseSlip(PROP_BET_CARD), 'DEGEN7');
  t.eq('the stake carries over', draft.stakeCents, 2221);
  t.eq('the payout carries over', draft.payoutCents, 7200);
  t.ok('and is marked as coming off the slip', draft.payoutAuto === false);
  t.eq('with all three legs', draft.picks.length, 3);
  t.ok('and no prices invented for them', draft.picks.every((p) => p.odds === ''));

  t.section('prop slip: it settles on the money alone');
  const stored = {
    id: 'L9', code: 'DEGEN7', uid: 'me', stakeCompCents: 2221, payoutCents: 7200, boostPct: 0,
    picks: draft.picks.map((p) => ({ text: p.text, league: 'nfl', odds: null })),
  };
  const ctx = { events: [], snapshots: [] };
  const open = DV.deriveLock(stored, ctx);
  t.eq('before kickoff it is pending', open.state, 'pending');
  t.eq('and it already knows what it pays', open.toWinCents, 7200);
  // Worked back from the money, since there are no prices to work from.
  t.eq('with the implied chance from the two figures', open.impliedPct, Math.round((2221 / 7200) * 1000) / 10);
  t.ok('and it says the book priced it', open.pricedByBook === true);

  const won = DV.deriveLock({ ...stored, overrides: { 0: G.STATE.WON, 1: G.STATE.WON, 2: G.STATE.WON } }, ctx);
  t.eq('all three landing wins it', won.state, 'won');
  // The bug this guards: keying the payout off whether a decimal could be
  // computed paid out null on a winning parlay.
  t.eq('and it pays exactly what the slip promised', won.returnCents, 7200);

  const lost = DV.deriveLock({ ...stored, overrides: { 0: G.STATE.LOST } }, ctx);
  t.eq('one miss loses it', lost.state, 'lost');
  t.eq('and it pays nothing', lost.returnCents, 0);

  // A leg falling out would have the book reprice, and with no leg prices
  // there is nothing to reprice by. Say so rather than overpay.
  const pushed = DV.deriveLock({ ...stored, overrides: { 0: G.STATE.PUSH, 1: G.STATE.WON, 2: G.STATE.WON } }, ctx);
  t.ok('a dropped leg is flagged for a human', pushed.needsReview === true);
  t.ok('and the flag says why', pushed.repricedByHand === true);
}

// ---------------------------------------------------------------------------
// A daily-fantasy slip, which is a different shape again
// ---------------------------------------------------------------------------

// Exactly what the vision model returned for a real PrizePicks entry, fence
// and blank lines included. Six picks across three games and two sports, the
// higher/lower choice printed nowhere, and a multiplier sitting between the
// payout label and the money.
const PRIZEPICKS_CARD = [
  '```',
  '14:06', '',
  'PRIZEPICKS', '',
  '6-Pick EARLY PAYOUT', '',
  'NFL JAC vs BAL Thu 7:15pm', '',
  'Brenton Strange', '36.5 Rec Yards', '',
  'Jakobi Meyers', '38.5 Rec Yards', '',
  'Trevor Lawrence', '233.5 Pass Yards', '',
  'NBA ORL vs PHX Thu 8:00pm', '',
  'Anthony Black', '15 Points', '',
  'Miles Bridges', '16.5 Points', '',
  'NBA MIA vs GSW Thu 9:00pm', '',
  'Stephen Curry', '27.5 Points', '',
  'Win contest or 6 of 6 picks', '',
  'Flex Play', 'Power Play ✓', '',
  'Entry fee', '$20', '',
  'To Win 26.5x', '$530', '',
  'Not enough balance. Tap below to deposit.', '',
  'Balance: Players $0 Teams $0', '',
  'Deposit Funds',
  '```',
].join('\n');

function testPrizePicks(t) {
  const s = SL.parseSlip(PRIZEPICKS_CARD);

  t.section('prizepicks: the money');
  t.eq('the entry fee is the stake', s.stakeCents, 2000);
  // The trap: "To Win 26.5x" sits above "$530". Taking the first number
  // after the label settles a $530 win at $26.50.
  t.eq('the payout is the money, not the multiplier', s.payoutCents, 53000);
  t.ok('which is emphatically not 26.5', s.payoutCents !== 2650);

  t.section('prizepicks: six picks across two sports');
  t.eq('all six are read', s.picks.length, 6);
  t.eq('and the slip agrees', s.declaredLegs, 6);
  t.eq('the picks, in order', s.picks.map((p) => p.text), [
    'Brenton Strange Over 36.5 Rec Yards',
    'Jakobi Meyers Over 38.5 Rec Yards',
    'Trevor Lawrence Over 233.5 Pass Yards',
    'Anthony Black Over 15 Points',
    'Miles Bridges Over 16.5 Points',
    'Stephen Curry Over 27.5 Points',
  ]);
  // Each section header sets the sport for the picks under it. One league
  // for the whole slip would send the basketball picks looking for a
  // quarterback and never find them.
  t.eq('each pick carries its own league', s.picks.map((p) => p.league),
    ['nfl', 'nfl', 'nfl', 'nba', 'nba', 'nba']);

  t.section('prizepicks: what the grader will look for');
  const want = s.picks.map((p) => {
    const sp = p.league === 'nba' ? 'basketball' : 'football';
    const q = R.parseLegText(p.text, sp);
    return [q.subjectRaw, q.stat, q.side, q.line];
  });
  t.eq('player, stat, side and line for every pick', want, [
    ['Brenton Strange', 'recYards', 'over', 36.5],
    ['Jakobi Meyers', 'recYards', 'over', 38.5],
    ['Trevor Lawrence', 'passYards', 'over', 233.5],
    ['Anthony Black', 'points', 'over', 15],
    ['Miles Bridges', 'points', 'over', 16.5],
    ['Stephen Curry', 'points', 'over', 27.5],
  ]);
  // A whole number is a real line here, not a typo for one with a half.
  t.eq('a whole-number line survives', R.parseLegText(s.picks[3].text, 'basketball').line, 15);

  t.section('prizepicks: the side is a guess, and says so');
  t.ok('every pick is marked as assumed', s.picks.every((p) => p.assumedSide === true));
  t.ok('and the slip warns about it', s.warnings.some((w) => /More or Less/i.test(w)));

  t.section('prizepicks: a Flex entry is refused, not guessed');
  // Flex pays on part of the card, on a scale the slip does not state.
  const flex = SL.parseSlip(PRIZEPICKS_CARD.replace('Power Play ✓', 'Power Play').replace('Flex Play', 'Flex Play ✓'));
  t.ok('a flex entry is called out', flex.warnings.some((w) => /Flex entry/i.test(w)));
  t.ok('and a power play entry is not', !s.warnings.some((w) => /Flex entry/i.test(w)));

  t.section('prizepicks: it reaches the form intact');
  const draft = SL.slipToDraft(s, 'DEGEN7');
  t.eq('with the stake', draft.stakeCents, 2000);
  t.eq('and the payout', draft.payoutCents, 53000);
  t.eq('and all six legs', draft.picks.length, 6);
  t.eq('each still in its own sport', draft.picks.map((p) => p.league),
    ['nfl', 'nfl', 'nfl', 'nba', 'nba', 'nba']);

  t.section('prizepicks: the line-movement arrow is decoration');
  // The app draws an arrow beside a number that has drifted. Read into the
  // number it would change the line being graded.
  const moved = SL.parseSlip([
    'NBA ORL vs PHX Thu 8:00pm', '', 'Miles Bridges', '▼ 16.5 Points', '',
    'Entry fee', '$5', '', 'To Win 3x', '$15',
  ].join('\n'));
  t.eq('the arrow does not reach the line', R.parseLegText(moved.picks[0].text, 'basketball').line, 16.5);
}

// ---------------------------------------------------------------------------
// A settled lock is still your lock
// ---------------------------------------------------------------------------

/**
 * Winning must never make a parlay disappear.
 *
 * It did. `summaryOnly` was set on any lock carrying a result, on the
 * assumption that a settled lock belonged to somebody else, and the views
 * filtered those out. Your own lock comes back from the server with a result
 * the moment it settles, so the instant one won it left your locks, your
 * wagered total and your profit, and the app told you that you had never
 * placed one.
 */
function testSettledStillYours(t) {
  const stored = {
    id: 'L1', code: 'DEGEN7', uid: 'me', weekKey: '2026-W45',
    stakeCompCents: 968, payoutCents: null, boostPct: 0,
    picks: [
      { text: 'Knicks ML', league: 'nba', odds: -150 },
      { text: 'Celtics ML', league: 'nba', odds: -200 },
    ],
    settledState: 'won', settledReturnCents: 2186, settledAt: 1762300000000,
  };
  const empty = { events: [], snapshots: [] };
  const d = DV.deriveLock(stored, empty);

  t.section('settled: it is still a lock');
  t.ok('it is not a bare summary row', d.summaryOnly !== true);
  t.eq('its legs are still there', d.legs.length, 2);
  t.eq('the stored result stands', d.state, 'won');
  t.eq('and so does the stored money', d.returnCents, 2186);
  t.eq('the stake is untouched', d.stakeCompCents, 968);
  t.ok('and it is marked final', d.roll.final === true);

  t.section('settled: it counts towards your record');
  // This is the number that read as zero on his screen.
  const rec = STS.recordOf([d]);
  t.eq('it counts as a lock', rec.bets, 1);
  t.eq('it counts as wagered', rec.stakedCents, 968);
  t.eq('it counts as a win', rec.won, 1);
  t.eq('and the profit is real', rec.profitCents, 2186 - 968);
  t.eq('with nothing left at risk', rec.atRiskCents, 0);

  t.section('settled: a device that never saw the games');
  t.ok('it says so', d.settledElsewhere === true);
  t.ok('it is not reported as live', d.live === false);
  t.ok('and not as needing review', d.needsReview === false);
  // A parlay pays only when its legs land, so a won one says they all did.
  t.eq('a won parlay shows every leg as hit', UI_pipState(d.legs[0], d), 'won');
  // A lost one does not say which leg killed it, so they stay unknown.
  const lost = DV.deriveLock({ ...stored, settledState: 'lost', settledReturnCents: 0 }, empty);
  t.eq('a lost one does not guess which leg went', UI_pipState(lost.legs[0], lost), 'open');
  t.eq('and its money is the stored zero', lost.returnCents, 0);

  t.section('settled: a row with no legs is still a summary');
  const bare = DV.deriveLock({ ...stored, picks: [] }, empty);
  t.ok('nothing to show but the result', bare.summaryOnly === true);
  t.eq('which is still right', bare.state, 'won');

  t.section('settled: a result is never re-derived');
  // The games are in the context and every leg reads as lost, but the stored
  // result says won. Stored wins: it was written when the games ended, and
  // the standings already counted it.
  const contrary = DV.deriveLock(
    { ...stored, overrides: { 0: G.STATE.LOST, 1: G.STATE.LOST } },
    empty,
  );
  t.eq('a contrary grading does not move it', contrary.state, 'won');
  t.eq('nor the money', contrary.returnCents, 2186);
}

// ---------------------------------------------------------------------------
// The folded card's pips
// ---------------------------------------------------------------------------

/**
 * A pip is the only thing a folded lock says about a leg, so it has to be
 * right about the one question worth asking: is this still alive.
 *
 * Clinched and dead are the cases that matter. A leg that cannot lose any
 * more has hit whatever the clock says, and one that cannot win is gone.
 * Showing either as merely "in progress" would paint a dead parlay as live.
 */
function testFoldedPips(t) {
  const leg = (verdict, snapState) => ({
    verdict,
    snapshot: snapState ? { state: snapState } : null,
  });

  t.section('folded card: what a pip says');
  t.eq('a won leg is green', UI_pipState(leg({ state: G.STATE.WON })), 'won');
  t.eq('a lost leg is red', UI_pipState(leg({ state: G.STATE.LOST })), 'lost');
  t.eq('a leg whose game is running is amber', UI_pipState(leg({ state: G.STATE.PENDING }, 'in')), 'live');
  t.eq('a leg whose game has not started is dim', UI_pipState(leg({ state: G.STATE.PENDING }, null)), 'open');
  t.eq('a finished game still pending is not live', UI_pipState(leg({ state: G.STATE.PENDING }, 'post')), 'open');

  t.section('folded card: clinched and dead');
  // The whole point: these are mid-game, so the state is still PENDING.
  t.eq(
    'a clinched leg reads as hit even while the game runs',
    UI_pipState(leg({ state: G.STATE.PENDING, clinched: true }, 'in')),
    'won',
  );
  t.eq(
    'and a dead one reads as missed rather than live',
    UI_pipState(leg({ state: G.STATE.PENDING, dead: true }, 'in')),
    'lost',
  );
  // Settled always wins over the in-progress flag.
  t.eq('a settled loss stays a loss', UI_pipState(leg({ state: G.STATE.LOST }, 'in')), 'lost');

  t.section('folded card: the rest');
  t.eq('a push is neither', UI_pipState(leg({ state: G.STATE.PUSH })), 'push');
  t.eq('a void is shown the same way', UI_pipState(leg({ state: G.STATE.VOID })), 'push');
  t.eq('one needing a look is its own colour', UI_pipState(leg({ state: G.STATE.REVIEW })), 'review');
  t.eq('a leg with no verdict does not throw', UI_pipState({}), 'open');
  t.eq('and neither does nothing at all', UI_pipState(null), 'open');
}

// ---------------------------------------------------------------------------
// Settling at the payout the slip promised
// ---------------------------------------------------------------------------

/**
 * The book's number is the money that changes hands, so it is the number
 * that settles.
 *
 * Taken from a real slip: $20.00 bought, a 20% boost, paid $201.20. The leg
 * prices multiply out to less than that, and settling from them would
 * short-change the bettor on every boosted ticket while looking confident.
 */
function testPromisedPayout(t) {
  t.section('payout: the slip wins');
  const stake = 2000;
  const dec = O.parlayDecimal([-110, 650]);
  const computed = O.totalReturnCents(stake, dec);

  t.ok('the leg prices alone come to something', computed > stake);
  t.eq('with no promise, the prices settle it', O.promisedReturnCents(stake, dec, dec, null), computed);
  t.eq('with a promise and nothing pushed, it pays exactly that', O.promisedReturnCents(stake, dec, dec, 20120), 20120);
  // The point of the whole exercise.
  t.ok('which the prices alone would have got wrong', computed !== 20120);

  t.section('payout: a pushed leg');
  // A push drops a leg and reprices the parlay, so the promised figure no
  // longer applies as written. What carries over is the ratio.
  const reduced = O.parlayDecimal([650]);
  const paid = O.promisedReturnCents(stake, dec, reduced, 20120);
  const plainReduced = O.totalReturnCents(stake, reduced);
  const ratio = (20120 - stake) / (computed - stake);
  t.eq(
    'the same boost applies to whatever price survived',
    paid,
    stake + Math.round((plainReduced - stake) * ratio),
  );
  t.ok('so it is not simply the promised figure again', paid !== 20120);
  t.ok('and the stake is never scaled, only the profit', paid > stake);

  t.section('payout: a boost is never applied to the stake');
  // A genuinely boosted slip, so the promise is above the price rather than
  // below it: 20% on the profit.
  const boosted = O.boostedReturnCents(stake, dec, 20);
  t.ok('a boost pays more than the price alone', boosted > computed);
  t.eq('and the slip figure reproduces it exactly', O.promisedReturnCents(stake, dec, dec, boosted), boosted);
  // The classic error is scaling the whole return rather than the profit,
  // which hands back the boost on the stake as well.
  const wrong = Math.round(computed * (boosted - stake) / (computed - stake));
  t.ok('scaling the total instead overpays', wrong > boosted);
  t.eq('by exactly the boost on the stake', wrong - boosted, Math.round(stake * 0.2));

  t.section('payout: degenerate cases');
  t.eq('no settled price, nothing to pay', O.promisedReturnCents(stake, dec, null, 20120), null);
  // A parlay that promised no profit tells us nothing about a ratio, so the
  // promise is taken at face value rather than divided by zero.
  t.eq('a parlay with no profit takes the promise as given', O.promisedReturnCents(stake, 1, 1, 2500), 2500);
  t.ok('and never returns NaN', Number.isFinite(O.promisedReturnCents(stake, 1, 1, 2500)));

  t.section('payout: through a whole lock');
  const mk = (over) => ({
    id: 'L1', code: 'X', uid: 'me', stakeCompCents: 2000, boostPct: 0,
    picks: [{ text: 'Packers ML', league: 'nfl', odds: -110 }],
    overrides: { 0: G.STATE.WON }, ...over,
  });
  const ctx = { events: [], snapshots: [] };
  const withPromise = DV.deriveLock(mk({ payoutCents: 20120 }), ctx);
  t.eq('a won lock pays what the slip promised', withPromise.returnCents, 20120);
  t.eq('and the card shows that as the full payout', withPromise.toWinCents, 20120);
  t.ok('and marks it boosted, because it beats the price', withPromise.boosted === true);

  const without = DV.deriveLock(mk({ payoutCents: null }), ctx);
  t.eq('without one it settles from the price', without.returnCents, O.totalReturnCents(2000, O.parlayDecimal([-110])));
  t.ok('and is not marked boosted', without.boosted === false);

  // Locks saved before the payout was recorded must keep settling the way
  // they were entered.
  const legacy = DV.deriveLock(mk({ payoutCents: null, boostPct: 20 }), ctx);
  t.eq('an old boost still settles', legacy.returnCents, O.boostedReturnCents(2000, O.parlayDecimal([-110]), 20));
  t.ok('and still reads as boosted', legacy.boosted === true);
}

// ---------------------------------------------------------------------------
// stats.js
// ---------------------------------------------------------------------------

/**
 * The record screen is read as fact, so its arithmetic is checked as such.
 *
 * The two mistakes that matter are dividing by money that has not come back
 * yet, which invents a loss, and counting one parlay under two sports, which
 * makes the rows add up to more than was ever wagered.
 */
function testStats(t) {
  const lock = (over) => ({
    id: over.id || 'L' + Math.random(),
    uid: 'me',
    stakeCompCents: 1000,
    returnCents: null,
    state: 'pending',
    picks: [{ text: 'a', league: 'nfl', odds: -110 }],
    ...over,
  });

  t.section('stats: the record');
  const r = STS.recordOf([
    lock({ state: 'won', stakeCompCents: 1000, returnCents: 2500 }),   // +1500
    lock({ state: 'lost', stakeCompCents: 1000, returnCents: 0 }),     // -1000
    lock({ state: 'push', stakeCompCents: 1000, returnCents: 1000 }),  // 0
    lock({ state: 'pending', stakeCompCents: 2000 }),                  // still running
  ]);
  t.eq('every lock is counted', r.bets, 4);
  t.eq('wagered is every stake, live ones included', r.stakedCents, 5000);
  t.eq('money still running is reported on its own', r.atRiskCents, 2000);
  t.eq('settled stake excludes it', r.settledStakeCents, 3000);
  t.eq('returns are what came back', r.returnedCents, 3500);
  t.eq('profit is returns minus the stakes that produced them', r.profitCents, 500);
  // The trap: dividing by all 5000 would read -30% on a winning record.
  t.ok('ROI divides by settled money only', Math.abs(r.roi - 500 / 3000) < 1e-9);
  t.eq('wins', r.won, 1);
  t.eq('losses', r.lost, 1);
  t.eq('a push is neither', r.push, 1);
  t.eq('open locks are counted', r.open, 1);
  t.ok('and a push is left out of the hit rate', Math.abs(r.winRate - 0.5) < 1e-9);

  t.section('stats: nothing settled yet');
  const open = STS.recordOf([lock({ state: 'pending', stakeCompCents: 500 })]);
  t.eq('ROI is unknown, not zero', open.roi, null);
  t.eq('and so is the hit rate', open.winRate, null);
  t.eq('profit is zero, because nothing has been decided', open.profitCents, 0);
  t.eq('an empty list does not throw', STS.recordOf([]).bets, 0);
  t.eq('and neither does nothing at all', STS.recordOf(null).bets, 0);

  t.section('stats: by sport');
  const nfl = (o) => lock({ picks: [{ text: 'a', league: 'nfl' }], ...o });
  const nba = (o) => lock({ picks: [{ text: 'a', league: 'nba' }], ...o });
  const both = (o) => lock({ picks: [{ text: 'a', league: 'nfl' }, { text: 'b', league: 'nba' }], ...o });
  const set = [
    nfl({ state: 'won', stakeCompCents: 1000, returnCents: 3000 }),
    nfl({ state: 'lost', stakeCompCents: 1000, returnCents: 0 }),
    nba({ state: 'lost', stakeCompCents: 2000, returnCents: 0 }),
    both({ state: 'won', stakeCompCents: 500, returnCents: 4000 }),
  ];
  t.eq('a single-sport parlay is filed under that sport', STS.sportOf(set[0]), 'nfl');
  t.eq('one spanning two is filed under mixed', STS.sportOf(set[3]), 'mixed');
  const rows = STS.bySport(set);
  t.eq('three buckets', rows.length, 3);
  // The invariant that makes the table trustworthy.
  t.eq(
    'the buckets add up to exactly what was wagered',
    rows.reduce((s, x) => s + x.stakedCents, 0),
    STS.recordOf(set).stakedCents,
  );
  t.eq(
    'and to exactly the same profit',
    rows.reduce((s, x) => s + x.profitCents, 0),
    STS.recordOf(set).profitCents,
  );
  const nflRow = rows.find((x) => x.key === 'nfl');
  t.eq('NFL staked', nflRow.stakedCents, 2000);
  t.eq('NFL profit', nflRow.profitCents, 1000);

  t.section('stats: by size');
  const sized = [
    lock({ state: 'lost', picks: [{ league: 'nfl' }], returnCents: 0 }),
    lock({ state: 'lost', picks: [{ league: 'nfl' }, { league: 'nfl' }], returnCents: 0 }),
    lock({ state: 'lost', picks: Array.from({ length: 7 }, () => ({ league: 'nfl' })), returnCents: 0 }),
    lock({ state: 'lost', picks: Array.from({ length: 6 }, () => ({ league: 'nfl' })), returnCents: 0 }),
  ];
  const buckets = STS.byLegCount(sized);
  t.ok('a single is its own bucket', buckets.some((b) => b.key === '1'));
  const big = buckets.find((b) => b.key === '6+');
  t.eq('six and seven legs share one bucket', big.bets, 2);

  t.section('stats: sorting');
  const sorted = STS.sortRows(rows, 'stakedCents', 'desc');
  t.ok('biggest first', sorted[0].stakedCents >= sorted[sorted.length - 1].stakedCents);
  const asc = STS.sortRows(rows, 'stakedCents', 'asc');
  t.eq('and the other way round', asc[0].stakedCents, sorted[sorted.length - 1].stakedCents);
  // A row with nothing settled has no ROI, and must not read as the worst.
  const withBlank = [...rows, { key: 'cbb', bets: 1, stakedCents: 100, profitCents: 0, roi: null }];
  t.eq('a row with no ROI sorts last going down', STS.sortRows(withBlank, 'roi', 'desc').pop().key, 'cbb');
  t.eq('and last going up too', STS.sortRows(withBlank, 'roi', 'asc').pop().key, 'cbb');
  t.eq('sorting nothing does not throw', STS.sortRows(null, 'roi').length, 0);

  t.section('stats: streaks');
  const seq = ['won', 'won', 'push', 'won', 'lost', 'lost'].map((s, i) => lock({
    state: s, settledAt: 1000 + i, returnCents: s === 'won' ? 2000 : s === 'push' ? 1000 : 0,
  }));
  const st = STS.streaks(seq);
  // A push sits between two wins and must not break the run.
  t.eq('a push does not break a run', st.longestWin, 3);
  t.eq('the longest losing run', st.longestLoss, 2);
  t.eq('and the current run is negative while losing', st.current, -2);
  t.eq('no settled locks, no streak', STS.streaks([]).current, 0);

  t.section('stats: highlights');
  const hl = STS.recordOf(set);
  t.eq('the biggest hit is the biggest profit', hl.best.profitCents, 3500);
  t.eq('the worst beat is the biggest loss', hl.worst.profitCents, -2000);

  t.section('stats: the whole report');
  const rep = STS.report(set);
  t.ok('it carries the overall record', rep.overall.bets === 4);
  t.ok('the sport rows', rep.sports.length === 3);
  t.ok('the size rows', rep.legCounts.length >= 1);
  t.ok('and the streaks', typeof rep.streaks.current === 'number');
}

// ---------------------------------------------------------------------------
// Pricing the entry form off the live board
// ---------------------------------------------------------------------------

/**
 * The quoted price has to belong to the side that was actually typed.
 *
 * This is the one place in the app where a silent error hands somebody the
 * wrong number and the app looks confident doing it: quoting the favorite's
 * -597 on a bet for the +443 underdog would misstate the payout of every
 * lock that took the price. So the side assignment is checked against every
 * game on a real board rather than one worked example.
 */
function testPricing(t, fx) {
  const events = E.eventsFromScoreboard(fx.nbaOddsBoard, 'nba');

  t.section('pricing: the board carries lines');
  t.ok('every game on this board is priced', events.length > 0 && events.every((e) => e.odds));
  t.ok('the book is named', events.every((e) => e.odds.provider));
  t.ok('both moneylines are there', events.every((e) => e.odds.moneyline.home !== null && e.odds.moneyline.away !== null));
  t.ok(
    'the two spread lines are opposite numbers',
    events.every((e) => {
      const s = e.odds.spread;
      return !s.home || !s.away || Math.abs(s.home.line + s.away.line) < 0.001;
    }),
  );
  t.ok(
    'over and under share one line',
    events.every((e) => e.odds.total.line === null || typeof e.odds.total.line === 'number'),
  );

  t.section('pricing: the quote matches the side typed');
  // Both sides of every game, by the name a person would actually type.
  let checkedML = 0;
  let wrongML = 0;
  let checkedSpread = 0;
  let wrongSpread = 0;
  for (const ev of events) {
    for (const side of ['home', 'away']) {
      const team = ev[side];
      // `shortName` is the nickname on its own ("Knicks"), which is how a slip
      // and a person both write it.
      const q = SL.suggestOdds(`${team.shortName} ML`, 'nba', events);
      if (q && !q.unavailable) {
        checkedML++;
        if (q.odds !== ev.odds.moneyline[side]) wrongML++;
      }
      const sp = ev.odds.spread[side];
      if (sp && sp.line !== null) {
        const typed = `${team.shortName} ${sp.line > 0 ? '+' : ''}${sp.line}`;
        const qs = SL.suggestOdds(typed, 'nba', events);
        if (qs && !qs.unavailable) {
          checkedSpread++;
          if (qs.odds !== sp.odds || qs.line !== sp.line) wrongSpread++;
        }
      }
    }
  }
  t.ok(`moneylines were quoted (${checkedML} of ${events.length * 2})`, checkedML >= events.length);
  t.eq('and every one is the price for that exact team', wrongML, 0);
  t.ok(`spreads were quoted (${checkedSpread})`, checkedSpread > 0);
  t.eq('and every one is that team\'s line and price', wrongSpread, 0);

  t.section('pricing: game totals');
  // A total names no side, so the game comes from the matchup in the text.
  const ny = events.find((e) => (e.shortName || '').includes('NY'));
  if (ny) {
    const line = ny.odds.total.line;
    const q = SL.suggestOdds(`${ny.away.shortName} vs ${ny.home.shortName} Over ${line}`, 'nba', events);
    t.ok('a "vs" matchup finds its game', !!q && q.event === ny.shortName);
    t.eq('and quotes the over', q && q.odds, ny.odds.total.over);
    t.eq('at the book\'s line', q && q.line, line);
    const u = SL.suggestOdds(`${ny.away.shortName}/${ny.home.shortName} Under ${line}`, 'nba', events);
    t.eq('a slash matchup quotes the under', u && u.odds, ny.odds.total.under);
    const abbr = SL.suggestOdds(`${ny.shortName} Over ${line}`, 'nba', events);
    t.ok('and abbreviations work too', !!abbr && abbr.event === ny.shortName);
  }
  // With a full slate and no matchup named, there is nothing to quote: a
  // total pinned to the wrong game would look just as authoritative.
  t.eq('a bare total on a full slate quotes nothing', SL.suggestOdds('Over 220.5', 'nba', events), null);
  t.ok(
    'but a one-game slate is unambiguous',
    (() => {
      const one = events.slice(0, 1);
      const q = SL.suggestOdds(`Over ${one[0].odds.total.line}`, 'nba', one);
      return !!q && q.odds === one[0].odds.total.over;
    })(),
  );

  t.section('pricing: a matchup is not a side');
  // Naming both teams pins the game but not the team, and a moneyline has to
  // be graded for one of them.
  if (ny) {
    const both = `${ny.away.shortName} vs ${ny.home.shortName}`;
    const r = R.resolveLeg({ rawText: both }, { league: 'nba', events, snapshots: [] });
    t.eq('a two-team moneyline does not resolve', r.teamAbbr, undefined);
    t.eq('but the game it belongs to is known', r.eventId, ny.eventId);
    t.ok('and the reason says why', /both teams/.test(r.reason || ''));
    t.eq('nothing is quoted for it', SL.suggestOdds(both + ' ML', 'nba', events), null);
  }

  t.section('pricing: what the feed does not carry');
  const prop = SL.suggestOdds('Jalen Brunson Over 24.5 Points', 'nba', events);
  t.ok('a player prop is reported unavailable', !!prop && prop.unavailable === true);
  t.ok('with a reason to show', /player prop/i.test((prop && prop.reason) || ''));
  const tt = SL.suggestOdds('Knicks Over 115.5', 'nba', events);
  t.ok('a team total is reported unavailable', !!tt && tt.unavailable === true);
  t.ok('and says so specifically', /team total/i.test((tt && tt.reason) || ''));

  t.section('pricing: a typed line that is not the book\'s');
  if (ny) {
    const sp = ny.odds.spread.home;
    if (sp && sp.line !== null) {
      const off = sp.line + 1; // a stale number off the slip
      const q = SL.suggestOdds(`${ny.home.shortName} ${off > 0 ? '+' : ''}${off}`, 'nba', events);
      t.ok('the mismatch is flagged', !!q && q.lineMismatch === true);
      t.eq('the book\'s line is what gets quoted', q && q.line, sp.line);
      t.eq('and the typed one is kept to show', q && q.typedLine, off);
    }
  }

  t.section('pricing: nothing to price against');
  t.eq('no events, no quote', SL.suggestOdds('Knicks ML', 'nba', []), null);
  t.eq('a league with no games on the board', SL.suggestOdds('Packers ML', 'nfl', events), null);
  t.eq('unparseable text', SL.suggestOdds('asdf', 'nba', events), null);
  t.eq('empty text', SL.suggestOdds('', 'nba', events), null);
  t.ok('and none of that throws', true);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * fixtures: { nfl, nba, cfb, nflBoard, nbaOddsBoard } of parsed ESPN JSON.
 * Returns { results, passed, failed, ms }.
 */
export function runAll(fixtures) {
  const t = makeHarness();
  const t0 = Date.now();
  testOdds(t);
  const snaps = testEspn(t, fixtures);
  testResolve(t, snaps);
  testGrade(t, snaps);
  testParlay(t);
  testLeague(t);
  testStore(t, snaps);
  testSlip(t);
  testPropSlip(t);
  testPrizePicks(t);
  testSettledStillYours(t);
  testFoldedPips(t);
  testPromisedPayout(t);
  testStats(t);
  testPricing(t, fixtures);
  const ms = Date.now() - t0;
  const passed = t.results.filter((r) => r.pass).length;
  return { results: t.results, passed, failed: t.results.length - passed, ms };
}

/** Console reporter, used by the node runner. */
export function report(fixtures) {
  const { results, passed, failed, ms } = runAll(fixtures);
  let last = '';
  for (const r of results) {
    if (r.section !== last) { console.log(`\n${r.section}`); last = r.section; }
    console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? '  <- ' + r.detail : ''}`);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} checks in ${ms}ms`);
  return failed === 0;
}
