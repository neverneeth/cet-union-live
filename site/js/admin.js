import { $, $$, esc, fmtTime, fmtDayTime, pct, num, api, loadConfig, showMsg, toast } from './common.js';

const S = { cfg: {}, token: '', user: '', data: null, sel: null, editBatch: null, tab: 'count', modFilter: 'review', importDirty: false };
const STATUS = { awaiting: 'Awaiting', counting: 'Counting', declared: 'Declared', unopposed: 'Unopposed', nocandidates: 'No candidates' };

// ================= auth =================
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = () => `${location.origin}/admin`;
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

async function startLogin() {
  if (S.cfg.mode === 'dev') {
    const name = $('#dev-user').value.trim() || 'admin';
    S.token = `dev:${name}`;
    store.set('admin-token', S.token);
    store.set('admin-exp', String(Date.now() + 12 * 3600e3));
    await boot();
    return;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  store.set('pkce-verifier', verifier);
  store.set('pkce-state', st);
  const q = new URLSearchParams({
    response_type: 'code', client_id: S.cfg.clientId, redirect_uri: redirectUri(), scope: 'openid email',
    state: st, code_challenge: challenge, code_challenge_method: 'S256',
  });
  location.assign(`https://${S.cfg.cognitoDomain}/oauth2/authorize?${q}`);
}

async function tokenRequest(params) {
  const r = await fetch(`https://${S.cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: S.cfg.clientId, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || 'Sign-in failed.');
  S.token = data.id_token;
  store.set('admin-token', data.id_token);
  store.set('admin-exp', String(Date.now() + (data.expires_in || 3600) * 1000));
  if (data.refresh_token) store.set('admin-refresh', data.refresh_token);
}

async function ensureToken() {
  const exp = Number(store.get('admin-exp') || 0);
  S.token = store.get('admin-token') || '';
  if (S.token && Date.now() < exp - 5 * 60e3) return true;
  const refresh = store.get('admin-refresh');
  if (refresh && S.cfg.mode !== 'dev') {
    try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }); return true; } catch { /* fall through */ }
  }
  return false;
}

function signOut() {
  ['admin-token', 'admin-exp', 'admin-refresh'].forEach(store.del);
  if (S.cfg.mode === 'dev') { location.reload(); return; }
  location.assign(`https://${S.cfg.cognitoDomain}/logout?${new URLSearchParams({ client_id: S.cfg.clientId, logout_uri: redirectUri() })}`);
}

async function call(path, opts = {}) {
  if (!await ensureToken()) { showLogin('Your session ended. Sign in again.'); throw new Error('Sign in again.'); }
  try {
    return await api(`/api/admin/${path}`, { ...opts, token: S.token });
  } catch (e) {
    if (e.status === 401) { showLogin('Your session ended. Sign in again.'); }
    throw e;
  }
}

function showLogin(text) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#dev-login').hidden = S.cfg.mode !== 'dev';
  if (S.cfg.mode === 'dev') $('#login-text').textContent = 'Local practice mode: no password needed. Nothing here touches the live site.';
  showMsg($('#login-msg'), text || '');
}
$('#login-btn').addEventListener('click', () => startLogin().catch((e) => showMsg($('#login-msg'), e.message)));
$('#logout').addEventListener('click', signOut);

// ================= data =================
async function reload() {
  const d = await call('state');
  S.data = d;
  S.user = d.user;
  $('#who').textContent = `Signed in as ${d.user}`;
  renderPostList();
  renderCountPanel();
  if (!S.importDirty) $('#import-text').value = d.importText;
  if (S.tab === 'candidates') renderParties();
}

const postOf = (id) => S.data.all.posts.find((p) => p.id === id);
const resOf = (id) => S.data.results.posts.find((p) => p.id === id);
const label = (p) => (p.dept ? `${p.dept}` : p.name);

// ================= count tab =================
function renderPostList() {
  const q = $('#post-filter').value.trim().toLowerCase();
  const groups = [['main', 'Main panel'], ['ug', 'UG representatives'], ['pg', 'PG representatives']];
  const html = [];
  for (const [g, name] of groups) {
    const list = S.data.results.posts.filter((p) => p.group === g && (!q || label(p).toLowerCase().includes(q) || p.candidates.some((c) => c.name.toLowerCase().includes(q))));
    if (!list.length) continue;
    html.push(`<div class="grp">${name}</div>`);
    for (const p of list) {
      html.push(`<button data-post="${esc(p.id)}" aria-current="${S.sel === p.id}"><span>${esc(label(p))}</span><span class="pill${p.tie ? ' bad' : ''}">${p.tie ? 'Tie' : STATUS[p.status]}${p.status === 'counting' || p.status === 'declared' ? ` ${num(p.counted)}` : ''}</span></button>`);
    }
  }
  $('#post-list').innerHTML = html.join('');
}
$('#post-filter').addEventListener('input', renderPostList);
$('#post-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-post]');
  if (!b) return;
  S.sel = b.dataset.post;
  S.editBatch = null;
  renderPostList();
  renderCountPanel();
  if (matchMedia('(max-width: 820px)').matches) $('#count-panel').scrollIntoView({ behavior: 'smooth' });
});

