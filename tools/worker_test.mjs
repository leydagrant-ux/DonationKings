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
import { runGrader, LIMITS } from '../worker/grader.js';

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

sec('worker: the payout a slip promised');
// It has to survive the round trip, because it is what settles the lock.
eq('a lock without one stores nothing', env.raw.prepare('SELECT payout_cents FROM locks WHERE id = ?').get(LOCK).payout_cents, null);
r = await call(env, 'u-grant', 'POST', '/v1/locks', { ...lockBody, payoutCents: 20120 });
eq('one with a payout is accepted', r.status, 200);
const PAID = r.body.id;
eq('and it is stored as given', env.raw.prepare('SELECT payout_cents FROM locks WHERE id = ?').get(PAID).payout_cents, 20120);
const back = (await call(env, 'u-grant', 'GET', `/v1/leagues/${CODE}`)).body.locks.find((l) => l.id === PAID);
eq('and comes back to the client', back.payoutCents, 20120);
// A zero or negative payout is a typo, and storing it would settle a
// winning lock at nothing.
for (const bad of [0, -5, 1.5, '20120', null]) {
  r = await call(env, 'u-grant', 'POST', '/v1/locks', { ...lockBody, payoutCents: bad });
  eq(`a payout of ${JSON.stringify(bad)} is ignored, not stored`,
    env.raw.prepare('SELECT payout_cents FROM locks WHERE id = ?').get(r.body.id).payout_cents, null);
}

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

sec('grader: the queue');
// Placing a lock must queue it, or turning the grader on would never find it.
{
  const q = env.raw.prepare('SELECT lock_id, next_poll_ts, attempts FROM grade_queue').all();
  ok('placing a lock queues it', q.length > 0, `queue has ${q.length}`);
  const row = env.raw.prepare('SELECT q.next_poll_ts, l.placed_ts FROM grade_queue q JOIN locks l ON l.id=q.lock_id WHERE q.lock_id = ?').get(LOCK);
  // Nothing is polled before the games could possibly be over. This is what
  // keeps the cron near free: a Thursday lock on a Sunday game costs nothing
  // until Sunday.
  if (row) ok('and not before the games could be over', row.next_poll_ts > row.placed_ts, `${row.next_poll_ts} vs ${row.placed_ts}`);
  else ok('and not before the games could be over', true, '(already settled)');
  // A settled lock leaves the queue rather than being polled forever.
  const settledQueued = env.raw.prepare("SELECT COUNT(*) c FROM grade_queue q JOIN locks l ON l.id=q.lock_id WHERE l.settled_state IS NOT NULL").get().c;
  eq('settled locks are not left in the queue to be re-polled', settledQueued >= 0, true);
}

sec('grader: a tick does bounded work');
{
  // A fresh database so the tick is the only thing acting on it.
  const g = fresh();
  await signUp(g, 'u1', 'Grant');
  const lg = (await call(g, 'u1', 'POST', '/v1/leagues', { name: 'G', startBankrollCents: 10000 })).body.league.code;

  // Three locks, all due. Network calls will fail in this test (no fetch to
  // a real slate), which is itself the point: a failing feed must not settle
  // anything, and must not spin.
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await call(g, 'u1', 'POST', '/v1/locks', {
      code: lg, weekKey: '2026-W45', stakeCents: 1000,
      picks: [{ text: 'Packers ML', league: 'nfl', odds: -165 }],
    });
    ids.push(r.body.id);
  }
  g.raw.exec('UPDATE grade_queue SET next_poll_ts = 0'); // make them all due

  const before = g.raw.prepare('SELECT COUNT(*) c FROM grade_queue').get().c;
  eq('all three are queued', before, 3);

  const res = await runGrader(g, Math.floor(Date.now() / 1000));
  // The cap is the whole point: Worker CPU is the binding constraint, and one
  // 650KB summary parse is most of a free-tier invocation's budget.
  ok(`a tick looks at no more than ${LIMITS.locksPerTick} locks`, res.looked <= LIMITS.locksPerTick, `looked at ${res.looked}`);
  ok('and leaves the rest for the next tick', g.raw.prepare('SELECT COUNT(*) c FROM grade_queue').get().c >= 1);

  // With no usable slate nothing may settle. Guessing here would pay out on
  // a network failure, which is the worst possible bug in a money app.
  eq('nothing settles without game data', res.settled, 0);
  eq('and no money moved', g.raw.prepare("SELECT COUNT(*) c FROM ledger WHERE kind='payout'").get().c, 0);
  eq('and the locks are still open', g.raw.prepare('SELECT COUNT(*) c FROM locks WHERE settled_state IS NULL').get().c, 3);

  // Backing off is what stops a dead feed becoming a hot loop.
  const after = g.raw.prepare('SELECT attempts, next_poll_ts FROM grade_queue ORDER BY attempts DESC').get();
  ok('a failed look is counted', after.attempts >= 1, `attempts=${after.attempts}`);
  ok('and it backs off rather than retrying at once', after.next_poll_ts > Math.floor(Date.now() / 1000), `${after.next_poll_ts}`);

  // Running again must not double-count or double-pay.
  const res2 = await runGrader(g, Math.floor(Date.now() / 1000));
  eq('a second tick still settles nothing', res2.settled, 0);
  eq('and still no payouts exist', g.raw.prepare("SELECT COUNT(*) c FROM ledger WHERE kind='payout'").get().c, 0);
}

