'use strict';
// Pure logic: no AWS calls here, so it runs the same in Lambda, the local dev server and tests.
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  title: 'CET College Union Election 2026',
  notice: '',
  pollOpensAt: '2026-10-16T10:00:00+05:30',
  pollClosesAt: '2026-10-16T12:30:00+05:30',
  pollRevealAt: '2026-10-16T12:30:00+05:30',
  pollEnabled: true,
  boardOpen: true,
  commentsOpen: true,
  reportThreshold: 5,
  postCooldownSec: 600,
  commentCooldownSec: 60,
  bannedWords: [],
  idPattern: '^L?TVE\\d{2}[A-Z]{1,6}\\d{1,4}$',
  version: 1,
};

const PUBLIC_SETTING_KEYS = ['title', 'notice', 'pollOpensAt', 'pollClosesAt', 'pollRevealAt', 'pollEnabled',
  'boardOpen', 'commentsOpen', 'postCooldownSec', 'commentCooldownSec', 'idPattern'];

const PARTY_PALETTE = ['#c62828', '#1565c0', '#ef6c00', '#2e7d32', '#6a1b9a', '#00838f', '#ad1457', '#5d4037', '#455a64', '#9e9d24'];

// Smallest group whose exit-poll breakdown we are willing to show.
const MIN_GROUP = 5;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function newId(prefix = '') {
  // Time-sortable: 8 base-36 chars of ms timestamp + random hex.
  return prefix + Date.now().toString(36).padStart(9, '0') + crypto.randomBytes(3).toString('hex');
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x'; }

function postLabel(p) { return p.dept ? `${p.name} (${p.dept})` : p.name; }

function cleanText(s) {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function wordCount(s) { const t = s.trim(); return t ? t.split(/\s+/).length : 0; }

// ---------- results ----------

function computeResults({ settings, parties, posts, batches }) {
  const byPost = {};
  for (const b of batches) (byPost[b.postId] = byPost[b.postId] || []).push(b);
  for (const k of Object.keys(byPost)) byPost[k].sort((a, b) => a.at.localeCompare(b.at));

  const tally = {};
  const bump = (party, field, n = 1) => {
    const k = party || '';
    tally[k] = tally[k] || { party: k || null, won: 0, leading: 0 };
    tally[k][field] += n;
  };
  const log = [];
  let seatsTotal = 0;

  const out = [...posts].sort((a, b) => a.order - b.order).map((p) => {
    seatsTotal += p.seats;
    const bs = byPost[p.id] || [];
    const totals = {};
    for (const c of p.candidates) totals[c.id] = 0;
    let invalid = 0;
    for (const b of bs) {
      for (const [cid, v] of Object.entries(b.votes || {})) if (cid in totals) totals[cid] += v;
      invalid += b.invalid || 0;
      log.push({ post: postLabel(p), postId: p.id, label: b.label, at: b.at });
    }
    const cands = p.candidates.map((c) => ({ id: c.id, name: c.name, party: c.party || null, votes: totals[c.id] }));
    const ranked = [...cands].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const counted = cands.reduce((s, c) => s + c.votes, 0);

    let status;
    if (!cands.length) status = 'nocandidates';
    else if (cands.length <= p.seats) status = 'unopposed';
    else if (p.final) status = 'declared';
    else if (bs.length) status = 'counting';
    else status = 'awaiting';

    let winners = [];
    let leaders = [];
    let tie = false;
    let margin = null;
    if (status === 'unopposed') winners = cands.map((c) => c.id);
    if (status === 'declared') winners = (p.winners || []).filter((id) => id in totals);
    if ((status === 'counting' || status === 'declared') && ranked.length > p.seats) {
      margin = ranked[p.seats - 1].votes - ranked[p.seats].votes;
      tie = margin === 0 && counted > 0;
    }
    if (status === 'counting' && counted > 0) {
      leaders = ranked.slice(0, p.seats).filter((c) => c.votes > 0).map((c) => c.id);
    }
    const byId = Object.fromEntries(cands.map((c) => [c.id, c]));
    for (const id of winners) bump(byId[id].party, 'won');
    for (const id of leaders) bump(byId[id].party, 'leading');

    return {
      id: p.id, name: p.name, dept: p.dept, group: p.group, seats: p.seats, years: p.years,
      status, candidates: ranked, invalid, counted, winners, leaders, tie, margin,
      batches: bs.map((b) => ({ label: b.label, at: b.at, votes: b.votes, invalid: b.invalid || 0 })),
      lastUpdate: bs.length ? bs[bs.length - 1].at : null,
    };
  });

  log.sort((a, b) => b.at.localeCompare(a.at));
  const publicSettings = {};
  for (const k of PUBLIC_SETTING_KEYS) publicSettings[k] = settings[k];
  return {
    generatedAt: new Date().toISOString(),
    settings: publicSettings,
    parties: parties.map((x) => ({ id: x.id, name: x.name, colour: x.colour })),
    seatsTotal,
    tally: Object.values(tally),
    log: log.slice(0, 40),
    posts: out,
  };
}

// ---------- exit poll ----------

function pollWindow(settings, nowMs = Date.now()) {
  const opens = Date.parse(settings.pollOpensAt);
  const closes = Date.parse(settings.pollClosesAt);
  const reveal = Date.parse(settings.pollRevealAt);
  let state;
  if (!settings.pollEnabled) state = 'disabled';
  else if (nowMs < opens) state = 'not_open';
  else if (nowMs < closes) state = 'open';
  else state = 'closed';
  return { state, accepting: state === 'open', revealed: nowMs >= reveal };
}

// Posts a respondent from `dept` may answer about: contested main-panel posts plus their own rep.
function pollablePosts(results, dept) {
  return results.posts.filter((p) =>
    (p.group === 'main' || p.id === dept) && p.candidates.length > p.seats);
}

function validatePoll(body, results) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Send the form as JSON.');
  const dept = String(body.dept || '');
  const deptPost = results.posts.find((p) => p.id === dept && (p.group === 'ug' || p.group === 'pg'));
  if (!deptPost) throw new HttpError(400, 'Choose your programme.');
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 1 || year > (deptPost.years || 5)) throw new HttpError(400, 'Choose your year of study.');
  const choices = body.choices && typeof body.choices === 'object' ? body.choices : {};
  const allowed = Object.fromEntries(pollablePosts(results, dept).map((p) => [p.id, p]));
  const picks = {};
  let any = false;
  for (const [postId, val] of Object.entries(choices)) {
    const p = allowed[postId];
    if (!p) throw new HttpError(400, 'One of the answers is for a post that is not in this poll.');
    const arr = Array.isArray(val) ? [...new Set(val.map(String))] : [];
    if (arr.length > p.seats) throw new HttpError(400, `Pick at most ${p.seats} for ${p.name}.`);
    const ids = new Set(p.candidates.map((c) => c.id));
    for (const id of arr) if (!ids.has(id)) throw new HttpError(400, `Unknown candidate for ${p.name}.`);
    if (arr.length) { picks[postId] = arr; any = true; }
  }
  if (!any) throw new HttpError(400, 'Answer at least one question.');
  return { dept, year, picks };
}

