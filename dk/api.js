// api.js: talking to the Worker.
//
// Every call carries a fresh Firebase ID token. Nothing here decides who may
// do what; the Worker does that, because a client-side permission check is a
// suggestion. These functions just report what it said.
//
// Failures come back as { ok: false, error } rather than thrown, because a
// phone losing signal mid-tap is ordinary and should never take the app down.

import { API_URL } from './config.js';
import { token } from './auth.js';

async function call(method, path, body) {
  if (!API_URL) return { ok: false, error: 'The backend is not set up yet.' };
  const jwt = await token();
  if (!jwt) return { ok: false, error: 'Sign in first.', needsAuth: true };

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: 'Could not reach the server.', offline: true };
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (data && data.error) || `Server said ${res.status}.`,
      needsAuth: res.status === 401,
    };
  }
  return { ok: true, ...(data || {}) };
}

/* -- identity ------------------------------------------------------- */

/** Upsert the signed-in user. Call once after sign-in, before anything else. */
export const me = (name) => call('POST', '/v1/me', { name });

/* -- leagues -------------------------------------------------------- */

export const myLeagues = () => call('GET', '/v1/leagues');
export const getLeague = (code) => call('GET', `/v1/leagues/${code}`);
export const createLeague = (name, startBankrollCents) =>
  call('POST', '/v1/leagues', { name, startBankrollCents });
export const joinLeague = (code) => call('POST', '/v1/leagues/join', { code });
export const renameLeague = (code, name) => call('POST', `/v1/leagues/${code}/rename`, { name });
export const removeMember = (code, uid) => call('POST', `/v1/leagues/${code}/members/${uid}/remove`, {});
export const transferOwner = (code, uid) => call('POST', `/v1/leagues/${code}/members/${uid}/owner`, {});
export const leaveLeague = (code) => call('POST', `/v1/leagues/${code}/leave`, {});

/* -- locks ---------------------------------------------------------- */

/**
 * Place a lock. `firstStartAt` is sent so the Worker can decide eligibility,
 * but the Worker uses its own clock for "now", so a client cannot claim it
 * got in before kickoff when it did not.
 */
export const createLock = ({ code, weekKey, stakeCents, boostPct, picks, placedAt, firstStartAt, book, source }) =>
  call('POST', '/v1/locks', { code, weekKey, stakeCents, boostPct, picks, placedAt, firstStartAt, book, source });

export const deleteLock = (id) => call('DELETE', `/v1/locks/${id}`);

/**
 * Report a finished lock. Idempotent: whoever sees the games finish first
 * writes the record, and everyone else's call is a no-op that returns the
 * settlement already stored. That is what stops two phones disagreeing.
 */
export const settleLock = (id, state, returnCents) =>
  call('POST', `/v1/locks/${id}/settle`, { state, returnCents });

export const overrideLeg = (id, idx, state, reason) =>
  call('POST', `/v1/locks/${id}/override`, { idx, state, reason });
