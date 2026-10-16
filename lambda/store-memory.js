'use strict';
// In-memory store used by the local dev server and tests. Same interface as store-dynamo.js.
const fs = require('fs');
const path = require('path');
const { HttpError, DEFAULT_SETTINGS } = require('./core');
const { seedPosts } = require('./seed');

const clone = (x) => JSON.parse(JSON.stringify(x));

function createMemoryStore({ publishDir } = {}) {
  const db = {
    settings: { ...DEFAULT_SETTINGS },
    parties: [],
    posts: seedPosts(),
    batches: [],
    audit: [],
    counters: {},
    cooldowns: {},
    board: [],
    comments: {},
  };
  const published = {};

  const checkVersion = (cur, expected) => {
    if (expected != null && cur && cur.version !== expected) {
      throw new HttpError(409, 'Someone else changed this a moment ago. Reload and try again.');
    }
  };

  return {
    kind: 'memory',
    published,
    async getAll() {
      return clone({ settings: db.settings, parties: db.parties, posts: db.posts, batches: db.batches });
    },
    async getSettings() { return clone(db.settings); },
    async putSettings(s, expectedVersion) {
      checkVersion(db.settings, expectedVersion);
      db.settings = { ...clone(s), version: (db.settings.version || 0) + 1 };
      return clone(db.settings);
    },
    async putParties(list) { db.parties = clone(list); },
    async putPost(post, expectedVersion) {
      const i = db.posts.findIndex((p) => p.id === post.id);
      if (i < 0) {
        if (expectedVersion != null) throw new HttpError(404, 'That post no longer exists.');
        const np = { ...clone(post), version: 1 };
        db.posts.push(np);
        return clone(np);
      }
      checkVersion(db.posts[i], expectedVersion);
      db.posts[i] = { ...clone(post), version: db.posts[i].version + 1 };
      return clone(db.posts[i]);
    },
    async deletePost(id) { db.posts = db.posts.filter((p) => p.id !== id); db.batches = db.batches.filter((b) => b.postId !== id); },
    async putBatch(b, expectedVersion) {
      const i = db.batches.findIndex((x) => x.id === b.id && x.postId === b.postId);
      if (i < 0) {
        if (expectedVersion != null) throw new HttpError(404, 'That batch was deleted by someone else.');
        const nb = { ...clone(b), version: 1 };
        db.batches.push(nb);
        return clone(nb);
      }
      checkVersion(db.batches[i], expectedVersion);
      db.batches[i] = { ...clone(b), version: db.batches[i].version + 1 };
      return clone(db.batches[i]);
    },
    async deleteBatch(postId, id) { db.batches = db.batches.filter((b) => !(b.postId === postId && b.id === id)); },
    async audit(entry) { db.audit.unshift(clone(entry)); },
    async listAudit(limit = 200) { return clone(db.audit.slice(0, limit)); },

    async pollSubmit(cooldownKey, expiresAt, keys) {
      const nowSec = Math.floor(Date.now() / 1000);
      const cd = db.cooldowns[cooldownKey];
      if (cd && cd > nowSec) throw new HttpError(409, 'An exit-poll response has already been recorded for this university ID.');
      db.cooldowns[cooldownKey] = expiresAt;
      for (const k of keys) db.counters[k] = (db.counters[k] || 0) + 1;
    },
    async pollCounters() { return { ...db.counters }; },
    async takeCooldown(key, expiresAt) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (db.cooldowns[key] && db.cooldowns[key] > nowSec) return false;
      db.cooldowns[key] = expiresAt;
      return true;
    },

    async createPost(item) { db.board.unshift(clone(item)); },
    async listPosts({ limit = 30, before, includeHidden = false } = {}) {
      let list = db.board.filter((p) => includeHidden || !p.hidden);
      if (before) list = list.filter((p) => p.id < before);
      list.sort((a, b) => b.id.localeCompare(a.id));
      const page = list.slice(0, limit);
      return { posts: clone(page), next: list.length > limit ? page[page.length - 1].id : null };
    },
    async getPost(id) { const p = db.board.find((x) => x.id === id); return p ? clone(p) : null; },
    async updatePost(id, patch) {
      const p = db.board.find((x) => x.id === id);
      if (!p) throw new HttpError(404, 'That post no longer exists.');
      Object.assign(p, clone(patch));
      return clone(p);
    },
    async boardDeletePost(id) { db.board = db.board.filter((x) => x.id !== id); delete db.comments[id]; },
    async addComment(postId, item) {
      const p = db.board.find((x) => x.id === postId);
      if (!p) throw new HttpError(404, 'That post no longer exists.');
      (db.comments[postId] = db.comments[postId] || []).push(clone(item));
      p.comments = (p.comments || 0) + 1;
    },
    async listComments(postId, includeHidden = false) {
      return clone((db.comments[postId] || []).filter((c) => includeHidden || !c.hidden).sort((a, b) => a.id.localeCompare(b.id)));
    },
    async updateComment(postId, cid, patch) {
      const c = (db.comments[postId] || []).find((x) => x.id === cid);
      if (!c) throw new HttpError(404, 'That comment no longer exists.');
      Object.assign(c, clone(patch));
      return clone(c);
    },
    async deleteComment(postId, cid) {
      const list = db.comments[postId] || [];
      const before = list.length;
      db.comments[postId] = list.filter((x) => x.id !== cid);
      const p = db.board.find((x) => x.id === postId);
      if (p && before !== db.comments[postId].length) p.comments = Math.max(0, (p.comments || 1) - 1);
    },
    async incrementReports(postId, cid) {
      const target = cid ? (db.comments[postId] || []).find((x) => x.id === cid) : db.board.find((x) => x.id === postId);
      if (!target) throw new HttpError(404, 'That no longer exists.');
      target.reports = (target.reports || 0) + 1;
      return clone(target);
    },

    async reset(what) {
      if (what === 'poll') { db.counters = {}; for (const k of Object.keys(db.cooldowns)) if (k.startsWith('poll:')) delete db.cooldowns[k]; }
      if (what === 'cooldowns') db.cooldowns = {};
      if (what === 'board') { db.board = []; db.comments = {}; }
      if (what === 'counts') { db.batches = []; for (const p of db.posts) { p.final = false; p.winners = []; p.version++; } }
    },

    async publish(name, obj) {
      published[name] = clone(obj);
      if (publishDir) {
        fs.mkdirSync(publishDir, { recursive: true });
        fs.writeFileSync(path.join(publishDir, name), JSON.stringify(obj));
      }
    },
  };
}

module.exports = { createMemoryStore };
