'use strict';
// DynamoDB + S3 implementation of the store interface.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, UpdateCommand, GetCommand,
  ScanCommand, BatchWriteCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { HttpError, DEFAULT_SETTINGS } = require('./core');
const { seedPosts } = require('./seed');

const SHARDS = 10;

function createDynamoStore(env = process.env, opts = {}) {
  const base = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const ddb = opts.wrap ? opts.wrap(base) : base;
  const s3 = new S3Client({});
  const T = {
    election: env.ELECTION_TABLE,
    audit: env.AUDIT_TABLE,
    poll: env.POLL_TABLE,
    cooldown: env.COOLDOWN_TABLE,
    board: env.BOARD_TABLE,
  };

  const strip = (item) => { if (!item) return item; const { pk, sk, ...rest } = item; return rest; };

  async function queryAll(params) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
      items.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async function scanAll(params) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
      items.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async function deleteKeys(table, keys) {
    for (let i = 0; i < keys.length; i += 25) {
      let req = { [table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
      for (let attempt = 0; attempt < 8 && req && Object.keys(req).length; attempt++) {
        const r = await ddb.send(new BatchWriteCommand({ RequestItems: req }));
        req = r.UnprocessedItems;
        if (req && Object.keys(req).length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
      }
    }
  }

  const byPk = (pk) => queryAll({ TableName: T.election, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ConsistentRead: true });

  async function versionedPut(table, item, expectedVersion, notFoundMsg) {
    const next = { ...item, version: (expectedVersion || 0) + 1 };
    const params = { TableName: table, Item: next };
    if (expectedVersion == null) params.ConditionExpression = 'attribute_not_exists(pk)';
    else {
      params.ConditionExpression = 'attribute_exists(pk) AND version = :v';
      params.ExpressionAttributeValues = { ':v': expectedVersion };
    }
    try {
      await ddb.send(new PutCommand(params));
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        if (expectedVersion == null) throw new HttpError(409, 'That already exists.');
        throw new HttpError(409, notFoundMsg || 'Someone else changed this a moment ago. Reload and try again.');
      }
      throw e;
    }
    return strip(next);
  }

  let seeded = false;
  async function ensureSeed(posts, settingsItems) {
    if (seeded) return;
    if (!settingsItems.length) {
      await ddb.send(new PutCommand({ TableName: T.election, Item: { pk: 'SETTINGS', sk: 'MAIN', ...DEFAULT_SETTINGS }, ConditionExpression: 'attribute_not_exists(pk)' })).catch(() => {});
    }
    if (!posts.length) {
      for (const p of seedPosts()) {
        await ddb.send(new PutCommand({ TableName: T.election, Item: { pk: 'POST', sk: p.id, ...p }, ConditionExpression: 'attribute_not_exists(pk)' })).catch(() => {});
      }
    }
    seeded = true;
  }

  return {
    kind: 'dynamo',
    async getAll() {
      let [s, parties, posts, batches] = await Promise.all([byPk('SETTINGS'), byPk('PARTY'), byPk('POST'), byPk('BATCH')]);
      if (!s.length || !posts.length) {
        await ensureSeed(posts, s);
        [s, posts] = await Promise.all([byPk('SETTINGS'), byPk('POST')]);
      }
      return {
        settings: { ...DEFAULT_SETTINGS, ...strip(s[0] || {}) },
        parties: parties.map(strip),
        posts: posts.map(strip),
        batches: batches.map(strip),
      };
    },
    async getSettings() {
      const r = await ddb.send(new GetCommand({ TableName: T.election, Key: { pk: 'SETTINGS', sk: 'MAIN' }, ConsistentRead: true }));
      return { ...DEFAULT_SETTINGS, ...strip(r.Item || {}) };
    },
    async putSettings(s, expectedVersion) {
      return versionedPut(T.election, { ...s, pk: 'SETTINGS', sk: 'MAIN' }, expectedVersion);
    },
    async putParties(list) {
      const existing = await byPk('PARTY');
      const keep = new Set(list.map((p) => p.id));
      await deleteKeys(T.election, existing.filter((p) => !keep.has(p.sk)).map((p) => ({ pk: 'PARTY', sk: p.sk })));
      for (const p of list) await ddb.send(new PutCommand({ TableName: T.election, Item: { pk: 'PARTY', sk: p.id, ...p } }));
    },
    async putPost(post, expectedVersion) {
      return versionedPut(T.election, { ...post, pk: 'POST', sk: post.id }, expectedVersion, 'Someone else changed this post a moment ago. Reload and try again.');
    },
    async deletePost(id) {
      const batches = (await byPk('BATCH')).filter((b) => b.postId === id);
      await deleteKeys(T.election, [{ pk: 'POST', sk: id }, ...batches.map((b) => ({ pk: 'BATCH', sk: b.sk }))]);
    },
    async putBatch(b, expectedVersion) {
      return versionedPut(T.election, { ...b, pk: 'BATCH', sk: `${b.postId}#${b.id}` }, expectedVersion, 'That batch was changed or deleted by someone else. Reload and try again.');
    },
    async deleteBatch(postId, id) {
      await ddb.send(new DeleteCommand({ TableName: T.election, Key: { pk: 'BATCH', sk: `${postId}#${id}` } }));
    },
    async audit(entry) {
      await ddb.send(new PutCommand({ TableName: T.audit, Item: { pk: 'A', sk: `${entry.at}#${Math.random().toString(36).slice(2, 8)}`, ...entry } }));
    },
    async listAudit(limit = 200) {
      const r = await ddb.send(new QueryCommand({ TableName: T.audit, KeyConditionExpression: 'pk = :a', ExpressionAttributeValues: { ':a': 'A' }, ScanIndexForward: false, Limit: limit }));
      return (r.Items || []).map(strip);
    },

    async pollSubmit(cooldownKey, expiresAt, keys) {
      const nowSec = Math.floor(Date.now() / 1000);
      for (let attempt = 0; attempt < 6; attempt++) {
        const shard = Math.floor(Math.random() * SHARDS);
        const TransactItems = [
          {
            Put: {
              TableName: T.cooldown,
              Item: { pk: cooldownKey, expiresAt },
              ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
              ExpressionAttributeValues: { ':now': nowSec },
            },
          },
          ...keys.map((k) => ({
            Update: {
              TableName: T.poll,
              Key: { pk: `${k}#${shard}` },
              UpdateExpression: 'ADD n :one',
              ExpressionAttributeValues: { ':one': 1 },
            },
          })),
        ];
        try {
          await ddb.send(new TransactWriteCommand({ TransactItems }));
          return;
        } catch (e) {
          const reasons = (e.CancellationReasons || []).map((r) => r && r.Code);
          if (reasons[0] === 'ConditionalCheckFailed') {
            throw new HttpError(409, 'An exit-poll response has already been recorded for this university ID.');
          }
          const retryable = e.name === 'TransactionConflictException' || reasons.includes('TransactionConflict') || e.name === 'ThrottlingException' || e.name === 'ProvisionedThroughputExceededException';
          if (!retryable || attempt === 5) throw e;
          await new Promise((res) => setTimeout(res, 40 + Math.random() * 120 * (attempt + 1)));
        }
      }
    },
    async pollCounters() {
      const items = await scanAll({ TableName: T.poll, ConsistentRead: true });
      const out = {};
      for (const it of items) {
        const k = it.pk.slice(0, it.pk.lastIndexOf('#'));
        out[k] = (out[k] || 0) + Number(it.n || 0);
      }
      return out;
    },
    async takeCooldown(key, expiresAt) {
      const nowSec = Math.floor(Date.now() / 1000);
      try {
        await ddb.send(new PutCommand({
          TableName: T.cooldown,
          Item: { pk: key, expiresAt },
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': nowSec },
        }));
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },

    async createPost(item) {
      await ddb.send(new PutCommand({ TableName: T.board, Item: { pk: 'P', sk: item.id, ...item } }));
    },
    async listPosts({ limit = 30, before, includeHidden = false } = {}) {
      const posts = [];
      let ExclusiveStartKey = before ? { pk: 'P', sk: before } : undefined;
      let more = true;
      while (posts.length < limit + 1 && more) {
        const r = await ddb.send(new QueryCommand({
          TableName: T.board, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'P' },
          ScanIndexForward: false, Limit: 100, ExclusiveStartKey,
        }));
        for (const it of r.Items || []) if (includeHidden || !it.hidden) posts.push(strip(it));
        ExclusiveStartKey = r.LastEvaluatedKey;
        more = !!ExclusiveStartKey;
      }
      const page = posts.slice(0, limit);
      return { posts: page, next: posts.length > limit ? page[page.length - 1].id : null };
    },
    async getPost(id) {
      const r = await ddb.send(new GetCommand({ TableName: T.board, Key: { pk: 'P', sk: id }, ConsistentRead: true }));
      return r.Item ? strip(r.Item) : null;
    },
    async updatePost(id, patch) {
      const names = {};
      const values = {};
      const sets = Object.entries(patch).map(([k, v], i) => { names[`#k${i}`] = k; values[`:v${i}`] = v; return `#k${i} = :v${i}`; });
      try {
        const r = await ddb.send(new UpdateCommand({
          TableName: T.board, Key: { pk: 'P', sk: id }, UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW',
        }));
        return strip(r.Attributes);
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') throw new HttpError(404, 'That post no longer exists.');
        throw e;
      }
    },
    async boardDeletePost(id) {
      const comments = await queryAll({ TableName: T.board, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `C#${id}` } });
      await deleteKeys(T.board, [{ pk: 'P', sk: id }, ...comments.map((c) => ({ pk: c.pk, sk: c.sk }))]);
    },
    async addComment(postId, item) {
      try {
        await ddb.send(new TransactWriteCommand({
          TransactItems: [
            { Update: { TableName: T.board, Key: { pk: 'P', sk: postId }, UpdateExpression: 'ADD comments :one', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':one': 1 } } },
            { Put: { TableName: T.board, Item: { pk: `C#${postId}`, sk: item.id, ...item } } },
          ],
        }));
      } catch (e) {
        if ((e.CancellationReasons || [])[0]?.Code === 'ConditionalCheckFailed') throw new HttpError(404, 'That post no longer exists.');
        throw e;
      }
    },
    async listComments(postId, includeHidden = false) {
      const items = await queryAll({ TableName: T.board, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `C#${postId}` } });
      return items.map(strip).filter((c) => includeHidden || !c.hidden);
    },
    async updateComment(postId, cid, patch) {
      const names = {};
      const values = {};
      const sets = Object.entries(patch).map(([k, v], i) => { names[`#k${i}`] = k; values[`:v${i}`] = v; return `#k${i} = :v${i}`; });
      try {
        const r = await ddb.send(new UpdateCommand({
          TableName: T.board, Key: { pk: `C#${postId}`, sk: cid }, UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW',
        }));
        return strip(r.Attributes);
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') throw new HttpError(404, 'That comment no longer exists.');
        throw e;
      }
    },
    async deleteComment(postId, cid) {
      const r = await ddb.send(new DeleteCommand({ TableName: T.board, Key: { pk: `C#${postId}`, sk: cid }, ReturnValues: 'ALL_OLD' }));
      if (r.Attributes) {
        await ddb.send(new UpdateCommand({ TableName: T.board, Key: { pk: 'P', sk: postId }, UpdateExpression: 'ADD comments :m', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':m': -1 } })).catch(() => {});
      }
    },
    async incrementReports(postId, cid) {
      const Key = cid ? { pk: `C#${postId}`, sk: cid } : { pk: 'P', sk: postId };
      try {
        const r = await ddb.send(new UpdateCommand({
          TableName: T.board, Key, UpdateExpression: 'ADD reports :one', ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'ALL_NEW',
        }));
        return strip(r.Attributes);
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') throw new HttpError(404, 'That no longer exists.');
        throw e;
      }
    },

    async reset(what) {
      if (what === 'poll') {
        const items = await scanAll({ TableName: T.poll, ProjectionExpression: 'pk' });
        await deleteKeys(T.poll, items.map((i) => ({ pk: i.pk })));
        const cds = await scanAll({ TableName: T.cooldown, ProjectionExpression: 'pk', FilterExpression: 'begins_with(pk, :p)', ExpressionAttributeValues: { ':p': 'poll:' } });
        await deleteKeys(T.cooldown, cds.map((i) => ({ pk: i.pk })));
      }
      if (what === 'cooldowns') {
        const cds = await scanAll({ TableName: T.cooldown, ProjectionExpression: 'pk' });
        await deleteKeys(T.cooldown, cds.map((i) => ({ pk: i.pk })));
      }
      if (what === 'board') {
        const items = await scanAll({ TableName: T.board, ProjectionExpression: 'pk, sk' });
        await deleteKeys(T.board, items.map((i) => ({ pk: i.pk, sk: i.sk })));
      }
      if (what === 'counts') {
        const batches = await byPk('BATCH');
        await deleteKeys(T.election, batches.map((b) => ({ pk: 'BATCH', sk: b.sk })));
        for (const p of await byPk('POST')) {
          await ddb.send(new UpdateCommand({ TableName: T.election, Key: { pk: 'POST', sk: p.sk }, UpdateExpression: 'SET final = :f, winners = :w ADD version :one', ExpressionAttributeValues: { ':f': false, ':w': [], ':one': 1 } }));
        }
      }
    },

    async publish(name, obj) {
      await s3.send(new PutObjectCommand({
        Bucket: env.DATA_BUCKET,
        Key: `data/${name}`,
        Body: JSON.stringify(obj),
        ContentType: 'application/json',
        CacheControl: 'public, max-age=2, s-maxage=2',
      }));
    },
  };
}

module.exports = { createDynamoStore };
