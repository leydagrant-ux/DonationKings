# DonationKings status

Sports parlay tracker with a weekly friend-group competition. Screenshot a bet
slip, the app reads it, grades it off live game data, and ranks everyone's
bankroll for the week.

**Read this file first.** The plan is the why; this file is the where.

---

## Where it stands

**SHIPPED.** Live at <https://leydagrant-ux.github.io/DonationKings/>, backed
by a deployed Worker and D1. 485 checks pass across three suites.

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
worker/         the backend: Worker, D1 schema, wrangler config
index.html      the shell; its only job is to load dk/app.js
dk/app.js       state, routing, event wiring. The only stateful module
dk/backend.js   one async surface, two implementations: local and cloud
dk/auth.js      Firebase sign-in, and nothing else
dk/api.js       calls to the Worker
dk/config.js    the two things to fill in before leagues can be shared
dk/store.js     versioned localStorage, migrations, demo data
dk/feed.js      the ONLY module that touches the score feed
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
dk/selftest.js  383 checks over all the pure modules
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
regression test; do not "simplify" them away.

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
