'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createApp } = require('../lambda/app');
const { createMemoryStore } = require('../lambda/store-memory');

const voter = (id) => crypto.createHash('sha256').update(`cetunion2026:${id}`).digest('hex');

async function setup() {
  const store = global.__makeStore ? await global.__makeStore() : createMemoryStore();
  const app = createApp(store, { secondPassMs: 0, log: { error() {} } });
  const call = async (method, path, body, user) => {
    const ev = { rawPath: path.split('?')[0], requestContext: { http: { method } }, headers: {}, body: body ? JSON.stringify(body) : undefined };
    const qs = path.split('?')[1];
    if (qs) ev.queryStringParameters = Object.fromEntries(new URLSearchParams(qs));
    if (user) ev.requestContext.authorizer = { jwt: { claims: { email: user } } };
    const r = await app.handle(ev);
    return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers };
  };
  return { store, app, call };
}

const IMPORT = `# Chairperson
Anu K | Red Front
Rahul M | Blue Union
Sara P | Red Front
# University Union Councillors
A One | Red Front
B Two | Blue Union
C Three | Red Front
# UG Representative (B.Tech Applied Electronics & Instrumentation)
Solo Candidate | Blue Union
# B.Tech Computer Science & Engineering
Dev A | Red Front
Dev B | Blue Union
`;

test('import, counting, declare, tie handling', async () => {
  const { call, store } = await setup();
  assert.equal((await call('GET', '/api/admin/state')).status, 401);
  let r = await call('POST', '/api/admin/import', { text: IMPORT }, 'a@x');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('GET', '/api/admin/state', null, 'a@x');
  const chair = r.body.all.posts.find((p) => p.id === 'chair');
  assert.equal(chair.candidates.length, 3);
  assert.equal(r.body.all.parties.length, 2);
  const aei = r.body.results.posts.find((p) => p.id === 'ug-aei');
  assert.equal(aei.status, 'unopposed');
  assert.equal(aei.winners.length, 1);

  const [c1, c2, c3] = chair.candidates;
  r = await call('POST', '/api/admin/posts/chair/batches', { label: 'Booth 1', votes: { [c1.id]: 10, [c2.id]: 7 }, invalid: 2 }, 'a@x');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call('POST', '/api/admin/posts/chair/batches', { label: 'Booth 2', votes: { [c2.id]: 3, [c3.id]: 1 } }, 'b@x');
  assert.equal(r.status, 201);
  const pub = store.published['results.json'];
  const pc = pub.posts.find((p) => p.id === 'chair');
  assert.equal(pc.status, 'counting');
  assert.equal(pc.tie, true); // 10 vs 10
  assert.equal(pc.invalid, 2);
  r = await call('POST', '/api/admin/posts/chair/finalize', {}, 'a@x');
  assert.equal(r.status, 409);
  // negative correction can't push totals below zero
  r = await call('POST', '/api/admin/posts/chair/batches', { label: 'fix', votes: { [c3.id]: -2 } }, 'a@x');
  assert.equal(r.status, 400);
  r = await call('POST', '/api/admin/posts/chair/batches', { label: 'Booth 3', votes: { [c1.id]: 5 } }, 'a@x');
  r = await call('POST', '/api/admin/posts/chair/finalize', {}, 'a@x');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const declared = store.published['results.json'].posts.find((p) => p.id === 'chair');
  assert.equal(declared.status, 'declared');
  assert.deepEqual(declared.winners, [c1.id]);
  const red = store.published['results.json'].tally.find((t) => t.party === chair.candidates[0].party);
  assert.ok(red.won >= 1);
  // locked after declaring
  r = await call('POST', '/api/admin/posts/chair/batches', { label: 'late', votes: { [c1.id]: 1 } }, 'a@x');
  assert.equal(r.status, 400);
  // removing a voted candidate is refused
  r = await call('POST', '/api/admin/import', { text: '# Chairperson\nRahul M | Blue Union\nSara P | Red Front\n' }, 'a@x');
  assert.equal(r.status, 400);
  r = await call('GET', '/api/admin/audit', null, 'a@x');
  assert.ok(r.body.audit.length >= 5);
});

test('version conflicts between two admins', async () => {
  const { call } = await setup();
  await call('POST', '/api/admin/import', { text: IMPORT }, 'a@x');
  const st = (await call('GET', '/api/admin/state', null, 'a@x')).body;
  const v = st.all.posts.find((p) => p.id === 'chair').version;
  let r = await call('PUT', '/api/admin/posts/chair', { name: 'Chairperson', version: v }, 'a@x');
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/admin/posts/chair', { name: 'Chair', version: v }, 'b@x');
  assert.equal(r.status, 409);
});

