process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'server-route-test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-server-test-'));
process.env.DATABASE_FILE = path.join(tempDataDir, 'database.sqlite');

const config = require('./config');
config.dataDir = tempDataDir;

const app = require('./index');

test('dashboard routes serve the customer dashboard HTML', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const routes = [
    '/dashboard',
    '/dashboard/verify?token=abc',
    '/dashboard/sub/path',
  ];

  for (const route of routes) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, `${route} should respond with 200`);
    const body = await response.text();
    assert.match(body, /<title>Plex Donate Dashboard<\/title>/);
  }
});
