import { $, $$, esc, pct, num, loadJson, showLoadError, applySiteSettings, partyLookup } from './common.js';

const state = { results: null, exit: null, breakdown: 'none' };

function deptLabel(id) {
  const p = state.results && state.results.posts.find((x) => x.id === id);
  return p ? p.dept : id;
}

// The exit poll's call for a post: its top `seats` candidates by number of answers.
function callFor(ep, seats) {
  return [...ep.candidates].sort((a, b) => b.count - a.count).slice(0, seats);
}

function comparison() {
  const e = state.exit;
  const r = state.results;
  const party = partyLookup(r.parties);
  const rows = [];
  let hits = 0;
  let seats = 0;
  for (const ep of e.posts) {
    const p = r.posts.find((x) => x.id === ep.postId);
    if (!p || ep.suppressed || !ep.n) continue;
    const cand = Object.fromEntries(p.candidates.map((c) => [c.id, c]));
    const call = callFor(ep, p.seats);
    const decided = (p.status === 'declared' || p.status === 'unopposed') && p.winners.length;
    const won = new Set(decided ? p.winners : []);
    const hit = call.filter((c) => won.has(c.id)).length;
    if (decided) { hits += hit; seats += p.seats; }
    const who = (c) => `<span class="cand-name"><span class="swatch" data-c="${esc(party(c.party).colour)}"></span>${esc(c.name)}</span>`;
    let verdict = '<span class="pill">No result</span>';
    if (decided) {
      if (hit === p.seats) verdict = '<span class="pill good">Correct</span>';
      else if (hit === 0) verdict = '<span class="pill bad">Missed</span>';
      else verdict = `<span class="pill">${hit} of ${p.seats}</span>`;
    }
    rows.push(`<tr>
      <td>${esc(p.dept || p.name)}${p.seats > 1 ? `<small class="sub">${p.seats} seats</small>` : ''}<span class="verdict">${verdict}</span></td>
      <td>${call.map((c) => `${who(cand[c.id])}<small class="sub">${pct(c.share)} of ${num(ep.n)}</small>`).join('')}</td>
      <td>${decided ? p.winners.map((id) => who(cand[id])).join('') : '<span class="hint">Not declared</span>'}</td>
    </tr>`);
  }
  const box = $('#cmp');
  box.removeAttribute('aria-busy');
  box.innerHTML = rows.length
    ? `<table class="table compare"><thead><tr><th>Post</th><th>Exit poll's call</th><th>Declared winner</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<p class="hint">No post had enough answers to call.</p>';
  $$('.swatch', box).forEach((s) => s.style.setProperty('--c', s.dataset.c));
  $('#cmp-summary').textContent = seats ? `${hits} of ${seats} seats called correctly` : '';
  const hidden = e.posts.filter((ep) => ep.suppressed || !ep.n).length;
  $('#cmp-note').textContent = `The call is the candidate (or, for multi-seat posts, the candidates) picked by the most respondents. ${hidden ? `${hidden} other posts had too few answers to show or call. ` : ''}The exit poll was whoever chose to answer, not a scientific sample.`;
}

function leaderboard() {
  const e = state.exit;
  const r = state.results;
  const party = partyLookup(r.parties);
  $('#lb-lede').textContent = `Final exit-poll results from ${num(e.responses)} people who chose to answer, and how they compared with the declared winners. Not a scientific sample. Breakdowns for groups smaller than ${e.minGroup || 5} are hidden.`;
  const cards = [];
  for (const ep of e.posts) {
    const p = r.posts.find((x) => x.id === ep.postId);
    if (!p || !ep.n) continue;
    const cand = Object.fromEntries(p.candidates.map((c) => [c.id, c]));
    const head = `<div class="post-head"><h3 class="post-name">${esc(p.dept || p.name)}${p.dept ? `<span class="post-dept">${esc(p.name)}</span>` : (p.seats > 1 ? `<span class="post-dept">Share of respondents who picked each candidate (up to ${p.seats} each)</span>` : '')}</h3><span class="status">${num(ep.n)} answered</span></div>`;
    if (ep.suppressed) {
      cards.push(`<article class="post">${head}<p class="hint">Too few answers to show.</p></article>`);
      continue;
    }
    let body;
    if (state.breakdown === 'none') {
      body = `<ul class="cands">${ep.candidates.map((c, i) => {
        const cc = cand[c.id];
        const pp = party(cc.party);
        return `<li class="cand${i < p.seats ? ' top' : ''}" data-c="${esc(pp.colour)}">
          <span class="cand-name"><span class="swatch"></span><span class="nm">${esc(cc.name)}</span><span class="cand-party">${esc(pp.name)}</span></span>
          <span class="cand-votes">${pct(c.share)}<small>${num(c.count)}</small></span>
          <span class="track"><span class="fill" data-w="${c.share}"></span></span></li>`;
      }).join('')}</ul>`;
    } else {
      const groups = state.breakdown === 'dept' ? ep.byDept : ep.byYear;
      const keys = Object.keys(groups).sort((a, b) => (state.breakdown === 'year' ? Number(a) - Number(b) : deptLabel(a).localeCompare(deptLabel(b))));
      const order = ep.candidates.map((c) => c.id);
      body = keys.length
        ? `<div class="batches-wrap"><table class="breakdown"><thead><tr><th>${state.breakdown === 'dept' ? 'Programme' : 'Year'}</th>${order.map((id) => `<th>${esc(cand[id].name.split(' ')[0])}</th>`).join('')}<th>n</th></tr></thead><tbody>${keys.map((k) => {
          const g = groups[k];
          const best = Math.max(...order.map((id) => g.shares[id] || 0));
          return `<tr><td>${esc(state.breakdown === 'dept' ? deptLabel(k) : `Year ${k}`)}</td>${order.map((id) => `<td class="${g.shares[id] === best && best > 0 ? 'hi' : ''}">${pct(g.shares[id] || 0)}</td>`).join('')}<td>${num(g.n)}</td></tr>`;
        }).join('')}</tbody></table></div>`
        : '<p class="hint">No group is large enough to show.</p>';
    }
    cards.push(`<article class="post">${head}${body}</article>`);
  }
  const lb = $('#lb');
  lb.innerHTML = cards.join('') || '<p class="empty"><strong>No answers recorded</strong>Nobody answered the exit poll.</p>';
  $$('.cand', lb).forEach((li) => li.style.setProperty('--c', li.dataset.c));
  requestAnimationFrame(() => $$('.fill', lb).forEach((f) => { f.style.width = `${Number(f.dataset.w) * 100}%`; }));
}

$('#lb-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !state.exit) return;
  state.breakdown = b.dataset.b;
  $$('#lb-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  leaderboard();
});

// Archived: load the bundled final files once.
Promise.all([loadJson('data/results.json'), loadJson('data/exitpoll.json')])
  .then(([r, e]) => {
    state.results = r;
    state.exit = e;
    applySiteSettings(r.settings);
    comparison();
    leaderboard();
  })
  .catch(() => showLoadError($('#cmp')));
