// ui-entry.js: adding a lock by hand.
//
// Legs are typed the way a book words them ("Jordan Love Over 249.5 Passing
// Yards") rather than assembled from dropdowns. That is on purpose: the
// parser already understands that wording, it is the same text a screenshot
// will eventually produce, and three selects per leg would make entering a
// six-leg lock a chore nobody does twice.

import { esc, money, americanStr, ICONS } from './ui.js';
import { parseLegText, matchStat } from './resolve.js';
import { parlayDecimal, boostedReturnCents, impliedProb, parseAmerican } from './odds.js';
import { LEAGUES } from './espn.js';

const SPORTS = [['nfl', 'NFL'], ['cfb', 'CFB'], ['nba', 'NBA'], ['cbb', 'CBB']];

export function emptyDraft(code) {
  return { code, stakeCents: 1000, boostPct: 0, picks: [{ text: '', league: 'nfl', odds: '' }] };
}

/**
 * What the parser made of a typed leg, shown live underneath the field.
 *
 * This is the honest feedback loop: if the app cannot tell what you meant, it
 * says so while you are still typing rather than at grading time, when the
 * money is already committed.
 */
function readback(pick) {
  const text = String(pick.text || '').trim();
  if (!text) return { kind: 'empty', label: '' };
  const sport = (LEAGUES[pick.league] || {}).sport || 'football';
  const p = parseLegText(text, sport);
  if (!p.market) return { kind: 'bad', label: 'not recognized yet' };

  const stat = p.stat ? (matchStat(text, sport) ? p.stat : p.stat) : null;
  const bits = [];
  if (p.market === 'moneyline') bits.push('moneyline');
  else if (p.market === 'spread') bits.push(`spread ${p.line > 0 ? '+' : ''}${p.line}`);
  else if (p.market === 'game_total') bits.push(`game total ${p.side} ${p.line}`);
  else if (p.market === 'team_total') bits.push(`team total ${p.side} ${p.line}`);
  else if (p.market === 'player_yes_no') bits.push(stat === 'anytimeTd' ? 'anytime touchdown' : String(stat));
  else if (p.market === 'first_td') bits.push('first touchdown');
  else if (p.market === 'player_ou') bits.push(`${p.side} ${p.line} ${stat}`);
  if (p.subjectRaw && p.market !== 'game_total') bits.unshift(p.subjectRaw);
  return { kind: 'ok', label: bits.join(' · ') };
}

function legRowHTML(pick, i, count) {
  const r = readback(pick);
  return `<div class="entry-leg" data-i="${i}">
    <div class="entry-leg-top">
      <select class="entry-sport" data-i="${i}" aria-label="League">
        ${SPORTS.map(([v, l]) => `<option value="${v}" ${v === pick.league ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input class="entry-text" data-i="${i}" value="${esc(pick.text)}" autocomplete="off"
             placeholder="${i === 0 ? 'Packers ML' : 'Tucker Kraft Anytime TD'}" aria-label="Selection">
      <input class="entry-odds" data-i="${i}" value="${esc(pick.odds)}" inputmode="numeric"
             placeholder="-110" aria-label="Odds">
      ${count > 1 ? `<button class="entry-del" data-action="del-leg" data-i="${i}" aria-label="Remove leg">✕</button>` : ''}
    </div>
    ${r.kind !== 'empty' ? `<div class="entry-read ${r.kind}">${r.kind === 'ok' ? '' : '⚠ '}${esc(r.label)}</div>` : ''}
  </div>`;
}

export function entryFormHTML(draft, leagues) {
  const odds = draft.picks.map((p) => parseAmerican(p.odds)).filter((o) => o !== null);
  const complete = draft.picks.filter((p) => String(p.text || '').trim() && parseAmerican(p.odds) !== null);
  const priced = complete.length === draft.picks.length && draft.picks.length > 0;
  const dec = priced ? parlayDecimal(odds) : null;
  const toWin = dec ? boostedReturnCents(draft.stakeCents, dec, draft.boostPct) : null;

  return `<div class="entry">
    ${leagues.length > 1 ? `
      <label class="field"><span>Counts in</span>
        <select id="entry-league">
          ${leagues.map((l) => `<option value="${esc(l.code)}" ${l.code === draft.code ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </label>` : ''}

    <div class="field">
      <span>Legs</span>
      <div class="entry-legs">${draft.picks.map((p, i) => legRowHTML(p, i, draft.picks.length)).join('')}</div>
      <button class="ghostbtn" data-action="add-leg">${ICONS.add} Add leg</button>
    </div>

    <div class="entry-money">
      <label class="field"><span>Stake</span>
        <input id="entry-stake" inputmode="decimal" value="${(draft.stakeCents / 100).toFixed(2)}"></label>
      <label class="field"><span>Boost %</span>
        <input id="entry-boost" inputmode="numeric" value="${draft.boostPct || 0}"></label>
    </div>

    <div class="entry-summary ${priced ? '' : 'muted'}">
      ${priced
        ? `<span>${draft.picks.length} ${draft.picks.length === 1 ? 'leg' : 'legs'} at <b>${americanStr(Math.round((dec >= 2 ? (dec - 1) * 100 : -100 / (dec - 1))))}</b></span>
           <span>To win <b>${money(toWin)}</b></span>
           <span class="entry-prob">${Math.round(impliedProb(dec) * 1000) / 10}% implied</span>`
        : '<span>Fill in every leg and its price to see the payout.</span>'}
    </div>

    <button class="bigbtn" data-action="save-lock" ${priced ? '' : 'disabled'}>Add lock</button>
    <button class="linkbtn" data-action="cancel-lock">Cancel</button>
  </div>`;
}
