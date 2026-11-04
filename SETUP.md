# Going live

**This is DONE as of 2026-11-04.** Kept as the record of what was set up and
how to redo it.

| | |
|---|---|
| Firebase project | `donationkings` (403792935207) |
| Worker | <https://donationkings-api.leydagrant.workers.dev> |
| D1 database | `donationkings`, id `493d5b49-72cb-4b72-b21e-6244cc318b3d` |
| Plan | Firebase Spark and Cloudflare free, $0/month |

## The one thing that did not work

`npx wrangler d1 execute --remote --file=./schema.sql` **fails** with
`Authentication error [code: 10000]`, even though the OAuth token from
`wrangler login` shows `d1 (write)` and the account is Super Administrator.
The `--file` form uploads through D1's bulk **import** endpoint, which that
token cannot use. The ordinary **query** endpoint works fine with the same
token, which is how you tell the two apart:

```bash
npx --yes wrangler@latest d1 execute donationkings --remote --command "SELECT 1"
```

So the schema is applied with `worker/apply-schema.ps1`, which sends the whole
file as one `--command` instead:

```bash
cd worker; .\apply-schema.ps1 -Remote
```

That script strips comments before joining the file onto one line. It has to:
leaving a trailing `-- ...` would comment out the rest of the statement and
fail in a way that reads like a SQL error rather than a formatting one.

---

## Doing it again from scratch

Four things, about twenty minutes. Everything below is free tier.

---

## 1. Firebase, for sign-in only

Firebase is used for nothing but identity. No locks, no money and no league
data go near it; all of that lives in D1 behind the Worker.

1. <https://console.firebase.google.com> and create a project. Turn Google
   Analytics off, it is not needed.
2. **Build -> Authentication -> Get started -> Email/Password -> Enable.**
   Leave "Email link" off.
3. **Project settings -> Your apps -> Web (`</>`)**, register an app, and copy
   the `firebaseConfig` values it shows.
4. **Authentication -> Settings -> Authorized domains**, add wherever you host
   the app (`leydagrant-ux.github.io`). `localhost` is already there.

Then fill in `dk/config.js`:

```js
export const FIREBASE = {
  apiKey: 'AIza...',
  authDomain: 'donationkings-xxxx.firebaseapp.com',
  projectId: 'donationkings-xxxx',
  appId: '1:123...:web:abc...',
};
```

These values are public by design. They identify the project; they do not
authorize anything. What authorizes a request is the signed ID token, which
the Worker verifies against Google's own keys on every single call.

Worth doing a separate project from LockIN rather than reusing it: your
friends will have DonationKings accounts and no business having LockIN ones.

## 2. The database

```bash
cd worker
npx wrangler d1 create donationkings
```

Paste the `database_id` it prints into `worker/wrangler.toml`, then create the
tables in both places:

```bash
npx wrangler d1 execute donationkings --local  --file=./schema.sql
```

```bash
npx wrangler d1 execute donationkings --remote --file=./schema.sql
```

## 3. The Worker

Put your Firebase project id into `worker/wrangler.toml` as
`FIREBASE_PROJECT_ID`, then:

```bash
npx wrangler deploy
```

It prints a URL like `https://donationkings-api.leydagrant.workers.dev`. Put
that into `dk/config.js` as `API_URL`, and make sure `ALLOWED_ORIGINS` in
`wrangler.toml` lists wherever you serve the app from.

## 4. Check it

Open the app. You should get a sign-in screen instead of the
"running on this device only" notice. Make an account, start a league, and
check that the invite code works from a second browser or a phone.

```bash
npx wrangler tail
```

That streams the Worker's logs while you poke at it, which is the fastest way
to see a rejected token or a bad route.

---

## What is already tested, and what is not

Worth being precise about, because "it deploys" and "it works" are different
claims.

**Tested, with no account needed:**

- The schema, against real SQLite. D1 is SQLite, so the DDL, the CHECK
  constraints, the triggers and the standings query are all genuinely
  exercised: `python -I tools/schema_test.py`, 14 checks.
- Every Worker route, against real SQLite through a D1 shim, including the
  authorization rules: who can rename a league, who can remove whom, that a
  non-member cannot read a league, that a lock cannot be deleted after
  kickoff, and that settling twice does not pay twice:
  `node tools/worker_test.mjs`, 88 checks.
- The token verifier's structural rejections, including an `alg: none`
  forgery.
- The whole client engine: `node tools/selftest.mjs`, 383 checks.

**Not tested, because it needs your accounts:**

- A real Firebase ID token verified against Google's live keys. The code is
  lifted from the LockIN Worker where it runs in production, but the round
  trip here has never happened.
- `wrangler.toml` actually binding D1 at runtime. The file is valid TOML and
  declares every binding the Worker reads, which was checked, but nothing has
  booted it.
- Two devices seeing the same league.

So expect the first deploy to need a small fix, most likely a wrong project id
or a missing authorized domain. `npx wrangler tail` will say which.

## Local data

Anything you entered before signing in stays in that browser and does not move
to the server. There is no migration yet: the leagues and locks you make while
signed out are separate from the ones you make signed in. If you have been
using it locally and want that history on the server, say so and I will write
the import, rather than you retyping it.

## Still to come

- A scheduled grader in the Worker, so locks settle while nobody has the app
  open. Right now whoever opens the app first reports the result, which is
  idempotent and agrees across devices, but needs somebody to open the app.
- Screenshot reading, which is the headline feature and deliberately last.
- A service worker, so the app installs properly to a home screen.
