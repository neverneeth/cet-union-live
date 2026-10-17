import { $, $$, esc, fmtTime, pct, num, loadJson, showLoadError, applySiteSettings, partyLookup, countUp, expand, collapse, reducedMotion } from './common.js';

const state = { data: null, exit: null, group: 'all', q: '', open: new Set(), widths: {}, votes: {} };
const GROUPS = [
  ['main', 'Main panel'],
  ['ug', 'UG representatives'],
  ['pg', 'PG representatives'],
];
const STATUS_TEXT = { awaiting: 'Awaiting count', counting: 'Counting', declared: 'Declared', unopposed: 'Elected unopposed', nocandidates: 'No candidates', nocount: 'No count' };

function seatCells(d, party) {
  const byGroup = { main: [], ug: [], pg: [] };
  for (const p of d.posts) {
    if (!byGroup[p.group]) continue;
    const cand = Object.fromEntries(p.candidates.map((c) => [c.id, c]));
    for (let i = 0; i < p.seats; i++) {
      let cls = 'seat';
      let who = null;
      if (p.winners[i]) { who = cand[p.winners[i]]; cls += p.status === 'unopposed' ? ' won unopp' : ' won'; }
      else if (p.leaders[i]) { who = cand[p.leaders[i]]; cls += ' lead'; }
      const post = p.dept || p.name;
      const tip = who
        ? `${post}: ${who.name} (${party(who.party).name}), ${p.winners[i] ? (p.status === 'unopposed' ? 'elected unopposed' : 'elected') : 'leading'}`
        : `${post}: ${STATUS_TEXT[p.status].toLowerCase()}`;
      byGroup[p.group].push({ cls, colour: who ? party(who.party).colour : null, tip, postId: p.id });
    }
  }
  return byGroup;
}

function renderStrip(d, party) {
  const groups = seatCells(d, party);
  const won = d.tally.reduce((s, t) => s + t.won, 0);
  $('#strip-summary').textContent = `${won} of ${d.seatsTotal} seats decided`;
  const strip = $('#strip');
  strip.innerHTML = GROUPS.map(([g, label]) => `
    <div class="strip-group" data-g="${g}">
      <div class="strip-cells">${groups[g].map((s, i) => `<button class="${s.cls}" data-i="${i}" data-post="${esc(s.postId)}" aria-label="${esc(s.tip)}"></button>`).join('')}</div>
      <div class="strip-label">${label} (${groups[g].length})</div>
    </div>`).join('');
  GROUPS.forEach(([g]) => {
    $$(`.strip-group[data-g="${g}"] .seat`, strip).forEach((el, i) => {
      const c = groups[g][i].colour;
      if (c) el.style.setProperty('--c', c);
    });
  });
  const rows = [...d.tally].sort((a, b) => (b.won - a.won) || (b.leading - a.leading));
  $('#legend').innerHTML = rows.length
    ? rows.map((t) => {
      const p = party(t.party);
      return `<li><span class="swatch" data-c="${esc(p.colour)}"></span><span>${esc(p.name)}</span><b>${t.won}</b><span class="sub">won${t.leading ? `, ${t.leading} leading` : ''}</span></li>`;
    }).join('')
    : '<li class="sub">Seats fill in as results come in.</li>';
  $$('#legend .swatch').forEach((s) => s.style.setProperty('--c', s.dataset.c));
}

function exitFor(postId) {
  const e = state.exit;
  if (!e || !e.revealed || !e.posts) return null;
  return e.posts.find((p) => p.postId === postId && !p.suppressed) || null;
}