function pollCounterKeys({ dept, year, picks }, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const minute = d.toISOString().slice(0, 16); // UTC minute bucket, aggregate only
  const keys = ['TOTAL', `D|${dept}`, `Y|${year}`, `M|${minute}`];
  for (const [postId, ids] of Object.entries(picks)) {
    keys.push(`N|${postId}`, `N|${postId}|D|${dept}`, `N|${postId}|Y|${year}`);
    for (const id of ids) keys.push(`V|${postId}|${id}`, `V|${postId}|${id}|D|${dept}`, `V|${postId}|${id}|Y|${year}`);
  }
  return keys;
}

function computePoll(counters, results, settings, nowMs = Date.now(), { admin = false } = {}) {
  const win = pollWindow(settings, nowMs);
  const total = counters.TOTAL || 0;
  const base = {
    generatedAt: new Date(nowMs).toISOString(),
    state: win.state,
    revealed: win.revealed,
    opensAt: settings.pollOpensAt,
    closesAt: settings.pollClosesAt,
    revealAt: settings.pollRevealAt,
    responses: total,
  };
  if (!win.revealed && !admin) return base;

  const share = (v, n) => (n ? v / n : 0);
  const posts = [];
  for (const p of results.posts) {
    if (!(p.candidates.length > p.seats)) continue;
    const n = counters[`N|${p.id}`] || 0;
    const entry = { postId: p.id, seats: p.seats, n, suppressed: n < MIN_GROUP && !admin, candidates: [], byDept: {}, byYear: {} };
    if (!entry.suppressed) {
      entry.candidates = p.candidates.map((c) => {
        const v = counters[`V|${p.id}|${c.id}`] || 0;
        return { id: c.id, count: v, share: share(v, n) };
      }).sort((a, b) => b.count - a.count);
      for (const [kind, dim] of [['D', 'byDept'], ['Y', 'byYear']]) {
        const prefix = `N|${p.id}|${kind}|`;
        for (const [k, gn] of Object.entries(counters)) {
          if (!k.startsWith(prefix)) continue;
          const g = k.slice(prefix.length);
          if (gn < MIN_GROUP && !admin) continue;
          entry[dim][g] = {
            n: gn,
            shares: Object.fromEntries(p.candidates.map((c) => [c.id, share(counters[`V|${p.id}|${c.id}|${kind}|${g}`] || 0, gn)])),
          };
        }
      }
    }
    posts.push(entry);
  }
  const groups = (kind) => Object.fromEntries(Object.entries(counters)
    .filter(([k, v]) => k.startsWith(`${kind}|`) && (admin || v >= MIN_GROUP))
    .map(([k, v]) => [k.slice(2), v]));
  const out = { ...base, posts, depts: groups('D'), years: groups('Y'), minGroup: MIN_GROUP };
  if (admin) out.perMinute = groups('M');
  return out;
}

