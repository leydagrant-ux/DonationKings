// Drive the real Worker routes against a real SQLite database.
//
// D1 is SQLite and its query API is small, so a faithful shim over node's
// built-in sqlite lets the actual route handlers, the actual SQL and the
// actual authorization checks run with no Cloudflare account and no Firebase
// token. The only thing stubbed is the token verification itself, which the
// router never does: it receives already-verified claims.
//
// Run: node tools/worker_test.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { route, validateLockBody, isCode, isWeekKey, isCents, isAmerican, verifyFirebaseToken } from '../worker/index.js';

const SCHEMA = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');

/* ---------------------------------------------------------------- shim */

/** D1's surface, over node:sqlite. prepare -> bind -> first/all/run, plus batch. */
function d1(db) {
  const make = (sql, args = []) => ({
    bind: (...a) => make(sql, a),
    first() {
      const row = db.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    all() {
      return { results: db.prepare(sql).all(...args) };
    },
    run() {
      db.prepare(sql).run(...args);
      return { success: true };
    },
  });
  return {
    prepare: (sql) => make(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  return { raw: db, DB: d1(db) };
}

/* -------------------------------------------------------------- harness */

const results = [];
let section = '';
const sec = (s) => { section = s; };
const ok = (name, cond, detail = '') => results.push({ section, name, pass: !!cond, detail: cond ? '' : detail });
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  results.push({ section, name, pass: same, detail: same ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}` });
};

/** Call a route as a given user and read the JSON back out. */
async function call(env, uid, method, path, body) {
  const res = await route(method, path, body, env, { sub: uid }, {});
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { json = null; }
  return { status: res.status, body: json };
}

async function signUp(env, uid, name) {
  return call(env, uid, 'POST', '/v1/me', { name });
}

/* ---------------------------------------------------------------- tests */

sec('worker: input validation');
ok('a real code passes', isCode('DEGEN7'));
ok('the wrong length fails', !isCode('DEGEN'));
// Ambiguous characters are not in the alphabet, so a misread code is refused
// rather than silently resolving to a different league.
ok('an ambiguous character fails', !isCode('DEGEN0') && !isCode('DEGENO'));
ok('lowercase fails (callers normalize first)', !isCode('degen7'));
ok('a week key passes', isWeekKey('2026-W45'));
ok('a malformed week fails', !isWeekKey('2026-45') && !isWeekKey('W45'));
ok('cents must be a positive integer', isCents(2500) && !isCents(0) && !isCents(-5) && !isCents(25.5));
// STRICT only promises lossless coercion, so '2500' would reach the database
// as 2500. The Worker is what actually refuses it.
ok('a stringy stake is refused here, not by STRICT', !isCents('2500'));
ok('American odds are refused inside the dead band', isAmerican(-110) && isAmerican(null) && !isAmerican(50) && !isAmerican(0));

sec('worker: lock body validation');
const goodLock = { code: 'DEGEN7', weekKey: '2026-W45', stakeCents: 2500, picks: [{ text: 'Packers ML', league: 'nfl', odds: -165 }] };
eq('a good lock passes', validateLockBody(goodLock), null);
eq('a bad code is caught', validateLockBody({ ...goodLock, code: 'nope' }), 'bad league code');
eq('a bad week is caught', validateLockBody({ ...goodLock, weekKey: 'later' }), 'bad week');
eq('a zero stake is caught', validateLockBody({ ...goodLock, stakeCents: 0 }), 'stake must be a whole number of cents above zero');
eq('no legs is caught', validateLockBody({ ...goodLock, picks: [] }), 'a lock needs at least one leg');
eq('an empty leg is caught', validateLockBody({ ...goodLock, picks: [{ text: '  ', league: 'nfl', odds: -110 }] }), 'every leg needs text');
eq('an unknown league is caught', validateLockBody({ ...goodLock, picks: [{ text: 'x', league: 'cricket', odds: -110 }] }), 'unknown league: cricket');
eq('an absurd leg count is caught', validateLockBody({ ...goodLock, picks: Array(40).fill({ text: 'x', league: 'nfl', odds: -110 }) }), 'a lock can have at most 16 legs');
eq('no body at all is caught', validateLockBody(null), 'no body');

sec('worker: token verification refuses junk');
// The signature path needs Google's keys, but every structural check runs
// before any network call and must reject on its own.
for (const [label, token] of [['empty', ''], ['not a jwt', 'abc'], ['two parts', 'a.b']]) {
  let threw = false;
  try { await verifyFirebaseToken(token, 'proj'); } catch { threw = true; }
  ok(`${label} is refused`, threw);
}
{
  // alg:none is the classic JWT forgery; it must be refused before any
  // signature check happens.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'none', kid: 'x' })}.${b64({ sub: 'u1', aud: 'proj' })}.`;
  let threw = false;
  try { await verifyFirebaseToken(forged, 'proj'); } catch { threw = true; }
  ok('an unsigned token is refused', threw);
}

sec('worker: identity');
const env = fresh();
let r = await signUp(env, 'u-grant', 'Grant');
eq('signing in creates the user', r.status, 200);
eq('and returns the profile', r.body, { uid: 'u-grant', name: 'Grant' });
r = await signUp(env, 'u-grant', 'Grant Leyda');
eq('signing in again updates the name', r.body.name, 'Grant Leyda');
eq('and does not duplicate the row', env.raw.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
await signUp(env, 'u-ash', 'Ashtin');
await signUp(env, 'u-ck', 'ckirby');

sec('worker: creating a league');
r = await call(env, 'u-grant', 'POST', '/v1/leagues', { name: 'Sunday Degenerates', startBankrollCents: 10000 });
eq('a league is created', r.status, 200);
const CODE = r.body.league.code;
ok('with a server-generated code', isCode(CODE), CODE);
eq('the creator owns it', r.body.league.ownerUid, 'u-grant');
eq('and is its only member', r.body.league.members.length, 1);
eq('a league needs a name', (await call(env, 'u-grant', 'POST', '/v1/leagues', { name: '  ' })).status, 400);
// The code must never come from the client: a chosen code lets somebody squat
// on one or guess their way in.
r = await call(env, 'u-grant', 'POST', '/v1/leagues', { name: 'Try', code: 'AAAAAA' });
ok('a client-supplied code is ignored', r.body.league.code !== 'AAAAAA', r.body.league.code);

sec('worker: joining');
r = await call(env, 'u-ash', 'POST', '/v1/leagues/join', { code: CODE.toLowerCase() });
eq('a lowercase code is accepted', r.status, 200);
eq('and the joiner is now a member', r.body.league.members.length, 2);
r = await call(env, 'u-ash', 'POST', '/v1/leagues/join', { code: CODE });
eq('joining twice is idempotent', r.body.already, true);
eq('and does not duplicate membership', r.body.league.members.length, 2);
eq('an unknown code is a 404', (await call(env, 'u-ck', 'POST', '/v1/leagues/join', { code: 'ZZZZZZ' })).status, 404);
eq('a malformed code is a 400', (await call(env, 'u-ck', 'POST', '/v1/leagues/join', { code: 'nope' })).status, 400);

sec('worker: a non-member sees nothing');
// The access model is that the code is unguessable, so the one thing that
// must hold is that knowing a league exists is not enough to read it.
eq('reading a league you are not in is refused', (await call(env, 'u-ck', 'GET', `/v1/leagues/${CODE}`)).status, 403);
eq('renaming it is refused', (await call(env, 'u-ck', 'POST', `/v1/leagues/${CODE}/rename`, { name: 'Mine' })).status, 403);
eq('listing your leagues shows only yours', (await call(env, 'u-ck', 'GET', '/v1/leagues')).body.leagues.length, 0);
eq('and shows the ones you are in', (await call(env, 'u-ash', 'GET', '/v1/leagues')).body.leagues.length, 1);

sec('worker: owner powers');
eq('a member cannot rename', (await call(env, 'u-ash', 'POST', `/v1/leagues/${CODE}/rename`, { name: 'Hijacked' })).status, 403);
r = await call(env, 'u-grant', 'POST', `/v1/leagues/${CODE}/rename`, { name: 'The Degenerates' });
eq('the owner can', r.body.league.name, 'The Degenerates');
eq('a member cannot remove anyone', (await call(env, 'u-ash', 'POST', `/v1/leagues/${CODE}/members/u-grant/remove`)).status, 403);
eq('the owner cannot remove themselves', (await call(env, 'u-grant', 'POST', `/v1/leagues/${CODE}/members/u-grant/remove`)).status, 400);
// The owner leaving would strand the league with nobody able to manage it.
eq('the owner cannot leave while others remain', (await call(env, 'u-grant', 'POST', `/v1/leagues/${CODE}/leave`)).status, 400);

sec('worker: placing a lock');
const lockBody = {
  code: CODE, weekKey: '2026-W45', stakeCents: 2500,
  picks: [
    { text: 'Packers ML', league: 'nfl', odds: -165 },
    { text: 'Tucker Kraft Anytime TD', league: 'nfl', odds: 260 },
  ],
};
r = await call(env, 'u-grant', 'POST', '/v1/locks', lockBody);
eq('a lock is accepted', r.status, 200);
const LOCK = r.body.id;
eq('and counts for the competition', r.body.eligible, true);
eq('its legs are stored in order', env.raw.prepare('SELECT raw_text FROM legs WHERE lock_id = ? ORDER BY idx').all(LOCK).map((x) => x.raw_text),
  ['Packers ML', 'Tucker Kraft Anytime TD']);
// The stake comes off the bankroll the moment the lock is placed.
eq('the stake is on the ledger', env.raw.prepare("SELECT delta_cents FROM ledger WHERE lock_id = ? AND kind='stake'").get(LOCK).delta_cents, -2500);
eq('nothing graded is stored', env.raw.prepare('SELECT settled_state FROM locks WHERE id = ?').get(LOCK).settled_state, null);
eq('a lock in a league you are not in is refused', (await call(env, 'u-ck', 'POST', '/v1/locks', lockBody)).status, 403);
eq('an invalid lock is refused', (await call(env, 'u-grant', 'POST', '/v1/locks', { ...lockBody, stakeCents: -1 })).status, 400);

sec('worker: backdating is refused');
// Submitted after the first game started: still tracked, but it cannot count.
r = await call(env, 'u-grant', 'POST', '/v1/locks', { ...lockBody, firstStartAt: Date.now() - 3600000 });
eq('a late lock is accepted', r.status, 200);
eq('but marked ineligible', r.body.eligible, false);
const late = r.body.id;
// And a client cannot claim it was submitted earlier than it was.
r = await call(env, 'u-grant', 'POST', '/v1/locks', { ...lockBody, firstStartAt: Date.now() - 3600000, placedAt: Date.now() - 7200000 });
eq('a claimed earlier placement does not buy eligibility', r.body.eligible, false);

sec('worker: settling once');
r = await call(env, 'u-grant', 'POST', `/v1/locks/${LOCK}/settle`, { state: 'won', returnCents: 9000 });
eq('a settlement is recorded', r.body.state, 'won');
eq('and pays into the ledger', env.raw.prepare("SELECT delta_cents FROM ledger WHERE lock_id = ? AND kind='payout'").get(LOCK).delta_cents, 9000);
// THE guard: a second settlement, from a retry or another phone seeing the
// same final score, must not pay twice.
r = await call(env, 'u-grant', 'POST', `/v1/locks/${LOCK}/settle`, { state: 'won', returnCents: 9000 });
eq('settling again is a no-op', r.body.already, true);
eq('and there is still only one payout', env.raw.prepare("SELECT COUNT(*) c FROM ledger WHERE lock_id = ? AND kind='payout'").get(LOCK).c, 1);
// Even a DIFFERENT answer cannot rewrite it.
r = await call(env, 'u-grant', 'POST', `/v1/locks/${LOCK}/settle`, { state: 'lost', returnCents: 0 });
eq('a conflicting settlement is refused', r.body.already, true);
eq('the original stands', env.raw.prepare('SELECT settled_state FROM locks WHERE id = ?').get(LOCK).settled_state, 'won');
eq('a bad settle state is refused', (await call(env, 'u-grant', 'POST', `/v1/locks/${late}/settle`, { state: 'maybe', returnCents: 0 })).status, 400);

sec('worker: deleting a lock');
r = await call(env, 'u-grant', 'POST', '/v1/locks', { ...lockBody, firstStartAt: Date.now() + 3600000 });
const future = r.body.id;
eq('someone else cannot delete your lock', (await call(env, 'u-ash', 'DELETE', `/v1/locks/${future}`)).status, 403);
eq('you can delete your own before kickoff', (await call(env, 'u-grant', 'DELETE', `/v1/locks/${future}`)).status, 200);
eq('and its ledger rows go with it', env.raw.prepare('SELECT COUNT(*) c FROM ledger WHERE lock_id = ?').get(future).c, 0);
// After kickoff, deleting would be a way to take a loser off the standings.
eq('but not after a game has started', (await call(env, 'u-grant', 'DELETE', `/v1/locks/${late}`)).status, 400);

sec('worker: overriding a leg');
eq('only the owner of the lock may override', (await call(env, 'u-ash', 'POST', `/v1/locks/${late}/override`, { idx: 0, state: 'won' })).status, 403);
eq('an override is stored', (await call(env, 'u-grant', 'POST', `/v1/locks/${late}/override`, { idx: 0, state: 'won' })).status, 200);
eq('and can be corrected', (await call(env, 'u-grant', 'POST', `/v1/locks/${late}/override`, { idx: 0, state: 'push' })).status, 200);
eq('without duplicating the row', env.raw.prepare('SELECT COUNT(*) c FROM leg_overrides WHERE lock_id = ?').get(late).c, 1);
eq('a bad leg index is refused', (await call(env, 'u-grant', 'POST', `/v1/locks/${late}/override`, { idx: -1, state: 'won' })).status, 400);

sec('worker: reading a league back');
r = await call(env, 'u-grant', 'GET', `/v1/leagues/${CODE}`);
eq('the league comes back', r.status, 200);
ok('with its members', r.body.league.members.length === 2);
ok('and its locks', r.body.locks.length >= 2, `got ${r.body.locks.length}`);
const got = r.body.locks.find((l) => l.id === LOCK);
eq('shaped the way the client stores them', Object.keys(got).sort().includes('picks'), true);
eq('with the legs as written', got.picks.map((p) => p.text), ['Packers ML', 'Tucker Kraft Anytime TD']);
eq('and the agreed settlement', got.settledState, 'won');
eq('timestamps come back in milliseconds', typeof got.placedAt === 'number' && got.placedAt > 1e12, true);
const lateRow = r.body.locks.find((l) => l.id === late);
eq('overrides come back keyed by leg', lateRow.overrides, { 0: 'push' });
eq('and ineligible locks are marked', lateRow.eligible, false);

sec('worker: the audit log records who did what');
const actions = env.raw.prepare('SELECT action FROM audit ORDER BY created_ts').all().map((a) => a.action);
ok('a league creation is logged', actions.includes('league.create'));
ok('a join is logged', actions.includes('league.join'));
ok('a settlement is logged', actions.includes('lock.settle'));
ok('an override is logged', actions.includes('leg.override'));

sec('worker: unknown routes');
eq('an unknown path is a 404', (await call(env, 'u-grant', 'GET', '/v1/nope')).status, 404);
eq('a bad league code in a path is a 400', (await call(env, 'u-grant', 'GET', '/v1/leagues/xx')).status, 400);

/* --------------------------------------------------------------- report */

let last = '';
for (const r2 of results) {
  if (r2.section !== last) { console.log(`\n${r2.section}`); last = r2.section; }
  console.log(`  ${r2.pass ? 'ok  ' : 'FAIL'} ${r2.name}${r2.detail ? '  <- ' + r2.detail : ''}`);
}
const passed = results.filter((x) => x.pass).length;
console.log(`\n${passed} passed, ${results.length - passed} failed, ${results.length} checks`);
process.exit(passed === results.length ? 0 : 1);
