// Node runner for the selftest. The suite itself is pure and takes its
// fixtures as an argument, so the browser page and this file are the only two
// places that know how to load them.
import { readFileSync } from 'node:fs';
import { report } from '../dk/selftest.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));

const ok = report({
  nfl: fx('nfl_final_car_gb.json'),
  nba: fx('nba_final_okc.json'),
  cfb: fx('cfb_labels_keys_mismatch.json'),
  nflBoard: fx('nfl_scoreboard.json'),
});

process.exit(ok ? 0 : 1);