function postBlock(p, party) {
  const max = p.counted || 0;
  const exit = exitFor(p.id);
  const exitShare = exit ? Object.fromEntries(exit.candidates.map((c) => [c.id, c.share / p.seats])) : {};
  const top = new Set(p.status === 'declared' || p.status === 'unopposed' ? p.winners : p.leaders);
  const winners = new Set(p.winners);
  const rows = p.candidates.map((c) => {
    const share = max ? c.votes / max : 0;
    const pp = party(c.party);
    const showVotes = (p.status === 'counting' || p.status === 'declared') && !p.countsHidden;
    const tick = exitShare[c.id] !== undefined ? `<span class="poll-tick" data-left="${exitShare[c.id]}" title="Exit poll: ${pct(exitShare[c.id] * p.seats)} of respondents"></span>` : '';
    return `<li class="cand${top.has(c.id) ? ' top' : ''}${winners.has(c.id) && p.status !== 'counting' ? ' winner' : ''}" data-c="${esc(pp.colour)}">
      <span class="cand-name"><span class="swatch"></span><span class="nm">${esc(c.name)}</span><span class="cand-party">${esc(pp.name)}</span></span>
      <span class="cand-votes">${showVotes ? `<span class="n" data-key="${esc(p.id)}|${esc(c.id)}" data-v="${c.votes}">${num(c.votes)}</span><small>${max ? pct(share, 1) : ''}</small>` : ''}</span>
      ${showVotes ? `<span class="track"><span class="fill" data-key="${esc(p.id)}|${esc(c.id)}" data-w="${share}"></span>${tick}</span>` : ''}
    </li>`;
  }).join('');
  let foot = '';
  if (p.countsHidden) foot = '<div class="post-foot"><span>Winner known. Exact counts not available.</span></div>';
  else if (p.status === 'nocount') foot = '<div class="post-foot"><span>Accurate counts not available.</span></div>';
  else if (p.status === 'counting' || p.status === 'declared') {
    const marginTxt = p.tie
      ? '<span class="tie">Tied for the last seat</span>'
      : (p.margin !== null ? `<span>${p.status === 'declared' ? 'Won by' : 'Lead'} ${num(p.margin)}</span>` : '');
    foot = `<div class="post-foot">
      <span>${num(p.counted)} votes counted, ${num(p.invalid)} invalid</span>
      ${marginTxt}
      <span>Updated ${fmtTime(p.lastUpdate)}</span>
      <button class="linkish" data-toggle="${esc(p.id)}" aria-expanded="${state.open.has(p.id)}">${state.open.has(p.id) ? 'Hide' : 'Show'} count updates (${p.batches.length})</button>
    </div>
    ${state.open.has(p.id) ? batchTable(p) : ''}`;
  }
  return `<article class="post" id="post-${esc(p.id)}">
    <div class="post-head">
      <h3 class="post-name">${esc(p.dept ? p.dept : p.name)}${p.dept ? `<span class="post-dept">${esc(p.name)}</span>` : (p.seats > 1 ? `<span class="post-dept">Top ${p.seats} are elected</span>` : '')}</h3>
      <span class="status ${p.status}">${STATUS_TEXT[p.status]}</span>
    </div>
    ${p.candidates.length ? `<ul class="cands">${rows}</ul>` : '<p class="hint">Candidates have not been entered yet.</p>'}
    ${foot}
  </article>`;
}

