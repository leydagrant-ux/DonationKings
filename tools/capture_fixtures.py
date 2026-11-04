"""Capture trimmed ESPN payloads as test fixtures.

Run once (or whenever you want fresh fixtures). Writes LF-only JSON into
../fixtures. We trim hard: the grader only ever looks at game status, the
player box score, scoring plays and the injury report, and the untrimmed
summary payload is mostly news, video and win-probability series.
"""
import io
import json
import os
import urllib.request

BASE = "https://site.api.espn.com/apis/site/v2/sports"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")

# Keep only what the adapter reads, so a fixture stays readable in a diff.
SUMMARY_KEEP = ("header", "boxscore", "scoringPlays", "injuries", "format")
TEAM_FIELDS = ("id", "abbreviation", "displayName", "shortDisplayName", "name", "location",
               "color", "alternateColor")


def linescores(competitor):
    """Per-period scores, for the quarter-by-quarter box score table.

    Only displayValue is kept; the feed also carries a float `value` that is
    the same number. Overtime appends an extra entry, so these stay positional
    and must never be read as "the last one is the 4th quarter".
    """
    ls = competitor.get("linescores")
    if not ls:
        return None
    return [{"displayValue": p.get("displayValue")} for p in ls]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "DonationKings/fixtures"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def trim_summary(d):
    out = {k: d[k] for k in SUMMARY_KEEP if k in d}
    # header carries a lot of league/season furniture we never read
    comps = (out.get("header") or {}).get("competitions") or []
    if comps:
        c = comps[0]
        out["header"] = {
            "id": (out.get("header") or {}).get("id"),
            "competitions": [{
                "id": c.get("id"),
                "date": c.get("date"),
                "status": c.get("status"),
                "competitors": [{
                    "homeAway": t.get("homeAway"),
                    "winner": t.get("winner"),
                    "score": t.get("score"),
                    "linescores": linescores(t),
                    "team": {f: (t.get("team") or {}).get(f) for f in TEAM_FIELDS},
                } for t in (c.get("competitors") or [])],
            }],
        }
    return out


def trim_scoreboard(d):
    events = []
    for e in d.get("events") or []:
        c = (e.get("competitions") or [{}])[0]
        events.append({
            "id": e.get("id"),
            "name": e.get("name"),
            "shortName": e.get("shortName"),
            "date": e.get("date"),
            "competitions": [{
                "date": c.get("date"),
                "status": c.get("status"),
                "odds": c.get("odds"),
                "competitors": [{
                    "homeAway": t.get("homeAway"),
                    "winner": t.get("winner"),
                    "score": t.get("score"),
                    "team": {f: (t.get("team") or {}).get(f) for f in TEAM_FIELDS},
                } for t in (c.get("competitors") or [])],
            }],
        })
    return {"events": events}


def write(name, obj, frozen=False):
    path = os.path.normpath(os.path.join(OUT, name))
    # A frozen fixture is captured once and never regenerated, because the
    # thing it proves is not in the feed any more. The odds board is the
    # case: ESPN carries betting lines only while a game is still "pre", so
    # re-capturing it the next day would quietly replace a board full of
    # prices with one that has none, and the pricing tests would pass while
    # asserting nothing.
    if frozen and os.path.exists(path):
        print("  %-34s frozen, kept as captured" % name)
        return
    text = json.dumps(obj, indent=1, sort_keys=False, ensure_ascii=False)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    print("  %-34s %8.1f KB" % (name, len(text) / 1024.0))


TARGETS = [
    # (league path, event id, fixture name, why this one)
    ("football/nfl", "401873023", "nfl_final_car_gb.json",
     "final; passing+rushing+receiving TDs; a passing TD and its receiver"),
    ("basketball/nba", "401909907", "nba_final_okc.json",
     "final; carries a didNotPlay row with a reason"),
    ("football/college-football", "401866453", "cfb_labels_keys_mismatch.json",
     "CFB passing has 5 labels but 6 keys"),
]

if __name__ == "__main__":
    os.makedirs(os.path.normpath(OUT), exist_ok=True)
    print("summaries:")
    for path, ev, name, _why in TARGETS:
        write(name, trim_summary(get("%s/%s/summary?event=%s" % (BASE, path, ev))))
    print("scoreboards:")
    for path, name in (("football/nfl", "nfl_scoreboard.json"),
                       ("basketball/nba", "nba_scoreboard.json")):
        write(name, trim_scoreboard(get("%s/%s/scoreboard" % (BASE, path))))

    # A board of games that have not started, so it still carries the
    # moneyline, spread and total the entry form quotes from. Captured
    # 2026-11-04 with all 14 games priced by DraftKings. Frozen: see write().
    print("odds board:")
    write("nba_scoreboard_odds.json",
          trim_scoreboard(get("%s/basketball/nba/scoreboard?dates=20261104" % BASE)),
          frozen=True)
    print("done")
