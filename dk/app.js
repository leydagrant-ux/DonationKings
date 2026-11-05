// app.js: state, routing and event wiring. The only stateful module.
//
// Three structural choices worth keeping:
//
//   * ONE delegated listener on the root, bound once, never re-bound. The
//     sibling bankroll app re-attached handlers on every render and ended up
//     firing a single tap three times. Here render only replaces innerHTML
//     and the listener is untouched.
//
//   * Render is a pure function of state plus fetched data. Grading, pricing
//     and standings are all recomputed from scratch, so nothing graded is
//     ever persisted and later believed.
//
//   * Local and cloud are one async surface (backend.js). The app never
//     branches on which one it has, so the signed-out path cannot quietly rot
//     while the signed-in one gets all the attention.

import * as S from './store.js';
import * as F from './feed.js';
import * as L from './league.js';
import * as D from './derive.js';
import * as UI from './ui.js';
import * as LG from './ui-league.js';
import * as EN from './ui-entry.js';
import * as IN from './ingest.js';
import * as AUTH from './auth.js';
import * as API from './api.js';
import { localBackend, cloudBackend } from './backend.js';
import { isConfigured } from './config.js';
import { STATE } from './grade.js';
import { parseAmerican } from './odds.js';
import { LEAGUES } from './espn.js';
import { parseLegText } from './resolve.js';
import { autoprice, repayout, flipSide } from './slip.js';
import * as ST from './stats.js';
import * as SV from './ui-stats.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const CLOUD = isConfigured() && !DEMO;

let state = null;
let ctx = { events: [], snapshots: [], errors: [] };

// Lock ids whose legs are folded away. Kept in memory rather than stored:
// folding is how you want the screen to look right now, not a setting, and
// one that survived a reload would hide legs you had forgotten you hid.
const folded = new Set();

// Today's games with their betting lines, used only to price the entry form.
// Kept apart from `ctx` because `ctx` is replaced wholesale on every refresh
// to match exactly what the open locks need, and that would throw away the
// slate for a league nobody has a lock in yet.
let slate = [];
let draft = null;
let loading = false;
let pollTimer = null;
let banner = null;
let user = null; // the signed-in account, when there is one
let authMode = 'in'; // 'in' | 'up'
// The name typed on the sign-up form. Firebase's updateProfile has not
// necessarily propagated by the time onAuthStateChanged fires, so without
// this the new account's display name falls back to its email address.
let pendingName = null;
// The screenshot path. `scan` is null when typing, otherwise it holds the
// stage: picking a file, or confirming what was read.
let scan = null;
let be = null;
let syncing = false;
const settleTried = new Set();

/* ============================== state ============================== */

function persist() {
  if (DEMO || (be && be.kind === 'cloud')) return; // the server owns cloud state
  if (!S.save(localStorage, state)) {
    banner = 'This browser will not save data, so nothing here will persist.';
  }
}

function setState(next, { save = true } = {}) {
  state = next;
  if (save) persist();
  render();
}

const setUI = (patch) => setState({ ...state, ui: { ...state.ui, ...patch } });

function toast(msg) {
  banner = msg;
  render();
  setTimeout(() => { if (banner === msg) { banner = null; render(); } }, 3600);
}

/* ============================== data ============================== */

/** Pull leagues and locks from whichever backend is in play. */
async function sync() {
  if (!be) return;
  syncing = true;
  render();
  const r = await be.load();
  syncing = false;
  if (r && r.ok === false) {
    if (r.needsAuth) { user = null; render(); return; }
    toast(r.error || 'Could not load your leagues.');
    return;
  }
  if (r && r.membership) {
    state = { ...state, membership: r.membership, locks: r.locks || [] };
  }
  render();
  await refresh();
}

async function refresh() {
  const mine = state.locks.filter((l) => !l.settledState && (l.picks || []).length);
  if (!mine.length) { ctx = { events: [], snapshots: [], errors: [] }; render(); return; }
  loading = true;
  render();
  // Demo mode reads the committed fixtures, so the screens are stable and do
  // not depend on what happens to be playing today.
  ctx = DEMO ? await F.loadFixtureContext() : await F.loadContext(mine);
  loading = false;
  render();
  await reportSettlements();
  schedulePoll();
}

// Leagues whose slate has already been pulled, so typing in the entry form
// does not refetch on every change.
const slateLoaded = new Set();

// Loaded as soon as the entry form opens. The other leagues load when their
// leg is actually switched to them, because a November college basketball
// scoreboard is several hundred games and nobody should pay for that slate
// just to price an NFL moneyline.
const ENTRY_LEAGUES = ['nfl', 'nba'];

