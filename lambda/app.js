'use strict';
// Request router shared by the Lambda (index.js) and the local dev server (dev/server.js).
const crypto = require('crypto');
const core = require('./core');

const { HttpError } = core;

function createApp(store, opts = {}) {
  const { originSecret, hmacSecret = 'dev-only-secret', turnstileSecret, log = console } = opts;

  const json = (statusCode, body, cache = 'no-store') => ({
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
    body: JSON.stringify(body),
  });

  // Keyed hash of the browser-side ID hash. Each scope gets its own key so the poll,
  // posts and reports cannot be joined to each other by this value.
  const voterKey = (scope, voter) => `${scope}:${crypto.createHmac('sha256', hmacSecret).update(`${scope}|${voter}`).digest('base64url').slice(0, 32)}`;

  function requireVoter(body) {
    const v = String((body && body.voter) || '');
    if (!/^[a-f0-9]{64}$/.test(v)) throw new HttpError(400, 'Enter your university ID.');
    return v;
  }

  async function verifyHuman(body) {
    if (!turnstileSecret) return;
    const token = String((body && body.turnstile) || '');
    if (!token) throw new HttpError(400, 'Complete the "verify you are human" check first.');
    const form = new URLSearchParams({ secret: turnstileSecret, response: token });
    let ok = false;
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
      ok = (await r.json()).success === true;
    } catch (e) {
      log.error('turnstile verify failed', e.name);
      throw new HttpError(503, 'The human check could not be verified right now. Try again in a minute.');
    }
    if (!ok) throw new HttpError(400, 'The human check expired. Complete it again and resubmit.');
  }

  async function publishResults(all) {
    const a = all || await store.getAll();
    const results = core.computeResults(a);
    await store.publish('results.json', results);
    return { all: a, results };
  }

  async function publishPoll(all, results) {
    const a = all || await store.getAll();
    const r = results || core.computeResults(a);
    const counters = await store.pollCounters();
    await store.publish('exitpoll.json', core.computePoll(counters, r, a.settings));
  }

  async function publishAll() {
    const { all, results } = await publishResults();
    await publishPoll(all, results);
  }

  // Two admins can save at the same moment; a second pass shortly after makes sure the
  // last published file includes both changes.
  async function publishAfterCountChange() {
    const first = await publishResults();
    await new Promise((r) => setTimeout(r, opts.secondPassMs ?? 800));
    await publishResults();
    return first;
  }

  const publicPost = (p) => ({ id: p.id, title: p.title, body: p.body, createdAt: p.createdAt, comments: p.comments || 0 });
  const publicComment = (c) => ({ id: c.id, body: c.body, createdAt: c.createdAt });
  const minuteIso = () => `${new Date().toISOString().slice(0, 16)}:00Z`;

  // ---------------- public routes ----------------

  async function submitPoll(body) {
    const voter = requireVoter(body);
    const all = await store.getAll();
    const win = core.pollWindow(all.settings);
    if (!win.accepting) {
      const msg = {
        not_open: 'The exit poll opens when voting starts.',
        closed: 'The exit poll has closed.',
        disabled: 'The exit poll is paused right now.',
      }[win.state];
      throw new HttpError(403, msg);
    }
    const results = core.computeResults(all);
    const answer = core.validatePoll(body, results);
    await verifyHuman(body);
    const expiresAt = Math.floor(Date.parse(all.settings.pollRevealAt) / 1000) + 3 * 86400;
    await store.pollSubmit(voterKey('poll', voter), expiresAt, core.pollCounterKeys(answer));
    return json(201, { ok: true });
  }

  async function createBoardPost(body) {
    const voter = requireVoter(body);
    const settings = await store.getSettings();
    if (!settings.boardOpen) throw new HttpError(403, 'The noticeboard is closed for new posts right now.');
    const v = core.validatePost(body, settings);
    await verifyHuman(body);
    // Expiry is rounded up to a 5-minute boundary so it does not reveal the exact post time.
    const exp = Math.ceil((Date.now() / 1000 + Number(settings.postCooldownSec || 600)) / 300) * 300;
    if (!await store.takeCooldown(voterKey('post', voter), exp)) {
      throw new HttpError(429, `You can post once every ${Math.round((settings.postCooldownSec || 600) / 60)} minutes. Try again a little later.`);
    }
    const item = { id: core.newId(), title: v.title, body: v.body, createdAt: minuteIso(), comments: 0, reports: 0, hidden: false, reviewed: false };
    await store.createPost(item);
    return json(201, { post: publicPost(item) });
  }

  async function createComment(postId, body) {
    const voter = requireVoter(body);
    const settings = await store.getSettings();
    if (!settings.commentsOpen) throw new HttpError(403, 'Comments are closed right now.');
    const v = core.validateComment(body, settings);
    const post = await store.getPost(postId);
    if (!post || post.hidden) throw new HttpError(404, 'That post is no longer on the board.');
    await verifyHuman(body);
    const exp = Math.ceil((Date.now() / 1000 + Number(settings.commentCooldownSec || 60)) / 60) * 60;
    if (!await store.takeCooldown(voterKey('comment', voter), exp)) {
      throw new HttpError(429, 'You are commenting too quickly. Wait a minute and try again.');
    }
    const item = { id: core.newId(), postId, body: v.body, createdAt: minuteIso(), reports: 0, hidden: false, reviewed: false };
    await store.addComment(postId, item);
    return json(201, { comment: publicComment(item) });
  }

  async function report(postId, cid, body) {
    const voter = requireVoter(body);
    const settings = await store.getSettings();
    const target = cid ? `${postId}/${cid}` : postId;
    const exp = Math.floor(Date.now() / 1000) + 3 * 86400;
    if (!await store.takeCooldown(voterKey('report', `${voter}|${target}`), exp)) {
      return json(200, { ok: true, already: true });
    }
    const item = await store.incrementReports(postId, cid);
    if (!item.hidden && !item.reviewed && item.reports >= Number(settings.reportThreshold || 5)) {
      const patch = { hidden: true, hiddenReason: 'reports' };
      if (cid) await store.updateComment(postId, cid, patch); else await store.updatePost(postId, patch);
    }
    return json(200, { ok: true });
  }

  // ---------------- admin routes ----------------

  async function audit(user, action, detail) {
    await store.audit({ at: new Date().toISOString(), user, action, detail: detail || '' });
  }

  function sanitizeSettings(input, current) {
    const s = { ...current };
    const str = (v, max) => core.cleanText(v).replace(/\n/g, ' ').slice(0, max);
    if ('title' in input) s.title = str(input.title, 80) || current.title;
    if ('notice' in input) s.notice = str(input.notice, 240);
    for (const k of ['pollOpensAt', 'pollClosesAt', 'pollRevealAt']) {
      if (k in input) {
        if (Number.isNaN(Date.parse(input[k]))) throw new HttpError(400, `${k} is not a valid date and time.`);
        s[k] = String(input[k]);
      }
    }
    for (const k of ['pollEnabled', 'boardOpen', 'commentsOpen']) if (k in input) s[k] = !!input[k];
    const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
    if ('reportThreshold' in input) s.reportThreshold = clampInt(input.reportThreshold, 1, 100);
    if ('postCooldownSec' in input) s.postCooldownSec = clampInt(input.postCooldownSec, 30, 86400);
    if ('commentCooldownSec' in input) s.commentCooldownSec = clampInt(input.commentCooldownSec, 5, 3600);
    if ('bannedWords' in input) {
      const list = Array.isArray(input.bannedWords) ? input.bannedWords : String(input.bannedWords || '').split('\n');
      s.bannedWords = [...new Set(list.map((w) => core.cleanText(w).toLowerCase()).filter(Boolean))].slice(0, 500);
    }
    if ('idPattern' in input) {
      try { new RegExp(String(input.idPattern)); } catch { throw new HttpError(400, 'The ID pattern is not a valid regular expression.'); }
      s.idPattern = String(input.idPattern).slice(0, 200);
    }
    if (Date.parse(s.pollClosesAt) <= Date.parse(s.pollOpensAt)) throw new HttpError(400, 'The exit poll must close after it opens.');
    return s;
  }

  const findPost = (all, id) => {
    const p = all.posts.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'That post does not exist. Reload the page.');
    return p;
  };

  function votedIds(batches) {
    const s = new Set();
    for (const b of batches) for (const [k, v] of Object.entries(b.votes || {})) if (v) s.add(k);
    return s;
  }

  async function admin(method, parts, body, query, user) {
    const [res, id, sub, subId, action] = parts; // e.g. posts/<id>/batches/<bid>

    if (method === 'GET' && res === 'state') {
      const all = await store.getAll();
      return json(200, { user, all, results: core.computeResults(all), importText: core.serializeConfig(all.posts, all.parties) });
    }

    if (method === 'PUT' && res === 'settings') {
      const all = await store.getAll();
      const next = sanitizeSettings(body.settings || {}, all.settings);
      const saved = await store.putSettings(next, body.version ?? all.settings.version);
      await audit(user, 'settings', Object.keys(body.settings || {}).join(', '));
      await publishAll();
      return json(200, { settings: saved });
    }

    if (method === 'POST' && res === 'import') {
      const all = await store.getAll();
      const { updated, newParties, errors } = core.parseImport(body.text, all.posts, all.parties, votedIds(all.batches));
      if (errors.length) throw new HttpError(400, 'The candidate list has problems. Fix them and save again.', { errors });
      if (newParties.length) await store.putParties([...all.parties, ...newParties]);
      let changed = 0;
      for (const p of updated) {
        const before = all.posts.find((x) => x.id === p.id);
        if (JSON.stringify(before.candidates) === JSON.stringify(p.candidates)) continue;
        await store.putPost(p, before.version);
        changed++;
      }
      await audit(user, 'import', `${changed} posts changed, ${newParties.length} parties added`);
      await publishResults();
      return json(200, { changed, newParties: newParties.length });
    }

    if (method === 'PUT' && res === 'parties') {
      const list = (Array.isArray(body.parties) ? body.parties : []).map((p) => ({
        id: String(p.id || `party-${core.slug(p.name)}`).slice(0, 40),
        name: core.cleanText(p.name).slice(0, 40),
        colour: /^#[0-9a-f]{6}$/i.test(p.colour) ? p.colour : '#777777',
      })).filter((p) => p.name);
      await store.putParties(list);
      await audit(user, 'parties', list.map((p) => p.name).join(', '));
      await publishResults();
      return json(200, { parties: list });
    }

    if (res === 'posts') {
      const all = await store.getAll();

      if (method === 'POST' && !id) {
        const name = core.cleanText(body.name).slice(0, 80);
        if (!name) throw new HttpError(400, 'Give the post a name.');
        const group = ['main', 'ug', 'pg'].includes(body.group) ? body.group : 'main';
        const seats = Math.max(1, Math.min(10, Number(body.seats) || 1));
        const dept = body.dept ? core.cleanText(body.dept).slice(0, 80) : null;
        const post = {
          id: `${core.slug(dept || name)}-${crypto.randomBytes(2).toString('hex')}`, name, dept, group, seats,
          years: group === 'main' ? null : Math.max(1, Math.min(5, Number(body.years) || (group === 'pg' ? 2 : 4))),
          order: Math.max(0, ...all.posts.map((p) => p.order)) + 1, candidates: [], final: false, winners: [],
        };
        const saved = await store.putPost(post, null);
        await audit(user, 'post.create', core.postLabel(saved));
        await publishResults();
        return json(201, { post: saved });
      }

      const post = findPost(all, id);
      const postBatches = all.batches.filter((b) => b.postId === post.id);
      const label = core.postLabel(post);

      if (method === 'PUT' && !sub) {
        const next = { ...post };
        if ('name' in body) next.name = core.cleanText(body.name).slice(0, 80) || post.name;
        if ('dept' in body) next.dept = body.dept ? core.cleanText(body.dept).slice(0, 80) : null;
        if ('seats' in body) next.seats = Math.max(1, Math.min(10, Number(body.seats) || 1));
        if ('candidates' in body) {
          const voted = votedIds(postBatches);
          const old = Object.fromEntries(post.candidates.map((c) => [c.id, c]));
          next.candidates = (body.candidates || []).map((c) => ({
            id: old[c.id] ? c.id : `${core.slug(c.name)}-${crypto.randomBytes(2).toString('hex')}`,
            name: core.cleanText(c.name).slice(0, 60),
            party: c.party || null,
          })).filter((c) => c.name);
          const kept = new Set(next.candidates.map((c) => c.id));
          const lost = post.candidates.find((c) => !kept.has(c.id) && voted.has(c.id));
          if (lost) throw new HttpError(400, `${lost.name} already has votes entered, so they can't be removed. Delete their batches first.`);
        }
        const saved = await store.putPost(next, body.version ?? post.version);
        await audit(user, 'post.edit', label);
        await publishResults();
        return json(200, { post: saved });
      }

      if (method === 'DELETE' && !sub) {
        if (postBatches.length) throw new HttpError(400, 'This post has counts entered. Delete its batches first.');
        await store.deletePost(post.id);
        await audit(user, 'post.delete', label);
        await publishResults();
        return json(200, { ok: true });
      }

      if (sub === 'batches') {
        if (post.final) throw new HttpError(400, 'This result has been declared. Reopen it before changing the count.');
        if (method === 'POST' && !subId) {
          const v = core.validateBatch(body, post);
          core.checkTotalsNonNegative(post, [...postBatches, v]);
          const batch = { id: core.newId('b'), postId: post.id, ...v, at: new Date().toISOString(), by: user };
          const saved = await store.putBatch(batch, null);
          await audit(user, 'count.add', `${label}: ${v.label}`);
          await publishAfterCountChange();
          return json(201, { batch: saved });
        }
        const existing = postBatches.find((b) => b.id === subId);
        if (!existing) throw new HttpError(404, 'That batch was deleted by someone else. Reload the page.');
        if (method === 'PUT') {
          const v = core.validateBatch(body, post);
          core.checkTotalsNonNegative(post, [...postBatches.filter((b) => b.id !== subId), v]);
          const saved = await store.putBatch({ ...existing, ...v, editedBy: user, editedAt: new Date().toISOString() }, body.version ?? existing.version);
          await audit(user, 'count.edit', `${label}: ${v.label}`);
          await publishAfterCountChange();
          return json(200, { batch: saved });
        }
        if (method === 'DELETE') {
          core.checkTotalsNonNegative(post, postBatches.filter((b) => b.id !== subId));
          await store.deleteBatch(post.id, subId);
          await audit(user, 'count.delete', `${label}: ${existing.label}`);
          await publishAfterCountChange();
          return json(200, { ok: true });
        }
      }

      if (method === 'POST' && sub === 'finalize') {
        const r = core.computeResults(all).posts.find((p) => p.id === post.id);
        if (r.status !== 'counting') throw new HttpError(400, r.status === 'declared' ? 'This result is already declared.' : 'Enter at least one count before declaring a result.');
        let winners;
        if (Array.isArray(body.winners) && body.winners.length) {
          winners = [...new Set(body.winners.map(String))];
          const ids = new Set(post.candidates.map((c) => c.id));
          if (winners.length !== post.seats || winners.some((w) => !ids.has(w))) throw new HttpError(400, `Choose exactly ${post.seats} winner${post.seats > 1 ? 's' : ''}.`);
        } else {
          if (r.tie) throw new HttpError(409, 'There is a tie for the last seat. Choose the winner(s) explicitly.', { tie: true });
          winners = r.candidates.slice(0, post.seats).map((c) => c.id);
        }
        const saved = await store.putPost({ ...post, final: true, winners }, body.version ?? post.version);
        const names = winners.map((w) => post.candidates.find((c) => c.id === w).name).join(', ');
        await audit(user, 'declare', `${label}: ${names}`);
        await publishAfterCountChange();
        return json(200, { post: saved });
      }

      if (method === 'POST' && sub === 'reopen') {
        const saved = await store.putPost({ ...post, final: false, winners: [] }, body.version ?? post.version);
        await audit(user, 'reopen', label);
        await publishAfterCountChange();
        return json(200, { post: saved });
      }
    }

    if (res === 'board') {
      if (method === 'GET' && !id) {
        const r = await store.listPosts({ limit: 50, before: query.before, includeHidden: true });
        return json(200, r);
      }
      if (method === 'GET' && sub === 'comments') {
        return json(200, { comments: await store.listComments(id, true) });
      }
      if (method === 'POST') {
        const cid = sub === 'comments' ? subId : null;
        const act = cid ? action : sub;
        const what = cid ? 'comment' : 'post';
        if (act === 'delete') {
          if (cid) await store.deleteComment(id, cid); else await store.boardDeletePost(id);
        } else if (act === 'hide' || act === 'restore') {
          const patch = act === 'hide' ? { hidden: true, hiddenReason: 'admin', reviewed: true } : { hidden: false, hiddenReason: null, reviewed: true };
          if (cid) await store.updateComment(id, cid, patch); else await store.updatePost(id, patch);
        } else {
          throw new HttpError(404, 'Unknown moderation action.');
        }
        await audit(user, `moderate.${what}.${act}`, cid ? `${id}/${cid}` : id);
        return json(200, { ok: true });
      }
    }

    if (method === 'GET' && res === 'audit') return json(200, { audit: await store.listAudit(300) });

    if (method === 'GET' && res === 'poll') {
      const all = await store.getAll();
      const counters = await store.pollCounters();
      return json(200, core.computePoll(counters, core.computeResults(all), all.settings, Date.now(), { admin: true }));
    }

    if (method === 'POST' && res === 'reset') {
      if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
      if (!['poll', 'board', 'counts', 'cooldowns'].includes(body.what)) throw new HttpError(400, 'Unknown reset.');
      await store.reset(body.what);
      await audit(user, 'reset', body.what);
      await publishAll();
      return json(200, { ok: true });
    }

    if (method === 'POST' && res === 'publish') {
      await publishAll();
      return json(200, { ok: true });
    }

    throw new HttpError(404, 'Not found.');
  }

  // ---------------- entry point ----------------

  async function handle(event) {
    if (event && (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event' || event.task === 'publish')) {
      await publishAll();
      return { ok: true };
    }
    const http = (event.requestContext && event.requestContext.http) || {};
    const method = http.method || 'GET';
    const path = event.rawPath || '/';
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (originSecret && headers['x-origin-verify'] !== originSecret) return json(403, { error: 'Forbidden' });

    let body = {};
    if (event.body) {
      if (event.body.length > 20000) return json(413, { error: 'That request is too large.' });
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        return json(400, { error: 'Send the request as JSON.' });
      }
    }
    const query = event.queryStringParameters || {};

    try {
      if (path.startsWith('/api/admin/')) {
        const claims = event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt && event.requestContext.authorizer.jwt.claims;
        if (!claims) return json(401, { error: 'Sign in again.' });
        const user = claims.email || claims['cognito:username'] || claims.sub || 'admin';
        const parts = path.slice('/api/admin/'.length).split('/').filter(Boolean).map(decodeURIComponent);
        return await admin(method, parts, body, query, user);
      }

      const parts = path.split('/').filter(Boolean).slice(1); // drop "api"
      const [res, id, sub, cid, action] = parts;
      if (method === 'GET' && res === 'health') return json(200, { ok: true });
      if (method === 'POST' && res === 'poll' && !id) return await submitPoll(body);
      if (res === 'board') {
        if (method === 'GET' && !id) {
          const r = await store.listPosts({ limit: 30, before: query.before });
          return json(200, { posts: r.posts.map(publicPost), next: r.next }, 'public, max-age=5');
        }
        if (method === 'GET' && sub === 'comments' && !cid) {
          const list = await store.listComments(id);
          return json(200, { comments: list.map(publicComment) }, 'public, max-age=5');
        }
        if (method === 'POST' && !id) return await createBoardPost(body);
        if (method === 'POST' && sub === 'comments' && !cid) return await createComment(id, body);
        if (method === 'POST' && sub === 'report') return await report(id, null, body);
        if (method === 'POST' && sub === 'comments' && cid && action === 'report') return await report(id, cid, body);
      }
      return json(404, { error: 'Not found.' });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, ...(e.extra || {}) });
      log.error('request failed', method, path, e && e.name, e && e.message);
      return json(500, { error: 'Something went wrong on the server. Try again in a moment.' });
    }
  }

  return { handle, publishAll };
}

module.exports = { createApp };
