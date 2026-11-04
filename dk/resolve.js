// resolve.js: turn a leg's wording into concrete identifiers.
//
// Pure: everything takes already-fetched, already-normalized data. The only
// inputs are a leg and a slate (events and, where available, snapshots).
//
// Two jobs:
//   parseLegText  text  ->  { market, stat, side, line, subjectRaw }
//   resolveLeg    that  ->  { eventId, teamAbbr, athleteId, stat, confidence }
//
// Anything this file is not sure about comes back with low confidence and a
// reason, and the caller sends the leg to review rather than grading a guess.
// That is the whole design: be certain or be honest.

import { normName, LEAGUES } from './espn.js';

/** Confidence levels, named so the thresholds are not magic numbers. */
export const C = {
  EXACT: 1.0, //  full name matched one player
  INITIAL: 0.9, //  last name plus first initial matched one player
  LAST_ONLY: 0.75, //  last name matched exactly one player on the slate
  AMBIGUOUS: 0.4, //  several candidates; a human has to pick
  NONE: 0.0, //  nothing matched
};

/** At or above this, grade it. Below, ask. */
export const AUTO_GRADE_MIN = C.LAST_ONLY;

// ---------------------------------------------------------------------------
// Market and stat vocabulary
// ---------------------------------------------------------------------------
//
// Books word the same market a dozen ways. These tables are ordered: the most
// specific phrasing has to win, so "passing touchdowns" is tested before
// "touchdowns" and "points + rebounds + assists" before "points".

const FOOTBALL_STAT_PHRASES = [
  [/\b(pass(ing)?\s*\+\s*rush(ing)?\s*yards?|pass\s*&\s*rush\s*yards?)\b/, 'passRushYards'],
  [/\b(rush(ing)?\s*\+\s*rec(eiving)?\s*yards?|rush\s*&\s*rec\s*yards?|scrimmage\s*yards?)\b/, 'scrimmageYards'],
  [/\bpass(ing)?\s*(yards?|yds?)\b/, 'passYards'],
  [/\bpass(ing)?\s*(touchdowns?|tds?)\b/, 'passTd'],
  [/\bpass(ing)?\s*(completions?|comp)\b/, 'completions'],
  [/\bpass(ing)?\s*attempts?\b/, 'passAttempts'],
  [/\b(interceptions?\s*thrown|int(erception)?s?\s*thrown)\b/, 'interceptionsThrown'],
  [/\brush(ing)?\s*(yards?|yds?)\b/, 'rushYards'],
  [/\brush(ing)?\s*(touchdowns?|tds?)\b/, 'rushTd'],
  [/\brush(ing)?\s*attempts?\b/, 'rushAttempts'],
  [/\brec(eiving)?\s*(yards?|yds?)\b/, 'recYards'],
  [/\brec(eiving)?\s*(touchdowns?|tds?)\b/, 'recTd'],
  [/\b(receptions?|catches)\b/, 'receptions'],
  [/\btargets?\b/, 'targets'],
  [/\blongest\s*rec(eption)?\b/, 'longRec'],
  [/\blongest\s*rush\b/, 'longRush'],
  [/\bfield\s*goals?\s*made\b/, 'fgMade'],
  [/\bkicking\s*points?\b/, 'kickingPoints'],
  [/\b(tackles?\s*\+\s*assists?|combined\s*tackles?|total\s*tackles?|tackles?)\b/, 'tackles'],
  [/\bsacks?\b/, 'sacks'],
  // Bare "touchdown" wording is the anytime market, which is why it is last:
  // every more specific touchdown phrasing above has already matched.
  [/\b(anytime\s*(touchdown|td)|to\s*score\s*a?\s*(touchdown|td)|(touchdown|td)\s*scorer|touchdowns?|tds?)\b/, 'anytimeTd'],
];