/**
 * Make sure the entry form can quote a price for these leagues.
 *
 * The grading path loads only what open locks already reference, which is
 * nothing at all in a brand new league. Without this, the very first lock
 * anybody writes is the one lock the app cannot offer a price for, which is
 * exactly the one where it matters most.
 *
 * Fire and forget: it re-renders when the prices land, so opening the form
 * stays instant on a slow connection instead of waiting on the network.
 */
async function ensureSlate(leagues) {
  if (DEMO) return; // fixtures carry no odds, and demo must not hit the network
  const want = [...new Set((leagues || []).filter((lg) => lg && !slateLoaded.has(lg)))];
  if (!want.length) return;
  let added = false;
  await Promise.all(want.map(async (lg) => {
    const { events, errors } = await F.loadSlates([lg]);
    // Only remember a league as loaded when it actually loaded, so a dropped
    // request on a phone retries rather than leaving prices off for good.
    if (!errors.length) slateLoaded.add(lg);
    if (!events.length) return;
    const byId = new Map(slate.map((e) => [e.eventId, e]));
    for (const e of events) if (!byId.has(e.eventId)) byId.set(e.eventId, e);
    slate = [...byId.values()];
    added = true;
  }));
  if (!added) return;
  // Prices arriving is the whole point of the fetch, so apply them to
  // whatever is on the form right now rather than waiting for the next
  // keystroke to notice the slate turned up.
  if (draft) draft = repayout(autoprice(draft, pricingEvents()));
  if (draft || scan) render();
}

/** The leagues the open draft needs priced. */
const draftLeagues = () => [...ENTRY_LEAGUES, ...((draft && draft.picks) || []).map((p) => p.league)];

/**
 * The slate the entry form prices against.
 *
 * The grading context comes first, because those events were loaded for a
 * lock that is already open and are the ones being polled; the entry slate
 * fills in the leagues no open lock mentions.
 */
function pricingEvents() {
  const byId = new Map(slate.map((e) => [e.eventId, e]));
  for (const e of ctx.events) byId.set(e.eventId, e);
  return [...byId.values()];
}

/**
 * Tell the server about locks that have finished.
 *
 * Grading runs on each client, so two phones could in principle disagree.
 * Whoever sees the games finish first writes the record and everyone else's
 * call is a no-op that returns what is already stored, which is what makes
 * the standings agree. The write is idempotent server-side; the Set here just
 * avoids asking twice in one session.
 */
async function reportSettlements() {
  if (!be || be.kind !== 'cloud' || !user) return;
  for (const d of derived()) {
    if (d.uid !== state.me.uid || d.summaryOnly) continue;
    if (!d.roll || !d.roll.final || d.settledState) continue;
    if (settleTried.has(d.id)) continue;
    settleTried.add(d.id);
    const r = await be.settleLock(d.id, d.state, d.returnCents || 0);
    if (r && r.ok && !r.already) await sync();
  }
}

/** Poll only while something is actually running. */
function schedulePoll() {
  clearTimeout(pollTimer);
  const live = F.anyLive(ctx.snapshots, ctx.events);
  const open = derived().some(isOpen);
  if (!live || !open) return;
  pollTimer = setTimeout(async () => {
    ctx = DEMO
      ? await F.loadFixtureContext()
      : await F.loadContext(state.locks.filter((l) => !l.settledState && (l.picks || []).length));
    render();
    await reportSettlements();
    schedulePoll();
  }, 30000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
  else clearTimeout(pollTimer);
});

/* ============================== derived ============================== */

const league = () => L.activeLeague(state.membership);
const weekKey = () => L.currentWeekKey();
const derived = () => D.deriveAll(state.locks, ctx);

const isOpen = D.isOpenLock;

function myLocks() {
  const lg = league();
  // Scoped by uid, so `summaryOnly` can only ever have excluded MY OWN
  // settled locks here. It did exactly that: a parlay vanished the moment
  // it won. A lock I placed stays mine whether it is running or finished.
  return derived().filter((d) => d.uid === state.me.uid && (!lg || d.code === lg.code));
}

function standingsRows(mode) {
  const lg = league();
  if (!lg) return [];
  const rows = D.toLedgerRows(derived());
  return mode === 'all' ? L.allTimeStandings(lg, rows) : L.standings(lg, rows, weekKey());
}

function myBankroll() {
  const row = standingsRows('week').find((r) => r.uid === state.me.uid);
  return row ? row.bankrollCents : (league() ? league().startBankrollCents : 0);
}

/**
 * Every lock of mine, across every league I am in.
 *
 * The header tallies and the stats screen are about my betting, not about
 * one competition, so they deliberately ignore which league a lock counts
 * for. `myLocks()` is scoped to the active league; this is not.
 */
function myLocksEverywhere() {
  return derived().filter((d) => d.uid === state.me.uid);
}

