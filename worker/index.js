/* DonationKings backend: Cloudflare Worker over D1.
 *
 * This exists so a league is shared rather than living in one browser. The
 * grading engine stays in the client, which already has free, open-CORS access
 * to the score feed; the Worker owns identity, membership and money.
 *
 * Every request is gated on a Firebase ID token. This URL ships inside public
 * JavaScript, so without that gate it would be an open door to the database.
 * Origin checks alone are worthless, because Origin is trivially forged
 * outside a browser; the token is the real gate and the origin allowlist just
 * keeps other sites' pages from using it.
 *
 * The JWT verifier, the JWKS cache and the CORS gate are lifted from the
 * LockIN worker, where they are already in production.
 *
 * Deploy:
 *   npx wrangler d1 create donationkings
 *   # put the returned database_id in wrangler.toml
 *   npx wrangler d1 execute donationkings --remote --file=./worker/schema.sql
 *   npx wrangler deploy
 */

import { runGrader, enqueueStatement } from './grader.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0 O 1 I L
const MAX_LEGS = 16;
const MAX_STAKE_CENTS = 100000000; // a sanity ceiling, not a rule

/* ============================== helpers ============================== */

const corsHeaders = (origin, allowed) => ({
  'Access-Control-Allow-Origin': allowed ? origin : 'null',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...headers, 'content-type': 'application/json' },
  });

const nowSec = () => Math.floor(Date.now() / 1000);

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
const b64urlToString = (s) => new TextDecoder().decode(b64urlToBytes(s));

/* Workers reuse an isolate across requests, so Google's signing keys are
   cached in module scope. A `kid` miss forces a refresh, which is what
   handles Google's key rotation. */
let jwksCache = null;
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

async function getJwks(force = false) {
  if (!jwksCache || Date.now() - jwksFetchedAt > JWKS_TTL_MS || force) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error('could not fetch signing keys');
    jwksCache = await res.json();
    jwksFetchedAt = Date.now();
  }
  return jwksCache;
}

/** Verify a Firebase ID token and return its claims. Throws on any failure. */
export async function verifyFirebaseToken(token, projectId) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = JSON.parse(b64urlToString(parts[0]));
  const claims = JSON.parse(b64urlToString(parts[1]));
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  let jwks = await getJwks();
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks = await getJwks(true);
    jwk = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed)) {
    throw new Error('bad signature');
  }

  const now = nowSec();
  if (claims.exp <= now) throw new Error('token expired');
  if (claims.iat > now + 300) throw new Error('token issued in the future');
  if (claims.aud !== projectId) throw new Error('wrong audience');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (!claims.sub) throw new Error('no subject');
  return claims;
}

/* ============================== validation ============================== */
/* The client is not trusted with any of this. STRICT tables only promise
   lossless conversion, so '2500' would be accepted as a stake; these checks
   are what actually keep junk out. */

export const isCode = (v) =>
  typeof v === 'string' && v.length === 6 && [...v].every((c) => CODE_ALPHABET.includes(c));

export const isWeekKey = (v) => typeof v === 'string' && /^\d{4}-W\d{2}$/.test(v);

export const isCents = (v) => Number.isInteger(v) && v > 0 && v <= MAX_STAKE_CENTS;

export const isAmerican = (v) => v === null || (Number.isInteger(v) && Math.abs(v) >= 100);

const LEAGUE_SLUGS = new Set(['nfl', 'cfb', 'nba', 'cbb', 'nhl', 'mlb']);
const SETTLE_STATES = new Set(['won', 'lost', 'push', 'void']);

