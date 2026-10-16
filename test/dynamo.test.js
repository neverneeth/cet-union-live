'use strict';
// Runs the backend tests against store-dynamo.js using the dynalite emulator.
// Usage: DYNALITE=/path/to/node_modules/dynalite node --test test/dynamo.test.js
const { DynamoDBClient, CreateTableCommand, UpdateTimeToLiveCommand } = require('../lambda/node_modules/@aws-sdk/client-dynamodb');
const dynalite = require(process.env.DYNALITE || 'dynalite');

const PORT = 4569;
Object.assign(process.env, {
  AWS_ENDPOINT_URL_DYNAMODB: `http://127.0.0.1:${PORT}`, AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x',
});
const server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
const ready = new Promise((r) => server.listen(PORT, r));
const raw = new DynamoDBClient({});
let n = 0;

global.__makeStore = async () => {
  await ready;
  const { createDynamoStore } = require('../lambda/store-dynamo');
  const p = `t${n++}_`;
  const mk = async (name, sort) => {
    await raw.send(new CreateTableCommand({
      TableName: p + name, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, ...(sort ? [{ AttributeName: 'sk', AttributeType: 'S' }] : [])],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, ...(sort ? [{ AttributeName: 'sk', KeyType: 'RANGE' }] : [])],
    }));
    return p + name;
  };
  const env = {
    ELECTION_TABLE: await mk('election', true), AUDIT_TABLE: await mk('audit', true), POLL_TABLE: await mk('poll', false),
    COOLDOWN_TABLE: await mk('cooldown', false), BOARD_TABLE: await mk('board', true), DATA_BUCKET: 'x',
  };
  // dynalite has no TransactWriteItems: emulate it item by item (not atomic, fine for tests).
  const lib = require('../lambda/node_modules/@aws-sdk/lib-dynamodb');
  const wrap = (doc) => ({
    async send(cmd) {
      if (!(cmd instanceof lib.TransactWriteCommand)) return doc.send(cmd);
      const items = cmd.input.TransactItems;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          if (it.Put) await doc.send(new lib.PutCommand(it.Put));
          else if (it.Update) await doc.send(new lib.UpdateCommand(it.Update));
        } catch (e) {
          if (e.name !== 'ConditionalCheckFailedException') throw e;
          const err = new Error('Transaction cancelled');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = items.map((_, j) => ({ Code: j === i ? 'ConditionalCheckFailed' : 'None' }));
          throw err;
        }
      }
      return {};
    },
  });
  const store = createDynamoStore(env, { wrap });
  store.published = {};
  store.publish = async (name, obj) => { store.published[name] = JSON.parse(JSON.stringify(obj)); };
  return store;
};

require('./backend.test.js');
require('node:test').after(() => server.close());