const myRecord = () => ST.recordOf(myLocksEverywhere());

/* ============================== render ============================== */

function authViewHTML() {
  const up = authMode === 'up';
  // Somebody arriving from an invite link should be told that is what is
  // happening, rather than being shown a bare sign-in box and left to guess.
  let invited = null;
  try { invited = sessionStorage.getItem('dk.pendingJoin'); } catch { invited = null; }

  return `<div class="section"><h2>${up ? 'Make an account' : 'Sign in'}</h2>
    <p>${invited
      ? `You have been invited to a league. ${up ? 'Make an account' : 'Sign in'} and you will join it straight away.`
      : (up ? 'So your friends can see your locks on the standings.' : 'Your leagues follow you to any device.')}</p></div>
    ${invited ? `<div class="notice">Joining league <b>${UI.esc(invited)}</b> once you are in.</div>` : ''}
    <div class="card form">
      ${up ? `<label class="field"><span>Name</span>
        <input id="au-name" placeholder="Grant" maxlength="30" autocomplete="name"></label>` : ''}
      <label class="field"><span>Email</span>
        <input id="au-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"></label>
      <label class="field"><span>Password</span>
        <input id="au-pass" type="password" autocomplete="${up ? 'new-password' : 'current-password'}"
               placeholder="${up ? 'at least six characters' : ''}"></label>
      <button class="bigbtn" data-action="${up ? 'do-signup' : 'do-signin'}">${up ? 'Create account' : 'Sign in'}</button>
      <button class="linkbtn" data-action="toggle-auth">${up ? 'I already have an account' : 'Make an account instead'}</button>
      ${up ? '' : '<button class="linkbtn" data-action="reset-pass">Forgot password</button>'}
    </div>`;
}

function noLeagueHTML() {
  return `<div class="section"><h2>Start here</h2>
    <p>Make a league for your group, or join one with a code. You can be in as many as you like.</p></div>
    ${be && be.kind === 'local' ? `<div class="card form" style="margin-bottom:14px">
      <label class="field"><span>Your name</span>
        <input id="me-name" value="${UI.esc(state.me.name === 'You' ? '' : state.me.name)}"
               placeholder="Grant" maxlength="30" autocomplete="name"></label>
      <p class="field-note">This is what your friends see on the standings.</p>
      <button class="ghostbtn" data-action="save-name">Save name</button>
    </div>` : ''}
    ${LG.leagueFormsHTML(state.ui.formMode)}`;
}

function leagueViewHTML() {
  const lg = league();
  if (!lg) return noLeagueHTML();
  const mode = state.ui.mode;
  const rows = standingsRows(mode === 'all' ? 'all' : 'week');

  return [
    LG.leagueSwitcherHTML(L.leagueList(state.membership, state.me.uid), state.membership.activeCode, state.me.uid),
    LG.leagueHeaderHTML(lg, weekKey(), state.me.uid),
    LG.standingsModeHTML(mode),
    mode === 'history'
      ? LG.historyHTML(L.weekHistory(lg, D.toLedgerRows(derived())).filter((w) => w.weekKey !== weekKey()))
      : mode === 'live'
        ? leagueLiveHTML()
        : LG.standingsHTML(rows, state.me.uid, mode === 'all' ? 'all' : 'week', {
          openUid: state.ui.openMember || null,
          cardsFor: memberBoardHTML,
        }),
    mode === 'week' ? LG.inviteCardHTML(lg) : '',
    mode === 'week' ? LG.ownerPanelHTML(lg, state.me.uid) : '',
    state.ui.showForms ? LG.leagueFormsHTML(state.ui.formMode) : '',
  ].join('');
}

function locksViewHTML(onlyLive) {
  const lg = league();
  if (!lg) return noLeagueHTML();

  // The screenshot path, which runs before the form.
  if (scan && scan.stage === 'pick') {
    return `<div class="section"><h2>New lock</h2><p>Add a screenshot and it reads the slip for you.</p></div>`
      + `<div class="card form">${EN.scanStartHTML(scan.busy, scan.error)}</div>`;
  }
  if (scan && scan.stage === 'confirm') {
    return `<div class="section"><h2>Check what it read</h2><p>Against your screenshot, before anything is saved.</p></div>`
      + `<div class="card form">${EN.scanConfirmHTML(scan)}</div>`;
  }

  if (draft) {
    return `<div class="section"><h2>New lock</h2><p>Type each leg the way the book words it.</p></div>`
      + `<div class="card form">${EN.entryFormHTML(draft, L.leagueList(state.membership, state.me.uid), pricingEvents())}</div>`;
  }

  let list = myLocks();
  if (onlyLive) list = list.filter(isOpen).sort(D.byCloseness);

  const head = onlyLive
    ? `<div class="section"><h2>Live</h2><p>${list.length ? 'Closest to cashing first.' : 'Nothing running right now.'}</p></div>`
    : `<div class="section"><h2>My Locks</h2><p>${UI.esc(lg.name)}${loading ? ', loading games' : ''}</p></div>`;

  if (!list.length) {
    return head + `<div class="empty">${UI.crownSVG()}
      <div>${onlyLive ? 'No live locks.' : 'No locks yet this week.'}</div>
      <button class="ghostbtn" data-action="new-lock" style="margin-top:14px">Add your first lock</button></div>`;
  }

  return head
    + (ctx.errors.length ? `<div class="notice">${UI.esc(ctx.errors[0])}</div>` : '')
    + `<div class="cards">${list.map((d) => UI.lockCardHTML(d, { collapsed: folded.has(d.id) })).join('')}</div>`;
}

