import { $, $$, esc, ago, fmtDayTime, api, poll, loadConfig, idField, humanCheck, showMsg, toast, applySiteSettings, expand, collapse } from './common.js';

const SAVED = 'board-voter-hash';
const state = { cfg: {}, settings: null, posts: [], next: null, open: new Set(), comments: {}, idPattern: null, composeId: null, human: null, dlgHuman: null, dlgId: null };

const saved = {
  get() { try { return sessionStorage.getItem(SAVED) || ''; } catch { return ''; } },
  set(h) { try { sessionStorage.setItem(SAVED, h); } catch { /* ignore */ } },
  clear() { try { sessionStorage.removeItem(SAVED); } catch { /* ignore */ } },
};

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// ---------- rendering ----------
function slipHtml(p) {
  const open = state.open.has(p.id);
  const comments = state.comments[p.id];
  return `<article class="slip" data-id="${esc(p.id)}">
    ${p.title ? `<h3>${esc(p.title)}</h3>` : ''}
    <p class="body">${esc(p.body)}</p>
    <div class="slip-meta">
      <time datetime="${esc(p.createdAt)}" title="${esc(fmtDayTime(p.createdAt))}">${esc(ago(p.createdAt))}</time>
      <button class="linkish" data-act="comments" aria-expanded="${open}">${open ? 'Hide comments' : `${p.comments ? `${p.comments} comment${p.comments === 1 ? '' : 's'}` : 'Comment'}`}</button>
      <button class="linkish" data-act="report">Report</button>
    </div>
    ${open ? `<div class="comments">
      ${comments ? (comments.length ? `<ul>${comments.map((c) => `<li data-cid="${esc(c.id)}">${esc(c.body)}<div class="slip-meta"><span>${esc(ago(c.createdAt))}</span><button class="linkish" data-act="report-comment">Report</button></div></li>`).join('')}</ul>` : '<p class="hint">No comments yet. Start the conversation.</p>') : '<div class="stack skeleton" aria-hidden="true"><span class="sk sk-line w-90"></span><span class="sk sk-line w-50"></span></div><p class="sr-only">Loading comments</p>'}
      ${state.settings && state.settings.commentsOpen === false ? '<p class="hint">Comments are closed right now.</p>' : `<form class="comment-form" data-act="comment"><input type="text" maxlength="300" placeholder="Add a short comment (50 words max)" aria-label="Your comment" required><button class="btn small" type="submit">Post</button></form>`}
    </div>` : ''}
  </article>`;
}

function renderBoard() {
  const box = $('#board');
  box.removeAttribute('aria-busy');
  box.innerHTML = state.posts.length ? state.posts.map(slipHtml).join('') : '<p class="empty"><strong>Nothing here yet</strong>Be the first to share what you think about the election.</p>';
  $('#more').hidden = !state.next;
}

function rerenderSlip(id) {
  const el = $(`.slip[data-id="${CSS.escape(id)}"]`);
  const p = state.posts.find((x) => x.id === id);
  if (el && p) el.outerHTML = slipHtml(p);
}

async function loadPosts({ older = false } = {}) {
  const url = older && state.next ? `/api/board?before=${encodeURIComponent(state.next)}` : '/api/board';
  const r = await api(url);
  if (older) {
    state.posts.push(...r.posts.filter((p) => !state.posts.some((x) => x.id === p.id)));
    state.next = r.next;
  } else {
    // Merge: keep older pages already loaded, refresh the newest page.
    const ids = new Set(r.posts.map((p) => p.id));
    const oldest = r.posts.length ? r.posts[r.posts.length - 1].id : '';
    const tail = state.posts.filter((p) => !ids.has(p.id) && p.id < oldest);
    state.posts = [...r.posts, ...tail];
    if (!tail.length) state.next = r.next;
  }
  renderBoard();
}

async function loadComments(id, after = Promise.resolve()) {
  try {
    const r = await api(`/api/board/${encodeURIComponent(id)}/comments`);
    state.comments[id] = r.comments;
  } catch (e) {
    state.comments[id] = [];
    toast(e.message, true);
  }
  await after; // let the opening animation finish before swapping in the comments
  rerenderSlip(id);
}

// ---------- ID + human-check dialog ----------
function ask({ title, text, go, needHuman }) {
  const dlg = $('#id-dialog');
  const savedHash = saved.get();
  $('#dlg-title').textContent = title;
  $('#dlg-text').textContent = text;
  $('#dlg-go').textContent = go;
  $('#dlg-id-field').hidden = !!savedHash;
  $('#dlg-saved').hidden = !savedHash;
  $('#dlg-uid').value = '';
  showMsg($('#dlg-msg'), '');
  const wantHuman = needHuman && !!state.cfg.turnstileSiteKey;
  $('#dlg-human').hidden = !wantHuman;
  dlg.showModal();
  if (wantHuman) {
    if (!state.dlgHuman) state.dlgHuman = humanCheck($('#dlg-human'), state.cfg.turnstileSiteKey);
    else state.dlgHuman.reset();
  }
  return new Promise((resolve) => {
    const form = $('#id-form');
    const done = (v) => { form.removeEventListener('submit', onSubmit); dlg.removeEventListener('cancel', onCancel); dlg.close(); resolve(v); };
    const onCancel = () => done(null);
    const onSubmit = async (e) => {
      e.preventDefault();
      if (e.submitter && e.submitter.value === 'cancel') { done(null); return; }
      try {
        const voter = $('#dlg-id-field').hidden ? saved.get() : await state.dlgId.value();
        const turnstile = wantHuman ? await state.dlgHuman.token() : '';
        saved.set(voter);
        done({ voter, turnstile });
      } catch (err) {
        showMsg($('#dlg-msg'), err.message);
      }
    };
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('cancel', onCancel);
  });
}
$('#dlg-change').addEventListener('click', () => {
  saved.clear();
  $('#dlg-id-field').hidden = false;
  $('#dlg-saved').hidden = true;
  $('#dlg-uid').focus();
  syncComposeId();
});

