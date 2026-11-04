// espn.js: turn raw ESPN payloads into a normalized EventSnapshot.
//
// Pure: these functions take already-fetched JSON. Nothing here does I/O, so
// the whole adapter is testable against saved fixtures.
//
// This file is the ONLY place that knows about ESPN's shape. Three verified
// traps are handled here so nothing downstream has to remember them:
//
//   1. Per-athlete `stats[]` aligns with the group's `labels[]`, NEVER with
//      `keys[]`. Verified across 171 athlete rows in 4 leagues: `labels`
//      matched every time, `keys` was a different length twice (CFB passing
//      has 5 labels and 6 keys). `keys` is used to author the tables below
//      during development and is ignored at runtime.
//   2. A player who recorded nothing is ABSENT from the group, and in the NFL
//      absent-from-everything is indistinguishable from inactive. We record
//      which groups each player appeared in so the grader can tell "played and
//      got zero" (grade it) from "never appeared" (ask).
//   3. A passing TD is thrown, not scored. `anytimeTd` deliberately excludes
//      the passing group.

// ---------------------------------------------------------------------------
// Stat tables
// ---------------------------------------------------------------------------
// Keyed by [group][label] because a label is only meaningful inside its group:
// `YDS` is passing yards in one group and receiving yards in another, and `TD`
// appears in seven NFL groups meaning seven different things.
//
// A value is either a canonical key, or { split, keys } for a composite cell
// like `23/41` or `4-8`. Note the separator is NOT consistent across labels:
// NFL passing uses '/' for C/ATT and '-' for SACKS, NBA uses '-' throughout.

const FOOTBALL_STATS = {
  passing: {
    'C/ATT': { split: '/', keys: ['completions', 'passAttempts'] },
    YDS: 'passYards',
    TD: 'passTd',
    INT: 'interceptionsThrown',
    SACKS: { split: '-', keys: ['sacksTaken', 'sackYardsLost'] },
    AVG: 'passYardsPerAttempt',
    QBR: null,
    RTG: null,
  },
  rushing: {
    CAR: 'rushAttempts',
    YDS: 'rushYards',
    TD: 'rushTd',
    LONG: 'longRush',
    AVG: 'rushYardsPerAttempt',
  },
  receiving: {
    REC: 'receptions',
    YDS: 'recYards',
    TD: 'recTd',
    LONG: 'longRec',
    TGTS: 'targets',
    AVG: 'recYardsPerCatch',
  },
  fumbles: { FUM: 'fumbles', LOST: 'fumblesLost', REC: 'fumblesRecovered' },
  defensive: {
    TOT: 'tackles',
    SOLO: 'soloTackles',
    SACKS: 'sacks',
    TFL: 'tacklesForLoss',
    PD: 'passesDefended',
    'QB HTS': 'qbHits', // NFL wording
    'QB HUR': 'qbHurries', // college wording for roughly the same thing
    TD: 'defTd',
  },
  interceptions: { INT: 'interceptions', YDS: 'intReturnYards', TD: 'intTd' },
  kickReturns: { NO: 'kickReturns', YDS: 'kickReturnYards', TD: 'kickReturnTd', LONG: 'longKickReturn', AVG: null },
  puntReturns: { NO: 'puntReturns', YDS: 'puntReturnYards', TD: 'puntReturnTd', LONG: 'longPuntReturn', AVG: null },
  kicking: {
    FG: { split: '/', keys: ['fgMade', 'fgAttempted'] },
    XP: { split: '/', keys: ['xpMade', 'xpAttempted'] },
    PTS: 'kickingPoints',
    LONG: 'longFieldGoal',
    PCT: null,
  },
  punting: { NO: 'punts', YDS: 'puntYards', AVG: null, TB: 'puntTouchbacks', 'In 20': 'puntsInside20', LONG: 'longPunt' },
};

// NBA ships a single unnamed group, so it is keyed under a synthetic name.
const BASKETBALL_STATS = {
  _all: {
    MIN: 'minutes',
    PTS: 'points',
    FG: { split: '-', keys: ['fgMade', 'fgAttempted'] },
    '3PT': { split: '-', keys: ['threesMade', 'threesAttempted'] },
    FT: { split: '-', keys: ['ftMade', 'ftAttempted'] },
    REB: 'rebounds',
    AST: 'assists',
    TO: 'turnovers',
    STL: 'steals',
    BLK: 'blocks',
    OREB: 'offensiveRebounds',
    DREB: 'defensiveRebounds',
    PF: 'fouls',
    '+/-': 'plusMinus',
  },
};

