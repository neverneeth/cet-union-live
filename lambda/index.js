'use strict';
// Lambda entry point. No request bodies, IDs or IP addresses are logged.
const { createApp } = require('./app');
const { createDynamoStore } = require('./store-dynamo');

const app = createApp(createDynamoStore(process.env), {
  originSecret: process.env.ORIGIN_SECRET,
  hmacSecret: process.env.HMAC_SECRET,
  turnstileSecret: process.env.TURNSTILE_SECRET || '',
});

exports.handler = (event) => app.handle(event);
