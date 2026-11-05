// ui-stats.js: the record screen.
//
// One job: show what has actually happened, including the parts nobody wants
// to see. The app is called DonationKings and the joke only works if the
// numbers are honest, so a losing ROI is printed in red at full size rather
// than softened or buried.

import { esc, money } from './ui.js';
import { LEAGUES } from './espn.js';

const LEAGUE_LABEL = { nfl: 'NFL', cfb: 'CFB', nba: 'NBA', cbb: 'CBB', mixed: 'Mixed' };

const pct = (v) => (v === null || v === undefined ? '--' : `${(v * 100).toFixed(1)}%`);
const signed = (cents) => `${cents > 0 ? '+' : ''}${money(cents)}`;
const cls = (cents) => (cents > 0 ? 'up' : cents < 0 ? 'down' : '');

/** Column definitions, shared by every breakdown table. */
const COLS = [
  { key: 'key', label: '', sortable: true },
  { key: 'bets', label: 'Bets', sortable: true },
  { key: 'stakedCents', label: 'Wagered', sortable: true, fmt: money },
  { key: 'profitCents', label: 'P/L', sortable: true, fmt: signed, colour: true },
  { key: 'roi', label: 'ROI', sortable: true, fmt: pct, colourRoi: true },
];

function labelFor(key, kind) {
  if (kind === 'sports') return LEAGUE_LABEL[key] || String(key).toUpperCase();
  if (kind === 'legCounts') return key === '1' ? 'Single' : `${key} legs`;
  return String(key);
}

function tableHTML(rows, { kind, sortKey, sortDir, title, note }) {
  if (!rows.length) return '';
  return `<section class="stats-block">
    <div class="section"><h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ''}</div>
    <table class="stats-table">
      <thead><tr>${COLS.map((c) => `
        <th class="${c.key === 'key' ? 'col-key' : 'col-num'} ${sortKey === c.key ? 'sorted ' + sortDir : ''}">
          <button data-action="sort-stats" data-kind="${esc(kind)}" data-key="${esc(c.key)}">
            ${esc(c.label)}${sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        </th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="col-key">${esc(labelFor(r.key, kind))}
          <span class="rec">${r.won}-${r.lost}${r.push ? `-${r.push}` : ''}${r.open ? ` · ${r.open} live` : ''}</span></td>
        <td class="col-num">${r.bets}</td>
        <td class="col-num">${money(r.stakedCents)}</td>
        <td class="col-num ${cls(r.profitCents)}">${signed(r.profitCents)}</td>
        <td class="col-num ${r.roi === null ? '' : cls(r.roi)}">${pct(r.roi)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`;
}

/**
 * The headline tiles.
 *
 * Money at risk sits next to profit on purpose: profit counts only settled
 * bets, so without the open figure beside it the page would look like a
 * complete account of the money when some of it is still on the table.
 */
function tilesHTML(o, streaks) {
  const run = streaks.current;
  const runLabel = run === 0 ? 'None'
    : run > 0 ? `${run} win${run === 1 ? '' : 's'}`
      : `${-run} loss${run === -1 ? '' : 'es'}`;

  return `<div class="stat-tiles">
    <div class="tile"><span class="t-label">Wagered</span><span class="t-big">${money(o.stakedCents)}</span>
      <span class="t-sub">${o.bets} ${o.bets === 1 ? 'lock' : 'locks'}</span></div>
    <div class="tile"><span class="t-label">Profit</span><span class="t-big ${cls(o.profitCents)}">${signed(o.profitCents)}</span>
      <span class="t-sub">settled only</span></div>
    <div class="tile"><span class="t-label">ROI</span><span class="t-big ${o.roi === null ? '' : cls(o.roi)}">${pct(o.roi)}</span>
      <span class="t-sub">${money(o.settledStakeCents)} settled</span></div>
    <div class="tile"><span class="t-label">Record</span><span class="t-big">${o.won}-${o.lost}${o.push ? `-${o.push}` : ''}</span>
      <span class="t-sub">${o.winRate === null ? 'nothing settled' : `${pct(o.winRate)} hit rate`}</span></div>
    <div class="tile"><span class="t-label">At risk</span><span class="t-big">${money(o.atRiskCents)}</span>
      <span class="t-sub">${o.open} still running</span></div>
    <div class="tile"><span class="t-label">Run</span><span class="t-big ${run > 0 ? 'up' : run < 0 ? 'down' : ''}">${esc(runLabel)}</span>
      <span class="t-sub">best ${streaks.longestWin}, worst ${streaks.longestLoss}</span></div>
  </div>`;
}

function highlightHTML(o, titleOf) {
  if (!o.best && !o.worst) return '';
  const row = (h, entry, k) => (!entry ? '' : `<div class="hl ${k}">
    <span class="hl-label">${esc(h)}</span>
    <span class="hl-name">${esc(titleOf(entry.lock))}</span>
    <span class="hl-amt ${k}">${signed(entry.profitCents)}</span>
  </div>`);
  return `<section class="stats-block">
    <div class="section"><h2>Highlights</h2></div>
    <div class="hl-list">
      ${row('Biggest hit', o.best, 'up')}
      ${row('Worst beat', o.worst, 'down')}
    </div>
  </section>`;
}

/**
 * sort: { sports: {key, dir}, legCounts: {key, dir} }
 */
export function statsHTML(report, { sort = {}, titleOf = () => '', sortRows }) {
  const o = report.overall;

  if (!o.bets) {
    return `<div class="section"><h2>Stats</h2><p>Nothing to measure yet.</p></div>
      <div class="empty"><div>Add a lock and this fills in: what you have wagered,
      what came back, and your ROI broken down by sport and by how many legs you stack.</div></div>`;
  }

  const block = (kind, title, note) => {
    const s = sort[kind] || { key: 'stakedCents', dir: 'desc' };
    return tableHTML(sortRows(report[kind], s.key, s.dir), {
      kind, sortKey: s.key, sortDir: s.dir, title, note,
    });
  };

  return `<div class="section"><h2>Stats</h2><p>Across every league you are in.</p></div>
    ${tilesHTML(o, report.streaks)}
    ${block('sports', 'By sport', 'A parlay spanning two sports counts once, under Mixed.')}
    ${block('legCounts', 'By size', 'The honest one. Watch what happens as the legs pile up.')}
    ${highlightHTML(o, titleOf)}`;
}