test('exit poll: window, one per ID, reveal and suppression', async () => {
  const { call, store, app } = await setup();
  await call('POST', '/api/admin/import', { text: IMPORT }, 'a@x');
  const st = (await call('GET', '/api/admin/state', null, 'a@x')).body;
  const chair = st.all.posts.find((p) => p.id === 'chair');
  const uuc = st.all.posts.find((p) => p.id === 'uuc');
  const cse = st.all.posts.find((p) => p.id === 'ug-cse');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let r = await call('PUT', '/api/admin/settings', { settings: { pollOpensAt: iso(now + 3600e3), pollClosesAt: iso(now + 7200e3), pollRevealAt: iso(now + 7200e3) } }, 'a@x');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ans = (id) => ({ voter: voter(id), dept: 'ug-cse', year: 3, choices: { chair: [chair.candidates[0].id], uuc: [uuc.candidates[0].id, uuc.candidates[1].id], 'ug-cse': [cse.candidates[1].id] } });
  r = await call('POST', '/api/poll', ans('TVE23CS001'));
  assert.equal(r.status, 403);
  await call('PUT', '/api/admin/settings', { settings: { pollOpensAt: iso(now - 60e3), pollClosesAt: iso(now + 3600e3), pollRevealAt: iso(now + 3600e3) } }, 'a@x');
  for (let i = 1; i <= 6; i++) {
    r = await call('POST', '/api/poll', ans(`TVE23CS00${i}`));
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  r = await call('POST', '/api/poll', ans('TVE23CS001'));
  assert.equal(r.status, 409);
  // too many picks for a 1-seat post
  r = await call('POST', '/api/poll', { ...ans('TVE23CS099'), choices: { chair: [chair.candidates[0].id, chair.candidates[1].id] } });
  assert.equal(r.status, 400);
  // unopposed posts are not pollable
  r = await call('POST', '/api/poll', { ...ans('TVE23CS098'), choices: { 'ug-aei': [st.all.posts.find((p) => p.id === 'ug-aei').candidates[0].id] } });
  assert.equal(r.status, 400);
  // another dept's rep is not pollable
  r = await call('POST', '/api/poll', { ...ans('TVE23CS097'), dept: 'ug-me', year: 2 });
  assert.equal(r.status, 400);

  await app.publishAll();
  let pub = store.published['exitpoll.json'];
  assert.equal(pub.revealed, false);
  assert.equal(pub.responses, 6);
  assert.equal(pub.posts, undefined);

  await call('PUT', '/api/admin/settings', { settings: { pollOpensAt: iso(now - 7200e3), pollClosesAt: iso(now - 60e3), pollRevealAt: iso(now - 60e3) } }, 'a@x');
  pub = store.published['exitpoll.json'];
  assert.equal(pub.revealed, true);
  const pc = pub.posts.find((p) => p.postId === 'chair');
  assert.equal(pc.n, 6);
  assert.equal(pc.candidates[0].share, 1);
  assert.ok(pc.byDept['ug-cse']);
  assert.ok(pc.byYear['3']);
  r = await call('POST', '/api/poll', ans('TVE23CS050'));
  assert.equal(r.status, 403);
  const admin = (await call('GET', '/api/admin/poll', null, 'a@x')).body;
  assert.ok(Object.keys(admin.perMinute).length >= 1);
});

test('noticeboard: validation, cooldown, reports auto-hide, moderation', async () => {
  const { call } = await setup();
  let r = await call('POST', '/api/board', { voter: voter('TVE22ME010'), title: 'Hi', body: 'too short' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/board', { voter: voter('TVE22ME010'), title: 'Hi', body: 'see www.example.com for more info today' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/board', { voter: voter('TVE22ME010'), title: 'Hi', body: 'call me on 98765 43210 for details please' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/board', { voter: voter('TVE22ME010'), title: 'Hi', body: 'tve22me010 is the worst person here' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/board', { voter: voter('TVE22ME010'), title: 'Canteen', body: 'The canteen needs more seating before anything else happens.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.post.id;
  r = await call('POST', '/api/board', { voter: voter('TVE22ME010'), title: 'Again', body: 'Posting again right away should be blocked now.' });
  assert.equal(r.status, 429);
  r = await call('POST', `/api/board/${id}/comments`, { voter: voter('TVE22ME011'), body: 'Agreed, totally.' });
  assert.equal(r.status, 201);
  r = await call('GET', '/api/board');
  assert.equal(r.body.posts.length, 1);
  assert.equal(r.body.posts[0].comments, 1);
  assert.equal(r.body.posts[0].reports, undefined);
  assert.match(r.headers['cache-control'], /max-age=5/);
  for (let i = 0; i < 5; i++) await call('POST', `/api/board/${id}/report`, { voter: voter(`TVE22ME02${i}`) });
  // duplicate report from same ID does not count twice
  await call('POST', `/api/board/${id}/report`, { voter: voter('TVE22ME020') });
  r = await call('GET', '/api/board');
  assert.equal(r.body.posts.length, 0);
  r = await call('GET', '/api/admin/board', null, 'a@x');
  assert.equal(r.body.posts[0].hidden, true);
  assert.equal(r.body.posts[0].reports, 5);
  r = await call('POST', `/api/admin/board/${id}/restore`, {}, 'a@x');
  assert.equal(r.status, 200);
  await call('POST', `/api/board/${id}/report`, { voter: voter('TVE22ME099') });
  r = await call('GET', '/api/board');
  assert.equal(r.body.posts.length, 1, 'reviewed posts stay up');
  r = await call('POST', `/api/admin/board/${id}/delete`, {}, 'a@x');
  r = await call('GET', '/api/board');
  assert.equal(r.body.posts.length, 0);
});

test('origin secret is enforced', async () => {
  const app = createApp(global.__makeStore ? await global.__makeStore() : createMemoryStore(), { originSecret: 's3cret', log: { error() {} } });
  const r = await app.handle({ rawPath: '/api/health', requestContext: { http: { method: 'GET' } }, headers: {} });
  assert.equal(r.statusCode, 403);
  const ok = await app.handle({ rawPath: '/api/health', requestContext: { http: { method: 'GET' } }, headers: { 'X-Origin-Verify': 's3cret' } });
  assert.equal(ok.statusCode, 200);
});
