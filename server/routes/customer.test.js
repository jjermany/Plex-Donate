process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'customer-router-test-session';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const testDbDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plex-donate-customer-db-')
  );
  process.env.DATABASE_FILE = path.join(testDbDir, 'database.sqlite');
}

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const { test } = require('node:test');
const nodemailer = require('nodemailer');

const config = require('../config');
const customerRouter = require('./customer');
const {
  db,
  createDonor,
  updateDonorPassword,
  getDonorById,
  markDonorEmailVerified,
  createDonorEmailVerificationToken,
} = require('../db');
const { hashPasswordSync } = require('../utils/passwords');
const paypalService = require('../services/paypal');
const { ensureSessionToken } = require('../utils/session-tokens');
const settingsStore = require('../state/settings');

const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'plex-donate-customer-router-')
);
config.dataDir = testDataDir;

const SESSION_COOKIE_NAME = 'plex-donate.sid';

function resetDatabase() {
  db.exec(`
    DELETE FROM donors;
    DELETE FROM invites;
    DELETE FROM events;
    DELETE FROM payments;
    DELETE FROM sessions;
    DELETE FROM settings;
    DELETE FROM support_messages;
    DELETE FROM support_requests;
  `);
}

function assertDefaultAnnouncement(announcement) {
  assert.ok(announcement);
  assert.equal(announcement.enabled, false);
  assert.equal(announcement.title, '');
  assert.equal(announcement.body, '');
  assert.equal(announcement.tone, 'info');
  assert.equal(announcement.dismissible, true);
  assert.equal(announcement.cta, null);
}

class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.sessionToken = null;
  }

  getCookieHeader() {
    if (this.cookies.size === 0) {
      return '';
    }
    return Array.from(this.cookies.values()).join('; ');
  }

  storeCookies(setCookieHeaders) {
    setCookieHeaders.forEach((header) => {
      if (!header) {
        return;
      }
      const [cookiePart] = header.split(';');
      if (!cookiePart) {
        return;
      }
      const separatorIndex = cookiePart.indexOf('=');
      if (separatorIndex === -1) {
        return;
      }
      const name = cookiePart.slice(0, separatorIndex);
      const value = cookiePart.slice(separatorIndex + 1);
      if (!value) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, `${name}=${value}`);
      }
    });
  }

  async request(pathname, { method = 'GET', headers = {}, body } = {}) {
    const url = new URL(pathname, this.baseUrl);
    const requestHeaders = { ...headers };

    if (this.sessionToken) {
      url.searchParams.set('session', this.sessionToken);
      requestHeaders['x-session-token'] = this.sessionToken;
    }

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      requestHeaders.cookie = cookieHeader;
    }

    let requestBody = body;
    if (
      requestBody &&
      typeof requestBody === 'object' &&
      !Buffer.isBuffer(requestBody) &&
      !(requestBody instanceof URLSearchParams) &&
      typeof requestBody !== 'string'
    ) {
      requestBody = JSON.stringify(requestBody);
      if (!requestHeaders['content-type']) {
        requestHeaders['content-type'] = 'application/json';
      }
    }

    const response = await fetch(url.toString(), {
      method,
      headers: requestHeaders,
      body: requestBody,
    });

    const rawHeaders =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : response.headers.raw
        ? response.headers.raw()['set-cookie'] || []
        : (() => {
            const single = response.headers.get('set-cookie');
            return single ? [single] : [];
          })();

    if (Array.isArray(rawHeaders)) {
      this.storeCookies(rawHeaders);
    }

    try {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const clone = response.clone();
        const data = await clone.json();
        if (data && Object.prototype.hasOwnProperty.call(data, 'sessionToken')) {
          const token = data.sessionToken;
          this.sessionToken = typeof token === 'string' && token ? token : null;
        }
      }
    } catch (err) {
      // ignore JSON parse errors when updating session token
    }

    return response;
  }

  get(pathname, options = {}) {
    return this.request(pathname, { ...options, method: 'GET' });
  }

  post(pathname, options = {}) {
    return this.request(pathname, { ...options, method: 'POST' });
  }
}

function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    })
  );

  app.post('/test/setup-session', (req, res) => {
    const { customerId = null } = req.body || {};
    if (customerId) {
      req.session.customerId = customerId;
    } else {
      delete req.session.customerId;
    }
    const sessionToken = ensureSessionToken(req);
    res.json({
      customerId: req.session.customerId || null,
      sessionToken,
    });
  });

  app.use('/customer', customerRouter);

  return app;
}