export function validateLockBody(body) {
  if (!body || typeof body !== 'object') return 'no body';
  if (!isCode(body.code)) return 'bad league code';
  if (!isWeekKey(body.weekKey)) return 'bad week';
  if (!isCents(body.stakeCents)) return 'stake must be a whole number of cents above zero';
  if (body.boostPct !== undefined && (!Number.isInteger(body.boostPct) || body.boostPct < 0 || body.boostPct > 500)) {
    return 'bad boost';
  }
  if (!Array.isArray(body.picks) || !body.picks.length) return 'a lock needs at least one leg';
  if (body.picks.length > MAX_LEGS) return `a lock can have at most ${MAX_LEGS} legs`;
  for (const p of body.picks) {
    if (!p || typeof p.text !== 'string' || !p.text.trim()) return 'every leg needs text';
    if (p.text.length > 200) return 'a leg is too long';
    if (!LEAGUE_SLUGS.has(p.league)) return `unknown league: ${p.league}`;
    if (!isAmerican(p.odds === undefined ? null : p.odds)) return 'a leg price must be American odds';
  }
  return null;
}

/** Codes are generated here, never accepted from a client. */
function genCode() {
  let c = '';
  while (c.length < 6) {
    const buf = new Uint8Array(6 - c.length);
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 248) c += CODE_ALPHABET[b % 31]; // 248 = 8 * 31
  }
  return c;
}

const newId = (p) => `${p}-${crypto.randomUUID()}`;

/* ============================== data access ============================== */

async function membership(db, code, uid) {
  return db.prepare('SELECT role FROM league_members WHERE code = ? AND uid = ? AND left_ts IS NULL')
    .bind(code, uid).first();
}

async function leagueDetail(db, code, uid) {
  const league = await db.prepare('SELECT * FROM leagues WHERE code = ?').bind(code).first();
  if (!league) return null;
  const { results: members } = await db.prepare(
    `SELECT m.uid, m.role, m.joined_ts, u.display_name AS name
       FROM league_members m JOIN users u ON u.uid = m.uid
      WHERE m.code = ? AND m.left_ts IS NULL
      ORDER BY m.joined_ts`,
  ).bind(code).all();
  return {
    code: league.code,
    name: league.name,
    ownerUid: league.owner_uid,
    startBankrollCents: league.start_bankroll_cents,
    createdAt: league.created_ts * 1000,
    archived: !!league.archived_ts,
    members: members.map((m) => ({ uid: m.uid, name: m.name, role: m.role, joinedAt: m.joined_ts * 1000 })),
    youAre: (members.find((m) => m.uid === uid) || {}).role || null,
  };
}

/** Every lock in a league, with its legs, shaped the way the client stores them. */
async function leagueLocks(db, code) {
  const { results: locks } = await db.prepare(
    `SELECT id, code, uid, week_key, stake_cents, boost_pct, book, placed_ts, eligible,
            settled_state, settled_return_cents, settled_ts
       FROM locks WHERE code = ? ORDER BY placed_ts DESC LIMIT 500`,
  ).bind(code).all();
  if (!locks.length) return [];

  const ids = locks.map((l) => l.id);
  const marks = ids.map(() => '?').join(',');
  const { results: legs } = await db.prepare(
    `SELECT lock_id, idx, raw_text, league, odds_american FROM legs
      WHERE lock_id IN (${marks}) ORDER BY lock_id, idx`,
  ).bind(...ids).all();
  const { results: overrides } = await db.prepare(
    `SELECT lock_id, idx, state FROM leg_overrides WHERE lock_id IN (${marks})`,
  ).bind(...ids).all();

  const byLock = new Map(ids.map((id) => [id, []]));
  for (const l of legs) byLock.get(l.lock_id).push({ text: l.raw_text, league: l.league, odds: l.odds_american });
  const ovByLock = new Map();
  for (const o of overrides) {
    if (!ovByLock.has(o.lock_id)) ovByLock.set(o.lock_id, {});
    ovByLock.get(o.lock_id)[o.idx] = o.state;
  }

  return locks.map((l) => ({
    id: l.id,
    code: l.code,
    uid: l.uid,
    weekKey: l.week_key,
    stakeCompCents: l.stake_cents,
    boostPct: l.boost_pct,
    book: l.book,
    placedAt: l.placed_ts * 1000,
    eligible: !!l.eligible,
    picks: byLock.get(l.id) || [],
    overrides: ovByLock.get(l.id) || {},
    // Present only once somebody has seen the games finish. The client still
    // grades locally; this is the agreed record so two phones cannot disagree.
    settledState: l.settled_state || undefined,
    settledReturnCents: l.settled_state ? l.settled_return_cents : undefined,
    settledAt: l.settled_ts ? l.settled_ts * 1000 : undefined,
  }));
}

