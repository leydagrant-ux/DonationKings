// ui-league.js: league chrome, standings and the invite flow. Pure renderers.
//
// Split from ui.js because the lock card and the league are two different
// surfaces that happen to share a design system, and ui.js was getting long.

import { esc, money, signedMoney, ICONS, crownSVG } from './ui.js';
import { weekRange, isOwner, inviteLink, ROLE } from './league.js';

/**
 * The switcher. Being in several leagues at once is the normal case (the
 * group chat one, the work one), so this is always visible rather than
 * hidden behind a menu, and it ends with a button to start or join another.
 */
export function leagueSwitcherHTML(leagues, activeCode, uid) {
  return `<div class="chiprow leagues">
    ${leagues.map((l) => `
      <button class="chip league-chip" data-code="${esc(l.code)}" aria-pressed="${l.code === activeCode}">
        ${isOwner(l, uid) ? `<span class="owner-dot" title="You run this league"></span>` : ''}
        ${esc(l.name)}
        <span class="count">${l.members.length}</span>
      </button>`).join('')}
    <button class="chip add-league" data-action="new-league">${ICONS.add} League</button>
  </div>`;
}

/** Week header: which league, which week, and how to invite people to it. */
export function leagueHeaderHTML(league, weekKey, uid) {
  const owner = isOwner(league, uid);
  return `<div class="league-head">
    <div class="league-title">
      <h2>${esc(league.name)}</h2>
      ${owner ? `<span class="owner-tag">You run this</span>` : ''}
    </div>
    <p class="league-sub">
      ${esc(weekRange(weekKey))}
      <span class="dot-sep"></span>${league.members.length} ${league.members.length === 1 ? 'player' : 'players'}
    </p>
  </div>`;
}

/** Week / All time / History. */
/**
 * Which standings to show.
 *
 * "Weekly game" is named as a game on purpose. Everyone starting Monday with
 * the same $100 is a competition, and it used to be presented as the plain
 * fact about your money, which it is not: it resets every week and it ignores
 * what you actually staked. "All time" is the real record, and the Stats tab
 * is the same thing broken down.
 */
export function standingsModeHTML(mode) {
  const modes = [['week', 'This week'], ['all', 'All time'], ['history', 'History']];
  return `<div class="chiprow modes">
    ${modes.map(([id, label]) => `<button class="chip" data-mode="${id}" aria-pressed="${id === mode}">${label}</button>`).join('')}
  </div>`;
}

/**
 * The standings table.
 *
 * Ranked on profit, and reading the same way in every mode: the record, what
 * was put in, and what came back out of it. The weekly $100 bankroll used to
 * be the headline number here, which made a side competition look like the
 * fact about somebody's betting. It resets every Monday and takes no account
 * of what was actually staked, so it says very little.
 */
export function standingsHTML(rows, meUid, mode = 'week') {
  if (!rows.length) return `<div class="empty">${crownSVG()}<div>Nobody has placed a lock yet.</div></div>`;

  return `<div class="lb">${rows.map((r) => {
    const cls = r.profitCents > 0 ? 'up' : r.profitCents < 0 ? 'down' : '';
    const record = [
      `${r.won}-${r.lost}${r.pushed ? `-${r.pushed}` : ''}`,
      r.open ? `${r.open} live` : '',
      r.roi !== null ? `${r.roi > 0 ? '+' : ''}${Math.round(r.roi * 100)}% ROI` : '',
    ].filter(Boolean).join(' · ');

    return `<div class="lb-row ${r.rank === 1 ? 'lead' : ''} ${r.uid === meUid ? 'me' : ''}">
      <span class="lb-rank">${r.rank}</span>
      <span class="avatar sm">${esc(r.initials)}</span>
      <span class="lb-who">
        <span class="lb-name">${esc(r.name)}${r.role === ROLE.OWNER ? '<span class="crown-mini" title="League owner"></span>' : ''}</span>
        <span class="lb-sub">${esc(record)}</span>
      </span>
      <span class="lb-right">
        <span class="lb-amt ${cls}">${signedMoney(r.profitCents)}</span>
        <span class="lb-risk">${money(r.stakedCents)} wagered${r.atRiskCents ? `, ${money(r.atRiskCents)} live` : ''}</span>
      </span>
    </div>`;
  }).join('')}</div>`;
}