function renderCountPanel() {
  const panel = $('#count-panel');
  if (!S.sel || !postOf(S.sel)) { panel.innerHTML = '<p class="empty"><strong>Pick a post to start</strong>Choose a post from the list to enter or check its counts.</p>'; return; }
  const p = postOf(S.sel);
  const r = resOf(S.sel);
  const totals = Object.fromEntries(r.candidates.map((c) => [c.id, c.votes]));
  const batches = S.data.all.batches.filter((b) => b.postId === p.id).sort((a, b) => a.at.localeCompare(b.at));
  const head = `<div class="post-head"><h2 class="post-name">${esc(label(p))}${p.dept ? `<span class="post-dept">${esc(p.name)}</span>` : ''}<span class="post-dept">${p.seats} seat${p.seats > 1 ? 's' : ''}</span></h2><span class="status ${r.status}">${STATUS[r.status]}</span></div>`;

  if (r.status === 'nocandidates') { panel.innerHTML = `${head}<p>No candidates yet. Add them in the Candidates tab.</p>`; return; }
  if (r.status === 'unopposed') { panel.innerHTML = `${head}<p>Elected unopposed: <strong>${esc(r.candidates.map((c) => c.name).join(', '))}</strong>. Nothing to count.</p>`; return; }

  const editing = S.editBatch && batches.find((b) => b.id === S.editBatch);
  const labels = [...new Set(S.data.all.batches.map((b) => b.label))].slice(-30);
  const locked = p.final;
  const form = locked ? `<p class="msg ok">Result declared: ${esc(r.winners.map((id) => p.candidates.find((c) => c.id === id)?.name).join(', '))}. Reopen to change counts.</p>` : `
    <form id="batch-form" class="stack" novalidate>
      <h3>${editing ? `Editing "${esc(editing.label)}"` : 'Add a count update'}</h3>
      <div class="row">
        <div class="field"><label for="b-label">Label</label><input id="b-label" type="text" maxlength="40" list="labels" placeholder="Booth 2, Round 3, CSE…" value="${editing ? esc(editing.label) : ''}"></div>
        ${editing ? '' : `<div class="field"><label for="b-mode">These numbers are</label><select id="b-mode"><option value="add">New votes to add</option><option value="total">Running totals so far</option></select></div>`}
      </div>
      <datalist id="labels">${labels.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
      <div class="entry-grid">
        <span class="h">Candidate</span><span class="h num">Votes</span><span class="h num">Total now</span>
        ${p.candidates.map((c) => `<label for="v-${esc(c.id)}">${esc(c.name)}</label><input id="v-${esc(c.id)}" data-cid="${esc(c.id)}" type="number" inputmode="numeric" step="1" value="${editing ? (editing.votes[c.id] || '') : ''}"><span class="tot">${num(totals[c.id])}</span>`).join('')}
        <label for="v-invalid">Invalid votes</label><input id="v-invalid" type="number" inputmode="numeric" step="1" value="${editing ? (editing.invalid || '') : ''}"><span class="tot">${num(r.invalid)}</span>
      </div>
      <div id="batch-msg" hidden></div>
      <div class="toolbar">
        <button class="btn" type="submit">${editing ? 'Save changes' : 'Add update'}</button>
        ${editing ? '<button class="btn ghost" type="button" id="b-cancel">Cancel edit</button>' : ''}
      </div>
      <p class="hint">Press Enter to move to the next box. Negative numbers correct an earlier mistake.</p>
    </form>`;

  const table = batches.length ? `<h3>Updates entered</h3><div class="batches-wrap"><table class="table"><thead><tr><th>Label</th>${p.candidates.map((c) => `<th class="num">${esc(c.name.split(' ')[0])}</th>`).join('')}<th class="num">Inv.</th><th>By</th><th>Time</th><th></th></tr></thead><tbody>
    ${batches.map((b) => `<tr><td>${esc(b.label)}</td>${p.candidates.map((c) => `<td class="num">${num(b.votes[c.id] || 0)}</td>`).join('')}<td class="num">${num(b.invalid || 0)}</td><td>${esc((b.editedBy || b.by || '').split('@')[0])}</td><td>${fmtTime(b.editedAt || b.at)}</td>
      <td>${locked ? '' : `<button class="linkish" data-edit="${esc(b.id)}">Edit</button> <button class="linkish" data-del="${esc(b.id)}">Delete</button>`}</td></tr>`).join('')}
    <tr><td><strong>Total</strong></td>${p.candidates.map((c) => `<td class="num"><strong>${num(totals[c.id])}</strong></td>`).join('')}<td class="num"><strong>${num(r.invalid)}</strong></td><td colspan="3"></td></tr>
    </tbody></table></div>` : '';

  const actions = `<div class="toolbar">
    ${locked ? '<button class="btn ghost" id="reopen">Reopen result</button>' : (r.status === 'counting' ? '<button class="btn" id="declare">Declare result…</button>' : '')}
    ${r.tie ? '<span class="tie">Tie for the last seat</span>' : ''}
  </div>`;

  panel.innerHTML = head + form + table + actions;

  const f = $('#batch-form');
  if (f) {
    f.addEventListener('submit', submitBatch);
    f.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      const inputs = $$('input', f);
      const i = inputs.indexOf(e.target);
      if (i < inputs.length - 1) { e.preventDefault(); inputs[i + 1].focus(); inputs[i + 1].select(); }
    });
    const cancel = $('#b-cancel');
    if (cancel) cancel.addEventListener('click', () => { S.editBatch = null; renderCountPanel(); });
  }
  $$('[data-edit]', panel).forEach((b) => b.addEventListener('click', () => { S.editBatch = b.dataset.edit; renderCountPanel(); $('#b-label').focus(); }));
  $$('[data-del]', panel).forEach((b) => b.addEventListener('click', () => deleteBatch(b.dataset.del)));
  const dec = $('#declare');
  if (dec) dec.addEventListener('click', openDeclare);
  const reo = $('#reopen');
  if (reo) reo.addEventListener('click', reopen);
}