/**
 * What one member of the league has running, under their standings row.
 *
 * Everyone's locks are already here: the league call returns every lock with
 * its legs, and the slate is already loaded for all of them because the
 * grader needs it. So this is a filter over work already done rather than
 * anything new being fetched.
 *
 * Live ones first and closest to cashing at the top, which is the order you
 * actually want when somebody is sweating a parlay. Settled ones are folded
 * away, because the point of opening a name is to see what is still alive.
 */
function memberBoardHTML(row) {
  const lg = league();
  const mine = derived().filter((d) => d.uid === row.uid && (!lg || d.code === lg.code));
  const live = mine.filter(isOpen).sort(D.byCloseness);
  const done = mine.filter((d) => !isOpen(d));

  if (!mine.length) {
    return `<p class="lb-empty">${UI.esc(row.name)} has not placed anything this week.</p>`;
  }
  if (!live.length) {
    return `<p class="lb-empty">Nothing running. ${done.length} settled this week.</p>`;
  }

  return `<p class="lb-open-note">${live.length} running${done.length ? `, ${done.length} settled` : ''}</p>`
    + `<div class="cards">${live.map((d) => UI.lockCardHTML(d, { collapsed: folded.has(d.id) })).join('')}</div>`;
}

/**
 * Everything the whole league has running, in one list.
 *
 * Closest to cashing at the top, regardless of whose it is, with a name over
 * each one. That ordering is the point: on a Sunday afternoon the question
 * is not "what has Jamal got on", it is "what is about to happen", and the
 * answer is usually somebody else's parlay one leg away.
 */
function leagueLiveHTML() {
  const lg = league();
  const names = new Map((lg.members || []).map((m) => [m.uid, m]));
  const live = derived()
    .filter((d) => d.code === lg.code && isOpen(d))
    .sort(D.byCloseness);

  const head = `<div class="section"><h2>Live locks</h2><p>${live.length
    ? 'Everyone in the league, closest to cashing first.'
    : `Nothing running in ${UI.esc(lg.name)} right now.`}</p></div>`;

  if (!live.length) {
    return head + `<div class="empty">${UI.crownSVG()}<div>When anyone places a lock it shows up here.</div></div>`;
  }

  return head + `<div class="cards">${live.map((d) => {
    const who = names.get(d.uid);
    const name = who ? who.name : 'Someone';
    const mine = d.uid === state.me.uid;
    return `<div class="owned">
      <div class="owned-by ${mine ? 'me' : ''}">
        <span class="avatar sm">${UI.esc(L.initialsOf(name))}</span>
        <span class="owned-name">${UI.esc(mine ? 'You' : name)}</span>
        ${d.live ? '<span class="owned-live">LIVE</span>' : ''}
      </div>
      ${UI.lockCardHTML(d, { collapsed: folded.has(d.id) })}
    </div>`;
  }).join('')}</div>`;
}

function statsViewHTML() {
  return SV.statsHTML(ST.report(myLocksEverywhere()), {
    sort: state.ui.statSort || {},
    sortRows: ST.sortRows,
    titleOf: (l) => UI.lockTitle((l.picks || []).length),
  });
}