/** Past weeks, newest first, with who took each one. */
export function historyHTML(weeks) {
  if (!weeks.length) return `<div class="empty">${crownSVG()}<div>No completed weeks yet.</div></div>`;
  return `<div class="lb">${weeks.map((w) => `
    <div class="lb-row history">
      <span class="lb-rank">${esc(w.weekKey.split('-W')[1])}</span>
      <span class="avatar sm">${esc(w.winner ? w.winner.initials : '?')}</span>
      <span class="lb-who">
        <span class="lb-name">${esc(w.winner ? w.winner.name : 'No winner')}</span>
        <span class="lb-sub">${esc(w.range)}</span>
      </span>
      <span class="lb-right"><span class="lb-amt up">${w.winner ? money(w.winner.bankrollCents) : ''}</span></span>
    </div>`).join('')}</div>`;
}

/**
 * The invite card. The code is the league's id and is unguessable, which is
 * the whole access model, so it is shown big and copyable rather than buried.
 */
export function inviteCardHTML(league, base) {
  return `<div class="invite">
    <div class="invite-label">Invite code</div>
    <div class="invite-code">${esc(league.code)}</div>
    <div class="invite-actions">
      <button class="ghostbtn" data-action="copy-code" data-code="${esc(league.code)}">Copy code</button>
      <button class="ghostbtn primary" data-action="share-link" data-link="${esc(inviteLink(league.code, base))}">${ICONS.share} Share link</button>
    </div>
    <p class="invite-note">Anyone with this code can join and see the standings.</p>
  </div>`;
}

/** Create and join, side by side, the way the poker app does it. */
export function leagueFormsHTML(mode) {
  return `<div class="league-forms">
    <div class="chiprow modes">
      <button class="chip" data-form="join" aria-pressed="${mode === 'join'}">Join a league</button>
      <button class="chip" data-form="create" aria-pressed="${mode === 'create'}">Start one</button>
    </div>
    ${mode === 'create' ? `
      <div class="card form">
        <label class="field"><span>League name</span>
          <input id="lg-name" placeholder="Sunday Degenerates" maxlength="60" autocomplete="off"></label>
        <label class="field"><span>Weekly bankroll</span>
          <input id="lg-bank" type="number" inputmode="decimal" value="100" min="1" step="1"></label>
        <p class="field-note">Everyone starts each week with this much. It can only be changed before the first lock is placed.</p>
        <button class="bigbtn" data-action="create-league">Start league</button>
      </div>` : `
      <div class="card form">
        <label class="field"><span>Invite code</span>
          <input id="lg-code" placeholder="ABC234" maxlength="7" autocomplete="off"
                 style="text-transform:uppercase;letter-spacing:.18em;font-weight:800"></label>
        <p class="field-note">Six characters, from whoever runs the league.</p>
        <button class="bigbtn" data-action="join-league">Join</button>
      </div>`}
  </div>`;
}

/**
 * Owner controls. Deliberately plain and a little boring: these change other
 * people's standings, so none of them should be a one-tap affordance sitting
 * next to the fun parts of the app.
 */
export function ownerPanelHTML(league, uid) {
  if (!isOwner(league, uid)) return '';
  const others = league.members.filter((m) => m.uid !== uid);
  return `<details class="owner-panel">
    <summary>League settings</summary>
    <div class="owner-body">
      <label class="field"><span>League name</span>
        <input id="lg-rename" value="${esc(league.name)}" maxlength="60"></label>
      <button class="ghostbtn" data-action="rename-league">Save name</button>

      <div class="owner-members">
        <div class="field-note">Members</div>
        ${others.length ? others.map((m) => `
          <div class="owner-member">
            <span class="avatar sm">${esc((m.name || '?').slice(0, 2).toUpperCase())}</span>
            <span>${esc(m.name)}</span>
            <button class="linkbtn danger" data-action="remove-member" data-uid="${esc(m.uid)}">Remove</button>
            <button class="linkbtn" data-action="hand-over" data-uid="${esc(m.uid)}">Make owner</button>
          </div>`).join('') : '<div class="field-note">Nobody else has joined yet.</div>'}
      </div>
    </div>
  </details>`;
}