/* ============================== reading a slip ============================== */

/* Model order is lifted from the LockIN worker, where these three are already
 * in production on this account. Groq retired every vision model during 2026,
 * which is why this runs on Workers AI rather than there. */
const VISION_ATTEMPTS = [
  { model: '@cf/meta/llama-3.2-11b-vision-instruct', style: 'messages' },
  { model: '@cf/mistralai/mistral-small-3.1-24b-instruct', style: 'messages' },
  { model: '@cf/llava-hf/llava-1.5-7b-hf', style: 'bytes' },
];

/* A TRANSCRIPTION prompt, not a description prompt. The model's job is to read
 * pixels into text and nothing else; turning that text into legs is done by
 * deterministic, tested code on the client. Asking a model to "extract JSON"
 * instead would be less accurate, impossible to test, and would drift with
 * every model version.
 *
 * "Character for character" matters more than it looks: a 249.5 read as 246.5
 * settles a bet wrongly with no trace, which is why the person is shown this
 * text to correct before anything is saved. */
const SLIP_PROMPT = [
  'Transcribe every line of text in this sports betting slip, top to bottom, in order.',
  'Keep numbers, prices and lines character for character: do not round, reorder or tidy them.',
  'Put each selection on its own line, and keep its market on the next line exactly as shown.',
  'Include the stake, the payout, the odds and any boost.',
  'Do not summarize, do not explain, do not add anything that is not printed on the slip.',
  'If part of it is unreadable, write [unclear] there rather than guessing.',
].join(' ');

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readSlip(body, env, cors) {
  if (!env.AI) return json({ error: 'Reading screenshots is not set up on this Worker' }, 501, cors);

  const dataUrl = String((body && body.image) || '');
  if (!dataUrl.startsWith('data:image/')) return json({ error: 'image must be a data: URL' }, 400, cors);
  /* The client compresses well below this. The cap is here so one stray
     upload cannot burn the day's free neuron allowance. */
  if (dataUrl.length > 1_500_000) return json({ error: 'that image is too large' }, 413, cors);

  const tried = [];
  for (const attempt of VISION_ATTEMPTS) {
    try {
      const input = attempt.style === 'messages'
        ? {
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: SLIP_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
          max_tokens: 1200,
        }
        : { image: [...dataUrlToBytes(dataUrl)], prompt: SLIP_PROMPT, max_tokens: 1200 };

      const res = await env.AI.run(attempt.model, input);
      const text = String(res?.response ?? res?.result?.response ?? res?.description ?? '').trim();
      if (text) return json({ text, model: attempt.model }, 200, cors);
      tried.push(`${attempt.model}: empty response`);
    } catch (err) {
      tried.push(`${attempt.model}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  return json({ error: 'No model could read that screenshot. Type it in instead.', tried }, 502, cors);
}

const audit = (db, code, lockId, actor, action, detail) =>
  db.prepare('INSERT INTO audit (id, code, lock_id, actor_uid, action, detail, created_ts) VALUES (?,?,?,?,?,?,?)')
    .bind(newId('a'), code || null, lockId || null, actor || null, action, detail ? JSON.stringify(detail) : null, nowSec());

/* ============================== routes ============================== */

/**
 * The router, exported so the test suite can drive it against a real SQLite
 * database without a Cloudflare account or a Firebase token.
 *
 * It takes ALREADY-VERIFIED claims, so exporting it bypasses nothing: the
 * default fetch handler below is still the only public entry point and it
 * always verifies the token first.
 */
export async function route(method, path, body, env, claims, cors) {
  const db = env.DB;
  const uid = claims.sub;
  const seg = path.split('/').filter(Boolean); // ['v1','leagues','ABC234', ...]

  /* -- identity ------------------------------------------------------ */

  if (method === 'POST' && path === '/v1/me') {
    const name = String((body && body.name) || claims.name || claims.email || 'Player').trim().slice(0, 30) || 'Player';
    await db.prepare(
      `INSERT INTO users (uid, display_name, created_ts, last_seen_ts) VALUES (?,?,?,?)
       ON CONFLICT(uid) DO UPDATE SET display_name = excluded.display_name, last_seen_ts = excluded.last_seen_ts`,
    ).bind(uid, name, nowSec(), nowSec()).run();
    return json({ uid, name }, 200, cors);
  }

  /* -- reading a slip ------------------------------------------------ */

  if (method === 'POST' && path === '/v1/ingest/read') {
    const out = await readSlip(body, env, cors);
    // Logged so a run of failures is visible later without storing the image.
    await audit(db, null, null, uid, out.status === 200 ? 'slip.read' : 'slip.read.failed', null).run();
    return out;
  }

  /* -- leagues ------------------------------------------------------- */

  if (method === 'GET' && path === '/v1/leagues') {
    const { results } = await db.prepare(
      `SELECT l.code FROM leagues l JOIN league_members m ON m.code = l.code
        WHERE m.uid = ? AND m.left_ts IS NULL ORDER BY l.created_ts`,
    ).bind(uid).all();
    const leagues = [];
    for (const r of results) leagues.push(await leagueDetail(db, r.code, uid));
    return json({ leagues }, 200, cors);
  }

  if (method === 'POST' && path === '/v1/leagues') {
    const name = String((body && body.name) || '').trim().slice(0, 60);
    if (!name) return json({ error: 'a league needs a name' }, 400, cors);
    const cents = Number.isInteger(body.startBankrollCents) && body.startBankrollCents > 0
      ? body.startBankrollCents : 10000;

    // Generated here, never taken from the client: a client-chosen code lets
    // somebody squat or guess their way into a league.
    let code = null;
    for (let i = 0; i < 5 && !code; i++) {
      const candidate = genCode();
      const clash = await db.prepare('SELECT 1 FROM leagues WHERE code = ?').bind(candidate).first();
      if (!clash) code = candidate;
    }
    if (!code) return json({ error: 'could not allocate a code, try again' }, 503, cors);

    const ts = nowSec();
    await db.batch([
      db.prepare('INSERT INTO leagues (code, name, owner_uid, start_bankroll_cents, created_ts) VALUES (?,?,?,?,?)')
        .bind(code, name, uid, cents, ts),
      db.prepare('INSERT INTO league_members (code, uid, role, joined_ts) VALUES (?,?,?,?)')
        .bind(code, uid, 'owner', ts),
      audit(db, code, null, uid, 'league.create', { name, cents }),
    ]);
    return json({ league: await leagueDetail(db, code, uid) }, 200, cors);
  }

  if (method === 'POST' && path === '/v1/leagues/join') {
    const code = String((body && body.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!isCode(code)) return json({ error: 'that code does not look right' }, 400, cors);
    const league = await db.prepare('SELECT code FROM leagues WHERE code = ?').bind(code).first();
    // Deliberately the same message either way: a different answer for "no
    // such league" would turn this into an oracle for guessing codes.
    if (!league) return json({ error: 'no league with that code' }, 404, cors);

    const existing = await db.prepare('SELECT left_ts FROM league_members WHERE code = ? AND uid = ?')
      .bind(code, uid).first();
    if (existing && existing.left_ts === null) {
      return json({ league: await leagueDetail(db, code, uid), already: true }, 200, cors);
    }
    await db.prepare(
      `INSERT INTO league_members (code, uid, role, joined_ts) VALUES (?,?,'member',?)
       ON CONFLICT(code, uid) DO UPDATE SET left_ts = NULL, joined_ts = excluded.joined_ts`,
    ).bind(code, uid, nowSec()).run();
    await audit(db, code, null, uid, 'league.join', null).run();
    return json({ league: await leagueDetail(db, code, uid) }, 200, cors);
  }

  if (seg[0] === 'v1' && seg[1] === 'leagues' && seg[2]) {
    const code = seg[2].toUpperCase();
    if (!isCode(code)) return json({ error: 'bad league code' }, 400, cors);
    const mine = await membership(db, code, uid);
    if (!mine) return json({ error: 'you are not in that league' }, 403, cors);
    const isOwner = async () => (await db.prepare('SELECT owner_uid FROM leagues WHERE code = ?').bind(code).first() || {}).owner_uid === uid;

    if (method === 'GET' && seg.length === 3) {
      return json({ league: await leagueDetail(db, code, uid), locks: await leagueLocks(db, code) }, 200, cors);
    }

    if (method === 'POST' && seg[3] === 'rename') {
      if (!await isOwner()) return json({ error: 'only the owner can rename it' }, 403, cors);
      const name = String((body && body.name) || '').trim().slice(0, 60);
      if (!name) return json({ error: 'a league needs a name' }, 400, cors);
      await db.prepare('UPDATE leagues SET name = ? WHERE code = ?').bind(name, code).run();
      await audit(db, code, null, uid, 'league.rename', { name }).run();
      return json({ league: await leagueDetail(db, code, uid) }, 200, cors);
    }

    if (method === 'POST' && seg[3] === 'members' && seg[4] && seg[5] === 'remove') {
      if (!await isOwner()) return json({ error: 'only the owner can remove people' }, 403, cors);
      if (seg[4] === uid) return json({ error: 'the owner cannot be removed' }, 400, cors);
      await db.prepare('UPDATE league_members SET left_ts = ? WHERE code = ? AND uid = ?')
        .bind(nowSec(), code, seg[4]).run();
      await audit(db, code, null, uid, 'league.remove', { uid: seg[4] }).run();
      return json({ league: await leagueDetail(db, code, uid) }, 200, cors);
    }

    if (method === 'POST' && seg[3] === 'members' && seg[4] && seg[5] === 'owner') {
      if (!await isOwner()) return json({ error: 'only the owner can hand it over' }, 403, cors);
      const target = await membership(db, code, seg[4]);
      if (!target) return json({ error: 'that person is not in this league' }, 400, cors);
      // Order matters: the members trigger checks against leagues.owner_uid,
      // so the league has to move first.
      await db.batch([
        db.prepare('UPDATE leagues SET owner_uid = ? WHERE code = ?').bind(seg[4], code),
        db.prepare("UPDATE league_members SET role = 'owner' WHERE code = ? AND uid = ?").bind(code, seg[4]),
        db.prepare("UPDATE league_members SET role = 'member' WHERE code = ? AND uid = ?").bind(code, uid),
        audit(db, code, null, uid, 'league.transfer', { to: seg[4] }),
      ]);
      return json({ league: await leagueDetail(db, code, uid) }, 200, cors);
    }

    if (method === 'POST' && seg[3] === 'leave') {
      if (await isOwner()) {
        const { results } = await db.prepare(
          'SELECT uid FROM league_members WHERE code = ? AND left_ts IS NULL AND uid != ?',
        ).bind(code, uid).all();
        if (results.length) return json({ error: 'hand the league to someone else first' }, 400, cors);
      }
      await db.prepare('UPDATE league_members SET left_ts = ? WHERE code = ? AND uid = ?')
        .bind(nowSec(), code, uid).run();
      await audit(db, code, null, uid, 'league.leave', null).run();
      return json({ ok: true }, 200, cors);
    }
  }

  /* -- locks --------------------------------------------------------- */

  if (method === 'POST' && path === '/v1/locks') {
    const bad = validateLockBody(body);
    if (bad) return json({ error: bad }, 400, cors);
    if (!await membership(db, body.code, uid)) return json({ error: 'you are not in that league' }, 403, cors);

    const id = newId('L');
    const ts = nowSec();
    // The server clock decides when this was submitted. Trusting the client
    // here would make the eligibility flag meaningless.
    const placed = Number.isInteger(body.placedAt) ? Math.floor(body.placedAt / 1000) : ts;
    const firstStart = Number.isInteger(body.firstStartAt) ? Math.floor(body.firstStartAt / 1000) : null;
    const eligible = firstStart === null || ts < firstStart ? 1 : 0;

    const stmts = [
      db.prepare(
        `INSERT INTO locks (id, code, uid, week_key, stake_cents, boost_pct, book, placed_ts, submitted_ts,
                            first_start_ts, eligible, source, created_ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, body.code, uid, body.weekKey, body.stakeCents, body.boostPct || 0,
        body.book || null, placed, ts, firstStart, eligible, body.source || 'manual', ts),
    ];
    body.picks.forEach((p, i) => {
      stmts.push(db.prepare('INSERT INTO legs (id, lock_id, idx, raw_text, league, odds_american) VALUES (?,?,?,?,?,?)')
        .bind(`${id}-${i}`, id, i, p.text.trim(), p.league, p.odds === undefined ? null : p.odds));
    });
    // The stake comes off the bankroll the moment the lock is placed.
    stmts.push(db.prepare(
      'INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts) VALUES (?,?,?,?,?,?,?,?,?)',
    ).bind(newId('g'), body.code, uid, body.weekKey, id, 'stake', -body.stakeCents, `stake:${id}`, ts));
    stmts.push(audit(db, body.code, id, uid, 'lock.create', { legs: body.picks.length, stake: body.stakeCents }));
    // Queue it for the scheduled grader, due once its games should be over.
    // Nothing is polled before then, which is what keeps the cron close to
    // free: a Thursday lock on a Sunday game costs nothing until Sunday.
    stmts.push(enqueueStatement(db, id, firstStart, placed));

    await db.batch(stmts);
    return json({ id, eligible: !!eligible }, 200, cors);
  }

  if (seg[0] === 'v1' && seg[1] === 'locks' && seg[2]) {
    const lockId = seg[2];
    const lock = await db.prepare('SELECT * FROM locks WHERE id = ?').bind(lockId).first();
    if (!lock) return json({ error: 'no such lock' }, 404, cors);
    const mine = await membership(db, lock.code, uid);
    if (!mine) return json({ error: 'you are not in that league' }, 403, cors);

    if (method === 'DELETE' && seg.length === 3) {
      if (lock.uid !== uid) return json({ error: 'that is not your lock' }, 403, cors);
      // Once a game has started, removing the lock would be a way to take a
      // loser off the standings after the fact.
      if (lock.first_start_ts && nowSec() >= lock.first_start_ts) {
        return json({ error: 'a game on this lock has already started' }, 400, cors);
      }
      // Belt and braces for a lock whose start time was never resolved: once
      // money has actually moved, the record stands and a correction is a
      // compensating entry rather than a deletion.
      if (lock.settled_state) return json({ error: 'this lock has already settled' }, 400, cors);
      await db.batch([
        db.prepare('DELETE FROM ledger WHERE lock_id = ?').bind(lockId),
        db.prepare('DELETE FROM locks WHERE id = ?').bind(lockId),
        audit(db, lock.code, lockId, uid, 'lock.delete', null),
      ]);
      return json({ ok: true }, 200, cors);
    }

    if (method === 'POST' && seg[3] === 'settle') {
      if (!SETTLE_STATES.has(body && body.state)) return json({ error: 'bad settle state' }, 400, cors);
      if (!Number.isInteger(body.returnCents) || body.returnCents < 0) return json({ error: 'bad return' }, 400, cors);
      if (lock.settled_state) {
        return json({ ok: true, already: true, state: lock.settled_state }, 200, cors);
      }
      const ts = nowSec();
      try {
        await db.batch([
          db.prepare('UPDATE locks SET settled_state = ?, settled_return_cents = ?, settled_ts = ? WHERE id = ?')
            .bind(body.state, body.returnCents, ts, lockId),
          db.prepare(
            'INSERT INTO ledger (id, code, uid, week_key, lock_id, kind, delta_cents, idem_key, created_ts) VALUES (?,?,?,?,?,?,?,?,?)',
          ).bind(newId('g'), lock.code, lock.uid, lock.week_key, lockId, 'payout', body.returnCents, `payout:${lockId}`, ts),
          audit(db, lock.code, lockId, uid, 'lock.settle', { state: body.state, returnCents: body.returnCents }),
        ]);
      } catch (e) {
        // The UNIQUE idempotency key means a second settlement attempt lands
        // here instead of paying twice. That is the guard working.
        const again = await db.prepare('SELECT settled_state FROM locks WHERE id = ?').bind(lockId).first();
        if (again && again.settled_state) return json({ ok: true, already: true, state: again.settled_state }, 200, cors);
        throw e;
      }
      return json({ ok: true, state: body.state }, 200, cors);
    }

    if (method === 'POST' && seg[3] === 'override') {
      if (lock.uid !== uid) return json({ error: 'that is not your lock' }, 403, cors);
      const idx = Number(body && body.idx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_LEGS) return json({ error: 'bad leg' }, 400, cors);
      if (!SETTLE_STATES.has(body.state)) return json({ error: 'bad state' }, 400, cors);
      await db.batch([
        db.prepare(
          `INSERT INTO leg_overrides (lock_id, idx, state, actor_uid, reason, created_ts) VALUES (?,?,?,?,?,?)
           ON CONFLICT(lock_id, idx) DO UPDATE SET state = excluded.state, actor_uid = excluded.actor_uid,
             reason = excluded.reason, created_ts = excluded.created_ts`,
        ).bind(lockId, idx, body.state, uid, (body.reason || '').slice(0, 200) || null, nowSec()),
        audit(db, lock.code, lockId, uid, 'leg.override', { idx, state: body.state }),
      ]);
      return json({ ok: true }, 200, cors);
    }
  }

  return json({ error: 'no such route' }, 404, cors);
}

/* ============================== entry ============================== */

export default {
  /**
   * The scheduled grader. Settles finished locks so a result does not wait
   * for somebody to open the app.
   *
   * One line of output per tick on purpose: `wrangler tail` should make the
   * cost of a tick obvious, because Worker CPU is the limit that matters
   * here and a quiet runaway loop would be expensive and invisible.
   */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      const t0 = Date.now();
      try {
        const r = await runGrader(env);
        // Most ticks have nothing due, which is the design working, so those
        // stay to one short line. Anything that did work says what it did.
        if (r.due || r.errors.length) {
          console.log(`grader: due=${r.due} settled=${r.settled} pending=${r.pending} dropped=${r.dropped} ms=${Date.now() - t0}`
            + (r.errors.length ? ` errors=${r.errors.join('; ')}` : ''));
        } else {
          console.log(`grader: idle ms=${Date.now() - t0}`);
        }
      } catch (e) {
        console.error('grader failed', e && e.message, e && e.stack);
      }
    })());
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = !origin || allowedOrigins.includes(origin);
    const cors = corsHeaders(origin, originOk);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originOk) return json({ error: 'origin not allowed' }, 403, cors);
    if (!env.DB) return json({ error: 'no database binding' }, 500, cors);
    if (!env.FIREBASE_PROJECT_ID) return json({ error: 'no project id configured' }, 500, cors);

    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json({ error: 'sign in first' }, 401, cors);

    let claims;
    try {
      claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    } catch (e) {
      return json({ error: `not signed in: ${e.message}` }, 401, cors);
    }

    let body = null;
    if (request.method === 'POST') {
      try {
        const text = await request.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        return json({ error: 'bad JSON' }, 400, cors);
      }
    }

    const url = new URL(request.url);
    try {
      return await route(request.method, url.pathname.replace(/\/+$/, '') || '/', body, env, claims, cors);
    } catch (e) {
      // Never leak a SQL error to the client; it would describe the schema.
      console.error('route failed', url.pathname, e && e.message);
      return json({ error: 'something went wrong' }, 500, cors);
    }
  },
};