async function withTestServer(callback) {
  const app = createTestServer();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new TestClient(baseUrl);

  try {
    await callback(client);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test(
  'customer login refreshes pending PayPal subscription',
  async (t) => {
    resetDatabase();
    t.after(resetDatabase);

    const password = 'pending-login-password';
    const donor = createDonor({
      email: 'login-refresh@example.com',
      name: 'Login Refresh',
      subscriptionId: 'I-LOGINREFRESH',
      status: 'pending',
    });
    updateDonorPassword(donor.id, hashPasswordSync(password));
    markDonorEmailVerified(donor.id);

    const paypalMock = t.mock.method(
      paypalService,
      'getSubscription',
      async (subscriptionId) => {
        assert.equal(subscriptionId, 'I-LOGINREFRESH');
        return {
          status: 'ACTIVE',
          billing_info: {
            last_payment: { time: '2024-01-15T12:34:56Z' },
          },
        };
      }
    );

    await withTestServer(async (client) => {
      const response = await client.post('/customer/login', {
        body: { email: donor.email, password },
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.authenticated, true);
      assertDefaultAnnouncement(payload.announcement);
      assert.ok(payload.donor);
      assert.equal(payload.donor.status, 'active');
      assert.equal(payload.donor.lastPaymentAt, '2024-01-15T12:34:56Z');
    });

    assert.equal(paypalMock.mock.callCount(), 1);
    const refreshed = getDonorById(donor.id);
    assert.equal(refreshed.status, 'active');
    assert.equal(refreshed.lastPaymentAt, '2024-01-15T12:34:56Z');
  }
);

test('email verification is required before login', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'VerifyMe123!';
  const donor = createDonor({
    email: 'verify-flow@example.com',
    name: 'Verify Flow',
    status: 'pending',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  const tokenRecord = createDonorEmailVerificationToken(donor.id);

  await withTestServer(async (client) => {
    let response = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(response.status, 403);
    let payload = await response.json();
    assert.equal(payload.verificationRequired, true);
    assert.match(payload.error, /verify your email/i);

    response = await client.post('/customer/verify', {
      body: { token: tokenRecord.token },
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.authenticated, true);
    assertDefaultAnnouncement(payload.announcement);
    assert.ok(payload.donor);
    assert.equal(payload.donor.emailVerified, true);

    const logoutResponse = await client.post('/customer/logout');
    assert.equal(logoutResponse.status, 200);
    await logoutResponse.json();

    response = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.authenticated, true);
    assertDefaultAnnouncement(payload.announcement);
    assert.equal(payload.donor.emailVerified, true);
  });

  const verificationState = db
    .prepare('SELECT email_verified_at FROM donors WHERE id = ?')
    .get(donor.id);
  assert.ok(verificationState.email_verified_at);

  const remainingTokens = db
    .prepare('SELECT COUNT(*) AS count FROM email_verification_tokens WHERE donor_id = ?')
    .get(donor.id);
  assert.equal(remainingTokens.count, 0);
});

test(
  'customer session refreshes pending PayPal subscription',
  async (t) => {
    resetDatabase();
    t.after(resetDatabase);

    const donor = createDonor({
      email: 'session-refresh@example.com',
      name: 'Session Refresh',
      subscriptionId: 'I-SESSIONREFRESH',
      status: 'pending',
    });

    const paypalMock = t.mock.method(
      paypalService,
      'getSubscription',
      async (subscriptionId) => {
        assert.equal(subscriptionId, 'I-SESSIONREFRESH');
        return {
          status: 'ACTIVE',
          billing_info: {
            last_payment: { time: '2024-02-20T00:00:00Z' },
          },
        };
      }
    );

    await withTestServer(async (client) => {
      const setupResponse = await client.post('/test/setup-session', {
        body: { customerId: donor.id },
      });
      assert.equal(setupResponse.status, 200);
      await setupResponse.json();

    const response = await client.get('/customer/session');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.authenticated, true);
    assertDefaultAnnouncement(payload.announcement);
    assert.ok(payload.donor);
    assert.equal(payload.donor.status, 'active');
      assert.equal(payload.donor.subscriptionId, 'I-SESSIONREFRESH');
      assert.equal(payload.donor.lastPaymentAt, '2024-02-20T00:00:00Z');
    });

    assert.equal(paypalMock.mock.callCount(), 1);
    const refreshed = getDonorById(donor.id);
    assert.equal(refreshed.status, 'active');
    assert.equal(refreshed.lastPaymentAt, '2024-02-20T00:00:00Z');
  }
);


test('customer support workflow creates thread and notifies admin', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  settingsStore.updateGroup('smtp', {
    host: 'smtp.test',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
  });

  const sentMessages = [];
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      sentMessages.push(payload);
    },
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const donor = createDonor({
    email: 'supporter@example.com',
    name: 'Supportive Donor',
    status: 'active',
  });

  await withTestServer(async (client) => {
    const setupResponse = await client.post('/test/setup-session', {
      body: { customerId: donor.id },
    });
    assert.equal(setupResponse.status, 200);
    await setupResponse.json();

    const createResponse = await client.post('/customer/support', {
      body: {
        subject: 'Library access issue',
        message: 'I cannot see the new movies library.',
        displayName: 'Supportive Donor',
      },
    });
    assert.equal(createResponse.status, 201);
    const createdPayload = await createResponse.json();
    assert.ok(createdPayload.thread);
    assert.equal(createdPayload.thread.request.donorId, donor.id);
    assert.equal(createdPayload.thread.messages.length, 1);
    const threadId = createdPayload.thread.request.id;

    const listResponse = await client.get('/customer/support');
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.ok(Array.isArray(listPayload.threads));
    assert.equal(listPayload.threads.length, 1);

    const replyResponse = await client.post(
      `/customer/support/${threadId}/replies`,
      {
        body: {
          message: 'Thanks for checking into this!',
          displayName: 'Supportive Donor',
        },
      }
    );
    assert.equal(replyResponse.status, 201);
    const replyPayload = await replyResponse.json();
    assert.equal(replyPayload.thread.messages.length, 2);
  });

  assert.equal(sentMessages.length, 2);
  const recipientAddresses = sentMessages.map((mail) => mail.to);
  assert.ok(
    recipientAddresses.every((address) => address === 'Plex Donate <notify@example.com>')
  );
});
