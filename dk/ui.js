// ui.js: render helpers. Pure string builders, no DOM reads, no fetching.
//
// Everything here takes already-graded data and returns HTML. Keeping render
// separate from state is what lets the preview page and the real app share
// one set of components, and it means a screen can be eyeballed against
// fixtures without any backend.

import { STATE, RENDER } from './grade.js';

export const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const money = (cents) => {
  if (cents === null || cents === undefined) return '−';
  const v = Math.abs(cents) / 100;
  return (cents < 0 ? '-$' : '$') + v.toFixed(2);
};

export const signedMoney = (cents) => {
  if (cents === null || cents === undefined) return '−';
  return (cents > 0 ? '+' : cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toFixed(2);
};

export const americanStr = (a) => (a === null || a === undefined ? '' : (a > 0 ? `+${a}` : String(a)));

/** What a card calls itself. A one-leg lock is a single, not a "1 Leg Lock". */
export const lockTitle = (legCount) => (legCount === 1 ? 'Single Lock' : `${legCount} Leg Lock`);

/**
 * The DonationKings mark: a crown with a down arrow through it, since the
 * joke in the name is that a parlay is a donation. Drawn here rather than
 * borrowed, because shipping a real sportsbook's logo would make the app look
 * like it is pretending to be theirs.
 */
export function crownSVG(cls = '') {
  return `<svg class="${cls}" viewBox="0 0 48 44" aria-hidden="true">
  <path d="M5 33 L2.5 11 Q2.3 9.3 3.9 10.2 L14 16.4 L22.4 5.1 Q24 3 25.6 5.1 L34 16.4 L44.1 10.2 Q45.7 9.3 45.5 11 L43 33 Z" fill="var(--green)"/>
  <rect x="5" y="35.5" width="38" height="6" rx="2.6" fill="var(--green)"/>
  <path d="M24 16.5 V25.5 M19.8 21.6 L24 26.4 L28.2 21.6" stroke="#0a1f05" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
}

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9"/><path d="M4.2 4.2a11 11 0 0 0 0 15.6M19.8 19.8a11 11 0 0 0 0-15.6"/></svg>',
  locks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z"/><path d="M9.5 8h5M9.5 12h5"/></svg>',
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5" stroke-linecap="round"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  filter: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/></svg>',
  slipScan: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5"/></svg>',
};

// ---------------------------------------------------------------------------
// Turning a resolved leg back into the words a slip would print
// ---------------------------------------------------------------------------

const STAT_LABEL = {
  passYards: 'Passing Yards', passTd: 'Passing TDs', completions: 'Completions',
  passAttempts: 'Pass Attempts', interceptionsThrown: 'Interceptions',
  rushYards: 'Rushing Yards', rushTd: 'Rushing TDs', rushAttempts: 'Carries',
  recYards: 'Receiving Yards', recTd: 'Receiving TDs', receptions: 'Receptions',
  targets: 'Targets', longRec: 'Longest Reception', longRush: 'Longest Rush',
  scrimmageYards: 'Rush + Rec Yards', passRushYards: 'Pass + Rush Yards',
  anytimeTd: 'Anytime TD Scorer', totalTd: 'Total TDs',
  tackles: 'Tackles', sacks: 'Sacks', fgMade: 'Field Goals Made',
  kickingPoints: 'Kicking Points',
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists',
  threesMade: 'Threes Made', ftMade: 'Free Throws Made',
  steals: 'Steals', blocks: 'Blocks', turnovers: 'Turnovers', minutes: 'Minutes',
  pra: 'Pts + Reb + Ast', pointsRebounds: 'Pts + Reb', pointsAssists: 'Pts + Ast',
  reboundsAssists: 'Reb + Ast', stocks: 'Stl + Blk', plusMinus: 'Plus/Minus',
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Describe a resolved leg the way a bet slip would: a bold selection on top
 * and the market underneath. Falls back to the raw transcribed text, which is
 * why `rawText` is kept forever.
 */
export function describeLeg(leg, snap) {
  const team = () => {
    if (!snap) return leg.subjectRaw;
    const t = [snap.home, snap.away].find((x) => x && x.abbr === leg.teamAbbr);
    return t ? `${t.abbr} ${t.shortName}` : (leg.teamAbbr || leg.subjectRaw);
  };
  const player = () => {
    const p = snap && leg.athleteId ? snap.players.get(String(leg.athleteId)) : null;
    return p ? p.display : leg.subjectRaw;
  };
  const stat = STAT_LABEL[leg.stat] || leg.stat || '';

  switch (leg.market) {
    case 'moneyline': return { name: team(), market: 'To Win' };
    case 'spread': return { name: team(), market: `Spread ${signed(leg.line)}` };
    case 'game_total': return { name: 'Total Points', market: `${cap(leg.side)} ${leg.line}` };
    case 'team_total': return { name: team(), market: `Team Total ${cap(leg.side)} ${leg.line}` };
    case 'player_yes_no': return { name: player(), market: leg.side === 'no' ? `No ${stat}` : stat };
    case 'first_td': return { name: player(), market: 'First TD Scorer' };
    case 'player_ou':
      return {
        name: player(),
        market: leg.altLine ? `${leg.line + 0.5}+ ${stat}` : `${cap(leg.side)} ${leg.line} ${stat}`,
      };
    default: return { name: leg.subjectRaw || leg.rawText, market: leg.rawText || '' };
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const STATE_LABEL = {
  [STATE.WON]: 'Won',
  [STATE.LOST]: 'Lost',
  [STATE.PUSH]: 'Push',
  [STATE.VOID]: 'Void',
  [STATE.PENDING]: 'Open',
  [STATE.REVIEW]: 'Check',
};

const LEG_GLYPH = {
  [STATE.WON]: '✓',
  [STATE.LOST]: '✕',
  [STATE.PUSH]: '−',
  [STATE.VOID]: '−',
  [STATE.PENDING]: '·',
  [STATE.REVIEW]: '?',
};

export function statusPill(state, { live = false } = {}) {
  if (live && state === STATE.PENDING) return `<span class="status live">Live</span>`;
  return `<span class="status ${esc(state)}">${esc(STATE_LABEL[state] || state)}</span>`;
}

/** Team chip standing in for a helmet, coloured from the feed's own fields. */
function teamChip(team) {
  const bg = team.color || '#333842';
  return `<span class="chipmark" style="background:${esc(bg)}">${esc(team.abbr || '')}</span>`;
}

/** Column labels for a box score, with anything past regulation as overtime. */
function periodLabels(count, regulation) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (!regulation || i < regulation) out.push(`Q${i + 1}`);
    else out.push(count - regulation > 1 ? `OT${i - regulation + 1}` : 'OT');
  }
  return out;
}

/**
 * Quarter-by-quarter box score. Totals are gold, which is the one place in
 * the design gold is used besides a winning lock.
 */
export function boxScoreHTML(snap) {
  if (!snap || !snap.home || !snap.away) return '';
  const played = Math.max(snap.home.periods.length, snap.away.periods.length);
  if (!played) return '';
  // Always draw the full regulation grid so the table does not reflow column
  // by column as a live game progresses. Overtime extends it past regulation.
  const n = Math.max(played, snap.regulationPeriods || 0);
  const labels = periodLabels(n, snap.regulationPeriods);
  const head = snap.completed ? (snap.detail || 'Final')
    : snap.state === 'in' ? (snap.detail || 'Live') : 'Scheduled';

  const row = (t) => `<tr>
      <td><span class="team">${teamChip(t)}<span class="tname"><span class="abbr">${esc(t.abbr)}</span>${esc(t.shortName || '')}</span></span></td>
      ${labels.map((_, i) => `<td>${t.periods[i] === undefined ? '' : esc(t.periods[i])}</td>`).join('')}
      <td class="total">${esc(t.score === null ? '' : t.score)}</td>
    </tr>`;

  return `<div class="box"><table>
    <thead><tr><th>${esc(head)}</th>${labels.map((l) => `<th>${l}</th>`).join('')}<th>T</th></tr></thead>
    <tbody>${row(snap.away)}${row(snap.home)}</tbody>
  </table></div>`;
}

/**
 * Live progress for one leg. This is the app's own addition rather than a
 * sportsbook pattern, and it is the reason the live board is worth opening.
 *
 * Clinched and dead are styled distinctly from settled on purpose: the bar
 * can go green while the leg is still formally pending, because money does
 * not move until the game is final.
 */
function progressHTML(v) {
  if (v.render !== RENDER.BAR || v.current === null || v.needed === null) return '';
  if (v.state !== STATE.PENDING) return '';
  const cls = v.clinched ? 'is-clinched' : v.dead ? 'is-dead' : 'is-live';
  const tag = v.clinched ? 'Clinched' : v.dead ? 'Dead' : '';
  return `<div class="prog ${cls}">
    <div class="prog-meta">
      <span><b>${esc(v.current)}</b> of ${esc(v.needed)}</span>
      ${tag ? `<span class="prog-tag">${tag}</span>` : `<span>${Math.round(v.pct * 100)}%</span>`}
    </div>
    <div class="prog-bar"><i style="width:${Math.max(2, Math.round(v.pct * 100))}%"></i></div>
  </div>`;
}

/**
 * Buttons to settle a leg by hand, shown only when the engine refused to
 * call it. This is the universal escape hatch that keeps a lock from ever
 * being stuck: an unmapped market, an ambiguous name, or a football player
 * we cannot tell played at all.
 */
function fixHTML(lockId, index, state) {
  if (state !== STATE.REVIEW || !lockId) return '';
  const opts = [['won', 'Hit'], ['lost', 'Missed'], ['push', 'Push'], ['void', 'Void']];
  return `<div class="leg-fix">
    ${opts.map(([v, label]) => `<button class="${v}" data-action="grade-leg" data-id="${esc(lockId)}" data-i="${index}" data-verdict="${v}">${label}</button>`).join('')}
  </div>`;
}

/** One leg: status circle, selection, market, and either progress or a note. */
export function legHTML(leg, verdict, snap, opts = {}) {
  const v = verdict || {};
  const st = v.state || STATE.PENDING;
  const note = st === STATE.REVIEW ? v.reason
    : st === STATE.VOID ? v.reason
      : '';
  const d = describeLeg(leg, snap);
  return `<div class="leg">
    <span class="leg-icon ${esc(st)}">${LEG_GLYPH[st] || ''}</span>
    <div>
      <div class="leg-name">${esc(d.name)}</div>
      <div class="leg-market">${esc(d.market)}${leg.oddsAmerican ? ` <span style="color:var(--mute)">${americanStr(leg.oddsAmerican)}</span>` : ''}</div>
      ${note ? `<div class="leg-note ${st === STATE.REVIEW ? 'review' : ''}">${esc(note)}</div>` : ''}
      ${progressHTML(v)}
      ${fixHTML(opts.lockId, opts.index === undefined ? 0 : opts.index, st)}
    </div>
  </div>`;
}

/**
 * Legs plus their box scores.
 *
 * A box score belongs to a game, not to a leg, so it is drawn once after the
 * last leg that references that game. Without this a same-game parlay repeats
 * the identical score table under every leg, which is both noisy and wrong.
 * Drawing it at full card width also keeps the quarter columns from being
 * squeezed into the leg's indent on a narrow phone.
 */
export function legsHTML(legs, lockId) {
  // The last leg that mentions each game is where that game's score goes.
  const lastIndexForEvent = new Map();
  legs.forEach((e, i) => { if (e.leg.eventId) lastIndexForEvent.set(e.leg.eventId, i); });

  return legs.map((entry, i) => {
    const row = legHTML(entry.leg, entry.verdict, entry.snapshot, { lockId, index: entry.index === undefined ? i : entry.index });
    const id = entry.leg.eventId;
    const showBox = id && lastIndexForEvent.get(id) === i;
    return row + (showBox ? boxScoreHTML(entry.snapshot) : '');
  }).join('');
}

// ---------------------------------------------------------------------------
// Bet card
// ---------------------------------------------------------------------------

const fmtPlaced = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return `Placed: ${date} at ${time}`;
};

/**
 * A whole lock (this app's word for a placed parlay).
 *
 * lock: {
 *   title, legs: [{ leg, verdict, snapshot }], roll, stakeCompCents,
 *   returnCents, oddsAmerican, boostPct, placedAt, eligible, correlated, live
 * }
 */
export function lockCardHTML(lock) {
  const st = lock.roll.state;
  const won = st === STATE.WON;
  // Use the resolved selection names rather than the raw transcription, so
  // the summary line reads "AKR Zips, Total Points" and not the leg text.
  // Presentation, computed here rather than carried on the lock, so derive.js
  // stays free of the render layer and the Worker's grader can import it.
  const title = lock.title || lockTitle(lock.legs.length || (lock.picks || []).length);
  const names = lock.legs.map((l) => describeLeg(l.leg, l.snapshot).name).filter(Boolean);
  const pct = lock.impliedPct;

  return `<article class="card ${won ? 'is-won' : ''}">
    ${won ? `<div class="crownline">
      <span class="mark">${crownSVG()}DONATION<span style="color:var(--green)">KINGS</span></span>
      <span class="tagline">LONG LIVE THE <b>KING</b></span>
    </div>` : ''}

    <div class="card-head">
      <h3 class="card-title">
        ${esc(title)}
        ${pct !== undefined ? `<span class="sep">|</span><span class="odds">${pct}%</span>` : ''}
      </h3>
      ${statusPill(st, { live: lock.live })}
    </div>
    ${names.length ? `<p class="card-sub">${esc(names.join(', '))}</p>` : ''}

    <div class="money">
      <span class="label">Bought:</span><span class="val">${money(lock.stakeCompCents)}</span>
      ${lock.returnCents !== null && lock.returnCents !== undefined && st !== STATE.LOST
        ? `<span class="sep">|</span><span class="label">Paid:</span><span class="val paid">${money(lock.returnCents)}</span>`
        : ''}
      ${st === STATE.PENDING && lock.toWinCents
        ? `<span class="sep">|</span><span class="label">To win:</span><span class="val paid">${money(lock.toWinCents)}</span>`
        : ''}
    </div>

    ${lock.boostPct || lock.correlated || lock.capped ? `<div class="badges">
      ${lock.boostPct ? `<span class="badge boost">${esc(lock.boostPct)}% Boost</span>` : ''}
      ${lock.correlated ? `<span class="badge sgp">Same Game</span>` : ''}
      ${lock.capped ? `<span class="badge capped">Stake capped to bankroll</span>` : ''}
    </div>` : ''}

    <button class="infobtn">${ICONS.info} Position Information</button>

    <div class="legs">${legsHTML(lock.legs, lock.id)}</div>

    <div class="card-foot">
      <div class="card-actions">
        <button class="ghostbtn">${ICONS.share} Share</button>
        <button class="ghostbtn">Hide Legs ${ICONS.chevron}</button>
      </div>
      <div class="card-meta">
        <span class="tag ${lock.eligible === false ? 'ineligible' : ''}">${lock.eligible === false ? 'Not eligible' : 'Counts'}</span>
        <span class="placed">${esc(fmtPlaced(lock.placedAt))}</span>
        ${lock.id ? `<button class="linkbtn" data-action="delete-lock" data-id="${esc(lock.id)}">Delete</button>` : ''}
      </div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export function appBarHTML({ bankrollCents, initials = 'GL' }) {
  return `<header class="appbar">
    <div class="brand">${crownSVG()}<span class="brand-name">Donation<span class="king">Kings</span></span></div>
    <div class="bankroll">${money(bankrollCents)}</div>
    <div class="avatar">${esc(initials)}<span class="dot"></span></div>
  </header>`;
}

export function tabsHTML(items, active) {
  return `<nav class="tabs">${items.map((t) => `<button class="tab" aria-selected="${t === active}">${esc(t)}</button>`).join('')}</nav>`;
}

export function chipsHTML(items, active) {
  return `<div class="chiprow">
    <button class="chip icon">${ICONS.filter}</button>
    <span class="divider"></span>
    ${items.map((c) => `<button class="chip" aria-pressed="${c === active}">${esc(c)}</button>`).join('')}
  </div>`;
}

/**
 * The bottom bar.
 *
 * These labels are exactly the views the app has, and exactly what the top
 * tabs say. An earlier version had Home and Board down here mapping onto My
 * Locks and League, which meant the highlight never matched where you were
 * and two buttons did the same thing as two others.
 */
export function tabBarHTML(active = 'Live', badges = {}) {
  const items = [
    ['My Locks', ICONS.locks], ['Live', ICONS.live],
    ['League', ICONS.board], ['Add', ICONS.add],
  ];
  return `<nav class="tabbar">${items.map(([label, svg]) => `
    <button aria-selected="${label === active}">
      ${badges[label] ? `<span class="nbadge">${esc(badges[label])}</span>` : ''}
      ${svg}<span>${esc(label)}</span>
    </button>`).join('')}</nav>`;
}

export function leaderboardHTML(rows, meUid) {
  return `<div class="lb">${rows.map((r, i) => {
    const delta = r.bankrollCents - r.startCents;
    const cls = r.bust ? 'bust' : delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    return `<div class="lb-row ${i === 0 ? 'lead' : ''} ${r.uid === meUid ? 'me' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="avatar" style="width:38px;height:38px">${esc(r.initials)}</span>
      <span><span class="lb-name">${esc(r.name)}</span><br><span class="lb-sub">${esc(r.record)}${r.bust ? ' · busted' : ''}</span></span>
      <span class="lb-amt ${cls}">${money(r.bankrollCents)}</span>
    </div>`;
  }).join('')}</div>`;
}