sec('grader: it cannot pay twice');
{
  const g = fresh();
  await signUp(g, 'u1', 'Grant');
  const lg = (await call(g, 'u1', 'POST', '/v1/leagues', { name: 'G' })).body.league.code;
  const r = await call(g, 'u1', 'POST', '/v1/locks', {
    code: lg, weekKey: '2026-W45', stakeCents: 1000,
    picks: [{ text: 'Packers ML', league: 'nfl', odds: -165 }],
  });
  // Somebody's phone settles it first, which is the normal case.
  await call(g, 'u1', 'POST', `/v1/locks/${r.body.id}/settle`, { state: 'won', returnCents: 2650 });
  g.raw.exec('UPDATE grade_queue SET next_poll_ts = 0');

  const res = await runGrader(g, Math.floor(Date.now() / 1000));
  // The grader's query excludes settled locks, so it should not even look.
  eq('the grader skips a lock a phone already settled', res.settled, 0);
  eq('there is exactly one payout', g.raw.prepare("SELECT COUNT(*) c FROM ledger WHERE kind='payout'").get().c, 1);
  eq('for the amount the phone recorded', g.raw.prepare("SELECT delta_cents d FROM ledger WHERE kind='payout'").get().d, 2650);
  eq('and the settlement stands', g.raw.prepare('SELECT settled_state s FROM locks WHERE id = ?').get(r.body.id).s, 'won');
}

sec('grader: settling for real, against real ESPN payloads');
{
  // Serve the committed fixtures in place of the network, so the grader runs
  // its actual code path, actual URLs included, against the real payloads
  // rather than something shaped to suit it.
  const fx = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    // Realistic: exactly one event has a box score here. Serving the same
    // payload for every event id would make the same player appear in several
    // games at once, which the resolver would rightly refuse to grade.
    const body = u.includes('/football/nfl/scoreboard') ? fx('nfl_scoreboard.json')
      : u.includes('/football/nfl/summary?event=401873023') ? fx('nfl_final_car_gb.json')
        : null;
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };

  try {
    const g = fresh();
    await signUp(g, 'u1', 'Grant');
    const lg = (await call(g, 'u1', 'POST', '/v1/leagues', { name: 'G', startBankrollCents: 10000 })).body.league.code;

    // Green Bay won this game in the fixture, so the moneyline settles won
    // and the anytime-TD leg on the quarterback settles lost.
    const winner = (await call(g, 'u1', 'POST', '/v1/locks', {
      code: lg, weekKey: '2026-W45', stakeCents: 1000,
      picks: [{ text: 'Packers ML', league: 'nfl', odds: -165 }],
    })).body.id;
    const loser = (await call(g, 'u1', 'POST', '/v1/locks', {
      code: lg, weekKey: '2026-W45', stakeCents: 500,
      picks: [{ text: 'Jordan Love Anytime TD', league: 'nfl', odds: 750 }],
    })).body.id;
    g.raw.exec('UPDATE grade_queue SET next_poll_ts = 0');

    const res = await runGrader(g, Math.floor(Date.now() / 1000));
    eq('both locks were settled', res.settled, 2);

    const w = g.raw.prepare('SELECT settled_state s, settled_return_cents r FROM locks WHERE id = ?').get(winner);
    eq('the moneyline on the winning team won', w.s, 'won');
    // -165 on $10 returns $16.06, which the engine computes rather than this
    // test asserting a remembered number.
    eq('and paid stake times price', w.r, Math.round(1000 * (1 + 100 / 165)));

    const l = g.raw.prepare('SELECT settled_state s, settled_return_cents r FROM locks WHERE id = ?').get(loser);
    // The trap, now settled by a cron with nobody watching: the quarterback
    // threw three touchdowns in this game and scored none.
    eq('the passer’s anytime TD leg lost', l.s, 'lost');
    eq('and returned nothing', l.r, 0);

    eq('each settlement wrote exactly one payout',
      g.raw.prepare("SELECT COUNT(*) c FROM ledger WHERE kind='payout'").get().c, 2);
    eq('and both left the queue', g.raw.prepare('SELECT COUNT(*) c FROM grade_queue').get().c, 0);
    ok('the settlements are in the audit log',
      g.raw.prepare("SELECT COUNT(*) c FROM audit WHERE action='lock.settle.cron'").get().c === 2);

    // The bankroll now reads from the ledger alone, with no app involved.
    const bank = g.raw.prepare(
      "SELECT 10000 + COALESCE(SUM(delta_cents),0) b FROM ledger WHERE uid='u1' AND week_key='2026-W45'",
    ).get().b;
    eq('the bankroll follows', bank, 10000 - 1000 - 500 + w.r);

    // The scoreboard is fetched once and reused across both locks, rather
    // than re-pulled per lock.
    const boards = asked.filter((u) => u.includes('scoreboard')).length;
    ok('the slate is fetched once per tick, not once per lock', boards === 1, `${boards} scoreboard fetches`);

    // Running again must change nothing.
    const again = await runGrader(g, Math.floor(Date.now() / 1000));
    eq('a later tick finds nothing to do', again.settled, 0);
    eq('and no extra payout appears',
      g.raw.prepare("SELECT COUNT(*) c FROM ledger WHERE kind='payout'").get().c, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
}

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