// ---------- board interactions ----------
$('#board').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'FORM') return;
  const slip = btn.closest('.slip');
  const id = slip.dataset.id;
  const act = btn.dataset.act;
  if (act === 'comments') {
    if (state.open.has(id)) {
      await collapse($('.comments', slip));
      state.open.delete(id);
      rerenderSlip(id);
    } else {
      state.open.add(id);
      rerenderSlip(id);
      loadComments(id, expand($(`.slip[data-id="${CSS.escape(id)}"] .comments`)));
    }
    const again = $(`.slip[data-id="${CSS.escape(id)}"] [data-act="comments"]`);
    if (again) again.focus({ preventScroll: true });
    return;
  }
  if (act === 'report' || act === 'report-comment') {
    const cid = act === 'report-comment' ? btn.closest('li').dataset.cid : null;
    const ans = await ask({ title: cid ? 'Report this comment?' : 'Report this post?', text: 'Reports are anonymous. Your university ID is only used so each person can report once. If several people report it, it is hidden until a moderator reviews it.', go: 'Report' });
    if (!ans) return;
    try {
      await api(cid ? `/api/board/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}/report` : `/api/board/${encodeURIComponent(id)}/report`, { method: 'POST', body: { voter: ans.voter } });
      toast('Reported. Thanks, the moderators will take a look.');
    } catch (err) { toast(err.message, true); }
  }
});

$('#board').addEventListener('submit', async (e) => {
  const form = e.target.closest('form.comment-form');
  if (!form) return;
  e.preventDefault();
  const id = form.closest('.slip').dataset.id;
  const input = $('input', form);
  const body = input.value.trim();
  if (!body) return;
  if (words(body) > 50) { toast('Comments are limited to 50 words.', true); return; }
  const ans = await ask({ title: 'Post your comment', text: 'Your university ID is checked on this phone and only used to stop rapid-fire commenting. It is not stored with your comment.', go: 'Post comment', needHuman: true });
  if (!ans) return;
  try {
    const r = await api(`/api/board/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { body, voter: ans.voter, turnstile: ans.turnstile } });
    state.comments[id] = [...(state.comments[id] || []), r.comment];
    const p = state.posts.find((x) => x.id === id);
    if (p) p.comments = (p.comments || 0) + 1;
    rerenderSlip(id);
    toast('Comment posted.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#more').addEventListener('click', () => loadPosts({ older: true }).catch((e) => toast(e.message, true)));

// ---------- compose ----------
const bodyEl = $('#body');
const wc = $('#wc');
bodyEl.addEventListener('input', () => {
  const n = words(bodyEl.value);
  wc.textContent = `${n} / 250 words${n > 0 && n < 5 ? ' (at least 5)' : ''}`;
  wc.classList.toggle('bad', n > 250 || (n > 0 && n < 5));
});

function syncComposeId() {
  const has = !!saved.get();
  const field = $('#uid').closest('.field');
  field.hidden = has;
  let note = $('#compose-saved');
  if (has && !note) {
    field.insertAdjacentHTML('afterend', '<p class="hint" id="compose-saved">Posting with the ID you entered earlier on this page. <button class="linkish" type="button" id="compose-change">Use a different ID</button></p>');
    $('#compose-change').addEventListener('click', () => { saved.clear(); syncComposeId(); $('#uid').focus(); });
  } else if (!has && note) note.remove();
}

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#post-msg');
  const btn = $('#post-submit');
  showMsg(msg, '');
  try {
    const n = words(bodyEl.value);
    if (n < 5) throw new Error('Write at least 5 words.');
    if (n > 250) throw new Error(`Keep it to 250 words (you have ${n}).`);
    const voter = saved.get() || await state.composeId.value();
    const turnstile = await state.human.token();
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    const r = await api('/api/board', { method: 'POST', body: { title: $('#title').value, body: bodyEl.value, voter, turnstile } });
    saved.set(voter);
    state.posts.unshift(r.post);
    renderBoard();
    $('#title').value = '';
    bodyEl.value = '';
    $('#uid').value = '';
    bodyEl.dispatchEvent(new Event('input'));
    syncComposeId();
    toast('Published.');
  } catch (err) {
    showMsg(msg, err.message);
  } finally {
    state.human.reset();
    btn.disabled = false;
    btn.textContent = 'Publish post';
  }
});

// ---------- start ----------
(async () => {
  state.cfg = await loadConfig();
  state.human = humanCheck($('#human'), state.cfg.turnstileSiteKey);
  syncComposeId();
  poll('/data/results.json', 60000, (d) => {
    if (!d) return;
    const first = !state.settings;
    state.settings = d.settings;
    applySiteSettings(d.settings);
    if (first) {
      state.composeId = idField($('#uid'), $('#uid-hash'), d.settings.idPattern);
      state.dlgId = idField($('#dlg-uid'), $('#dlg-hash'), d.settings.idPattern);
    }
    $('#compose').hidden = d.settings.boardOpen === false;
    $('#closed-note').hidden = d.settings.boardOpen !== false;
  });
  try { await loadPosts(); } catch (e) { $('#board').removeAttribute('aria-busy'); $('#board').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
  setInterval(() => {
    const typing = $$('.comment-form input').some((i) => i.value) || $('#id-dialog').open;
    if (!document.hidden && !typing) loadPosts().catch(() => {});
  }, 30000);
})();