function render() {
  if (!root) return;
  const tab = state.ui.tab;
  const liveCount = myLocks().filter(isOpen).length;
  const needAuth = CLOUD && !user;

  // Until there is a league, every tab would render the same "Start here"
  // screen, so tapping them looks like nothing happens. There is exactly one
  // thing to do at that point, so show only that and hide the navigation.
  const noLeague = !needAuth && !league();
  const chrome = !needAuth && !noLeague;

  const body = needAuth ? authViewHTML()
    : noLeague ? noLeagueHTML()
      : tab === 'League' ? leagueViewHTML()
        : tab === 'Stats' ? statsViewHTML()
          : tab === 'Live' ? locksViewHTML(true)
            : locksViewHTML(false);

  const scroll = window.scrollY;
  root.innerHTML = [
    UI.appBarHTML({ ...myRecord(), initials: state.me.initials }),
    chrome ? UI.tabsHTML(['My Locks', 'Live', 'League', 'Stats'], tab) : '',
    banner ? `<div class="notice warn">${UI.esc(banner)}</div>` : '',
    DEMO ? '<div class="notice">Demo data. Nothing here is saved.</div>' : '',
    !CLOUD && !DEMO
      ? '<div class="notice">Running on this device only. Fill in dk/config.js to share leagues with your friends.</div>'
      : '',
    syncing ? '<div class="notice">Loading your leagues...</div>' : '',
    body,
    chrome ? UI.tabBarHTML(tab, liveCount ? { Live: liveCount } : {}) : '',
  ].join('');
  window.scrollTo(0, scroll);
}

/* ============================== events ============================== */

const val = (id) => {
  const el = document.getElementById(id);
  return el ? el.value : '';
};
const centsFrom = (text) => Math.round(parseFloat(String(text).replace(/[^0-9.]/g, '')) * 100) || 0;

/** Set the display name, keeping it in step across every league you are in. */
function setName(name) {
  const n = String(name || '').trim().slice(0, 30);
  if (!n) return toast('A name cannot be empty.');
  const leagues = {};
  for (const [code, lg] of Object.entries(state.membership.leagues)) {
    leagues[code] = { ...lg, members: lg.members.map((m) => (m.uid === state.me.uid ? { ...m, name: n } : m)) };
  }
  setState({
    ...state,
    me: { ...state.me, name: n, initials: L.initialsOf(n) },
    membership: { ...state.membership, leagues },
  });
  if (be && be.kind === 'cloud') API.me(n).then(() => sync());
  return undefined;
}

