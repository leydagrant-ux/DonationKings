# DonationKings

A parlay tracker with a weekly bankroll league, for a group of friends.

Enter a lock, and it grades itself against live game data. Everyone in a league
starts the week with the same bankroll, stakes come off it, payouts go back,
and busting ends your week. The name is the joke: a parlay is mostly a
donation.

**[Open the app](https://leydagrant-ux.github.io/DonationKings/)**

## What it does

- **Locks grade themselves.** Write a leg the way the book words it, for
  example `Jordan Love Over 249.5 Passing Yards`, and the app resolves it to a
  real game and a real player and settles it off the box score.
- **A progress bar per leg while the game runs.** Bars go green when a leg is
  mathematically safe and red when it is dead. Sportsbook apps do not do this,
  and it is the reason the live board is worth opening.
- **Leagues with invite codes.** Six characters, share it with whoever. Be in
  as many as you like; the group chat one and the work one stay separate.
- **Weekly standings**, Monday to Sunday, plus all time and a history of who
  took each week.
- **Nothing is graded on a guess.** Anything the engine is not sure about asks
  you instead, with a one-tap answer, so a lock is never stuck.

## Getting your friends on it

1. Open the app and make an account.
2. Start a league. You get a six-character code.
3. Send them the **Share link** from the league screen. It takes them straight
   in: they make an account and land in your league without typing the code.

On a phone, use Add to Home Screen and it behaves like an app.

If somebody would rather type the code, Join a league on the first screen takes
it in any case, with or without spaces.

## How it is built

No framework, no build step, no dependencies in the app. Vanilla ES modules
served as static files.

| | |
|---|---|
| Scores | ESPN's public JSON, free and keyless, read straight from the browser |
| Sign-in | Firebase Auth, identity only |
| Data | Cloudflare D1 behind a Worker that verifies the Firebase token |
| Hosting | GitHub Pages |
| Cost | $0 |

The grading engine is pure functions over a normalized snapshot, which is why
it can be tested properly without a network. Nothing graded is ever stored:
verdicts, prices and progress are recomputed from live data on every render,
so a stale grade cannot be persisted and then believed.

## Tests

```bash
node tools/selftest.mjs      # 383 checks: odds, grading, leagues, storage
node tools/worker_test.mjs   #  88 checks: the real Worker routes
python -I tools/schema_test.py  # 14 checks: the real D1 schema
```

The last two are stronger than they look. D1 is SQLite, so `schema_test.py`
exercises the real DDL, constraints and triggers, and `worker_test.mjs` drives
the actual route handlers against a real database through a small D1 shim.
Neither needs an account or a network.

## Running it

```bash
python -m http.server 8791 --directory .
```

- `/index.html` the app
- `/index.html?demo` filled with sample data from committed fixtures, saving
  nothing
- `/selftest.html` the test suite in a browser
- `/preview.html` a static design preview

See [SETUP.md](SETUP.md) for the backend, and [STATUS.md](STATUS.md) for where
the build is and what is still to come.

## Not a betting service

This tracks bets you placed somewhere else. It does not take wagers, hold
money, or offer odds, and the bankroll in a league is a scoreboard rather than
a balance. It also shows you your real return by leg count, which tends to be
a sobering number, and that is deliberate.
