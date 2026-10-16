#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cdk = require('aws-cdk-lib');
const { ElectionStack } = require('../lib/stack');

const root = path.join(__dirname, '..');

// Secrets are generated once and kept next to the code (git-ignored). Deploy from the same
// folder each time; regenerating them would reset cooldowns and the CloudFront-to-API secret.
const secretsFile = path.join(root, 'secrets.local.json');
if (!fs.existsSync(secretsFile)) {
  fs.writeFileSync(secretsFile, JSON.stringify({
    originSecret: crypto.randomBytes(24).toString('base64url'),
    hmacSecret: crypto.randomBytes(32).toString('base64url'),
  }, null, 2));
}
const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));

const configFile = path.join(root, 'deploy.config.json');
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};

const app = new cdk.App();
new ElectionStack(app, 'UnionElection', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Unofficial live results, exit poll and noticeboard for the college union election',
  config,
  secrets,
});
