'use strict';
// The CloudFront Function that serves clean URLs. Runs the real file the same way the dev server does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handler = vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', 'lib', 'clean-urls.js'), 'utf8')}; handler`);
const run = (uri, querystring = {}) => handler({ request: { uri, querystring } });

test('clean URLs are served from the matching .html file', () => {
  assert.equal(run('/').uri, '/index.html');
  for (const p of ['poll', 'board', 'privacy', 'admin']) assert.equal(run(`/${p}`).uri, `/${p}.html`);
});

test('old .html URLs redirect (301) to the clean ones and keep the query string', () => {
  const r = run('/admin.html', { code: { value: 'abc-123' }, state: { value: 'x_Y' } });
  assert.equal(r.statusCode, 301);
  assert.equal(r.headers.location.value, '/admin?code=abc-123&state=x_Y');
  assert.equal(r.headers['cache-control'].value, 'no-store');
  assert.equal(run('/index.html').headers.location.value, '/');
  assert.equal(run('/poll.html').headers.location.value, '/poll');
  assert.equal(run('/board.html', { a: { value: '1', multiValue: [{ value: '1' }, { value: '2' }] } }).headers.location.value, '/board?a=1&a=2');
});

test('trailing slash redirects to the clean URL', () => {
  assert.equal(run('/poll/').headers.location.value, '/poll');
});

test('everything else passes through untouched', () => {
  for (const uri of ['/css/app.css', '/js/results.js', '/fonts/figtree-latin.woff2', '/favicon.svg', '/config.json', '/constructor', '/poll.htm', '/other.html']) {
    const r = run(uri);
    assert.equal(r.statusCode, undefined, uri);
    assert.equal(r.uri, uri);
  }
});
