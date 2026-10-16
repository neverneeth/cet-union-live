import { $, $$, esc, fmtTime, fmtDayTime, pct, num, api, poll, loadConfig, idField, humanCheck, showMsg, toast, applySiteSettings, partyLookup } from './common.js';

const DONE_KEY = 'exitpoll-submitted-2026';
const state = { results: null, exit: null, breakdown: 'none', formBuilt: false, id: null, human: null, cfg: {} };

let doneFlag = false;
try { doneFlag = localStorage.getItem(DONE_KEY) === '1'; } catch { /* storage blocked */ }

const contested = (p) => p.candidates.length > p.seats;

function deptLabel(id) {
  const p = state.results && state.results.posts.find((x) => x.id === id);
  return p ? p.dept : id;
}

function buildDeptSelect() {
  const sel = $('#dept');
  const posts = state.results.posts;
  const grp = (g, label) => `<optgroup label="${label}">${posts.filter((p) => p.group === g).map((p) => `<option value="${esc(p.id)}">${esc(p.dept)}</option>`).join('')}</optgroup>`;
  sel.innerHTML = `<option value="">Choose your programme</option>${grp('ug', 'Undergraduate')}${grp('pg', 'Postgraduate')}`;
}

function buildYearSelect() {
  const sel = $('#year');
  const p = state.results.posts.find((x) => x.id === $('#dept').value);
  if (!p) { sel.disabled = true; sel.innerHTML = '<option value="">Choose a programme first</option>'; return; }
  const prev = sel.value;
  sel.disabled = false;
  sel.innerHTML = `<option value="">Choose your year</option>${Array.from({ length: p.years || 4 }, (_, i) => `<option value="${i + 1}">Year ${i + 1}</option>`).join('')}`;
  if (prev && Number(prev) <= (p.years || 4)) sel.value = prev;
}

function questionHtml(p, party) {
  const multi = p.seats > 1;
  const name = `q-${p.id}`;
  const opts = p.candidates.map((c) => {
    const pp = party(c.party);
    return `<label class="opt"><input type="${multi ? 'checkbox' : 'radio'}" name="${esc(name)}" value="${esc(c.id)}"><span class="swatch" data-c="${esc(pp.colour)}"></span><span>${esc(c.name)}</span><span class="party">${esc(pp.name)}</span></label>`;
  }).join('');
  const skip = multi ? '' : `<label class="opt skip"><input type="radio" name="${esc(name)}" value="" checked><span>Skip this question</span></label>`;
  const title = p.dept ? `Your rep: ${p.dept}` : p.name;
  return `<fieldset class="q" data-post="${esc(p.id)}" data-seats="${p.seats}">
    <legend>${esc(title)}</legend>
    ${multi ? `<p class="hint">Pick up to ${p.seats}, or leave blank to skip.</p>` : ''}
    ${opts}${skip}
  </fieldset>`;
}

function buildQuestions() {
  const party = partyLookup(state.results.parties);
  const dept = $('#dept').value;
  const keep = collectChoices();
  const posts = state.results.posts.filter((p) => contested(p) && (p.group === 'main' || p.id === dept));
  const box = $('#questions');
  box.innerHTML = posts.length
    ? posts.map((p) => questionHtml(p, party)).join('')
    : '<p class="card hint">Candidate lists are not up yet. Check back shortly.</p>';
  if (!dept) box.insertAdjacentHTML('beforeend', '<p class="hint">Choose your programme above to also answer about your department representative.</p>');
  $$('.swatch', box).forEach((s) => s.style.setProperty('--c', s.dataset.c));
  for (const [postId, ids] of Object.entries(keep)) {
    for (const id of ids) {
      const input = box.querySelector(`fieldset[data-post="${CSS.escape(postId)}"] input[value="${CSS.escape(id)}"]`);
      if (input) input.checked = true;
    }
  }
}

function collectChoices() {
  const out = {};
  $$('#questions fieldset.q').forEach((fs) => {
    const ids = $$('input:checked', fs).map((i) => i.value).filter(Boolean);
    if (ids.length) out[fs.dataset.post] = ids;
  });
  return out;
}

$('#questions').addEventListener('change', (e) => {
  const fs = e.target.closest('fieldset.q');
  if (!fs || e.target.type !== 'checkbox') return;
  const seats = Number(fs.dataset.seats);
  const checked = $$('input:checked', fs);
  if (checked.length > seats) {
    e.target.checked = false;
    toast(`You can pick at most ${seats} for this post. Untick one first.`, true);
  }
});
$('#dept').addEventListener('change', () => { buildYearSelect(); buildQuestions(); });

