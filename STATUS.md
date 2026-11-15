# DonationKings status

Sports parlay tracker with a weekly friend-group competition. Screenshot a bet
slip, the app reads it, grades it off live game data, and ranks everyone's
bankroll for the week.

**Read this file first.** The plan is the why; this file is the where.

---

## Where it stands

**SHIPPED, and it reads screenshots.** Live at <https://leydagrant-ux.github.io/DonationKings/>, backed
by a deployed Worker and D1. 979 checks pass across three suites.

Four bugs hit live during NFL weeks 9 and 10 are fixed; see
[The week 9 and 10 bugs](#the-week-9-and-10-bugs)
below for what was wrong and what is still open.

There is now a read-only route for the TV overlay, `GET /overlay/parlays`. It
is written, tested and pushed but **NOT DEPLOYED**: see
[The TV overlay route](#the-tv-overlay-route).

Build steps 1, 2 and 3 are done.

The backend is live. Firebase project `donationkings`, Worker at
<https://donationkings-api.leydagrant.workers.dev>, D1 database `donationkings`
with all 8 tables, 8 indexes and 8 triggers applied. Smoke-tested: no token is
401, junk token is 401 not 500, a disallowed origin is 403, and CORS preflight
from the app origin returns the right headers.

**Verified end to end across two different browsers on 2026-11-04.** Signed up
in the built-in browser, created league `34PXMF`, then signed up a second
account in Chrome and joined with that code. The joiner saw the league, both
members and the standings; the joiner placed a $25 lock; the owner's browser
then showed that lock and the joiner at $75.00 with "$25.00 live". The live
database holds 2 users, 1 league, 2 members, 1 lock, 1 leg, 1 ledger row and
3 audit rows.

Two disposable test accounts are left in Firebase Authentication
(`dk-test-a@example.com`, `dk-test-b@example.com`). Delete them from the
Firebase console; nothing depends on them. Their credentials are in
`tools/test-accounts.local.json`, which should not be committed.

Verified from the public origin on 2026-11-04: signed in at
`https://leydagrant-ux.github.io`, loaded league `34PXMF` with both members and
the standings, no console errors. The Worker accepts that origin and Firebase
authorizes that domain.

Repo: <https://github.com/leydagrant-ux/DonationKings> (public, which GitHub
Pages requires on a free account). The Firebase web config in `dk/config.js` is
public by design and authorizes nothing; the Worker verifies a signed token on
every request.

GitHub's Pages runners sat Queued for about six minutes on the first deploy.
That is normal and not a misconfiguration. Watch
`/actions` rather than polling the URL.

See [SETUP.md](SETUP.md) for the live values and, importantly, the D1 import
endpoint gotcha that `--file` hits.

```
SETUP.md        how to go live, and what is and is not verified
worker/         the backend: Worker, grader, D1 schema, wrangler config
index.html      the shell; its only job is to load dk/app.js
dk/app.js       state, routing, event wiring. The only stateful module
dk/backend.js   one async surface, two implementations: local and cloud
dk/auth.js      Firebase sign-in, and nothing else
dk/api.js       calls to the Worker
dk/config.js    the two things to fill in before leagues can be shared
dk/store.js     versioned localStorage, migrations, demo data
dk/feed.js      the ONLY module that touches the score feed, and the only
                one that knows a lock is graded against its OWN day
dk/derive.js    stored lock + live data -> verdicts, prices, progress
dk/odds.js      odds, payouts, parlay pricing, reconciliation, bankroll rules
dk/espn.js      the ONLY file that knows an ESPN field name. Raw JSON -> snapshot
dk/resolve.js   leg text -> market, stat, team, athlete, with confidence
dk/grade.js     (leg, snapshot) -> verdict, plus live clinch/dead flags
dk/parlay.js    leg verdicts -> lock verdict and settlement
dk/league.js    invite codes, ISO weeks, membership, standings
dk/theme.css    design tokens and every component class
dk/ui.js        render helpers: lock card, leg rows, box score, chrome
dk/ui-league.js switcher, standings, history, invite, owner controls
dk/ui-entry.js  adding a lock by hand, with a live parser readback
dk/slip.js      slip transcript -> draft lock. Pure, and the reason this works
dk/ingest.js    compress a screenshot, send it up, hand back a draft
dk/selftest.js  773 checks over all the pure modules
preview.html    static design preview, real fixtures through the real engine
selftest.html   browser test runner; sets document.title to the result
design/         exported screenshots of the current look
tools/          fixture capture, node runner, adapter probe
fixtures/       real ESPN payloads, trimmed and committed
```

## Words

A placed parlay is a **Lock**. That is the app's own noun and it is what the
UI says everywhere: "My Locks", "4 Leg Lock", "Single Lock".

"Slip" is kept for one thing only: the sportsbook's own printed bet slip, the
thing a screenshot is of. So `odds.js` and `resolve.js` still say slip, because
they describe transcribing and pricing what a book printed. `parlay.js` and the
UI say lock, because those are about an entry in this app. Keep that line; it
stops the ingest code and the app code from blurring together.

### Running it

Three suites, none of which needs an account or a network:

```bash
node tools/selftest.mjs
```

```bash
node tools/worker_test.mjs
```

```bash
python -I tools/schema_test.py
```

The second and third are worth explaining, because they are stronger than they
look. **D1 is SQLite**, so `schema_test.py` exercises the real DDL, CHECK
constraints, triggers and the standings query against real SQLite, and
`worker_test.mjs` drives the **actual route handlers** against a real database
through a small D1 shim over node's built-in sqlite. The only thing stubbed is
token verification, which the router never does anyway: it receives
already-verified claims. So the authorization rules, the SQL and the
idempotency guard are all genuinely tested without deploying anything.

Serve the folder, then open `/index.html`:

```bash
python -m http.server 8791 --directory .
```

- `/index.html` the app
- `/index.html?demo` the app filled with a plausible league and locks, reading
  the committed fixtures instead of the live slate, and saving nothing
- `/selftest.html` the suite, which sets `document.title` to the pass or fail
  count so headless Chrome can read it without parsing the page
- `/preview.html` the static design preview

### How it fits together

Render is a pure function of state plus fetched data. A stored lock keeps only
the legs as written, the money and the time; resolution, verdicts, prices and
progress are recomputed every render, so a stale grade can never be persisted
and then believed. Polling runs only while something is live, and stops when
the tab is hidden.

There is **one delegated click listener**, bound once to the root and never
re-bound; render only replaces `innerHTML`. The sibling bankroll app
re-attached handlers on every render and ended up firing a single tap three
times.

Entering a lock is typed text per leg ("Jordan Love Over 249.5 Passing
Yards"), not three dropdowns, with the parser's reading shown underneath as
you type. It is the same text a screenshot will eventually produce, so the
ingest work later feeds straight into this path. If the app cannot tell what
you meant, it says so while you are typing rather than at grading time when
the money is already committed.

**`?demo` must read the fixtures, not the live slate.** Pointed at live data it
looks like it works and then shows nothing but pending legs, because the demo's
locks name games that finished last week.

## The look

Modelled on the big sportsbook apps, which is what Grant asked for: true black
canvas, one loud green for anything actionable, gold used only for box score
totals and winning slips, dense cards stacking a header, leg rows and a
quarter-by-quarter box score, pill filters and a floating tab bar.

Deliberately not copied: any real sportsbook's logo, wordmark or tagline, and
any league's team logos. A real brand mark would make the app look like it is
impersonating them. So DonationKings has its own crown mark (a crown with a
down arrow through it, since the joke in the name is that a parlay is a
donation), its own "LONG LIVE THE KING" winner banner, and team identity drawn
as a colour chip from the feed's own colour fields rather than a helmet image.
That also means the UI renders offline and never hotlinks anything.

The one thing here that no sportsbook app does: **a progress bar per leg**, so
a slip can be watched mid-game. It is the reason the live board is worth
opening, and it comes free from the grading engine because clinch and dead are
already computed.

### Layout gotchas worth keeping

- **`overflow: hidden` on the app bar is not a fix.** It hid the avatar
  instead of making the bar fit. A sticky bar is still in flow, so contents
  that refuse to shrink set a minimum width for the whole document and every
  card below inherits the overflow. Items must be able to give: the wordmark
  truncates and is capped, the mark and avatar never shrink.
- **Headless Chrome clamps `--window-size` to a minimum width of about 500px.**
  Asking for 390 or 430 renders at ~500 and crops the screenshot, which looks
  exactly like a layout bug and is not one. Verify layout by measuring in a
  real browser; use headless only for capture, at 500 or wider.
- **The box score belongs to a game, not a leg.** It is drawn once after the
  last leg that references that game, at full card width. Nesting it inside a
  leg repeats the identical table under every leg of a same-game parlay and
  squeezes the quarter columns into the leg indent.
- Always draw the full regulation grid in the box score so a live game's table
  does not reflow column by column as quarters complete.

Note: do **not** add a `.claude/launch.json` entry on port 8777. The parent
folder's LockIN config already owns that port and `preview_start` resolves to
it instead, silently serving the wrong directory.

### Refreshing fixtures

```bash
python -I tools/capture_fixtures.py
```

Re-pulls and re-trims from live ESPN. The trimmer keeps only `header`,
`boxscore`, `scoringPlays` and `injuries`, because the untrimmed summary is
mostly news, video and win-probability series.

---

## What the data actually does

All verified against live endpoints, not assumed. `site.api.espn.com` needs no
API key, sends `Access-Control-Allow-Origin: *` with a 4 second cache, does not
block non-browser user agents, and updates player stats mid-game.

**Four traps, each of which silently grades bets wrong.** Every one has a
regression test; do not "simplify" them away. Three more turned up during
week 9 and are written up under
[The week 9 and 10 bugs](#the-week-9-and-10-bugs): the stat
table's ORDER is load-bearing, a team abbreviation must never match inside a
player's name, and a lock must be graded against its own day's slate.

1. **Align `stats[]` to `labels[]`, never to `keys[]`.** `keys` looks like the
   better thing to match on and is not always the same length: CFB passing has
   5 labels and 6 keys. Across 171 athlete rows in 4 leagues, `stats` matched
   `labels` every time. `keys` is for authoring the tables during development
   and is ignored at runtime.

2. **A passing TD is thrown, not scored.** Seven NFL groups carry a `TD` label.
   `anytimeTd` sums all of them *except* `passing`. Including it would credit
   the quarterback with a touchdown every time he throws one and wrongly cash a
   huge number of anytime-TD legs. The fixture has Jordan Love at `passTd=3`
   and `anytimeTd` absent, with Tucker Kraft at `recTd=1`, from the same play.

3. **Absent is not always zero.** A player who recorded nothing is missing from
   the group entirely. If he appears in *some other* group he played, so the
   stat is a real 0 and the under has won. If he is flagged `didNotPlay` the
   prop is **void**, not lost, because books refund it. In football there is no
   such flag and the box score lists only players who recorded something, so a
   player missing everywhere is genuinely undecidable: that case asks the user
   rather than guessing. Guessing zero loses bets that should be voided;
   guessing void voids bets that should lose.

4. **A slash is a combo separator, not whitespace.** "Rush/Rec Yards" means
   rushing plus receiving. Folding the slash to a space leaves "rush rec yards"
   which falls through to plain receiving yards. Hyphens *do* fold, because
   "3-Pointers Made" and "3 Pointers Made" are the same market.

Other verified facts worth not rediscovering:

- `competitors[].score` is a **string**; `winner` is `undefined` until the game
  is final, so test `=== true` and never truthiness.
- NBA leaves `firstName` and `lastName` **null** and populates only
  `displayName`. Football populates all three. Both are handled by falling back
  to splitting `displayName`; without that fallback, initial matching
  ("J. Williams") silently never fires for basketball.
- NBA ships **one unnamed stat group** per team; football ships ten named ones.
- NBA composite cells split on `-` (`4-8`), NFL passing `C/ATT` splits on `/`.
  The separator is not consistent, so the stat table names the parse per label.
- `scoringPlays[].text` names two players on a passing touchdown
  ("Kraft 12 Yd pass from Love") and only the first scored. Cutting at the
  first digit yields the scorer and drops the passer, which also sidesteps the
  NFL saying "Rush" where college football says "Run".
- The OKC fixture really does contain two players surnamed Williams, and a
  Mitchell on each team. Those are the honest ambiguity tests.

---

## Leagues

Modelled on the poker bankroll app, which already solved this. `genCode`,
`isoWeekKey` and `weekRange` are lifted from it rather than rewritten; the only
change is the dash in the range label.

- **The invite code is the league's id.** Six characters from a 31-letter
  alphabet with 0, O, 1, I and L removed so a code read aloud is unambiguous.
  Bytes at 248 and up are rejected rather than taken modulo 31, because 256 is
  not a multiple of 31 and plain modulo quietly favours the early letters.
  Being unguessable is the whole access model.
- **You can be in several leagues at once.** One for the group chat, one for
  work. Each keeps its own bankroll, standings and history, and the active
  league is explicit state rather than something inferred.
- **One owner per league**, who can rename it, remove members and hand it over.
  The owner cannot simply walk out of a league that still has people in it,
  because nobody would be left to manage it. The weekly bankroll can only be
  changed before the first lock is placed, since changing it later silently
  rewrites every standing that came before.
- **Weeks are Monday to Sunday ISO weeks**, and a lock belongs to the week it
  was placed in, never the week it settled in. A Sunday night game graded at
  3am Monday still counts for Sunday's week.
- **Busting is not a zero balance.** Staking your last $20 leaves you at zero
  with a live lock, and you are not out until it settles against you. So a bust
  needs an empty bankroll AND nothing still running, and the standings sort a
  survivor holding one cent above a tidy $0.
- **All time ranks on profit, not balance**, because the bankroll resets every
  week and a balance means nothing across weeks.

## Design rules that are load-bearing

**`state` is a ledger fact; `clinched` and `dead` are display facts.** A leg
whose outcome is forced mid-game stays `pending` and moves no money, because a
stat correction can still change it. This is what lets the live board be
instant without ever paying out early.

**Clinch logic only applies to monotone stats.** Plus-minus and any average can
fall, so they never clinch. Spreads and moneylines never clinch either: a
21-point lead is not a mathematical certainty and this engine does not do
probability.

**Rollup precedence is deliberate.** Any lost leg kills the slip immediately,
even with legs still pending, because that is what books do and what makes the
leaderboard feel live. Review outranks pending, so three winners plus one
unresolvable leg does not pay out. A loss outranks review, because freezing a
dead slip helps nobody.

**A same-game parlay is not priced as the product of its legs.** Books price
correlated legs jointly. Verifying an SGP against the leg product would flag
every one as a misread, so SGPs verify against the slip's own printed price or
not at all.

**Be certain or be honest.** Anything the resolver is unsure of comes back with
low confidence and a reason, and routes to one-tap manual grading. No slip is
ever stuck, and nothing is graded on a guess.

---

## The backend

Firebase is identity only. Leagues, locks and money live in D1 behind the
Worker, which verifies a Firebase ID token on every request. That URL ships
inside public JavaScript, so without the token gate it would be an open door
to the database; the origin allowlist is not the boundary, because Origin is
trivially forged outside a browser.

Rules the Worker enforces, all tested:

- **Invite codes are generated server-side.** A client-chosen code lets
  somebody squat on one or guess their way in. A client that sends one has it
  ignored.
- **The server clock decides eligibility.** A lock submitted after its first
  game started is still tracked but does not count, and a client claiming an
  earlier `placedAt` does not buy its way around that.
- **A lock cannot be deleted after kickoff**, which would otherwise be a way to
  take a loser off the standings after the fact.
- **Settlement happens once.** Grading runs on each client, so whoever sees the
  games finish first writes the record and everyone else's call is a no-op
  returning what is stored. A conflicting second answer cannot rewrite it.
- **Knowing a league exists is not enough to read it.** Non-members get 403 on
  everything, and "no such league" and "not for you" are deliberately
  indistinguishable so the endpoint is not an oracle for guessing codes.

Two design notes worth keeping:

**The ledger is append-only, with one deliberate exception.** A row is never
edited. Deletion is blocked once a lock has settled, because those rows are
the record of money that actually moved; before settlement the stake row is a
hold, and withdrawing a lock before kickoff has to be able to release it. A
blanket no-delete rule reads stricter and makes a fat-fingered stake
impossible to take back. The schema test asserts both halves.

**STRICT tables promise less than they look like they do.** A STRICT INTEGER
column accepts `'2500'` and coerces it, because that conversion is lossless.
It only refuses what would lose information. So the Worker validates types
itself rather than leaning on STRICT, and both facts have tests.

## The TV overlay route

`GET /overlay/parlays`. One read-only route, serving the parlay board that
runs on the TV upstairs (`../FantasyOverlay`, a Python watcher that draws on a
TCL Google TV through TvOverlay's REST API).

**Status: written, tested, pushed, NOT DEPLOYED.** The run that built it could
not deploy, because the wrangler OAuth token on this machine had expired and
could not be refreshed. Nothing about the endpoint is live yet. See
[Deploying the overlay route](#deploying-the-overlay-route) below for the four
commands.

It exists because the watcher is a Python script on the house wifi with no
Firebase. The alternative was Firebase auth from Python, which means real
account credentials in a config file on a laptop for a convenience feature.

What it returns: the configured person's open locks, with their legs already
graded, in exactly the per-leg shape `dk/grade.js` emits (`state`, `clinched`,
`dead`, `current`, `needed`, `pct`, `overshoot`, `render`, `label`), plus
`stake_cents`, `payout_cents`, a `name` and `started`. That is the shape
`FantasyOverlay/parlay.py` already consumed from mock data, so the contract
was not invented here, it was met. A test asserts every key by name, so a
rename on either side breaks a check rather than a television.

Grading imports `deriveLock` and `feed.loadContext`, the same code the browser
and the cron grader run. The server and the TV cannot reach different verdicts
about a leg, which is the same reason `derive.js` carries no UI import.

Four rules, all tested:

- **It reads.** No INSERT, no UPDATE, nothing touching `ledger`,
  `locks.settled_state` or `grade_queue`. A POST is a 405, and a test counts
  the rows in six tables before and after a poll.
- **One person.** The uid is `OVERLAY_UID`, a secret, never a request
  parameter. There is no request that reads anybody else's bets, which is what
  stops a token on a laptop becoming a way to read the league.
- **Its own gate.** `OVERLAY_TOKEN` is a long random shared secret, compared
  without an early return, refused outright below 32 characters so a
  half-finished deploy fails closed rather than open, and accepted on no other
  path. A Firebase ID token presented here is refused too: the route answers
  before the Firebase gate and never falls through to it.
- **Nothing else changed.** Every other route still demands a Firebase token,
  and the origin allowlist still refuses this route from a disallowed origin.

**Cost is the real constraint, not security.** It is polled every 25 seconds
while a game is on, and one NFL box score is roughly 650KB of JSON whose parse
is most of an invocation's CPU budget. So the work is bounded four ways: no
open locks means no network call at all, which is most of the week; only
STARTED games get a box score, via the new `startedOnly` option in
`feed.loadContext` (off by default, so the app is unchanged, because the app
wants the fixture for a leg still to come); at most six summaries a poll,
overridable with `OVERLAY_MAX_SUMMARIES`; and the finished payload is memoed
in the isolate for twelve seconds.

Two consequences of that cap worth knowing, because they look like bugs:

- **Which legs are graded shifts between polls.** With several open locks, the
  six-summary cap means a leg whose box score was not loaded this time comes
  back as `needs_review` or `pending`. That is a gap in what was fetched, not
  a result. The watcher handles it: a leg that was settled and now is not
  keeps its old snapshot, so a result is announced once instead of once per
  gap.
- **`errors` is normally non-empty on a Sunday.** `"9 more games on the slate
  were not loaded"` is the cap working, not a failure.

"Open locks" rather than "this week's", deliberately: an ISO week boundary
falls on Monday morning, in the middle of nothing, while a Thursday lock is
still running on Sunday. `?week=YYYY-Www` narrows it for anyone who wants it.

### Deploying the overlay route

The token already exists and is already in `FantasyOverlay/config.json` under
`dk_token`. It is not in this repo and must not be. `worker/.dev.vars` holds a
different, throwaway token for `wrangler dev` and is gitignored.

Note `--config wrangler.toml` on every command. There is a stray
`wrangler.jsonc` two directories up that names a different worker, and
wrangler prefers it even when run from inside `worker/`, so a plain
`npx wrangler deploy` here deploys the poker bankroll app.

```powershell
cd worker
$tok = (Get-Content ..\..\FantasyOverlay\config.json -Raw | ConvertFrom-Json).dk_token
$tok | npx wrangler secret put OVERLAY_TOKEN --config wrangler.toml
"<your firebase uid>" | npx wrangler secret put OVERLAY_UID --config wrangler.toml
npx wrangler deploy --config wrangler.toml
```

The uid is whichever row in `users` is yours:

```powershell
npx wrangler d1 execute donationkings --remote --config wrangler.toml --command "SELECT uid, display_name FROM users"
```

Then it should answer `{"error":"overlay token required"}` with no token and
JSON with one. Before deployment it answers
`{"error":"not signed in: malformed token"}`, because the path does not exist
yet and falls to the Firebase gate: that is how to tell whether the deploy
landed.

## Reading a screenshot

Working and deployed. Point it at a bet slip screenshot and it fills the form
in.

The division of labour is the whole design. **A vision model does one thing:
read pixels into text.** Everything after that is `slip.js`, which is
deterministic, offline and tested against transcripts a real model actually
produced. Asking a model to "extract JSON" instead would be less accurate,
untestable, and would drift with every model version.

It runs on **Workers AI**, not Gemini, trying three models in order. Those
model ids are lifted from the LockIN worker where they are already in
production on this account, so no new API key and no new signup. Groq is not
an option: it retired every vision model during 2026.

**The confirmation step is not optional.** The transcript is shown next to the
screenshot and can be edited, and the legs re-read as you type. A 249.5 misread
as 246.5 looks perfectly reasonable on screen and is only wrong when the money
moves, which is exactly the kind of mistake nobody catches.

Things learned from running it on a real DraftKings screenshot:

- **The selection is on one line and its market on the next.** That is the
  layout every real slip uses. Parsing lines independently gave two legs both
  called "Anytime TD Scorer" with no player. The join only happens when the
  current line is not already a complete bet, or a self-contained line like
  "Total Points Over 44.5" gets swallowed into the leg above it.
- **The model wraps its output in a markdown fence** even when told not to.
  Stripped rather than argued with in the prompt.
- The screenshot contains the sportsbook's own navigation, filter chips and
  box score. None of it may become a bet.
- Slips often do not print per-leg prices, only the total. That is reported as
  a warning rather than guessed at.

## The scheduled grader

Running every five minutes, settling finished locks so a result does not wait
for somebody to open the app.

**It imports the same engine the browser uses** (`dk/derive.js` and what that
pulls in), so a phone and the server cannot reach different verdicts about who
won. That is the whole reason `derive.js` carries no UI import and why a
lock's display title is computed by the render layer instead of being derived.

**Worker CPU is the binding constraint, not the database.** One NFL summary is
roughly 650KB of JSON and parsing it is most of a free-tier invocation's
budget, with no way to parse JSON partially. So a tick does a strictly bounded
amount of work: at most 2 locks and 3 box scores, then it stops. A minute
later it does a bit more.

What keeps it close to free is that **a lock is not looked at until its games
should be over**: queued at `first_start + 3h`. A Thursday lock on a Sunday
game costs nothing until Sunday evening, so most ticks find nothing due and
cost one indexed query.

Three details worth keeping:

- **Nothing settles without game data.** A failed fetch leaves the lock open
  and backs off. Guessing on a network failure would pay out wrongly, which is
  the worst bug available in a money app.
- **Backoff, not retry.** 10 minutes doubling to an hour, so a dead feed is
  not a hot loop. It gives up after 60 attempts, about two days.
- **A player-only lock names no team**, so there is nothing to scope the slate
  by. Successive attempts start further down the list, so a lock whose game
  sits past the per-tick cap is reached within a few ticks rather than being
  stuck behind the same first few games forever.

**A working grader looks identical to a broken one.** Most ticks have nothing
due, which is the design succeeding, and it took a probe of what the Worker
could actually see to tell that apart from a query returning nothing. The
answer was that the locks had already been processed and were sitting in a
ten-minute backoff, exactly as intended. `attempts` and `last_error` on
`grade_queue` are the first things to look at; `wrangler tail` alone will
mislead you, because a quiet tick and a broken one print the same nothing.
That is why an idle tick now logs one short line of its own.

Settlement is idempotent in both directions: whichever of a phone or the cron
gets there first writes the record, and the other is a harmless no-op. The
ledger's `UNIQUE` idempotency key is what makes that structural rather than a
convention.

## The week 9 and 10 bugs

Three things went wrong using it live on NFL week 9 (games 8 and 9 November
2026), reported on the 14th. All three were reproduced against the real week 8
and week 9 payloads before anything was changed, which matters because two of
them were quietly settling money the wrong way rather than merely looking
broken. `?dates=20261108` still returns that whole Sunday months later, so the
slate can be replayed rather than guessed at.

**None of the three was in the display layer.** This app does not mirror
somebody else's score, it works the grade out itself, so every one of these was
in how a bet is attached to a game or how a stat is read.

### 1. Locks stayed "live" for ever

**Nothing transitioned them out, because the data that would have settled them
was never fetched.** A scoreboard asked for no date answers with the CURRENT
week. `feed.loadContext` and the cron grader both did exactly that, so once the
board rolled over to week 10 a week 9 lock's games were simply not in the
reply. Every leg fell back to "waiting for the game to start" (true enough:
next week's games really had not started), `isOpenLock` stayed true, and the
Live tab showed it for ever. Reproduced: on 14 November a week 9 lock came back
`pending`, `isOpen=true`, nothing paid.

The worse half is that it did not always just linger. Teams play again. The
leg "Green Bay Packers -3.5" bound itself to week 10's Packers fixture, and a
week 8 "Kansas City Chiefs ML" replayed against week 9's board settles **won**
off the Jets game when it really **lost** 24-28 at Denver. Both are real
payloads; that is a $48 payout on a losing bet.

Fixed by asking for the lock's own day. `feed.loadContext` keeps the current
board for anything placed this week, and for a lock whose games are behind
everything on that board it fetches `?dates=YYYYMMDD` from its own anchor
forward (`firstStartAt`, else `placedAt`, four days at most, never into the
current board). The context now carries `scope`: lock id to the set of event
ids that lock may be graded against, and `derive.js` applies it, so the same
fixture a week later is not even a candidate. `worker/grader.js` does the same
for a lock that has been in backoff since the weekend.

Two things worth keeping:

- **ESPN buckets a board by US Eastern date.** A Sunday night game kicking at
  20:20 ET is 01:20 UTC on Monday and sits on SUNDAY's board. `dateKeyOf` in
  `feed.js` is the only place that knows this.
- **`?dates=` is a day, not a week.** Week 9 had 15 games and `?dates=20261108`
  returns 13 of them: the Thursday and Monday games are on their own days.
  `?dates=2026&seasontype=2&week=9` returns all 15 in one request and is the
  cheaper primitive if this ever needs to be tightened, but it is football-only
  and needs the season and week numbers, which a lock does not carry.

### 2. A bet placed mid-game arrived with no game attached

`earliestStart` in `app.js` was handed `ctx.events`, the GRADING slate, which
`refresh()` empties on purpose whenever you hold no open locks. So the first
lock of a session had nothing to match against and went to the server with
`firstStartAt: null`. It also scanned for team wording only, so a player prop
never found a kickoff even when the slate was loaded.

The server reads a missing kickoff as "no game had started", so a bet placed
**90 minutes into the game** came back `eligible: true` and counted for the
week, and the "Saved, but a game had already started" toast never fired. With
`first_start_ts` null the server's own "a lock cannot be deleted after kickoff"
guard cannot fire either, so a mid-game loser could be taken back off the
standings. All three reproduced through the real route handlers.

Now `resolve.attachEvents` does it: a pure function of the legs and the slate,
given the slate the entry form already holds for its prices, and resolving each
leg properly rather than scanning text. Mid-game that answers the player-prop
case too, because the game is running, so its box score exists and the player
is in it. It returns each pick carrying its `eventId` and the earliest kickoff
across them. The Worker now returns `firstStartAt` on a lock as well, so the
feed can anchor on the real kickoff rather than on when the bet was written.

**What is still open.** A player prop placed BEFORE any kickoff cannot name its
game: no box score exists yet, so there is nothing to match the name against.
Those still go up with no kickoff, which is harmless for eligibility (no game
had started, so it does count) but leaves the delete-after-kickoff guard blind
for that one case. Closing it properly means storing the event id per leg
server-side, `ALTER TABLE legs ADD COLUMN event_id TEXT`, and having the first
grader tick fill it in. `derive.js` already prefers `pick.eventId` when one is
there, and the local signed-out path already keeps it, so the client half is
done; only the column and the route are missing.

### 3. Some props read the wrong stat, and some read the wrong team's score

Two separate faults, and between them the only ones here that were settling
bets wrongly with nobody able to tell.

**The stat table was in the wrong order.** A bare `attempts` sat above
`rushing attempts`, so every rushing-attempts prop was read as PASSING
attempts, which a running back has none of. Kenneth Walker III carried 18 times
in week 9; the grader read 0 and settled an over on 16.5 as a loss. The same
shape of mistake had `receptions` above `longest reception`, so CeeDee Lamb's
48-yard long was graded as his 10 catches. Both now read correctly off the real
payloads. The bare daily-fantasy forms still exist, they just sit after every
"passing ..." AND "rushing ..." version now. Missing wordings were added at the
same time (`Carries`, `FG Made`, `FGM`, `Field Goals`, `Long Rush`, bare `Rec`,
`Stl`, `Blk`): 69 of 70 real book wordings now read correctly, up from 56.

A bare "Interceptions" is deliberately still not matched. It is the market a
quarterback throws and the one a defensive back catches, and guessing either
settles the other wrongly, so it goes to a person.

**A team abbreviation was matching inside a player's name.** `resolveTeam`'s
loose containment pass tested raw substrings against every naming field, so
three letters matched anywhere: "Barrett **Car**ter" resolved to CAR, "La**Cal**e
London" to LAC, "**Den**zel Boston" and "Charles Snow**den**" to DEN. On its own
that was a wasted fetch. Combined with an unrecognized stat wording, which fell
through to the TEAM TOTAL market at exactly the auto-grade confidence, **306
player props on the real week 9 slate were settled off a team's score**. The
loose pass now matches on whole words only, and that count is zero.

The fall-through itself is closed as well, which is the more important half: a
team total is written with nothing after the line ("Packers Over 30.5") and a
player prop always names its stat, so wording left over after the number that
is not a stat this app knows is an unrecognized market and goes to review,
naming the words it could not read. It is no longer a team total.

**First-TD legs could be won by the wrong man.** The scorer is matched from
play text, and the surname fallback had no uniqueness check, so with David
Walker and Jahdae Walker both at Chicago, or four players named Williams at New
England, a first-TD leg cashed on whichever one you did not back. A surname now
only settles it when the box score holds exactly one of them.

Two name traps from the sibling projects were checked and are NOT present here:
suffixes are stripped by `normName`, so "Michael Penix Jr." keys on "penix"
correctly, verified across every suffixed player on the week 9 slate; and this
app reads names from `scoringPlays` (full names) rather than from play-by-play,
so the `S.Perine` abbreviation never reaches it. The initial-with-no-space form
("J.Love") does fail to resolve, all 281 of them, so do not feed it one.

### The week 10 one, found the same way

**A shared first initial is not a match.** A prop on Javonte Williams of
Dallas resolved to Jameson Williams of Detroit. After an exact first name
failed, the fallback tested the first LETTER, and that returns `C.INITIAL`,
0.9, which is above the auto-grade bar, so it was taken silently.

It bit on a Sunday morning because of what the slate looks like then. The
9:30 game was the only one with a box score and Dallas had not kicked off, so
the only Williams the app could see was the wrong one.

The second symptom was the expensive one and came free with the first:
`attachEvents` pins a leg to its game, so the lock was pinned to DETROIT'S
fixture, which had kicked off hours earlier, and the server read that kickoff
as proof the bet was placed mid-game and took it out of the week's standings.
That consequence is new, because before `attachEvents` a player prop never
found a kickoff at all. It is worth keeping in mind for any future change
here: **anything that makes leg resolution more willing to guess now also
decides whether a lock counts.**

A first name has to FIT now: equal, or one a prefix of the other. That still
accepts the two things a slip really does, printing an initial ("J. Williams")
and shortening a name ("Josh" where the roster says Joshua, "Cam" for
Cameron), and refuses two different names that merely start alike. "javonte"
and "jameson" share a letter and nothing else; a prefix test says so and a
first-letter test cannot.

One repair this needed in the live database, because the damage was already
written: a lock created while this was broken carries `eligible = 0` and a
`first_start_ts` belonging to the wrong game, and neither is recomputed. The
leg text is fine and re-resolves correctly on its own, since the event id is
not stored server-side. Only the two columns need it:

```sql
UPDATE locks SET eligible = 1, first_start_ts = NULL WHERE id = '<lock id>';
```

`locks_core_immutable` covers the stake, week, owner and timestamps but not
those two, so the update is allowed. Verified against the real DDL.

### What is still honestly unresolved

- **Team defence props** ("Packers D/ST Over 1.5 Sacks") are not a supported
  market and go to review. The subject is a team, not a player, and nothing
  routes it to the team's defensive totals.
- **A bare game total** ("Over 44.5") still needs the matchup named, because a
  thirteen-game slate cannot say which game it belongs to. This is the design
  working: guessing would be a silent loss.
- **The live database could not be read from here**, so which of Grant's own
  week 9 legs were affected is unknown. The failure modes above are
  characterised against the real slate by prop class rather than by his actual
  bets.

---

## Next task

**Deploy it.** Everything for shared leagues is written and tested; it needs
twenty minutes in the Firebase and Cloudflare consoles to go live. SETUP.md has
the exact commands and says what the first deploy is most likely to trip on.

After that, in order:

1. **A scheduled grader in the Worker.** Right now a lock settles when somebody
   opens the app, which is idempotent and agrees across devices but needs
   somebody to open the app. Worker CPU is the binding constraint, not the row
   budget: one NFL summary is roughly 650KB and parsing it is most of a
   free-tier invocation, so the grader works off a queue a few events per tick.
2. **Importing local data**, for anything entered before signing in. Deliberately
   not half-done: a partial migration that duplicates someone's locks is worse
   than retyping them.
3. **Screenshot reading**, the headline feature, last on purpose because it is
   the riskiest piece and everything works without it. The manual entry path
   already takes the same typed-leg text a screenshot will produce, so it
   feeds straight in.
4. **A service worker**, following LockIN's `sw.js` and not bankroll's, so the
   app installs to a home screen and updates without being removed and re-added.

## Open risks

- **The ESPN endpoints are undocumented.** They work well and are widely used
  but promise nothing. All access goes through `espn.js` so a break is one
  file, and manual grading is always available. Alternates: TheSportsDB,
  balldontlie for NBA, nflverse for NFL after the fact.
- **The free odds feed covers three markets and no more.** A scoreboard entry
  carries a book's moneyline for both sides, the spread for both sides, and the
  game total, and that is the lot. Player props and team totals are not in it at
  any price, so the entry form says so rather than leaving a blank box. Two
  traps: a game drops its odds entirely once it is no longer `pre`, so prices
  cannot be read back after kickoff, and `moneyline.home.close.odds` is a
  **string** (`"-597"`), not a number. `fixtures/nba_scoreboard_odds.json` is a
  frozen capture of a fully priced board for exactly this reason, and
  `capture_fixtures.py` refuses to overwrite it: regenerating it on a later day
  would swap in a board with no prices and the pricing tests would pass while
  asserting nothing.
- **Worker CPU, not D1 rows, is the cron's binding constraint.** One NFL
  summary is roughly 650KB of JSON and a single parse is most of a free-tier
  invocation. The grader must work off a queue a few events at a time, never a
  whole slate per tick. Measure before raising the batch size.
- **Free vision tiers churn.** Groq dropped vision entirely during 2026, which
  is why the fallback here is Cloudflare Workers AI. Keep the model list in one
  allowlisted table and confirm IDs against the live console at build time.
- **College football name matching is the weakest link.** More teams, more
  shared surnames, thinner stats. "Miami" alone is three different programs.
  Treat CFB game-level markets as solid and CFB props as best effort.