async function submitBatch(e) {
  e.preventDefault();
  const p = postOf(S.sel);
  const r = resOf(S.sel);
  const msg = $('#batch-msg');
  const mode = $('#b-mode') ? $('#b-mode').value : 'add';
  const votes = {};
  let any = false;
  for (const input of $$('#batch-form input[data-cid]')) {
    if (input.value === '') { if (mode === 'total') { showMsg(msg, 'In running-total mode, fill in every candidate.'); return; } continue; }
    const n = Number(input.value);
    if (!Number.isInteger(n)) { showMsg(msg, 'Use whole numbers only.'); input.focus(); return; }
    const cur = r.candidates.find((c) => c.id === input.dataset.cid).votes;
    votes[input.dataset.cid] = mode === 'total' ? n - cur : n;
    any = true;
  }
  const invRaw = $('#v-invalid').value;
  let invalid = invRaw === '' ? 0 : Number(invRaw);
  if (!Number.isInteger(invalid)) { showMsg(msg, 'Invalid votes must be a whole number.'); return; }
  if (mode === 'total' && invRaw !== '') invalid -= r.invalid;
  if (!any && !invalid) { showMsg(msg, 'Enter at least one number.'); return; }
  const labelText = $('#b-label').value.trim() || (mode === 'total' ? 'Running total' : 'Update');
  const btn = $('#batch-form button[type="submit"]');
  btn.disabled = true;
  try {
    if (S.editBatch) {
      const b = S.data.all.batches.find((x) => x.id === S.editBatch);
      await call(`posts/${encodeURIComponent(p.id)}/batches/${encodeURIComponent(b.id)}`, { method: 'PUT', body: { label: labelText, votes, invalid, version: b.version } });
      toast('Saved. The public page updates within a few seconds.');
      S.editBatch = null;
    } else {
      await call(`posts/${encodeURIComponent(p.id)}/batches`, { method: 'POST', body: { label: labelText, votes, invalid } });
      toast('Added. The public page updates within a few seconds.');
    }
    await reload();
  } catch (err) {
    showMsg(msg, err.message);
    btn.disabled = false;
    if (err.status === 409) reload();
  }
}

