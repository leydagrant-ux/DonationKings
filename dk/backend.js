// backend.js: one async surface, two implementations.
//
// `local` keeps everything in this browser. `cloud` talks to the Worker. The
// app calls the same methods either way and never branches on which it got,
// which is the pattern the sibling bankroll app used to keep its demo mode and
// its real mode from drifting apart.
//
// The split is deliberate rather than a fallback: the app is fully usable
// signed out, it just cannot share a league. Signing in is what makes a league
// visible on more than one phone.

import * as S from './store.js';
import * as API from './api.js';
import * as L from './league.js';

/* ============================== local ============================== */

export function localBackend(getState, setState) {
  const patchLeague = (lg) => setState({ ...getState(), membership: L.addLeague(getState().membership, lg) });

  return {
    kind: 'local',

    async load() {
      return { membership: getState().membership, locks: getState().locks };
    },

    async createLeague(name, startBankrollCents) {
      const st = getState();
      const lg = L.createLeague({ name, ownerUid: st.me.uid, ownerName: st.me.name, startBankrollCents });
      patchLeague(lg);
      return { ok: true, league: lg };
    },

    async joinLeague(code) {
      const st = getState();
      if (st.membership.leagues[code]) {
        setState({ ...st, membership: L.setActive(st.membership, code) });
        return { ok: true, already: true, league: st.membership.leagues[code] };
      }
      // There is nothing to look a code up in without a backend, so this
      // creates a local placeholder and the app says so plainly rather than
      // pretending it connected to anyone.
      const stub = L.joinLeague(
        L.createLeague({ name: `League ${code}`, ownerUid: 'unknown', ownerName: 'Owner', code }),
        { uid: st.me.uid, name: st.me.name },
      ).league;
      patchLeague(stub);
      return { ok: true, league: stub, localOnly: true };
    },

    async renameLeague(code, name) {
      const r = L.renameLeague(getState().membership.leagues[code], getState().me.uid, name);
      if (!r.ok) return { ok: false, error: r.reason };
      patchLeague(r.league);
      return { ok: true };
    },

    async removeMember(code, uid) {
      const r = L.removeMember(getState().membership.leagues[code], getState().me.uid, uid);
      if (!r.ok) return { ok: false, error: r.reason };
      patchLeague(r.league);
      return { ok: true };
    },

    async transferOwner(code, uid) {
      const r = L.transferOwnership(getState().membership.leagues[code], getState().me.uid, uid);
      if (!r.ok) return { ok: false, error: r.reason };
      patchLeague(r.league);
      return { ok: true };
    },

    async addLock(lock) {
      setState(S.addLock(getState(), lock));
      return { ok: true, id: lock.id };
    },

    async deleteLock(id) {
      setState(S.removeLock(getState(), id));
      return { ok: true };
    },

    async overrideLeg(id, idx, state) {
      setState(S.setOverride(getState(), id, idx, state));
      return { ok: true };
    },

    // Nothing to agree with when it is just this browser, so a settlement is
    // simply recomputed every render and never written down.
    async settleLock() { return { ok: true, noop: true }; },
  };
}

/* ============================== cloud ============================== */

export function cloudBackend(getState) {
  /** Turn the Worker's leagues into the membership shape the app renders. */
  const toMembership = (leagues, keepActive) => {
    const map = {};
    for (const lg of leagues) map[lg.code] = lg;
    const active = keepActive && map[keepActive] ? keepActive : (leagues[0] ? leagues[0].code : null);
    return { leagues: map, activeCode: active };
  };

  return {
    kind: 'cloud',

    async load() {
      const r = await API.myLeagues();
      if (!r.ok) return { ok: false, error: r.error, needsAuth: r.needsAuth };
      const membership = toMembership(r.leagues || [], getState().membership.activeCode);

      // Locks come per league, so the active one is fetched in full and the
      // others are left until they are looked at. Pulling every league's
      // history on every load would get slow for no benefit.
      let locks = [];
      if (membership.activeCode) {
        const d = await API.getLeague(membership.activeCode);
        if (d.ok) locks = d.locks || [];
      }
      return { ok: true, membership, locks };
    },

    async createLeague(name, startBankrollCents) {
      const r = await API.createLeague(name, startBankrollCents);
      return r.ok ? { ok: true, league: r.league } : r;
    },

    async joinLeague(code) {
      const r = await API.joinLeague(code);
      return r.ok ? { ok: true, league: r.league, already: r.already } : r;
    },

    renameLeague: (code, name) => API.renameLeague(code, name),
    removeMember: (code, uid) => API.removeMember(code, uid),
    transferOwner: (code, uid) => API.transferOwner(code, uid),

    async addLock(lock, firstStartAt) {
      const r = await API.createLock({
        code: lock.code,
        weekKey: lock.weekKey,
        stakeCents: lock.stakeCompCents,
        payoutCents: lock.payoutCents,
        boostPct: lock.boostPct,
        picks: lock.picks,
        placedAt: lock.placedAt,
        firstStartAt,
        book: lock.book,
        source: 'manual',
      });
      return r.ok ? { ok: true, id: r.id, eligible: r.eligible } : r;
    },

    deleteLock: (id) => API.deleteLock(id),
    overrideLeg: (id, idx, state) => API.overrideLeg(id, idx, state),
    settleLock: (id, state, returnCents) => API.settleLock(id, state, returnCents),
  };
}
