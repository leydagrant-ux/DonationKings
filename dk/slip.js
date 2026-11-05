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
import { parseAmerican, parlayDecimal, totalReturnCents } from './odds.js';
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
  // A share card labels the stake "Total". The dollar sign is required, so
  // this can never swallow a game total: "Total Points Over 44.5" has none.
  /\btotal\b\s*:?\s*\$\s*([\d.,]+)/i,
  /\bentry\s*fee\b\s*:?\s*\$?\s*([\d.,]+)/i, // PrizePicks
];

/* The payout, with one trap in it.
 *
 * PrizePicks writes "To Win 26.5x" above "$530": a multiplier and then the
 * money. Taking the first number after the label reads the payout as $26.50
 * and would settle a $530 win at a twentieth of it. So the dollar sign is
 * looked for first, across the short gap a multiplier occupies, and only if
 * there is no dollar figure at all is a bare number accepted, and then never
 * one that is itself a multiplier. */
const PAYOUT_LABELS = [
  /\b(?:total\s*payout|paid|payout|to\s*pay|to\s*win|to\s*return|potential\s*(?:win|payout|return)|returns?)\b[^$]{0,24}?\$\s*([\d.,]+)/i,
  /\b(?:total\s*payout|paid|payout|to\s*pay|to\s*win|to\s*return|potential\s*(?:win|payout|return)|returns?)\b\s*:?\s*([\d.,]+)(?!\s*x\b)/i,
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
  /^(?:sell|buy|trade\s*placed)\s*$/i,
  /^\d+\s*pick\s*combo\b/i, // the title line, which names no selection
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

  /**
   * An alt line printed on its own: "60+", "2+".
   *
   * The books put the threshold on the headline and the player and stat
   * underneath, so this is half a leg, not a stray number. It has to be
   * rescued from the bare-number noise rule, which was eating it and taking
   * the rest of the leg with it.
   */
  const isThreshold = (l) => /^\d+(?:\.\d+)?\s*\+$/.test(String(l || '').trim());

  /**
   * The matchup line a slip prints under each selection, like
   * "JAX Jaguars @ BAL Ravens".
   *
   * It is context, not a selection. Read as one it became the subject of the
   * leg below it, so a parlay came out as "JAX Jaguars @ BAL Ravens Anytime
   * TD Scorer" with the player's name thrown away.
   */
  const isGameLabel = (l) => {
    const s = String(l || '').trim();
    if (!s || isThreshold(s)) return false;
    if (!/\s(?:@|vs\.?|v\.?|at)\s/i.test(s)) return false;
    return !parseLegText(s, sport).market;
  };

  /**
   * A section header: "NFL JAC vs BAL Thu 7:15pm".
   *
   * These group the picks below them, and on a daily-fantasy slip they are
   * the ONLY statement of which sport each pick belongs to. A six-pick entry
   * can be half football and half basketball, and reading one league for the
   * whole slip sends the basketball picks looking for a quarterback.
   */
  const sectionLeague = (l) => {
    const m = /^(nfl|nba|cbb|cfb|ncaaf|ncaab|college\s*football|college\s*basketball)\b/i
      .exec(String(l || '').trim());
    if (!m) return null;
    const k = m[1].toLowerCase().replace(/\s+/g, '');
    if (k === 'ncaaf' || k === 'collegefootball') return 'cfb';
    if (k === 'ncaab' || k === 'collegebasketball') return 'cbb';
    return LEAGUES[k] ? k : null;
  };

  /**
   * A line that is a number and a stat, with no player: "36.5 Rec Yards",
   * "15 Points". The player is on the line above.
   *
   * The arrow is a line-movement marker the app draws next to a number that
   * has drifted; it is decoration and must not end up in the number.
   */
  const lineAndStat = (l, lg) => {
    const m = /^[▲▼↑↓]?\s*(\d+(?:\.\d+)?)\s+(.+)$/.exec(String(l || '').trim());
    if (!m) return null;
    const sp = (LEAGUES[lg] || {}).sport || sport;
    return matchStat(m[2], sp) ? { line: m[1], stat: m[2] } : null;
  };

  /** Chrome, or a matchup line: either way it is not part of a selection. */
  const skippable = (l) => !l || isGameLabel(l) || (isNoise(l) && !isThreshold(l));

  /** The next line that actually carries something. */
  const nextContent = (from) => {
    let j = from;
    while (j < lines.length && skippable(lines[j])) j++;
    return j;
  };

  /**
   * Put a lone threshold back where it belongs, between the player and the
   * stat: "60+" over "Bhayshul Tuten Rushing Yards" is one leg reading
   * "Bhayshul Tuten 60+ Rushing Yards".
   *
   * The split is found by trying every position and keeping the longest
   * player name that still leaves a stat the grader recognizes. Longest
   * first matters: splitting after "Bhayshul" also parses, and would file
   * the bet under a player who does not exist.
   */
  const composeThreshold = (thresh, marketLine) => {
    const words = String(marketLine || '').trim().split(/\s+/);
    for (let k = words.length - 1; k >= 1; k--) {
      const cand = `${words.slice(0, k).join(' ')} ${thresh} ${words.slice(k).join(' ')}`;
      const p = parseLegText(cand, sport);
      if (p.market && p.subjectRaw && p.stat) return cand;
    }
    return null;
  };

  // The league in force for the picks below, which a section header changes
  // as the slip goes down. Starts as the whole-slip guess, which is all a
  // single-sport slip ever needs.
  let current = league;
  let assumedSide = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sec = sectionLeague(line);
    if (sec) { current = sec; continue; }

    if (skippable(line) || isMoneyLine(line)) continue;

    let { body, odds } = splitOdds(line);
    let consumed = 1;

    // The daily-fantasy layout: a player's name, then the number and the
    // stat on the line under it. There is no "over" or "under" printed
    // anywhere, because the choice lives in a pair of buttons the
    // transcription cannot see, so it is read as the higher side and the
    // slip is flagged for a human to check.
    if (!parseLegText(body, sport).stat) {
      const j = nextContent(i + 1);
      const ls = lineAndStat(lines[j], current);
      if (ls && !/\d/.test(body)) {
        const text = `${body} Over ${ls.line} ${ls.stat}`;
        const p = parseLegText(text, (LEAGUES[current] || {}).sport || sport);
        if (p.market && p.subjectRaw && p.stat) {
          picks.push({ text, league: current, odds, assumedSide: true });
          assumedSide = true;
          i = j;
          continue;
        }
      }
    }

    // A threshold headline takes its player and stat from the line below,
    // which may be a matchup line away.
    if (isThreshold(body)) {
      const j = nextContent(i + 1);
      const target = lines[j];
      const n = target ? splitOdds(target) : null;
      const composed = n ? composeThreshold(body, n.body) : null;
      if (composed) {
        picks.push({ text: composed, league: current, odds: odds !== null ? odds : n.odds });
        i = j;
        continue;
      }
      continue; // a stray number after all
    }

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
    // The two can be separated by the matchup line, which is why this looks
    // for the next line with content rather than simply the next line.
    const j = nextContent(i + 1);
    const next = lines[j] || '';
    if (!ownComplete && next && !isMoneyLine(next) && isMarketLabel(next)) {
      const n = splitOdds(next);
      const joined = parseLegText(`${body} ${n.body}`, sport);
      if (joined.market) {
        body = `${body} ${n.body}`;
        if (odds === null) odds = n.odds;
        consumed = (j - i) + 1;
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

    picks.push({ text: body, league: current, odds });
    i += consumed - 1;
  }

  if (!picks.length) warnings.push('No selections were recognized. Type them in instead.');
  if (declaredLegs && picks.length && declaredLegs !== picks.length) {
    warnings.push(`The slip says ${declaredLegs} picks but ${picks.length} were read. Check for a missing leg.`);
  }
  if (stakeCents === null) warnings.push('Could not find the stake.');
  // Missing leg prices are not a problem in themselves. A player-prop slip
  // prints none at all, and it does not need to: what was bought and what it
  // pays settle the lock between them. It is only a problem when the payout
  // is missing too, because then there is nothing to settle it with.
  if (payoutCents === null && picks.some((p) => p.odds === null)) {
    warnings.push('No payout and no leg prices, so this cannot be settled. Add what it pays if it hits.');
  }
  if (payoutCents === null && picks.length) warnings.push('Could not find the payout.');

  // The higher/lower choice on a daily-fantasy slip lives in a pair of
  // buttons, not in any text, so a transcription cannot see which way each
  // pick went. Reading them all as the higher side is a guess, and a guess
  // about money has to be said out loud rather than buried.
  if (assumedSide) {
    warnings.push('This slip does not print More or Less in words, so every pick was read as More. Change any that were Less before saving.');
  }

  // Flex pays out on some of the picks landing rather than all of them, on a
  // sliding scale the slip does not state. Graded all-or-nothing it would
  // call a paying entry a loss, so it is refused rather than guessed at.
  if (/flex\s*play[^\n]*[✓✔]|[✓✔][^\n]*flex\s*play/i.test(text)) {
    warnings.push('This is a Flex entry, which pays on part of the card. Only an all-or-nothing entry is graded here, so enter what it actually paid when it settles.');
  }

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
  const payout = slip.payoutCents === null || slip.payoutCents === undefined ? null : slip.payoutCents;
  return {
    code,
    stakeCents: slip.stakeCents || 1000,
    // Straight off the slip, so it is not recomputed from the leg prices.
    // On a player-prop slip there are no leg prices to recompute it from,
    // and this is the figure that settles the lock.
    payoutCents: payout,
    payoutAuto: payout === null,
    boostPct: slip.boostPct || 0,
    picks: slip.picks.length
      ? slip.picks.map((p) => ({ text: p.text, league: p.league, odds: p.odds === null ? '' : String(p.odds) }))
      : [{ text: '', league: slip.league || 'nfl', odds: '' }],
  };
}

/**
 * Fill in every price the book will tell us, and leave typed ones alone.
 *
 * The price is applied rather than offered. Tapping a button to accept a
 * number the app already knew was a step with no decision in it: there is
 * only one current price, and it is the book's.
 *
 * What makes that safe is the `oddsAuto` flag. A price this function wrote
 * is ours to replace when the selection changes; a price a person typed is
 * theirs and is never overwritten, because their slip is the authority on
 * what they were actually given. That matters for a boosted or stale price,
 * where the book's current number is not the number they got.
 */
export function autoprice(draft, events) {
  if (!draft || !Array.isArray(draft.picks)) return draft;
  let changed = false;

  const picks = draft.picks.map((p) => {
    const typed = String(p.odds === undefined || p.odds === null ? '' : p.odds).trim();
    if (typed && !p.oddsAuto) return p; // theirs, hands off

    const q = suggestOdds(p.text, p.league, events);
    const has = q && !q.unavailable && q.odds !== null && q.odds !== undefined;
    const want = has ? String(q.odds) : '';

    if (!want) {
      // The selection changed to something the feed cannot price. A stale
      // auto price left behind would quietly belong to the previous leg.
      if (p.oddsAuto && typed) { changed = true; return { ...p, odds: '', oddsAuto: false }; }
      return p;
    }
    if (want === typed) return p;
    changed = true;
    return { ...p, odds: want, oddsAuto: true };
  });

  return changed ? { ...draft, picks } : draft;
}

/**
 * Keep the payout in step with the legs, until somebody corrects it.
 *
 * Same rule as the prices: a figure this computed is ours to recompute, a
 * figure typed from a slip is theirs and is left exactly alone. That is the
 * whole point of letting it be typed. The leg prices cannot reproduce what a
 * book pays on a boosted or same-game slip, so when the two disagree the
 * slip is right and the arithmetic is wrong.
 */
export function repayout(draft) {
  if (!draft || !Array.isArray(draft.picks)) return draft;
  const has = draft.payoutCents !== null && draft.payoutCents !== undefined;
  if (has && !draft.payoutAuto) return draft; // typed from a slip

  const odds = draft.picks.map((p) => parseAmerican(p.odds));
  if (!odds.length || odds.some((o) => o === null)) {
    // Not every leg is priced yet, so there is no payout to show.
    return has ? { ...draft, payoutCents: null, payoutAuto: true } : draft;
  }

  const want = totalReturnCents(draft.stakeCents, parlayDecimal(odds));
  if (want === draft.payoutCents) return draft;
  return { ...draft, payoutCents: want, payoutAuto: true };
}