async function deleteBatch(id) {
  const b = S.data.all.batches.find((x) => x.id === id);
  if (!confirm(`Delete the update "${b.label}"? Its votes will be removed from the totals.`)) return;
  try {
    await call(`posts/${encodeURIComponent(b.postId)}/batches/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Deleted.');
    await reload();
  } catch (e) { toast(e.message, true); }
}

function openDeclare() {
  const p = postOf(S.sel);
  const r = resOf(S.sel);
  $('#declare-title').textContent = `Declare ${label(p)}`;
  const top = new Set(r.candidates.slice(0, p.seats).map((c) => c.id));
  $('#declare-body').innerHTML = `<p>${r.tie ? `<strong class="tie">There is a tie for the last seat.</strong> Tick the ${p.seats} candidate${p.seats > 1 ? 's' : ''} the returning officer declared.` : `Tick the ${p.seats} elected candidate${p.seats > 1 ? 's' : ''}. The leaders are ticked for you.`}</p>
    <div class="check-list">${r.candidates.map((c) => `<label class="opt"><input type="checkbox" value="${esc(c.id)}" ${top.has(c.id) && !r.tie ? 'checked' : ''}><span>${esc(c.name)}</span><span class="party">${num(c.votes)}</span></label>`).join('')}</div>`;
  showMsg($('#declare-msg'), '');
  const dlg = $('#declare-dialog');
  dlg.showModal();
  const form = $('form', dlg);
  const onSubmit = async (e) => {
    if (!e.submitter || e.submitter.value !== 'go') { form.removeEventListener('submit', onSubmit); return; }
    e.preventDefault();
    const winners = $$('#declare-body input:checked').map((i) => i.value);
    if (winners.length !== p.seats) { showMsg($('#declare-msg'), `Tick exactly ${p.seats}.`); return; }
    try {
      await call(`posts/${encodeURIComponent(p.id)}/finalize`, { method: 'POST', body: { winners, version: p.version } });
      form.removeEventListener('submit', onSubmit);
      dlg.close();
      toast('Result declared.');
      await reload();
    } catch (err) { showMsg($('#declare-msg'), err.message); }
  };
  form.addEventListener('submit', onSubmit);
}

async function reopen() {
  const p = postOf(S.sel);
  if (!confirm(`Reopen ${label(p)}? It goes back to "Counting" on the public page.`)) return;
  try {
    await call(`posts/${encodeURIComponent(p.id)}/reopen`, { method: 'POST', body: { version: p.version } });
    await reload();
  } catch (e) { toast(e.message, true); }
}

// ================= candidates tab =================
$('#import-text').addEventListener('input', () => { S.importDirty = true; });
$('#import-reload').addEventListener('click', () => { S.importDirty = false; $('#import-text').value = S.data.importText; showMsg($('#import-msg'), ''); });
$('#import-save').addEventListener('click', async () => {
  const msg = $('#import-msg');
  try {
    const r = await call('import', { method: 'POST', body: { text: $('#import-text').value } });
    S.importDirty = false;
    showMsg(msg, `Saved. ${r.changed} post${r.changed === 1 ? '' : 's'} changed${r.newParties ? `, ${r.newParties} new part${r.newParties === 1 ? 'y' : 'ies'} added (set their colours below)` : ''}.`, 'ok');
    await reload();
    renderParties();
  } catch (e) {
    showMsg(msg, e.data && e.data.errors ? `${e.message}\n${e.data.errors.join('\n')}` : e.message);
  }
});

function renderParties() {
  const list = S.data.all.parties;
  $('#party-list').innerHTML = list.map((p, i) => `<div class="row party-row" data-i="${i}" data-id="${esc(p.id)}">
    <div class="field"><label>Name</label><input type="text" class="p-name" value="${esc(p.name)}" maxlength="40" aria-label="Party name"></div>
    <div class="field colour"><label>Colour</label><input type="color" class="p-colour" value="${esc(p.colour)}" aria-label="Party colour"></div>
    <div class="field act"><button class="btn ghost small p-del" type="button">Remove</button></div>
  </div>`).join('') || '<p class="hint">No parties yet. They are created when you save candidates with a party.</p>';
}
$('#party-list').addEventListener('click', (e) => { if (e.target.classList.contains('p-del')) e.target.closest('.party-row').remove(); });
$('#party-add').addEventListener('click', () => {
  $('#party-list').insertAdjacentHTML('beforeend', `<div class="row party-row" data-id=""><div class="field"><label>Name</label><input type="text" class="p-name" maxlength="40" aria-label="Party name"></div><div class="field colour"><label>Colour</label><input type="color" class="p-colour" value="#777777" aria-label="Party colour"></div><div class="field act"><button class="btn ghost small p-del" type="button">Remove</button></div></div>`);
});
$('#party-save').addEventListener('click', async () => {
  const parties = $$('.party-row').map((row) => ({ id: row.dataset.id || undefined, name: $('.p-name', row).value, colour: $('.p-colour', row).value }));
  try { await call('parties', { method: 'PUT', body: { parties } }); toast('Parties saved.'); await reload(); renderParties(); } catch (e) { toast(e.message, true); }
});
$('#np-add').addEventListener('click', async () => {
  try {
    await call('posts', { method: 'POST', body: { name: $('#np-name').value, dept: $('#np-dept').value, group: $('#np-group').value, seats: Number($('#np-seats').value) } });
    toast('Post added. Add its candidates in the list above.');
    $('#np-name').value = ''; $('#np-dept').value = '';
    S.importDirty = false;
    await reload();
  } catch (e) { toast(e.message, true); }
});

// ================= moderation tab =================
async function loadMod() {
  const box = $('#mod-list');
  box.innerHTML = '<div class="mod-item skeleton" aria-hidden="true"><span class="sk sk-line w-30"></span><span class="sk sk-line w-90"></span><span class="sk sk-line w-70"></span></div>';
  try {
    const r = await call('board');
    let posts = r.posts;
    if (S.modFilter === 'review') posts = posts.filter((p) => p.hidden || ((p.reports || 0) > 0 && !p.reviewed));
    box.innerHTML = posts.length ? posts.map(modItem).join('') : `<p class="empty">${S.modFilter === 'review' ? '<strong>All clear</strong>Nothing needs review. Reported posts and comments show up here.' : '<strong>No posts yet</strong>Noticeboard posts will show up here.'}</p>`;
  } catch (e) { box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}
function modItem(p) {
  return `<div class="mod-item${p.hidden ? ' hidden-item' : ''}" data-id="${esc(p.id)}">
    <div class="toolbar">${p.hidden ? `<span class="pill bad">Hidden${p.hiddenReason === 'reports' ? ' by reports' : ''}</span>` : '<span class="pill">Visible</span>'}${p.reports ? `<span class="pill bad">${p.reports} report${p.reports === 1 ? '' : 's'}</span>` : ''}${p.reviewed ? '<span class="pill">Reviewed</span>' : ''}<span class="hint">${fmtDayTime(p.createdAt)}</span></div>
    ${p.title ? `<strong>${esc(p.title)}</strong>` : ''}<p class="body">${esc(p.body)}</p>
    <div class="toolbar">
      ${p.hidden ? '<button class="btn small" data-m="restore">Restore</button>' : '<button class="btn small" data-m="hide">Hide</button>'}
      ${!p.hidden && p.reports && !p.reviewed ? '<button class="btn ghost small" data-m="restore">Keep up (mark reviewed)</button>' : ''}
      <button class="btn danger small" data-m="delete">Delete</button>
      <button class="linkish" data-m="comments">Comments (${p.comments || 0})</button>
    </div>
    <div class="mod-comments"></div>
  </div>`;
}
$('#mod-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  const item = b.closest('.mod-item');
  const id = item.dataset.id;
  const cid = b.closest('[data-cid]') ? b.closest('[data-cid]').dataset.cid : null;
  const m = b.dataset.m;
  if (m === 'comments') {
    const r = await call(`board/${encodeURIComponent(id)}/comments`);
    $('.mod-comments', item).innerHTML = r.comments.length ? r.comments.map((c) => `<div class="mod-item${c.hidden ? ' hidden-item' : ''}" data-cid="${esc(c.id)}">${c.hidden ? '<span class="pill bad">Hidden</span> ' : ''}${c.reports ? `<span class="pill bad">${c.reports} reports</span> ` : ''}${esc(c.body)}<div class="toolbar">${c.hidden ? '<button class="btn small" data-m="restore">Restore</button>' : '<button class="btn small" data-m="hide">Hide</button>'}<button class="btn danger small" data-m="delete">Delete</button></div></div>`).join('') : '<p class="hint">No comments.</p>';
    return;
  }
  if (m === 'delete' && !confirm('Delete permanently?')) return;
  try {
    await call(cid ? `board/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}/${m}` : `board/${encodeURIComponent(id)}/${m}`, { method: 'POST', body: {} });
    toast('Done.');
    loadMod();
  } catch (err) { toast(err.message, true); }
});
$('#mod-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.modFilter = b.dataset.f;
  $$('#mod-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadMod();
});
$('#mod-refresh').addEventListener('click', loadMod);

// ================= exit poll tab =================
async function loadPoll() {
  try {
    const e = await call('poll');
    const s = S.data.all.settings;
    $('#ep-summary').textContent = `${num(e.responses)} responses. State: ${e.state.replace('_', ' ')}. Public results ${e.revealed ? 'are visible' : `appear at ${fmtDayTime(e.revealAt)}`}.`;
    $('#ep-toggle').textContent = s.pollEnabled ? 'Pause exit poll' : 'Resume exit poll';
    const now = Date.now();
    const bars = [];
    for (let i = 59; i >= 0; i--) {
      const k = new Date(now - i * 60e3).toISOString().slice(0, 16);
      bars.push(e.perMinute[k] || 0);
    }
    const max = Math.max(1, ...bars);
    $('#ep-spark').innerHTML = bars.map((v, i) => `<span data-h="${v / max}" title="${v} in minute ${i - 59}"></span>`).join('');
    $$('#ep-spark span').forEach((el) => { el.style.height = `${Number(el.dataset.h) * 100}%`; });
    $('#ep-table').innerHTML = (e.posts || []).map((ep) => {
      const p = postOf(ep.postId);
      if (!p) return '';
      const cand = Object.fromEntries(p.candidates.map((c) => [c.id, c.name]));
      return `<div class="ep-post"><h3>${esc(label(p))} <span class="hint">(${num(ep.n)} answered)</span></h3><p class="hint">${ep.candidates.map((c) => `${esc(cand[c.id])} ${pct(c.share)}`).join(', ') || 'No answers yet.'}</p></div>`;
    }).join('');
  } catch (err) { $('#ep-summary').textContent = err.message; }
}
$('#ep-refresh').addEventListener('click', loadPoll);
$('#ep-toggle').addEventListener('click', async () => {
  const s = S.data.all.settings;
  try {
    await call('settings', { method: 'PUT', body: { settings: { pollEnabled: !s.pollEnabled }, version: s.version } });
    await reload();
    loadPoll();
  } catch (e) { toast(e.message, true); }
});

// ================= settings tab =================
const toLocal = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + 5.5 * 3600e3).toISOString().slice(0, 16);
};
const fromLocal = (v) => `${v}:00+05:30`;
function fillSettings() {
  const s = S.data.all.settings;
  $('#s-title').value = s.title || '';
  $('#s-notice').value = s.notice || '';
  $('#s-open').value = toLocal(s.pollOpensAt);
  $('#s-close').value = toLocal(s.pollClosesAt);
  $('#s-reveal').value = toLocal(s.pollRevealAt);
  $('#s-poll').checked = !!s.pollEnabled;
  $('#s-idpat').value = s.idPattern || '';
  $('#s-board').checked = !!s.boardOpen;
  $('#s-comments').checked = !!s.commentsOpen;
  $('#s-thresh').value = s.reportThreshold;
  $('#s-pcd').value = Math.round(s.postCooldownSec / 60);
  $('#s-ccd').value = s.commentCooldownSec;
  $('#s-banned').value = (s.bannedWords || []).join('\n');
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = S.data.all.settings;
  const settings = {
    title: $('#s-title').value, notice: $('#s-notice').value,
    pollOpensAt: fromLocal($('#s-open').value), pollClosesAt: fromLocal($('#s-close').value), pollRevealAt: fromLocal($('#s-reveal').value),
    pollEnabled: $('#s-poll').checked, idPattern: $('#s-idpat').value,
    boardOpen: $('#s-board').checked, commentsOpen: $('#s-comments').checked,
    reportThreshold: Number($('#s-thresh').value), postCooldownSec: Number($('#s-pcd').value) * 60, commentCooldownSec: Number($('#s-ccd').value),
    bannedWords: $('#s-banned').value.split('\n'),
  };
  try {
    await call('settings', { method: 'PUT', body: { settings, version: s.version } });
    showMsg($('#settings-msg'), 'Saved.', 'ok');
    await reload();
    fillSettings();
  } catch (err) { showMsg($('#settings-msg'), err.message); }
});
$('#reset-go').addEventListener('click', async () => {
  const what = $('#reset-what').value;
  if (!confirm(`Clear ${$('#reset-what').selectedOptions[0].textContent.toLowerCase()}? This cannot be undone.`)) return;
  try {
    await call('reset', { method: 'POST', body: { what, confirm: $('#reset-confirm').value.trim() } });
    $('#reset-confirm').value = '';
    toast('Cleared.');
    await reload();
  } catch (e) { toast(e.message, true); }
});
$('#republish').addEventListener('click', async () => {
  try { await call('publish', { method: 'POST', body: {} }); toast('Public files republished.'); } catch (e) { toast(e.message, true); }
});

// ================= log tab =================
async function loadAudit() {
  try {
    const r = await call('audit');
    $('#audit').innerHTML = r.audit.map((a) => `<tr><td>${fmtDayTime(a.at)}</td><td>${esc(a.user.split('@')[0])}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">Nothing yet.</td></tr>';
  } catch (e) { toast(e.message, true); }
}
$('#log-refresh').addEventListener('click', loadAudit);