const BASKETBALL_STAT_PHRASES = [
  [/\b(points?\s*\+\s*rebounds?\s*\+\s*assists?|pts?\s*\+\s*reb\s*\+\s*ast|p\s*\+\s*r\s*\+\s*a|pra)\b/, 'pra'],
  [/\b(points?\s*\+\s*rebounds?|pts?\s*\+\s*reb)\b/, 'pointsRebounds'],
  [/\b(points?\s*\+\s*assists?|pts?\s*\+\s*ast)\b/, 'pointsAssists'],
  [/\b(rebounds?\s*\+\s*assists?|reb\s*\+\s*ast)\b/, 'reboundsAssists'],
  [/\b(steals?\s*\+\s*blocks?|stl\s*\+\s*blk|stocks)\b/, 'stocks'],
  [/\b(three\s*pointers?\s*made|3\s*pointers?\s*made|threes?\s*made|3pt?m?\s*made|made\s*threes?|threes?|3\s*pt)\b/, 'threesMade'],
  [/\b(free\s*throws?\s*made|ftm)\b/, 'ftMade'],
  [/\b(points?|pts?)\b/, 'points'],
  [/\b(rebounds?|reb)\b/, 'rebounds'],
  [/\b(assists?|ast)\b/, 'assists'],
  [/\bsteals?\b/, 'steals'],
  [/\bblocks?\b/, 'blocks'],
  [/\bturnovers?\b/, 'turnovers'],
  [/\b(minutes?|min)\b/, 'minutes'],
];

function statPhrases(sport) {
  return sport === 'basketball' ? BASKETBALL_STAT_PHRASES : FOOTBALL_STAT_PHRASES;
}

/**
 * Find the stat a phrase is talking about, or null.
 *
 * Punctuation is folded in two different ways, and the distinction matters.
 *
 * Hyphens and underscores become whitespace, because books write the same
 * market as "3-Pointers Made", "3 Pointers Made" and "3PT Made".
 *
 * A slash becomes a '+', NOT whitespace, because it separates the parts of a
 * combo market: "Rush/Rec Yards" means rushing plus receiving. Folding it to
 * a space instead would leave the text reading "rush rec yards", which falls
 * through to plain receiving yards and silently mis-grades the bet. A '+' is
 * left alone for the same reason.
 */