root.addEventListener('click', async (e) => {
  // The avatar is the way back to your name and to signing out.
  if (e.target.closest('.appbar .avatar')) {
    if (CLOUD && user) {
      if (confirm(`Signed in as ${user.email || state.me.name}. Sign out?`)) {
        await AUTH.signOut();
        settleTried.clear();
        return;
      }
      const n = prompt('Your name, as your friends see it:', state.me.name);
      if (n !== null) setName(n);
      return;
    }
    const n = prompt('Your name, as your friends see it on the standings:', state.me.name === 'You' ? '' : state.me.name);
    if (n !== null) setName(n);
    return;
  }

  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;

  /* -- auth -- */
  if (action === 'toggle-auth') { authMode = authMode === 'in' ? 'up' : 'in'; return render(); }
  if (action === 'do-signin' || action === 'do-signup') {
    const email = val('au-email');
    const pass = val('au-pass');
    if (!email || !pass) return toast('Email and password, please.');
    btn.disabled = true;
    const typedName = val('au-name').trim();
    if (action === 'do-signup' && typedName) pendingName = typedName;
    const r = action === 'do-signup'
      ? await AUTH.signUp(email, pass, typedName)
      : await AUTH.signIn(email, pass);
    btn.disabled = false;
    if (!r.ok) return toast(r.error);
    return undefined; // onAuth drives the rest
  }
  if (action === 'reset-pass') {
    const email = val('au-email');
    if (!email) return toast('Enter your email first.');
    const r = await AUTH.resetPassword(email);
    return toast(r.ok ? 'Check your email for a reset link.' : r.error);
  }
  if (action === 'save-name') return setName(val('me-name'));

  /* -- navigation -- */
  if (btn.classList.contains('tab')) return setUI({ tab: btn.textContent.trim() });
  if (btn.closest('.tabbar')) {
    const label = btn.querySelector('span:last-child').textContent.trim();
    if (label === 'Add') {
      scan = CLOUD && user ? { stage: 'pick', busy: false } : null;
      draft = scan ? null : EN.emptyDraft(league() ? league().code : null);
      ensureSlate(ENTRY_LEAGUES);
      return setUI({ tab: 'My Locks' });
    }
    // Leaving a half-finished entry by tapping a tab should drop it rather
    // than keeping it pinned over whatever you switched to.
    draft = null;
    scan = null;
    return setUI({ tab: label });
  }

  /* -- league chrome -- */
  if (btn.dataset.code && btn.classList.contains('league-chip')) {
    setState({ ...state, membership: L.setActive(state.membership, btn.dataset.code) });
    if (be.kind === 'cloud') await sync();
    return undefined;
  }
  if (btn.dataset.mode) return setUI({ mode: btn.dataset.mode });
  if (btn.dataset.form) return setUI({ formMode: btn.dataset.form, showForms: true });
  if (action === 'new-league') return setUI({ showForms: !state.ui.showForms, formMode: 'create' });

  /* -- league create / join -- */
  if (action === 'create-league') {
    const name = val('lg-name').trim() || 'New League';
    const cents = centsFrom(val('lg-bank') || '100') || L.DEFAULT_BANKROLL_CENTS;
    btn.disabled = true;
    const r = await be.createLeague(name, cents);
    btn.disabled = false;
    if (!r.ok) return toast(r.error || 'Could not create that league.');
    setState({ ...state, ui: { ...state.ui, showForms: false, tab: 'League' } });
    if (be.kind === 'cloud') await sync();
    // Switch to the league just made, in both modes. Without this the server
    // reload keeps whatever was already active, so you create a league and
    // the screen still shows the old one, invite code included.
    setState({ ...state, membership: L.setActive(state.membership, r.league.code) });
    return toast(`${name} created. Share code ${r.league.code}.`);
  }

  if (action === 'join-league') {
    const code = L.normalizeCode(val('lg-code'));
    if (!code) return toast('That code does not look right. Six characters, no O, 0, I, 1 or L.');
    btn.disabled = true;
    const r = await be.joinLeague(code);
    btn.disabled = false;
    if (!r.ok) return toast(r.error || 'Could not join that league.');
    setState({ ...state, ui: { ...state.ui, showForms: false, tab: 'League' } });
    if (be.kind === 'cloud') { await sync(); setState({ ...state, membership: L.setActive(state.membership, code) }); }
    else setState({ ...state, membership: L.setActive(state.membership, code) });
    if (r.localOnly) return toast('Joined on this device only. Sign in to share leagues.');
    return toast(r.already ? 'You are already in that league.' : 'Joined.');
  }

  /* -- invite -- */
  if (action === 'copy-code' || action === 'share-link') {
    const text = action === 'copy-code' ? btn.dataset.code : btn.dataset.link;
    try {
      if (action === 'share-link' && navigator.share) await navigator.share({ title: 'DonationKings', url: text });
      else { await navigator.clipboard.writeText(text); toast('Copied.'); }
    } catch { toast(text); }
    return undefined;
  }

  /* -- owner controls -- */
  if (action === 'rename-league') {
    const r = await be.renameLeague(league().code, val('lg-rename'));
    if (!r.ok) return toast(r.error);
    if (be.kind === 'cloud') await sync();
    return toast('Renamed.');
  }
  if (action === 'remove-member' || action === 'hand-over') {
    const fn = action === 'remove-member' ? be.removeMember : be.transferOwner;
    const r = await fn(league().code, btn.dataset.uid);
    if (!r.ok) return toast(r.error);
    if (be.kind === 'cloud') await sync();
    return undefined;
  }

  /* -- the screenshot path -- */
  if (action === 'type-instead') {
    scan = null;
    draft = EN.emptyDraft(league() ? league().code : null);
    ensureSlate(draftLeagues());
    return render();
  }
  if (action === 'scan-retry') { scan = { stage: 'pick', busy: false }; return render(); }
  if (action === 'scan-continue') {
    // Re-read from whatever the person edited, not from what the model said.
    const edited = document.getElementById('scan-text');
    const { draft: d } = IN.redraft(edited ? edited.value : scan.transcript, league() ? league().code : null);
    // Legs the slip priced keep that price: it is what the book actually
    // gave them, which a current quote is not. Only legs the screenshot left
    // unpriced get filled in from the feed.
    draft = repayout(autoprice(d, pricingEvents()));
    scan = null;
    ensureSlate(draftLeagues());
    return render();
  }

  /* -- lock entry -- */
  if (action === 'new-lock') {
    scan = CLOUD && user ? { stage: 'pick', busy: false } : null;
    draft = scan ? null : EN.emptyDraft(league() ? league().code : null);
    // Start pulling the slate now, even on the screenshot path, so the prices
    // are already there by the time the transcript is confirmed.
    ensureSlate(ENTRY_LEAGUES);
    return setUI({ tab: 'My Locks' });
  }
  if (action === 'cancel-lock') { draft = null; scan = null; return render(); }
  if (action === 'add-leg') {
    draft = { ...draft, picks: [...draft.picks, { text: '', league: draft.picks[draft.picks.length - 1].league, odds: '' }] };
    return render();
  }
  if (action === 'open-member') {
    const uid = btn.dataset.uid;
    return setUI({ openMember: state.ui.openMember === uid ? null : uid });
  }
  if (action === 'sort-stats') {
    const { kind, key } = btn.dataset;
    const cur = (state.ui.statSort || {})[kind] || { key: 'stakedCents', dir: 'desc' };
    // Tapping the column you are already on turns it around; a new column
    // starts biggest first, which is what you want every time but one.
    const dir = cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : 'desc';
    return setUI({ statSort: { ...(state.ui.statSort || {}), [kind]: { key, dir } } });
  }
  if (action === 'fold-lock') {
    const id = btn.dataset.id;
    if (folded.has(id)) folded.delete(id); else folded.add(id);
    return render();
  }
  if (action === 'set-side') {
    readDraftInputs();
    const i = Number(btn.dataset.i);
    const want = btn.dataset.side;
    draft = {
      ...draft,
      picks: draft.picks.map((p, j) => {
        if (j !== i) return p;
        const sport = (LEAGUES[p.league] || {}).sport || 'football';
        const now = parseLegText(p.text, sport).side;
        // Choosing the side it already has is not a correction, but it does
        // settle the question, so the "we guessed this" mark comes off.
        if (now === want) return { ...p, assumedSide: false };
        return { ...p, text: flipSide(p.text), assumedSide: false };
      }),
    };
    return render();
  }
  if (action === 'del-leg') {
    draft = { ...draft, picks: draft.picks.filter((_, i) => i !== Number(btn.dataset.i)) };
    return render();
  }
  if (action === 'save-lock') {
    readDraftInputs();
    const lg = league();
    const lock = {
      ...S.newLock({
        code: draft.code || lg.code,
        uid: state.me.uid,
        stakeCents: draft.stakeCents,
        payoutCents: draft.payoutCents,
        picks: draft.picks.map((p) => ({ text: p.text.trim(), league: p.league, odds: parseAmerican(p.odds) })),
      }),
      weekKey: weekKey(),
    };
    // The earliest kickoff across the legs, so the server can judge whether
    // this got in before the games started. It decides, not us.
    const firstStart = earliestStart(lock);
    btn.disabled = true;
    const r = await be.addLock(lock, firstStart);
    btn.disabled = false;
    if (!r.ok) return toast(r.error || 'Could not save that lock.');
    draft = null;
    if (be.kind === 'cloud') await sync();
    else await refresh();
    if (r.eligible === false) toast('Saved, but a game had already started so it does not count this week.');
    return undefined;
  }

  /* -- grading and tidying -- */
  if (action === 'grade-leg') {
    const { id, i, verdict } = btn.dataset;
    const r = await be.overrideLeg(id, Number(i), verdict);
    if (!r.ok) return toast(r.error);
    if (be.kind === 'cloud') await sync();
    return undefined;
  }
  if (action === 'delete-lock') {
    if (!confirm('Delete this lock? It will come off the standings.')) return undefined;
    const r = await be.deleteLock(btn.dataset.id);
    if (!r.ok) return toast(r.error);
    if (be.kind === 'cloud') await sync();
    return undefined;
  }
  if (action === 'refresh') return refresh();
  return undefined;
});