function batchTable(p) {
  return `<div class="batches-wrap collapse" data-batches="${esc(p.id)}"><table class="batches">
    <thead><tr><th>Update</th>${p.candidates.map((c) => `<th>${esc(c.name.split(' ')[0])}</th>`).join('')}<th>Invalid</th><th>Time</th></tr></thead>
    <tbody>${p.batches.map((b) => `<tr><td>${esc(b.label)}</td>${p.candidates.map((c) => `<td>${num((b.votes || {})[c.id] || 0)}</td>`).join('')}<td>${num(b.invalid)}</td><td>${fmtTime(b.at)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function matches(p) {
  if (state.group !== 'all' && p.group !== state.group) return false;
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return [p.name, p.dept || '', ...p.candidates.map((c) => c.name)].some((s) => s.toLowerCase().includes(q));
}

function renderPosts(d, party) {
  const out = [];
  for (const [g, label] of GROUPS) {
    const list = d.posts.filter((p) => p.group === g && matches(p) && p.status !== 'nocandidates');
    if (!list.length) continue;
    const contested = g === 'main' ? list : list.filter((p) => p.status !== 'unopposed');
    const unopp = g === 'main' ? [] : list.filter((p) => p.status === 'unopposed');
    const decided = list.filter((p) => p.status === 'declared' || p.status === 'unopposed').length;
    const parts = [`<h2 class="section-title">${label}<span>${decided} of ${list.length} decided</span></h2>`];
    if (contested.length) parts.push(`<div class="posts ${g === 'main' ? 'main' : ''}">${contested.map((p) => postBlock(p, party)).join('')}</div>`);
    if (unopp.length) {
      parts.push(`<div class="unopp-list"><h3>Elected unopposed</h3><ul>${unopp.map((p) => {
        const c = p.candidates[0];
        return `<li id="post-${esc(p.id)}"><span class="dept">${esc(p.dept || p.name)}</span><span class="cand-name"><span class="swatch" data-c="${esc(party(c.party).colour)}"></span>${esc(c.name)}</span></li>`;
      }).join('')}</ul></div>`);
    }
    out.push(`<section class="group">${parts.join('')}</section>`);
  }
  const box = $('#posts');
  box.removeAttribute('aria-busy');
  const nothing = d.posts.some((p) => p.status !== 'nocandidates')
    ? '<p class="empty"><strong>No matches</strong>Try another name or department, or clear the search.</p>'
    : '<p class="empty"><strong>Candidates coming soon</strong>The candidate list will appear here before counting starts.</p>';
  box.innerHTML = out.join('') || nothing;
  $$('.cand', box).forEach((li) => li.style.setProperty('--c', li.dataset.c));
  $$('.unopp-list .swatch', box).forEach((s) => s.style.setProperty('--c', s.dataset.c));
  $$('.poll-tick', box).forEach((t) => { t.style.left = `calc(${Math.min(1, Number(t.dataset.left)) * 100}% - 1.5px)`; });
  // Animate bars from their previous width to the new one.
  const fills = $$('.fill', box);
  fills.forEach((f) => { f.style.width = `${(state.widths[f.dataset.key] || 0) * 100}%`; });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fills.forEach((f) => { const w = Number(f.dataset.w); f.style.width = `${w * 100}%`; state.widths[f.dataset.key] = w; });
  }));
  // Count vote numbers up from what this visitor last saw.
  $$('.cand-votes .n', box).forEach((n) => {
    const to = Number(n.dataset.v);
    const from = state.votes[n.dataset.key] ?? 0;
    state.votes[n.dataset.key] = to;
    countUp(n, from, to);
  });
}

function renderLog(d) {
  const ul = $('#log');
  ul.innerHTML = d.log.length
    ? d.log.map((l) => `<li><time>${fmtTime(l.at)}</time><span>${esc(l.post)}: ${esc(l.label)}</span></li>`).join('')
    : '<li><span class="hint">No count updates were recorded.</span></li>';
}

function render() {
  const d = state.data;
  if (!d) return;
  const party = partyLookup(d.parties);
  applySiteSettings(d.settings);
  renderStrip(d, party);
  renderPosts(d, party);
  renderLog(d);
  $('#exit-key').hidden = !(state.exit && state.exit.revealed && state.exit.posts);
}

// ---- events ----
$('#seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.group = b.dataset.g;
  $$('#seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  render();
});
$('#q').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });
$('#posts').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  const id = t.dataset.toggle;
  const sel = `[data-batches="${CSS.escape(id)}"]`;
  if (state.open.has(id)) {
    await collapse($(sel));
    state.open.delete(id);
    render();
  } else {
    state.open.add(id);
    render();
    expand($(sel));
  }
  const again = $(`[data-toggle="${CSS.escape(id)}"]`);
  if (again) again.focus({ preventScroll: true });
});

const tip = document.createElement('div');
tip.className = 'seat-tip';
tip.hidden = true;
document.body.appendChild(tip);
const strip = $('#strip');
const showTip = (el) => {
  tip.textContent = el.getAttribute('aria-label');
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 248, r.left - 100))}px`;
  tip.style.top = `${r.top - 40}px`;
};
strip.addEventListener('pointerover', (e) => { const s = e.target.closest('.seat'); if (s) showTip(s); });
strip.addEventListener('pointerout', () => { tip.hidden = true; });
strip.addEventListener('focusin', (e) => { const s = e.target.closest('.seat'); if (s) showTip(s); });
strip.addEventListener('focusout', () => { tip.hidden = true; });
strip.addEventListener('click', (e) => {
  const s = e.target.closest('.seat');
  if (!s) return;
  state.group = 'all';
  state.q = '';
  $('#q').value = '';
  $$('#seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.g === 'all')));
  render();
  const target = document.getElementById(`post-${s.dataset.post}`);
  if (target) target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
});

// Archived: load the bundled final files once. The exit poll only adds ticks, so the page works without it.
Promise.all([loadJson('data/results.json'), loadJson('data/exitpoll.json').catch(() => null)])
  .then(([d, e]) => { state.data = d; state.exit = e; render(); })
  .catch(() => showLoadError($('#posts')));
