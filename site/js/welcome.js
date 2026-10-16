// One-time welcome note on the public pages (/, /poll, /board). Loaded as its own module so it never
// holds up the live results: the page keeps loading and polling behind the dialog.
const KEY = 'welcome-seen-v1';

function seen() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; } // storage blocked: show once per page load
}
function remember() {
  try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked: nothing to remember */ }
}

function el(tag, attrs = {}, text = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function show() {
  const dlg = el('dialog', { id: 'welcome', class: 'welcome', 'aria-labelledby': 'welcome-title', 'aria-describedby': 'welcome-text' });
  const inner = el('div', { class: 'welcome-inner' });
  const body = el('div', { id: 'welcome-text', class: 'stack' });
  body.append(
    el('p', {}, 'This site is anonymous for all practical purposes. Your university ID is scrambled on your phone before anything is sent, and nothing you post or answer is linked back to you.'),
    el('p', {}, "Please don't misuse that. We're putting this up with trust in CETians. Answer the exit poll once, for yourself. Be fair to candidates, and keep it free of personal attacks. Posts that cross the line will be taken down."),
  );
  const actions = el('div', { class: 'toolbar welcome-actions' });
  const link = el('a', { href: '/privacy', id: 'welcome-privacy' }, 'Read how your data is handled');
  const ok = el('button', { type: 'button', class: 'btn', id: 'welcome-ok' }, 'Got it');
  actions.append(link, ok);
  inner.append(el('h2', { id: 'welcome-title' }, 'Before you start'), body, actions);
  dlg.append(inner);
  document.body.append(dlg);

  // Every way out counts as dismissing it: the button, Esc, the backdrop and the privacy link.
  // Remember straight away (the close event fires later, after a quick reload or link tap could already be under way).
  const dismiss = () => { remember(); dlg.close(); };
  ok.addEventListener('click', dismiss);
  dlg.addEventListener('cancel', remember); // Esc
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dismiss(); }); // only the backdrop hits the bare dialog
  link.addEventListener('click', remember);
  dlg.addEventListener('close', () => { remember(); dlg.remove(); });

  try {
    dlg.showModal();
  } catch {
    dlg.remove(); // a browser without modal dialogs: skip the note rather than get in the way
    return;
  }
  ok.focus();
}

if (!seen()) show();