// ---------- text rules for the noticeboard ----------

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|me|ly|xyz|co|app|link|site|info|gg)\b)/i;
const ROLL_RE = /\bl?\s*tve\s*\d{2}\s*[a-z]{1,6}\s*\d{1,4}\b/i;

function hasPhone(s) {
  const runs = s.match(/\+?\d[\d\s().-]{7,}\d/g) || [];
  return runs.some((r) => r.replace(/\D/g, '').length >= 10);
}

function checkText(text, settings) {
  if (URL_RE.test(text)) return 'Links are not allowed. Remove the web address and try again.';
  if (hasPhone(text)) return 'Phone numbers are not allowed.';
  if (ROLL_RE.test(text)) return 'University ID numbers are not allowed.';
  const lower = text.toLowerCase();
  for (const w of settings.bannedWords || []) {
    const t = String(w).trim().toLowerCase();
    if (t && lower.includes(t)) return 'Your text contains a word that is not allowed on this board.';
  }
  return null;
}

function validatePost(body, settings) {
  const title = cleanText(body && body.title).replace(/\n/g, ' ');
  const text = cleanText(body && body.body);
  if (title.length > 80) throw new HttpError(400, 'Keep the headline under 80 characters.');
  const wc = wordCount(text);
  if (wc < 5) throw new HttpError(400, 'Write at least 5 words.');
  if (wc > 250) throw new HttpError(400, `Keep it to 250 words (you have ${wc}).`);
  if (text.length > 2000) throw new HttpError(400, 'That is too long. Keep it under 2,000 characters.');
  const problem = checkText(`${title}\n${text}`, settings);
  if (problem) throw new HttpError(400, problem);
  return { title, body: text };
}

function validateComment(body, settings) {
  const text = cleanText(body && body.body).replace(/\n+/g, ' ');
  const wc = wordCount(text);
  if (wc < 1) throw new HttpError(400, 'Write a comment first.');
  if (wc > 50 || text.length > 300) throw new HttpError(400, 'Comments are limited to 50 words.');
  const problem = checkText(text, settings);
  if (problem) throw new HttpError(400, problem);
  return { body: text };
}

// ---------- candidate import ----------