/** The earliest resolved kickoff among a lock's legs, in ms, or null. */
function earliestStart(lock) {
  let best = null;
  for (const pick of lock.picks) {
    for (const e of ctx.events) {
      if (e.league !== pick.league || !e.startAt) continue;
      const text = String(pick.text || '').toLowerCase();
      const named = [e.home, e.away].some((t) => t && t.names.some((n) => {
        const nn = String(n).toLowerCase();
        return nn.length >= 3 && text.includes(nn);
      }));
      if (named && (best === null || e.startAt < best)) best = e.startAt;
    }
  }
  return best;
}

/** Draft fields are read back out of the DOM on demand, not on every keypress. */
function readDraftInputs() {
  if (!draft) return;
  const picks = draft.picks.map((p, i) => {
    const text = document.querySelector(`.entry-text[data-i="${i}"]`);
    const odds = document.querySelector(`.entry-odds[data-i="${i}"]`);
    const sport = document.querySelector(`.entry-sport[data-i="${i}"]`);
    return {
      text: text ? text.value : p.text,
      odds: odds ? odds.value : p.odds,
      league: sport ? sport.value : p.league,
      // The field no longer holding what we put in it means a person typed
      // over the top, and from then on the price is theirs, not the book's.
      oddsAuto: !!p.oddsAuto && (!odds || odds.value === p.odds),
    };
  });
  const stake = document.getElementById('entry-stake');
  const payout = document.getElementById('entry-payout');
  const code = document.getElementById('entry-league');

  // Same rule as a leg price: if the box no longer holds what we put there,
  // it came off a slip and is not ours to recompute.
  const shown = draft.payoutCents === null || draft.payoutCents === undefined
    ? '' : (draft.payoutCents / 100).toFixed(2);
  const typedPayout = payout && payout.value.trim() !== shown.trim();

  draft = {
    ...draft,
    code: code ? code.value : draft.code,
    stakeCents: stake ? centsFrom(stake.value) : draft.stakeCents,
    payoutCents: payout
      ? (payout.value.trim() ? centsFrom(payout.value) : null)
      : draft.payoutCents,
    payoutAuto: payout ? (draft.payoutAuto !== false && !typedPayout) : draft.payoutAuto,
    picks,
  };
}