export const LEAGUES = {
  nfl: { path: 'football/nfl', sport: 'football', stats: FOOTBALL_STATS },
  cfb: { path: 'football/college-football', sport: 'football', stats: FOOTBALL_STATS },
  nba: { path: 'basketball/nba', sport: 'basketball', stats: BASKETBALL_STATS },
  cbb: { path: 'basketball/mens-college-basketball', sport: 'basketball', stats: BASKETBALL_STATS },
};

/**
 * Stats that are a sum of other stats. Books price these as single markets
 * ("pts+reb+ast", "rush+rec yards"), so they are first-class here.
 *
 * `anytimeTd` is the important one: every TD group EXCEPT passing. Including
 * passing would credit the quarterback with a touchdown every time he throws
 * one, wrongly cashing a huge number of anytime-TD legs.
 */
export const DERIVED = {
  anytimeTd: ['rushTd', 'recTd', 'defTd', 'intTd', 'kickReturnTd', 'puntReturnTd'],
  scrimmageYards: ['rushYards', 'recYards'],
  passRushYards: ['passYards', 'rushYards'],
  totalTd: ['passTd', 'rushTd', 'recTd', 'defTd', 'intTd', 'kickReturnTd', 'puntReturnTd'],
  pra: ['points', 'rebounds', 'assists'],
  pointsRebounds: ['points', 'rebounds'],
  pointsAssists: ['points', 'assists'],
  reboundsAssists: ['rebounds', 'assists'],
  stocks: ['steals', 'blocks'],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** '1,024' -> 1024 ; '' / '--' / null -> null (absent, which is not zero). */
export function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '--' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 'MM:SS' -> minutes as a float. NBA reports minutes played this way. */
function minutesToNumber(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d+):(\d{1,2})$/.exec(s);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  return num(s);
}

/**
 * Fold a name to a comparable form: lowercase, accents stripped, punctuation
 * removed, generational suffixes dropped. 'D'Andre Swift Jr.' -> 'dandre swift'
 */
export function normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Scoreboard -> event list
// ---------------------------------------------------------------------------

function teamNames(team) {
  // Every way a slip can name a team, in one array. Between these fields a
  // slip's wording is a direct match rather than a fuzzy one.
  const out = [];
  for (const f of ['abbreviation', 'displayName', 'shortDisplayName', 'name', 'location']) {
    if (team && team[f]) out.push(String(team[f]));
  }
  if (team && team.location && team.name) out.push(`${team.location} ${team.name}`);
  return [...new Set(out)];
}

function competitorOf(c) {
  const t = c.team || {};
  return {
    id: t.id || null,
    abbr: t.abbreviation || null,
    displayName: t.displayName || null,
    shortName: t.shortDisplayName || t.name || null,
    names: teamNames(t),
    // Team colours come back as bare hex with no '#'. Used for the team chip
    // in the box score, which stands in for a helmet: a real team logo is the
    // league's trademark and not ours to ship.
    color: t.color ? `#${t.color}` : null,
    altColor: t.alternateColor ? `#${t.alternateColor}` : null,
    score: num(c.score),
    winner: c.winner === true,
    homeAway: c.homeAway || null,
    // Per-period scores for the box score table. Positional: overtime appends
    // an extra entry, so the last element is NOT reliably the 4th quarter.
    periods: (c.linescores || []).map((p) => num(p.displayValue)),
  };
}

/**
 * The betting line on an event, so a price does not have to be typed in.
 *
 * ESPN carries a book's own numbers on a scheduled game: moneyline, spread
 * with its price, and total with its price, for both sides. This is what lets
 * the app know the Knicks are -220 tonight rather than asking.
 *
 * It covers game-level markets ONLY. Player props are not in this feed at any
 * price, so those still have to be typed, and the entry form says so rather
 * than leaving a blank field looking broken.
 *
 * The numbers are quoted strings ("-518", "o221.5"), and a book may publish
 * either a closing or a current line, so both are accepted.
 */
function sideOdds(block, side) {
  const s = (block || {})[side];
  if (!s) return null;
  const q = s.close || s.current || s.open || null;
  if (!q) return null;
  // A total's line is written "o221.5" / "u221.5".
  const rawLine = q.line === undefined ? null : String(q.line).replace(/^[ou]/i, '');
  return {
    odds: q.odds === undefined ? null : num(q.odds),
    line: rawLine === null ? null : num(rawLine),
  };
}