$('#poll-submit').addEventListener('click', async () => {
  const btn = $('#poll-submit');
  const msg = $('#poll-msg');
  showMsg(msg, '');
  try {
    const voter = await state.id.value();
    const dept = $('#dept').value;
    const year = Number($('#year').value);
    if (!dept) throw new Error('Choose your programme.');
    if (!year) throw new Error('Choose your year of study.');
    const choices = collectChoices();
    if (!Object.keys(choices).length) throw new Error('Answer at least one question.');
    const turnstile = await state.human.token();
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    await api('/api/poll', { method: 'POST', body: { voter, dept, year, choices, turnstile } });
    markDone();
  } catch (e) {
    state.human && state.human.reset();
    if (e.status === 409) { markDone(); return; }
    showMsg(msg, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit my answers';
  }
});

function markDone() {
  doneFlag = true;
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
  $('#uid').value = '';
  render();
  window.scrollTo({ top: 0 });
}

function leaderboard() {
  const e = state.exit;
  const r = state.results;
  const party = partyLookup(r.parties);
  $('#lb-lede').textContent = `Based on ${num(e.responses)} responses from people who chose to answer. Not a scientific sample, and not a prediction. Breakdowns for groups smaller than ${e.minGroup || 5} are hidden.`;
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
  lb.innerHTML = cards.join('') || '<p class="empty"><strong>No answers recorded</strong>Nobody answered the exit poll this time.</p>';
  $$('.cand', lb).forEach((li) => li.style.setProperty('--c', li.dataset.c));
  requestAnimationFrame(() => $$('.fill', lb).forEach((f) => { f.style.width = `${Number(f.dataset.w) * 100}%`; }));
}

$('#lb-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.breakdown = b.dataset.b;
  $$('#lb-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  leaderboard();
});

function render() {
  const r = state.results;
  const e = state.exit;
  if (!r || !e) return;
  applySiteSettings(r.settings);
  const s = r.settings;
  $$('.reveal-time').forEach((el) => { el.textContent = fmtTime(s.pollRevealAt); });
  const dot = $('#poll-state');
  const show = (id) => ['#poll-loading', '#poll-form-wrap', '#poll-done', '#poll-wait', '#leaderboard'].forEach((x) => { $(x).hidden = x !== id; });

  if (e.revealed && e.posts) {
    dot.className = 'live-dot';
    dot.textContent = 'Results';
    $('#poll-count').textContent = `${num(e.responses)} responses`;
    $('#poll-lede').hidden = true;
    show('#leaderboard');
    leaderboard();
    return;
  }
  $('#poll-count').textContent = e.responses ? `${num(e.responses)} responses so far` : '';
  if (e.state === 'open' && !doneFlag) {
    dot.className = 'live-dot pulse';
    dot.textContent = `Open until ${fmtTime(s.pollClosesAt)}`;
    if (!state.formBuilt) {
      buildDeptSelect();
      buildQuestions();
      state.formBuilt = true;
    }
    show('#poll-form-wrap');
    return;
  }
  dot.className = 'live-dot stale';
  if (e.state === 'open' && doneFlag) { dot.textContent = `Open until ${fmtTime(s.pollClosesAt)}`; show('#poll-done'); return; }
  const text = {
    not_open: `The exit poll opens at ${fmtDayTime(s.pollOpensAt)}, when voting starts.`,
    closed: `The exit poll has closed. Results appear here at ${fmtDayTime(s.pollRevealAt)}.`,
    disabled: 'The exit poll is paused for a moment. Check back shortly.',
  }[e.state] || 'Loading…';
  dot.textContent = { not_open: 'Not open yet', closed: 'Closed', disabled: 'Paused' }[e.state] || '';
  $('#poll-wait-text').textContent = text;
  show(doneFlag && e.state !== 'not_open' ? '#poll-done' : '#poll-wait');
}

(async () => {
  state.cfg = await loadConfig();
  poll('/data/results.json', 20000, (d) => {
    if (!d) return;
    const first = !state.results;
    state.results = d;
    if (first) state.id = idField($('#uid'), $('#uid-hash'), d.settings.idPattern);
    if (state.formBuilt && !$('#poll-form-wrap').hidden) { /* keep the form stable while someone is answering */ }
    render();
  });
  poll('/data/exitpoll.json', 15000, (d) => { if (d) { state.exit = d; render(); } });
  state.human = humanCheck($('#human'), state.cfg.turnstileSiteKey);
})();
