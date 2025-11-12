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

const { createDonor, getDonorById } = require('./db');
const paypalService = require('./services/paypal');
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

test('scheduled subscription refresh updates donor payment timestamp', async (t) => {
  const isoDate = new Date().toISOString();
  const originalGetSubscription = paypalService.getSubscription;
  let subscriptionCalls = 0;

  paypalService.getSubscription = async (subscriptionId) => {
    subscriptionCalls += 1;
    assert.equal(subscriptionId, 'I-REFRESH123');
    return {
      status: 'ACTIVE',
      billing_info: {
        last_payment: { time: isoDate },
      },
    };
  };

  t.after(() => {
    paypalService.getSubscription = originalGetSubscription;
  });

  const donor = createDonor({
    email: 'refresh-job@example.com',
    name: 'Refresh Job',
    subscriptionId: 'I-REFRESH123',
    status: 'pending',
  });

  assert.equal(donor.lastPaymentAt, null);

  await app.processSubscriptionRefreshes();

  const updatedDonor = getDonorById(donor.id);

  assert.equal(subscriptionCalls, 1);
  assert.equal(updatedDonor.lastPaymentAt, isoDate);
  assert.equal((updatedDonor.status || '').toLowerCase(), 'active');
});
