// Dev probe: run the adapter over the saved fixtures and print what it found.
// Not a test. This exists to eyeball the normalization and surface any stat
// label ESPN ships that the tables do not map yet.
import { readFileSync } from 'node:fs';
import { snapshotFromSummary, eventsFromScoreboard } from '../dk/espn.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));

function show(name, league, pick) {
  const s = snapshotFromSummary(fx(name), league);
  console.log(`\n=== ${name} (${league}) ===`);
  console.log(`  ${s.away?.abbr} ${s.away?.score} @ ${s.home?.abbr} ${s.home?.score}` +
              ` | state=${s.state} completed=${s.completed} total=${s.totalScore}`);
  console.log(`  players=${s.players.size} firstTD=${JSON.stringify(s.firstTdScorerName)}` +
              ` injuries=${s.injuries.size}`);
  const w = [...new Set(s.warnings)];
  console.log(`  warnings (${w.length}):`);
  for (const x of w) console.log(`    - ${x}`);
  for (const want of pick) {
    const hits = [...s.players.values()].filter((p) => p.lastNorm === want);
    for (const p of hits) {
      const keep = Object.entries(p.stats)
        .filter(([, v]) => v !== null && v !== 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(`  ${p.display} (${p.teamAbbr}) dnp=${p.didNotPlay}` +
                  ` groups=[${[...p.groups].join(',')}]`);
      console.log(`      ${keep}`);
    }
  }
  const dnp = [...s.players.values()].filter((p) => p.didNotPlay);
  if (dnp.length) console.log(`  didNotPlay: ${dnp.map((p) => `${p.display} (${p.dnpReason})`).join(', ')}`);
}

show('nfl_final_car_gb.json', 'nfl', ['love', 'kraft', 'hubbard', 'jacobs']);
show('nba_final_okc.json', 'nba', ['williams', 'barnhizer']);
show('cfb_labels_keys_mismatch.json', 'cfb', ['poulos']);

for (const [n, lg] of [['nfl_scoreboard.json', 'nfl'], ['nba_scoreboard.json', 'nba']]) {
  const ev = eventsFromScoreboard(fx(n), lg);
  console.log(`\n=== ${n}: ${ev.length} events ===`);
  const e = ev[0];
  console.log(`  ${e.shortName} start=${new Date(e.startAt).toISOString()} state=${e.state}`);
  console.log(`  home names: ${JSON.stringify(e.home.names)}`);
}