export function oddsFromCompetition(comp) {
  const o = ((comp || {}).odds || [])[0];
  if (!o) return null;
  const ml = sideOdds(o.moneyline, 'home');
  const mla = sideOdds(o.moneyline, 'away');
  const sh = sideOdds(o.pointSpread, 'home');
  const sa = sideOdds(o.pointSpread, 'away');
  const to = sideOdds(o.total, 'over');
  const tu = sideOdds(o.total, 'under');

  const any = [ml, mla, sh, sa, to, tu].some((x) => x && (x.odds !== null || x.line !== null));
  if (!any) return null;

  return {
    provider: ((o.provider || {}).name) || null,
    details: o.details || null,
    moneyline: { home: ml ? ml.odds : null, away: mla ? mla.odds : null },
    spread: {
      home: sh ? { line: sh.line, odds: sh.odds } : null,
      away: sa ? { line: sa.line, odds: sa.odds } : null,
    },
    total: {
      line: (to && to.line !== null) ? to.line : (tu ? tu.line : (num(o.overUnder) ?? null)),
      over: to ? to.odds : null,
      under: tu ? tu.odds : null,
    },
  };
}

/**
 * The price for one selection, or null when this feed does not carry it.
 *
 * `market` and `side` use the resolver's own vocabulary, so a parsed leg can
 * be handed straight in.
 */
export function priceFor(event, { market, side, teamAbbr }) {
  const o = event && event.odds;
  if (!o) return null;
  const which = teamAbbr && event.home && event.home.abbr === teamAbbr ? 'home'
    : teamAbbr && event.away && event.away.abbr === teamAbbr ? 'away' : null;

  if (market === 'moneyline') return which ? o.moneyline[which] : null;
  if (market === 'spread') {
    const s = which ? o.spread[which] : null;
    return s ? { odds: s.odds, line: s.line } : null;
  }
  if (market === 'game_total') {
    const odds = side === 'under' ? o.total.under : o.total.over;
    return { odds, line: o.total.line };
  }
  return null; // team totals and player props are not in this feed
}