// Format: lines starting with '#' name a post; following lines are "Candidate name | Party".
function serializeConfig(posts, parties) {
  const pname = Object.fromEntries(parties.map((p) => [p.id, p.name]));
  return [...posts].sort((a, b) => a.order - b.order).map((p) => {
    const lines = [`# ${postLabel(p)}`];
    for (const c of p.candidates) lines.push(c.party ? `${c.name} | ${pname[c.party] || ''}` : c.name);
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

function parseImport(text, posts, parties, votedCandidateIds = new Set()) {
  const errors = [];
  const lookup = {};
  for (const p of posts) {
    lookup[norm(postLabel(p))] = p;
    lookup[norm(p.id)] = p;
    if (p.dept) lookup[norm(p.dept)] = p;
    else lookup[norm(p.name)] = p;
  }
  const partyByName = Object.fromEntries(parties.map((p) => [norm(p.name), p]));
  const newParties = [];
  const assigned = {}; // postId -> [{name, partyName}]
  let current = null;
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      const key = norm(line.replace(/^#+/, ''));
      current = lookup[key] || null;
      if (!current) errors.push(`Line ${i + 1}: no post called "${line.replace(/^#+/, '').trim()}".`);
      else if (assigned[current.id]) errors.push(`Line ${i + 1}: "${postLabel(current)}" appears twice.`);
      else assigned[current.id] = [];
      return;
    }
    if (!current) { if (!errors.length || !errors[errors.length - 1].includes('before the first')) errors.push(`Line ${i + 1}: candidate listed before the first "# Post name" line.`); return; }
    const [name, party] = line.split('|').map((s) => cleanText(s));
    if (!name) return;
    if (name.length > 60) { errors.push(`Line ${i + 1}: name is too long.`); return; }
    assigned[current.id].push({ name, partyName: party || '' });
  });

  const updated = [];
  for (const p of posts) {
    if (!assigned[p.id]) continue;
    const old = Object.fromEntries(p.candidates.map((c) => [norm(c.name), c]));
    const seen = new Set();
    const cands = [];
    for (const { name, partyName } of assigned[p.id]) {
      const k = norm(name);
      if (seen.has(k)) { errors.push(`${postLabel(p)}: ${name} is listed twice.`); continue; }
      seen.add(k);
      let partyId = null;
      if (partyName) {
        let party = partyByName[norm(partyName)];
        if (!party) {
          party = { id: `party-${slug(partyName)}`, name: partyName, colour: PARTY_PALETTE[(parties.length + newParties.length) % PARTY_PALETTE.length] };
          partyByName[norm(partyName)] = party;
          newParties.push(party);
        }
        partyId = party.id;
      }
      const prev = old[k];
      cands.push({ id: prev ? prev.id : `${slug(name)}-${crypto.randomBytes(2).toString('hex')}`, name, party: partyId });
    }
    const keptIds = new Set(cands.map((c) => c.id));
    for (const c of p.candidates) {
      if (!keptIds.has(c.id) && votedCandidateIds.has(c.id)) errors.push(`${postLabel(p)}: ${c.name} already has votes entered, so they can't be removed. Delete their batches first.`);
    }
    updated.push({ ...p, candidates: cands });
  }
  return { updated, newParties, errors };
}

// ---------- batches ----------

function validateBatch(body, post) {
  const label = cleanText(body && body.label).replace(/\n/g, ' ').slice(0, 40) || 'Update';
  const ids = new Set(post.candidates.map((c) => c.id));
  const votes = {};
  const src = (body && body.votes) || {};
  for (const [k, v] of Object.entries(src)) {
    if (!ids.has(k)) throw new HttpError(400, 'A vote count was entered for someone who is not a candidate for this post.');
    const n = Number(v);
    if (!Number.isInteger(n) || Math.abs(n) > 100000) throw new HttpError(400, 'Vote counts must be whole numbers.');
    if (n !== 0) votes[k] = n;
  }
  const invalid = Number((body && body.invalid) || 0);
  if (!Number.isInteger(invalid) || Math.abs(invalid) > 100000) throw new HttpError(400, 'Invalid votes must be a whole number.');
  return { label, votes, invalid };
}

function checkTotalsNonNegative(post, batches) {
  const totals = {};
  let inv = 0;
  for (const b of batches) {
    for (const [k, v] of Object.entries(b.votes || {})) totals[k] = (totals[k] || 0) + v;
    inv += b.invalid || 0;
  }
  const neg = post.candidates.find((c) => (totals[c.id] || 0) < 0);
  if (neg) throw new HttpError(400, `That would make ${neg.name}'s total negative.`);
  if (inv < 0) throw new HttpError(400, 'That would make the invalid-vote total negative.');
}

module.exports = {
  DEFAULT_SETTINGS, PARTY_PALETTE, MIN_GROUP, HttpError, newId, norm, slug, postLabel, cleanText, wordCount,
  computeResults, pollWindow, pollablePosts, validatePoll, pollCounterKeys, computePoll,
  checkText, validatePost, validateComment, serializeConfig, parseImport, validateBatch, checkTotalsNonNegative,
};