// ================= tabs + boot =================
$('#admin-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  $$('#admin-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== S.tab; });
  if (S.tab === 'candidates') renderParties();
  if (S.tab === 'moderation') loadMod();
  if (S.tab === 'exitpoll') loadPoll();
  if (S.tab === 'settings') fillSettings();
  if (S.tab === 'log') loadAudit();
});

async function boot() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await reload();
  // Keep the count view fresh so both admins see each other's updates.
  setInterval(() => {
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#batch-form, #settings-form, #import-text, .party-row');
    const hasDraft = $$('#batch-form input').some((i) => i.value && i.id !== 'b-label');
    if (!document.hidden && !typing && !hasDraft && S.tab === 'count') reload().catch(() => {});
  }, 10000);
}

(async () => {
  S.cfg = await loadConfig();
  const params = new URLSearchParams(location.search);
  if (params.get('code') && S.cfg.mode !== 'dev') {
    try {
      if (params.get('state') !== store.get('pkce-state')) throw new Error('Sign-in did not match. Try again.');
      await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri(), code_verifier: store.get('pkce-verifier') || '' });
      history.replaceState(null, '', '/admin');
    } catch (e) { showLogin(e.message); return; }
  }
  if (await ensureToken()) {
    try { await boot(); } catch (e) { showLogin(e.message); }
  } else showLogin();
})();
