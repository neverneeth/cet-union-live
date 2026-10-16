// Light / dark / system theme. Loaded as a classic (blocking) script in <head> so the saved choice
// is applied before first paint. No inline script: the site runs under a strict CSP.
(function () {
  var KEY = 'theme';
  var ORDER = ['system', 'light', 'dark'];
  var LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
  var root = document.documentElement;

  function read() {
    try { var v = localStorage.getItem(KEY); return ORDER.indexOf(v) >= 0 ? v : 'system'; } catch (e) { return 'system'; }
  }
  function write(v) {
    try { if (v === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* storage blocked */ }
  }
  function apply(v) {
    if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v);
    else root.removeAttribute('data-theme');
  }
  function sync(btn, v) {
    btn.setAttribute('data-mode', v);
    btn.setAttribute('aria-label', 'Colour theme: ' + LABEL[v] + '. Change theme');
    btn.title = 'Theme: ' + LABEL[v];
  }

  apply(read());

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        sync(btn, read());
        btn.addEventListener('click', function () {
          var next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
          write(next);
          apply(next);
          sync(btn, next);
        });
      })(buttons[i]);
    }
  });
})();