export function matchStat(text, sport) {
  const folded = String(text || '')
    .toLowerCase()
    .replace(/\s*\/\s*/g, ' + ')
    .replace(/[-\u2013\u2014_]+/g, ' ')
    .replace(/\s+/g, ' ');
  const t = ' ' + folded + ' ';
  for (const [re, stat] of statPhrases(sport)) {
    if (re.test(t)) return stat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leg text parsing
// ---------------------------------------------------------------------------

const NUM = String.raw`[+-]?\d+(?:\.\d+)?`;

/**
 * Best-effort deterministic parse of a leg as a book writes it.
 *
 * This runs over the user-confirmed transcription, so it is working with text
 * a human already checked. It exists so that the model's own classification is
 * a hint rather than the source of truth: regexes are testable and do not
 * drift between model versions.
 *
 * Returns { market, stat, side, line, subjectRaw, confidence, reason }.
 * `market` is null when nothing matched, which routes the leg to review.
 *
 * Alt lines are normalized into over/under: "2+ passing TDs" becomes
 * over 1.5, because "at least 2" and "more than 1.5" are the same condition
 * and that way one grading rule covers both. It also correctly makes alt
 * lines unpushable, which is right: you cannot tie "2+".
 */
export function parseLegText(raw, sport = 'football') {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { market: null, reason: 'empty' };
  const low = text.toLowerCase();

  // --- game total: "Over 47.5", "Total Points Over 47.5", "U 210.5"
  const totalRe = new RegExp(String.raw`^(?:total\s*(?:points|runs|goals)?\s*)?(over|under|o|u)\s*(${NUM})\s*$`, 'i');
  let m = totalRe.exec(text);
  if (m) {
    return {
      market: 'game_total',
      subjectRaw: null,
      side: /^[ou]$/i.test(m[1]) ? (m[1].toLowerCase() === 'o' ? 'over' : 'under') : m[1].toLowerCase(),
      line: parseFloat(m[2]),
      stat: null,
      confidence: C.EXACT,
    };
  }

  // --- "N+ <stat>" alt line, with the player in front: "Josh Allen 2+ Passing TDs"
  m = new RegExp(String.raw`^(.*?)\s*(\d+(?:\.\d+)?)\s*\+\s*(.+)$`).exec(text);
  if (m) {
    const stat = matchStat(m[3], sport);
    if (stat) {
      return {
        market: stat === 'anytimeTd' ? 'player_yes_no' : 'player_ou',
        subjectRaw: m[1].trim() || null,
        side: 'over',
        line: parseFloat(m[2]) - 0.5, // "2+" is "over 1.5"
        stat,
        confidence: C.EXACT,
        altLine: true,
      };
    }
  }

  // --- anytime / first touchdown scorer, no number involved
  if (/\bfirst\s*(touchdown|td)\b/i.test(low)) {
    return {
      market: 'first_td',
      subjectRaw: text.replace(/\b(to\s*score\s*the\s*)?first\s*(touchdown|td)\s*(scorer)?\b/gi, '').trim() || null,
      side: 'yes',
      line: null,
      stat: 'firstTd',
      confidence: C.EXACT,
    };
  }
  if (/\b(anytime|to\s*score\s*a?)\s*(touchdown|td)\b/i.test(low) || /\b(touchdown|td)\s*scorer\b/i.test(low)) {
    return {
      market: 'player_yes_no',
      subjectRaw: text.replace(/\b(anytime|to\s*score\s*a?)?\s*(touchdown|td)\s*(scorer)?\b/gi, '').trim() || null,
      side: /\bno\b/i.test(low) ? 'no' : 'yes',
      line: 0.5, // scored at least one
      stat: 'anytimeTd',
      confidence: C.EXACT,
    };
  }

  // --- player over/under: "Patrick Mahomes Over 249.5 Passing Yards"
  //     and the other common order: "Passing Yards Over 249.5 - P. Mahomes"
  m = new RegExp(String.raw`^(.*?)\s*\b(over|under|o|u)\b\s*(${NUM})\s*(.*)$`, 'i').exec(text);
  if (m) {
    const side = m[2].length === 1 ? (m[2].toLowerCase() === 'o' ? 'over' : 'under') : m[2].toLowerCase();
    const line = parseFloat(m[3]);
    const before = m[1].trim();
    const after = m[4].trim();
    const stat = matchStat(after, sport) || matchStat(before, sport);
    if (stat) {
      // Whichever side of the "over" did NOT supply the stat holds the name.
      const subjectRaw = matchStat(after, sport) ? before : after.replace(/^[-\u2013\u2014:,]\s*/, '').trim();
      return {
        market: 'player_ou',
        subjectRaw: subjectRaw || null,
        side,
        line,
        stat,
        confidence: C.EXACT,
      };
    }
    // An over/under with no recognizable stat and a team in front is a team total.
    if (before) {
      return { market: 'team_total', subjectRaw: before, side, line, stat: null, confidence: C.LAST_ONLY };
    }
  }

  // --- spread: "Kansas City Chiefs -3.5", "Chiefs +3.5"
  m = new RegExp(String.raw`^(.+?)\s*([+-]\d+(?:\.\d+)?)\s*$`).exec(text);
  if (m) {
    return {
      market: 'spread',
      subjectRaw: m[1].trim(),
      side: null,
      line: parseFloat(m[2]),
      stat: null,
      confidence: C.EXACT,
    };
  }

  // --- moneyline: an explicit marker, or a bare team name
  if (/\b(moneyline|money\s*line|\bml\b|to\s*win)\b/i.test(low)) {
    return {
      market: 'moneyline',
      subjectRaw: text.replace(/\b(moneyline|money\s*line|ml|to\s*win)\b/gi, '').replace(/\s+/g, ' ').trim(),
      side: null,
      line: null,
      stat: null,
      confidence: C.EXACT,
    };
  }
  if (/^[A-Za-z .'&-]+$/.test(text)) {
    return { market: 'moneyline', subjectRaw: text, side: null, line: null, stat: null, confidence: C.LAST_ONLY };
  }

  return { market: null, subjectRaw: text, reason: 'no market pattern matched', confidence: C.NONE };
}

// ---------------------------------------------------------------------------
// Team resolution
// ---------------------------------------------------------------------------

/**
 * Find the event and side a team name refers to.
 *
 * Teams carry five naming fields between them (abbreviation, displayName,
 * shortDisplayName, name, location), so a slip's wording is nearly always a
 * direct match against one of them. That makes this exact rather than fuzzy.
 */
export function resolveTeam(nameRaw, events) {
  const want = normName(nameRaw);
  if (!want) return { confidence: C.NONE, reason: 'no team name' };

  const hits = [];
  for (const ev of events || []) {
    for (const side of ['home', 'away']) {
      const t = ev[side];
      if (!t) continue;
      if (t.names.some((n) => normName(n) === want)) hits.push({ ev, side, t, exact: true });
    }
  }
  if (hits.length === 1) {
    const h = hits[0];
    return { eventId: h.ev.eventId, side: h.side, teamAbbr: h.t.abbr, event: h.ev, confidence: C.EXACT };
  }
  if (hits.length > 1) {
    return { confidence: C.AMBIGUOUS, reason: `team "${nameRaw}" matches ${hits.length} games`, candidates: hits.map((h) => h.ev.eventId) };
  }

  // Nothing exact. Try a containment pass, which catches a slip that writes
  // "Green Bay Packers " with trailing junk or drops the city.
  const loose = [];
  for (const ev of events || []) {
    for (const side of ['home', 'away']) {
      const t = ev[side];
      if (!t) continue;
      if (t.names.some((n) => {
        const nn = normName(n);
        return nn.length >= 3 && (want.includes(nn) || nn.includes(want));
      })) loose.push({ ev, side, t });
    }
  }
  if (loose.length === 1) {
    const h = loose[0];
    return { eventId: h.ev.eventId, side: h.side, teamAbbr: h.t.abbr, event: h.ev, confidence: C.LAST_ONLY };
  }
  return {
    confidence: C.NONE,
    reason: loose.length ? `team "${nameRaw}" is ambiguous across ${loose.length} games` : `no team matched "${nameRaw}"`,
  };
}

// ---------------------------------------------------------------------------
// Player resolution
// ---------------------------------------------------------------------------

function nameParts(nameRaw) {
  const n = normName(nameRaw);
  if (!n) return null;
  const parts = n.split(' ').filter(Boolean);
  if (!parts.length) return null;
  return { full: n, first: parts[0], last: parts[parts.length - 1], parts };
}

/**
 * Match a player name inside one game's box score.
 *
 * Deliberately not a string-similarity function. ESPN gives firstName and
 * lastName as separate fields, so "T. McMillan" is an exact last-name match
 * plus a first-initial check, which is both cheaper and far less likely to
 * confidently pick the wrong person than a fuzzy score would be.
 */
export function resolvePlayerInSnapshot(nameRaw, snapshot) {
  const p = nameParts(nameRaw);
  if (!p) return { confidence: C.NONE, reason: 'no player name' };

  // Full name, exactly.
  const full = [...snapshot.players.values()].filter((x) => x.fullNorm === p.full);
  if (full.length === 1) return { athleteId: full[0].id, player: full[0], confidence: C.EXACT };
  if (full.length > 1) {
    return { confidence: C.AMBIGUOUS, reason: `"${nameRaw}" matches ${full.length} players in this game`, candidates: full.map((x) => x.id) };
  }

  const byLast = snapshot.byLast.get(p.last) || [];
  if (byLast.length === 1) {
    // One player with that surname. If a first name or initial was given,
    // require it to agree, otherwise we would happily accept the wrong Smith.
    const only = byLast[0];
    if (p.parts.length === 1) return { athleteId: only.id, player: only, confidence: C.LAST_ONLY };
    const initialOk = only.firstNorm && only.firstNorm[0] === p.first[0];
    const firstOk = only.firstNorm === p.first;
    if (firstOk) return { athleteId: only.id, player: only, confidence: C.EXACT };
    if (initialOk) return { athleteId: only.id, player: only, confidence: C.INITIAL };
    return { confidence: C.AMBIGUOUS, reason: `surname matched ${only.display} but the first name does not` };
  }
  if (byLast.length > 1) {
    // Several share the surname. A full first name, then an initial, then
    // the jersey number are the tie-breakers; if none settles it, ask.
    const exactFirst = byLast.filter((x) => x.firstNorm === p.first);
    if (exactFirst.length === 1) return { athleteId: exactFirst[0].id, player: exactFirst[0], confidence: C.EXACT };
    const byInitial = byLast.filter((x) => x.firstNorm && x.firstNorm[0] === p.first[0]);
    if (byInitial.length === 1) return { athleteId: byInitial[0].id, player: byInitial[0], confidence: C.INITIAL };
    return {
      confidence: C.AMBIGUOUS,
      reason: `${byLast.length} players named ${p.last} in this game`,
      candidates: byLast.map((x) => x.id),
    };
  }
  return { confidence: C.NONE, reason: `no player matched "${nameRaw}" in this game` };
}

/**
 * Match a player across every game on the slate, for a leg whose slip did not
 * name the matchup. Returns the event as well as the player.
 */
export function resolvePlayerInSlate(nameRaw, snapshots) {
  const found = [];
  for (const snap of snapshots || []) {
    const r = resolvePlayerInSnapshot(nameRaw, snap);
    if (r.athleteId) found.push({ ...r, eventId: snap.eventId, snapshot: snap });
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    const best = Math.max(...found.map((f) => f.confidence));
    const top = found.filter((f) => f.confidence === best);
    if (top.length === 1) return top[0];
    return {
      confidence: C.AMBIGUOUS,
      reason: `"${nameRaw}" matched players in ${top.length} different games`,
      candidates: top.map((f) => `${f.eventId}:${f.athleteId}`),
    };
  }
  return { confidence: C.NONE, reason: `no player matched "${nameRaw}" on this slate` };
}

// ---------------------------------------------------------------------------
// Whole-leg resolution
// ---------------------------------------------------------------------------

const TEAM_MARKETS = new Set(['moneyline', 'spread', 'team_total']);
const PLAYER_MARKETS = new Set(['player_ou', 'player_yes_no', 'first_td']);

/**
 * Resolve a leg end to end.
 *
 * ctx: { league, events, snapshots }
 *   events    normalized scoreboard entries, needed for every market
 *   snapshots normalized summaries, needed for player markets (absent before
 *             a game starts, which is why player legs resolve lazily at grade
 *             time rather than at ingest)
 *
 * Returns the parsed leg plus { eventId, teamAbbr, athleteId, confidence,
 * reason }. Confidence is the minimum across the steps, because a leg is only
 * as trustworthy as its weakest resolution.
 */
export function resolveLeg(leg, ctx) {
  const sport = (LEAGUES[ctx.league] || {}).sport || 'football';
  const parsed = leg.market ? leg : { ...leg, ...parseLegText(leg.rawText, sport) };

  if (!parsed.market) {
    return { ...parsed, confidence: C.NONE, reason: parsed.reason || 'market not recognized' };
  }

  if (parsed.market === 'game_total') {
    // A game total names no subject, so the event has to come from elsewhere:
    // the slip's own matchup line, or whatever the rest of the slip resolved.
    const ev = ctx.events && ctx.events.length === 1 ? ctx.events[0] : null;
    if (leg.eventId) return { ...parsed, eventId: leg.eventId, confidence: C.EXACT };
    if (ev) return { ...parsed, eventId: ev.eventId, confidence: C.EXACT };
    return { ...parsed, confidence: C.NONE, reason: 'game total needs the matchup, which the slip did not give' };
  }

  if (TEAM_MARKETS.has(parsed.market)) {
    const t = resolveTeam(parsed.subjectRaw, ctx.events);
    if (!t.eventId) return { ...parsed, confidence: C.NONE, reason: t.reason };
    return { ...parsed, eventId: t.eventId, teamAbbr: t.teamAbbr, side_: t.side, confidence: t.confidence };
  }

  if (PLAYER_MARKETS.has(parsed.market)) {
    const snaps = ctx.snapshots || [];
    if (!snaps.length) {
      return { ...parsed, confidence: C.NONE, reason: 'no box score yet; player legs resolve once the game starts' };
    }
    const scoped = leg.eventId ? snaps.filter((s) => s.eventId === leg.eventId) : snaps;
    const r = scoped.length === 1
      ? { ...resolvePlayerInSnapshot(parsed.subjectRaw, scoped[0]), eventId: scoped[0].eventId }
      : resolvePlayerInSlate(parsed.subjectRaw, scoped);
    if (!r.athleteId) return { ...parsed, confidence: C.NONE, reason: r.reason };
    return {
      ...parsed,
      eventId: r.eventId,
      athleteId: r.athleteId,
      teamAbbr: r.player ? r.player.teamAbbr : null,
      confidence: r.confidence,
    };
  }

  return { ...parsed, confidence: C.NONE, reason: `market "${parsed.market}" is not supported yet` };
}