// Re-render the draft on change rather than on input, so the readback updates
// without the field losing focus mid-word.
root.addEventListener('change', async (e) => {
  // A screenshot was picked.
  if (e.target.id === 'scan-file') {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    scan = { stage: 'pick', busy: true };
    render();
    let out;
    try {
      out = await IN.readFileToDraft(file, league() ? league().code : null);
    } catch (err) {
      out = { ok: false, error: (err && err.message) || 'Could not read that file.' };
    }
    if (!out.ok) { scan = { stage: 'pick', busy: false, error: out.error }; return render(); }
    scan = { stage: 'confirm', transcript: out.transcript, preview: out.preview, slip: out.slip, model: out.model };
    return render();
  }

  // The transcript was edited: re-read the legs from it, keeping the caret
  // where it was so editing does not fight the re-render.
  if (e.target.id === 'scan-text' && scan) {
    const { slip } = IN.redraft(e.target.value, league() ? league().code : null);
    scan = { ...scan, transcript: e.target.value, slip };
    return render();
  }

  if (!draft) return;
  if (e.target.matches('.entry-text, .entry-odds, .entry-sport, #entry-stake, #entry-payout, #entry-league')) {
    readDraftInputs();
    // Switching a leg to a league nobody has a lock in pulls that slate, so
    // the price for it appears a moment later.
    if (e.target.matches('.entry-sport')) ensureSlate(draftLeagues());
    draft = repayout(autoprice(draft, pricingEvents()));
    render();
  }
  return undefined;
});

/* ============================== boot ============================== */

const getState = () => state;

async function onSignedIn(u) {
  user = u;
  // What to call this person, best source first: what they just typed on the
  // sign-up form, then whatever Firebase has, then their local name. The
  // email is the last resort, not the default.
  const chosen = pendingName || u.name || (state.me.name !== 'You' ? state.me.name : null) || u.email || 'Player';
  pendingName = null;
  // The Firebase uid is the identity the standings key off, so it replaces
  // whatever local id this browser was using.
  state = { ...state, me: { ...state.me, uid: u.uid, name: chosen, initials: L.initialsOf(chosen) } };
  be = cloudBackend(getState);
  const r = await API.me(chosen);
  if (r.ok && r.name) state = { ...state, me: { ...state.me, name: r.name, initials: L.initialsOf(r.name) } };
  await sync();
}

function onSignedOut() {
  user = null;
  be = localBackend(getState, setState);
  state = S.load(localStorage) || S.freshState('You');
  render();
  refresh();
}

async function boot() {
  if (DEMO) {
    state = S.demoState(L.currentWeekKey());
    be = localBackend(getState, setState);
  } else {
    state = S.load(localStorage) || S.freshState('You');
    be = localBackend(getState, setState);
  }

  // An invite link lands straight on the league it names. In cloud mode the
  // join is deferred until after sign-in, because joining needs an account.
  const join = L.readJoinCode(location.search);
  if (join) {
    const u = new URL(location.href);
    u.searchParams.delete('join');
    history.replaceState(null, '', u);
    if (!CLOUD) {
      const r = await be.joinLeague(join);
      if (r.ok) banner = `Joined ${join} on this device. Sign in to share leagues.`;
    } else {
      sessionStorage.setItem('dk.pendingJoin', join);
    }
  }

  // A friend arriving from an invite link almost certainly has no account
  // yet, so open on sign-up rather than making them find the toggle.
  try { if (sessionStorage.getItem('dk.pendingJoin')) authMode = 'up'; } catch { /* private window */ }

  render();

  if (CLOUD) {
    await AUTH.onAuth(async (u) => {
      if (u) {
        await onSignedIn(u);
        const pending = sessionStorage.getItem('dk.pendingJoin');
        if (pending) {
          sessionStorage.removeItem('dk.pendingJoin');
          const r = await be.joinLeague(pending);
          if (r.ok) { await sync(); toast('Joined.'); } else toast(r.error || 'Could not join that league.');
        }
      } else {
        onSignedOut();
      }
    });
  } else {
    refresh();
  }
}

/* A new version arrived. Reloading outright would throw away a half-typed
 * lock, so this offers the reload instead and takes it only when nothing is
 * in progress. index.html calls this on `controllerchange`. */
window.__dkUpdateReady = () => {
  if (!draft && !scan) { location.reload(); return; }
  banner = 'A new version is ready. Finish this and reload when you are done.';
  render();
};

boot();
window.__dk = {
  get state() { return state; },
  get ctx() { return ctx; },
  get mode() { return be ? be.kind : null; },
  get user() { return user; },
  refresh, render, sync,
};
