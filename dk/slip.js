// slip.js: turn the text of a bet slip into a draft lock. Pure.
//
// The division of labour here is deliberate. A vision model does the one thing
// models are genuinely good at, reading pixels into text. Everything after
// that is this file: deterministic, offline, and testable against real slip
// transcripts. A second model call to "extract JSON" would be less accurate,
// slower, impossible to test, and would drift with every model version.
//
// Nothing here is trusted. The output prefills the entry form, which the
// person then checks before anything is saved, so a misread line costs a tap
// rather than a wrong settlement.

import { parseLegText, matchStat, resolveTeam } from './resolve.js';
import { parseAmerican } from './odds.js';
import { LEAGUES, priceFor } from './espn.js';

/** Money, in cents, from "$1,234.56" / "1234.56" / "$25". */
export function parseMoney(text) {
  const m = /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(String(text || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Books label the same two numbers a dozen ways. Order matters: the more
// specific label has to win, so "total payout" is tested before "total".
const STAKE_LABELS = [
  /\b(?:bought|wager(?:ed)?|stake|risk(?:ing|ed)?|bet\s*amount|amount\s*bet)\b\s*:?\s*\$?\s*([\d.,]+)/i,
  /\$?\s*([\d.,]+)\s*\b(?:wager|stake|bet)\b/i,
];
const PAYOUT_LABELS = [
  /\b(?:total\s*payout|paid|payout|to\s*win|to\s*return|potential\s*(?:win|payout|return)|returns?)\b\s*:?\s*\$?\s*([\d.,]+)/i,
];

/** Lines that are chrome, not content. Dropping them cuts false leg matches. */
const NOISE = [
  /^\s*$/,
  /^(?:draft\s*kings|draftkings|fanduel|bet\s*mgm|betmgm|caesars|espn\s*bet|fanatics|pointsbet)\s*$/i,
  /^(?:my\s*)?(?:bets?|trades?|activity|open|settled|live|won|lost|all)\s*$/i,
  /^(?:share|hide\s*legs|show\s*legs|position\s*information|details?|cash\s*out)\b/i,
  /^(?:final|live|scheduled|q[1-4]|halftime|ot)\b\s*$/i,
  /^placed\s*:/i,
  /^\s*[\d.,$%+-]+\s*$/, // a bare number on its own line
  /^(?:deposit|rewards|search|home)\s*$/i,
];

const isNoise = (line) => NOISE.some((re) => re.test(line.trim()));

/**
 * A trailing American price on a leg line: "Tucker Kraft Anytime TD  +260".
 * Anchored to the end so a line's own numbers (a yardage line, a date) are
 * not mistaken for odds.
 */
const TRAILING_ODDS = /\s[(\[]?([+-]\d{3,5})[)\]]?\s*$/;

/** How many legs the slip says it has: "4 Pick Combo", "3 Leg Parlay". */
export function declaredLegCount(text) {
  const m = /\b(\d{1,2})\s*(?:pick|leg|team|selection)s?\b/i.exec(String(text || ''));
  return m ? parseInt(m[1], 10) : null;
}

/** A profit boost the slip advertises: "10% Boost", "Profit Boost 25%". */
export function declaredBoost(text) {
  const m = /\b(\d{1,3})\s*%\s*(?:profit\s*)?boost\b/i.exec(String(text || ''))
    || /\bboost(?:ed)?\b[^%\d]{0,12}(\d{1,3})\s*%/i.exec(String(text || ''));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Guess which league a slip is about, from team and league words.
 *
 * Only a guess: the entry form shows a per-leg league selector so a wrong
 * one is a tap to fix. Getting it right most of the time is worth more than
 * being clever.
 */
export function guessLeague(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(nba|lakers|celtics|warriors|knicks|heat|bucks|nuggets|thunder|76ers|sixers)\b/.test(t)) return 'nba';
  if (/\b(ncaab|cbb|college basketball)\b/.test(t)) return 'cbb';
  if (/\b(ncaaf|cfb|college football)\b/.test(t)) return 'cfb';
  if (/\b(nhl|hockey)\b/.test(t)) return 'nhl';
  if (/\b(mlb|baseball)\b/.test(t)) return 'mlb';
  // Football words that basketball does not share.
  if (/\b(nfl|touchdown|passing|rushing|receiving|reception|field\s*goal|quarterback)\b/.test(t)) return 'nfl';
  if (/\b(points|rebounds|assists|threes|3-?pointers)\b/.test(t)) return 'nba';
  return 'nfl';
}

/**
 * Read a whole slip.
 *
 * Returns a draft the entry form can take directly:
 *   { stakeCents, payoutCents, boostPct, picks, declaredLegs, warnings }
 *
 * `warnings` is the honest part. Anything uncertain is said out loud rather
 * than guessed at, because the person is about to check this anyway and a
 * flagged doubt is cheaper than a confident mistake.
 */
export function parseSlip(raw) {
  // Models like to wrap a transcription in a markdown fence even when told
  // not to. Observed from a real run, so it is stripped rather than argued
  // with in the prompt.
  const text = String(raw || '')
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '');
  const all = text.split(/\r?\n/);
  const warnings = [];

  // Money first, from the whole text, so a label and its number split across
  // two lines still match.
  const flat = all.join(' \n ');
  let stakeCents = null;
  for (const re of STAKE_LABELS) {
    const m = re.exec(flat);
    if (m) { stakeCents = parseMoney(m[1]); break; }
  }
  let payoutCents = null;
  for (const re of PAYOUT_LABELS) {
    const m = re.exec(flat);
    if (m) { payoutCents = parseMoney(m[1]); break; }
  }

  const boostPct = declaredBoost(text);
  const declaredLegs = declaredLegCount(text);
  const league = guessLeague(text);
  const sport = (LEAGUES[league] || {}).sport || 'football';

  // Now the legs. A line is a leg if the parser recognizes a market in it,
  // which reuses exactly the same code that grades them later.
  const picks = [];
  const lines = all.map((l) => l.replace(/\s+/g, ' ').trim());

  const BARE_ODDS = /^\s*[(\[]?([+-]\d{3,5})[)\]]?\s*$/;
  const isMoneyLine = (l) => STAKE_LABELS.some((re) => re.test(l)) || PAYOUT_LABELS.some((re) => re.test(l));

  /** Split a line into its selection text and any trailing price. */
  const splitOdds = (l) => {
    const m = TRAILING_ODDS.exec(l);
    return m
      ? { body: l.slice(0, m.index).trim(), odds: parseAmerican(m[1]) }
      : { body: l, odds: null };
  };

  /**
   * A line that names a market but no selection: "To Win", "Anytime TD
   * Scorer", "Over 44.5". Books put these UNDER the selection, which is the
   * layout every screenshot of a real slip uses, so these have to be joined
   * onto the line above rather than read on their own.
   */
  const isMarketLabel = (l) => {
    if (!l || BARE_ODDS.test(l)) return false;
    const p = parseLegText(splitOdds(l).body, sport);
    return !!p.market && !p.subjectRaw;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || isNoise(line) || isMoneyLine(line)) continue;

    let { body, odds } = splitOdds(line);
    let consumed = 1;

    /* Whether this line is already a whole bet on its own.
     *
     * The catch is that a bare name parses as a moneyline, so "Derrick Henry"
     * looks complete when it is really the first half of a two-line leg. It
     * only counts as a moneyline if the line actually says so. Without this
     * distinction, either every two-line leg loses its player name, or a
     * self-contained line like "Total Points Over 44.5" gets swallowed into
     * the leg above it. */
    const own = parseLegText(body, sport);
    const bareName = own.market === 'moneyline' && !/\b(to\s*win|moneyline|money\s*line|\bml\b)\b/i.test(body);
    const ownComplete = !!own.market && !bareName && (!!own.subjectRaw || own.market === 'game_total');

    // Selection on this line, market on the next: join them and take both.
    const next = lines[i + 1] || '';
    if (!ownComplete && !isNoise(next) && !isMoneyLine(next) && isMarketLabel(next)) {
      const n = splitOdds(next);
      const joined = parseLegText(`${body} ${n.body}`, sport);
      if (joined.market) {
        body = `${body} ${n.body}`;
        if (odds === null) odds = n.odds;
        consumed = 2;
      }
    }

    const parsed = parseLegText(body, sport);
    if (!parsed.market) continue;

    // A bare name parses as a moneyline, which is right when the slip said
    // "To Win" underneath and wrong for a stray word. With no market wording
    // and no price, there is not enough here to call it a bet.
    if (parsed.market === 'moneyline' && consumed === 1 && odds === null
        && !/\b(to\s*win|moneyline|money\s*line|\bml\b)\b/i.test(line)) {
      continue;
    }

    // The price often sits alone on the line after the leg.
    if (odds === null) {
      const after = lines[i + consumed] || '';
      const m = BARE_ODDS.exec(after);
      if (m) odds = parseAmerican(m[1]);
    }

    picks.push({ text: body, league, odds });
    i += consumed - 1;
  }

  if (!picks.length) warnings.push('No selections were recognized. Type them in instead.');
  if (declaredLegs && picks.length && declaredLegs !== picks.length) {
    warnings.push(`The slip says ${declaredLegs} picks but ${picks.length} were read. Check for a missing leg.`);
  }
  if (stakeCents === null) warnings.push('Could not find the stake.');
  if (picks.some((p) => p.odds === null)) warnings.push('Some leg prices are missing.');

  return {
    stakeCents,
    payoutCents,
    boostPct: boostPct || 0,
    league,
    picks,
    declaredLegs,
    warnings,
  };
}

/**
 * Look up the real price for a typed leg, so nobody has to know the Knicks
 * are -220 tonight.
 *
 * Only game-level markets can be answered: the score feed carries a book's
 * moneyline, spread and total, and nothing else. Player props are not in it
 * at any price, so those come back as `unavailable` and the form says so
 * rather than leaving a blank box looking broken.
 *
 * The line is returned alongside the price because a spread or total written
 * without one ("Celtics spread") is only meaningful once it says -11.5, and
 * because a typed line that disagrees with the book's is worth showing.
 */
export function suggestOdds(text, league, events) {
  const sport = (LEAGUES[league] || {}).sport || 'football';
  const parsed = parseLegText(String(text || ''), sport);
  if (!parsed.market) return null;

  const pool = (events || []).filter((e) => e.league === league);
  if (!pool.length) return null;

  // The free feed carries exactly three markets: both sides of the
  // moneyline, both sides of the spread, and the game total. Everything else
  // says so outright, because an empty price box with no explanation reads as
  // a broken app rather than a limit of the data.
  const GAME_MARKETS = new Set(['moneyline', 'spread', 'game_total']);
  if (!GAME_MARKETS.has(parsed.market)) {
    return {
      unavailable: true,
      market: parsed.market,
      reason: parsed.market === 'team_total'
        ? 'Team totals are not in the free odds feed.'
        : 'Player prop prices are not in the free odds feed.',
    };
  }

  let event = null;
  let teamAbbr = null;
  if (parsed.market === 'game_total') {
    // A total has no side to pick, so the game comes from the matchup the
    // text names, if it named one ("Knicks vs Bulls Over 233.5"). Otherwise
    // it is only unambiguous when a single game on the slate is priced:
    // quoting a total against the wrong game would be worse than quoting
    // nothing, because the number looks authoritative either way.
    if (parsed.subjectRaw) {
      const t = resolveTeam(parsed.subjectRaw, pool);
      event = t.eventId ? pool.find((e) => e.eventId === t.eventId) || null : null;
    }
    if (!event) {
      const withOdds = pool.filter((e) => e.odds && e.odds.total && e.odds.total.line !== null);
      if (withOdds.length !== 1) return null;
      event = withOdds[0];
    }
  } else {
    const t = resolveTeam(parsed.subjectRaw, pool);
    // No side means the text named both teams, and a moneyline or spread
    // price belongs to one of them. Nothing to quote.
    if (!t.eventId || !t.teamAbbr) return null;
    event = pool.find((e) => e.eventId === t.eventId) || null;
    teamAbbr = t.teamAbbr;
  }
  if (!event || !event.odds) return null;

  const got = priceFor(event, { market: parsed.market, side: parsed.side, teamAbbr });
  if (got === null || got === undefined) return null;

  const odds = typeof got === 'number' ? got : got.odds;
  const line = typeof got === 'number' ? null : got.line;
  if (odds === null || odds === undefined) return null;

  return {
    odds,
    line,
    market: parsed.market,
    side: parsed.side,
    teamAbbr,
    provider: event.odds.provider,
    event: event.shortName || event.name,
    startAt: event.startAt,
    // A typed line that is not the book's current one is worth flagging: the
    // price belongs to the book's number, not the one in the text.
    lineMismatch: parsed.line !== null && parsed.line !== undefined && line !== null
      && Math.abs(Math.abs(parsed.line) - Math.abs(line)) > 0.001,
    typedLine: parsed.line === undefined ? null : parsed.line,
  };
}

/**
 * Turn a parsed slip into the shape the entry form holds, so the screenshot
 * path and the typed path converge on the same editable draft.
 */
export function slipToDraft(slip, code) {
  return {
    code,
    stakeCents: slip.stakeCents || 1000,
    boostPct: slip.boostPct || 0,
    picks: slip.picks.length
      ? slip.picks.map((p) => ({ text: p.text, league: p.league, odds: p.odds === null ? '' : String(p.odds) }))
      : [{ text: '', league: slip.league || 'nfl', odds: '' }],
  };
}