/** Normalize a scoreboard payload into a flat list of events. */
export function eventsFromScoreboard(raw, league) {
  const out = [];
  for (const e of (raw && raw.events) || []) {
    const comp = (e.competitions || [])[0];
    if (!comp) continue;
    const st = (comp.status && comp.status.type) || {};
    const sides = (comp.competitors || []).map(competitorOf);
    out.push({
      eventId: String(e.id),
      league,
      name: e.name || null,
      shortName: e.shortName || null,
      startAt: toMs(comp.date || e.date),
      state: st.state || null,
      detail: st.detail || null,
      completed: st.completed === true,
      odds: oddsFromCompetition(comp),
      home: sides.find((s) => s.homeAway === 'home') || null,
      away: sides.find((s) => s.homeAway === 'away') || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary -> EventSnapshot
// ---------------------------------------------------------------------------

/**
 * Build the snapshot the grader runs against.
 *
 * Returns { eventId, league, state, completed, period, clock, home, away,
 *           totalScore, players, byLast, firstTdScorerId, warnings }
 *
 * `players` is a Map of athlete id -> player record. Each record carries
 * `stats` (canonical key -> number), `groups` (a Set of the stat groups the
 * player appeared in at all) and `didNotPlay`.
 */
export function snapshotFromSummary(raw, league) {
  const cfg = LEAGUES[league];
  if (!cfg) throw new Error(`unknown league: ${league}`);

  const warnings = [];
  const header = (raw && raw.header) || {};
  const comp = ((header.competitions || [])[0]) || {};
  const st = (comp.status && comp.status.type) || {};
  const sides = (comp.competitors || []).map(competitorOf);
  const home = sides.find((s) => s.homeAway === 'home') || null;
  const away = sides.find((s) => s.homeAway === 'away') || null;

  const players = new Map();
  const byLast = new Map();
  const unmapped = new Set();

  for (const teamBlock of ((raw && raw.boxscore && raw.boxscore.players) || [])) {
    const teamAbbr = ((teamBlock.team || {}).abbreviation) || null;

    for (const group of teamBlock.statistics || []) {
      const groupName = group.name || '_all';
      const table = cfg.stats[groupName];
      const labels = group.labels || [];

      if (!table) {
        warnings.push(`unmapped stat group: ${league}/${groupName}`);
        continue;
      }

      for (const row of group.athletes || []) {
        const ath = row.athlete || {};
        const id = ath.id ? String(ath.id) : null;
        if (!id) continue;

        let p = players.get(id);
        if (!p) {
          // firstName and lastName are populated in the football feeds but
          // come back null in the NBA box score, so both have to fall back to
          // splitting displayName. Without the first-name fallback, initial
          // matching ("J. Williams") silently never fires for basketball.
          const full = normName(ath.displayName);
          const words = full ? full.split(' ') : [];
          const first = normName(ath.firstName) || words[0] || '';
          const last = normName(ath.lastName) || (words.length ? words[words.length - 1] : '');
          p = {
            id,
            teamAbbr,
            first: ath.firstName || null,
            last: ath.lastName || null,
            display: ath.displayName || null,
            firstNorm: first,
            lastNorm: last,
            fullNorm: full,
            jersey: ath.jersey || null,
            headshot: (ath.headshot && ath.headshot.href) || null,
            didNotPlay: false,
            groups: new Set(),
            stats: {},
          };
          players.set(id, p);
          if (!byLast.has(last)) byLast.set(last, []);
          byLast.get(last).push(p);
        }

        // NBA flags inactive players explicitly; the NFL has no such flag.
        if (row.didNotPlay === true) {
          p.didNotPlay = true;
          p.dnpReason = row.reason || null;
        }

        const stats = row.stats || [];
        // THE alignment rule. labels[i] pairs with stats[i]; keys[] is ignored.
        if (stats.length && labels.length && stats.length !== labels.length) {
          warnings.push(
            `stats/labels length mismatch in ${league}/${groupName}: ${stats.length} vs ${labels.length}`
          );
        }
        if (!stats.length) continue;
        p.groups.add(groupName);

        const n = Math.min(stats.length, labels.length);
        for (let i = 0; i < n; i++) {
          const label = labels[i];
          const spec = Object.prototype.hasOwnProperty.call(table, label) ? table[label] : undefined;
          if (spec === undefined) {
            unmapped.add(`${league}/${groupName}/${label}`);
            continue;
          }
          if (spec === null) continue; // deliberately ignored (AVG, QBR, ...)

          const cell = stats[i];
          if (typeof spec === 'string') {
            p.stats[spec] = spec === 'minutes' ? minutesToNumber(cell) : num(cell);
          } else {
            const parts = String(cell == null ? '' : cell).split(spec.split);
            spec.keys.forEach((k, j) => {
              p.stats[k] = num(parts[j]);
            });
          }
        }
      }
    }
  }

  // Derived sums. A derived stat is only null when every component is absent,
  // so a receiver with rushYards absent and recYards 40 gets scrimmage 40.
  for (const p of players.values()) {
    for (const [key, parts] of Object.entries(DERIVED)) {
      let sum = null;
      for (const part of parts) {
        const v = p.stats[part];
        if (v !== null && v !== undefined) sum = (sum || 0) + v;
      }
      if (sum !== null) p.stats[key] = sum;
    }
  }

  for (const u of unmapped) warnings.push(`unmapped stat label: ${u}`);

  const homeScore = home ? home.score : null;
  const awayScore = away ? away.score : null;

  return {
    eventId: String(header.id || comp.id || ''),
    league,
    state: st.state || null,
    completed: st.completed === true,
    detail: st.detail || null,
    // How many periods a regulation game has, read from the feed rather than
    // hardcoded per league. Anything beyond this count is overtime.
    regulationPeriods: ((raw.format || {}).regulation || {}).periods || null,
    period: comp.status ? comp.status.period : null,
    clock: comp.status ? comp.status.displayClock : null,
    startAt: toMs(comp.date),
    home,
    away,
    totalScore: homeScore !== null && awayScore !== null ? homeScore + awayScore : null,
    players,
    byLast,
    scoringPlays: (raw && raw.scoringPlays) || [],
    firstTdScorerName: firstTdScorerName(raw),
    injuries: injuryIndex(raw),
    warnings,
  };
}

/**
 * The scorer of the first touchdown, as a raw name string.
 *
 * Only this market needs the play text, because order matters and the box
 * score has no ordering. The text names two players on a passing touchdown
 * ("Tucker Kraft 12 Yd pass from Jordan Love") and only the first one scored,
 * so cutting at the first digit yields the scorer and drops the passer.
 */
export function firstTdScorerName(raw) {
  for (const play of (raw && raw.scoringPlays) || []) {
    const abbr = (play.type || {}).abbreviation;
    if (abbr !== 'TD') continue;
    const text = String(play.text || '');
    const m = /^([^0-9]+?)\s+\d/.exec(text);
    if (m) return m[1].trim();
    return null;
  }
  return null;
}

/** Pregame injury statuses by normalized name. A hint only, never decisive. */
function injuryIndex(raw) {
  const out = new Map();
  for (const block of (raw && raw.injuries) || []) {
    for (const entry of block.injuries || []) {
      const name = ((entry.athlete || {}).displayName) || '';
      if (name) out.set(normName(name), entry.status || null);
    }
  }
  return out;
}
