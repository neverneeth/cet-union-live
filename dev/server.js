'use strict';
// Local practice server: the real site and API code, with an in-memory database.
// Run: npm run dev   then open http://localhost:8080 (admin: http://localhost:8080/admin)
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../lambda/app');
const { createMemoryStore } = require('../lambda/store-memory');
const { CSP } = require('../lib/csp');

const PORT = Number(process.env.PORT || 8080);
const SITE = path.join(__dirname, '..', 'site');
const store = createMemoryStore();
const app = createApp(store, { hmacSecret: 'local-dev', secondPassMs: 50 });
// The same clean-URL / redirect function CloudFront runs in production.
const cleanUrls = vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', 'lib', 'clean-urls.js'), 'utf8')}; handler`);
function viewerRequest(url) {
  const querystring = {};
  for (const [k, v] of url.searchParams) {
    const raw = encodeURIComponent(v);
    if (querystring[k]) (querystring[k].multiValue = querystring[k].multiValue || [{ value: querystring[k].value }]).push({ value: raw });
    else querystring[k] = { value: raw };
  }
  return cleanUrls({ request: { uri: url.pathname, querystring } });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain' };

function headers(type) {
  return {
    'content-type': type,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/config.json') {
      res.writeHead(200, headers('application/json'));
      res.end(JSON.stringify({ mode: 'dev', turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '' }));
      return;
    }
    if (url.pathname.startsWith('/data/')) {
      const name = url.pathname.slice('/data/'.length);
      if (!store.published[name]) await app.publishAll();
      res.writeHead(200, headers('application/json'));
      res.end(JSON.stringify(store.published[name] || {}));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const event = {
        rawPath: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        requestContext: { http: { method: req.method } },
        headers: req.headers,
        body: body || undefined,
      };
      const auth = req.headers.authorization || '';
      if (url.pathname.startsWith('/api/admin/') && auth.startsWith('Bearer dev:')) {
        event.requestContext.authorizer = { jwt: { claims: { email: `${auth.slice('Bearer dev:'.length)}@local` } } };
      }
      const r = await app.handle(event);
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body);
      return;
    }
    const r = viewerRequest(url);
    if (r.statusCode) {
      res.writeHead(r.statusCode, { location: r.headers.location.value, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let file = path.normalize(path.join(SITE, r.uri));
    if (!file.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, headers('text/plain')); res.end('Not found'); return; }
    res.writeHead(200, headers(TYPES[path.extname(file)] || 'application/octet-stream'));
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end('error');
  }
});

// Republish once a minute like the cloud scheduler does (exit-poll reveal etc.).
setInterval(() => app.publishAll().catch(() => {}), 60000);

app.publishAll().then(() => server.listen(PORT, () => {
  console.log(`Practice site:  http://localhost:${PORT}`);
  console.log(`Admin (no password in practice mode): http://localhost:${PORT}/admin`);
}));
