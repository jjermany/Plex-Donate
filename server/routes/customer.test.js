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
  createDonorPasswordResetToken,
  getRecentEvents,
} = require('../db');
const { hashPasswordSync, verifyPasswordSync } = require('../utils/passwords');
const paypalService = require('../services/paypal');
const emailService = require('../services/email');
const plexService = require('../services/plex');
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
    DELETE FROM email_verification_tokens;
    DELETE FROM password_reset_tokens;
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

test('password reset request sends email for verified donor', async (t) => {
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
    email: 'reset-request@example.com',
    name: 'Reset Request',
    status: 'active',
  });
  updateDonorPassword(donor.id, hashPasswordSync('ExistingPass123!'));
  markDonorEmailVerified(donor.id);

  await withTestServer(async (client) => {
    const response = await client.post('/customer/password/reset/request', {
      body: { email: donor.email },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.match(payload.message, /reset link/i);
  });

  const tokenRow = db
    .prepare('SELECT COUNT(*) AS count FROM password_reset_tokens WHERE donor_id = ?')
    .get(donor.id);
  assert.equal(tokenRow.count, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].subject || '', /reset/i);
  assert.match(sentMessages[0].html || '', /reset=/i);
});

test('password reset updates password and signs donor in', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const donor = createDonor({
    email: 'reset-complete@example.com',
    name: 'Reset Complete',
    status: 'active',
  });
  const originalHash = hashPasswordSync('OldPass123!');
  updateDonorPassword(donor.id, originalHash);
  markDonorEmailVerified(donor.id);
  const tokenRecord = createDonorPasswordResetToken(donor.id, {
    expiresInHours: 4,
  });

  await withTestServer(async (client) => {
    const response = await client.post('/customer/password/reset', {
      body: {
        token: tokenRecord.token,
        password: 'BrandNew123!',
        confirmPassword: 'BrandNew123!',
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.authenticated, true);
    assert.ok(payload.donor);
    assert.equal(payload.donor.id, donor.id);
  });

  const updatedRow = db
    .prepare('SELECT password_hash FROM donors WHERE id = ?')
    .get(donor.id);
  assert.ok(updatedRow.password_hash && updatedRow.password_hash.startsWith('pbkdf2$'));
  assert.notEqual(updatedRow.password_hash, originalHash);
  assert.ok(verifyPasswordSync('BrandNew123!', updatedRow.password_hash));
  const remainingTokens = db
    .prepare('SELECT COUNT(*) AS count FROM password_reset_tokens WHERE donor_id = ?')
    .get(donor.id);
  assert.equal(remainingTokens.count, 0);
});

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


test('customer can start a trial from the dashboard', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'TrialTime123!';
  const donor = createDonor({
    email: 'trial-dashboard@example.com',
    name: 'Trial Dashboard',
    status: 'cancelled',
    plexAccountId: 'plex-trial-dashboard',
    plexEmail: 'trial-dashboard@example.com',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  markDonorEmailVerified(donor.id);

  let trialPayload = null;

  await withTestServer(async (client) => {
    const loginResponse = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(loginResponse.status, 200);
    await loginResponse.json();

    const trialResponse = await client.post('/customer/trial');
    assert.equal(trialResponse.status, 200);
    trialPayload = await trialResponse.json();
    assertDefaultAnnouncement(trialPayload.announcement);
    assert.ok(trialPayload.donor);
    assert.equal(trialPayload.donor.id, donor.id);
    assert.equal(trialPayload.donor.status, 'trial');
    assert.equal(typeof trialPayload.donor.accessExpiresAt, 'string');
    assert.ok(Date.parse(trialPayload.donor.accessExpiresAt) > Date.now());
  });

  assert.ok(trialPayload);
  const updated = getDonorById(donor.id);
  assert.equal(updated.status, 'trial');
  assert.equal(updated.accessExpiresAt, trialPayload.donor.accessExpiresAt);
  assert.ok(Date.parse(updated.accessExpiresAt) > Date.now());
});

test('customer trial start requires a linked Plex account', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'LinkPlex987!';
  const donor = createDonor({
    email: 'noplex@example.com',
    name: 'No Plex Link',
    status: 'pending',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  markDonorEmailVerified(donor.id);

  await withTestServer(async (client) => {
    const loginResponse = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(loginResponse.status, 200);
    await loginResponse.json();

    const trialResponse = await client.post('/customer/trial');
    assert.equal(trialResponse.status, 409);
    const payload = await trialResponse.json();
    assert.match(payload.error, /link your plex account/i);
  });

  const unchanged = getDonorById(donor.id);
  assert.equal(unchanged.status, 'pending');
  assert.equal(unchanged.accessExpiresAt, null);
});

test('customer trial start is blocked when a trial is already active', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'TrialActive456!';
  const existingExpiration = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const donor = createDonor({
    email: 'trialing@example.com',
    name: 'Already Trialing',
    status: 'trial',
    accessExpiresAt: existingExpiration,
    plexAccountId: 'plex-trialing',
    plexEmail: 'trialing@example.com',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  markDonorEmailVerified(donor.id);

  await withTestServer(async (client) => {
    const loginResponse = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(loginResponse.status, 200);
    await loginResponse.json();

    const trialResponse = await client.post('/customer/trial');
    assert.equal(trialResponse.status, 409);
    const payload = await trialResponse.json();
    assert.match(payload.error, /trial is already in progress/i);
  });

  const unchanged = getDonorById(donor.id);
  assert.equal(unchanged.status, 'trial');
  assert.equal(unchanged.accessExpiresAt, existingExpiration);
});

test('customer trial start is blocked when trial has already been used', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'TrialExpired789!';
  const donor = createDonor({
    email: 'trial-expired@example.com',
    name: 'Trial Expired',
    status: 'trial_expired',
    plexAccountId: 'plex-trial-expired',
    plexEmail: 'trial-expired@example.com',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  markDonorEmailVerified(donor.id);

  await withTestServer(async (client) => {
    const loginResponse = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(loginResponse.status, 200);
    await loginResponse.json();

    const trialResponse = await client.post('/customer/trial');
    assert.equal(trialResponse.status, 409);
    const payload = await trialResponse.json();
    assert.match(payload.error, /trial has already been used/i);
  });

  const unchanged = getDonorById(donor.id);
  assert.equal(unchanged.status, 'trial_expired');
  assert.equal(unchanged.accessExpiresAt, null);
});


test('customer support workflow creates thread and notifies admin', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  settingsStore.updateGroup('smtp', {
    host: 'smtp.test',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
    supportNotificationEmail: 'Support Team <support@example.com>',
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
    recipientAddresses.every(
      (address) => address === 'Support Team <support@example.com>'
    )
  );
});

test('dashboard page includes relay advisory and FAQ guidance', () => {
  const dashboardHtmlPath = path.join(__dirname, '..', '..', 'public', 'dashboard.html');
  const html = fs.readFileSync(dashboardHtmlPath, 'utf8');
  assert.match(
    html,
    /If you use Apple ‘Hide My Email’, Plex invites may not map to your expected address\./
  );
  assert.match(html, /Why did my Plex invite go to a different email\?/);
});

test('customer session payload includes non-blocking relay warning', async () => {
  resetDatabase();
  const donor = createDonor({
    email: 'relay-session@privaterelay.appleid.com',
    name: 'Relay Session',
    status: 'active',
  });

  await withTestServer(async (client) => {
    const setupResponse = await client.post('/test/setup-session', {
      body: { customerId: donor.id },
    });
    assert.equal(setupResponse.status, 200);
    await setupResponse.json();

    const sessionResponse = await client.get('/customer/session');
    assert.equal(sessionResponse.status, 200);
    const payload = await sessionResponse.json();
    assert.match(payload.warning, /Hide My Email/i);
    assert.equal(payload.authenticated, true);
  });
});


test('customer trial invite event logs relay diagnostics without raw emails', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'TrialRelay123!';
  const donor = createDonor({
    email: 'trial-relay@privaterelay.appleid.com',
    name: 'Trial Relay',
    status: 'cancelled',
    plexAccountId: 'plex-trial-relay',
    plexEmail: 'trial-plex@example.com',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  markDonorEmailVerified(donor.id);

  const originalIsConfigured = plexService.isConfigured;
  const originalListUsers = plexService.listUsers;
  const originalCreateInvite = plexService.createInvite;
  const originalSendInvite = emailService.sendInviteEmail;
  const createInviteCalls = [];
  const sentInviteEmails = [];

  plexService.isConfigured = () => true;
  plexService.listUsers = async () => [];
  plexService.createInvite = async (payload) => {
    createInviteCalls.push(payload);
    return {
      inviteId: 'trial-relay-invite',
      inviteUrl: 'https://plex.local/invite/trial-relay-invite',
      status: 'pending',
      invitedAt: new Date().toISOString(),
    };
  };
  emailService.sendInviteEmail = async (payload) => {
    sentInviteEmails.push(payload);
  };

  t.after(() => {
    plexService.isConfigured = originalIsConfigured;
    plexService.listUsers = originalListUsers;
    plexService.createInvite = originalCreateInvite;
    emailService.sendInviteEmail = originalSendInvite;
  });

  await withTestServer(async (client) => {
    const loginResponse = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(loginResponse.status, 200);
    await loginResponse.json();

    const trialResponse = await client.post('/customer/trial');
    assert.equal(trialResponse.status, 200);
  });

  const event = getRecentEvents(20).find((item) => item.eventType === 'invite.trial.generated');
  assert.ok(event);
  const payload = JSON.parse(event.payload);
  assert.equal(payload.donorEmailIsRelay, true);
  assert.equal(payload.plexEmailIsRelay, false);
  assert.equal(payload.emailsDiffer, true);
  assert.equal(Object.hasOwn(payload, 'email'), false);
  assert.equal(createInviteCalls.length, 1);
  assert.equal(createInviteCalls[0].email, 'trial-plex@example.com');
  assert.equal(sentInviteEmails.length, 1);
  assert.equal(sentInviteEmails[0].to, 'trial-relay@privaterelay.appleid.com');
});

test('customer trial invite uses plexEmail target and does not match existing users by donor email alone', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const password = 'TrialPlexIdentity123!';
  const donor = createDonor({
    email: 'non-plex@example.com',
    name: 'Trial Plex Identity',
    status: 'cancelled',
    plexAccountId: 'acct-trial-plex-123',
    plexEmail: 'relay-or-plex@example.com',
  });
  updateDonorPassword(donor.id, hashPasswordSync(password));
  markDonorEmailVerified(donor.id);

  const originalIsConfigured = plexService.isConfigured;
  const originalListUsers = plexService.listUsers;
  const originalCreateInvite = plexService.createInvite;

  const createInviteCalls = [];
  plexService.isConfigured = () => true;
  plexService.listUsers = async () => [
    {
      email: 'non-plex@example.com',
      id: 'someone-else',
    },
  ];
  plexService.createInvite = async (payload) => {
    createInviteCalls.push(payload);
    return {
      inviteId: 'trial-plex-identity-invite',
      inviteUrl: 'https://plex.local/invite/trial-plex-identity-invite',
      status: 'pending',
      invitedAt: new Date().toISOString(),
    };
  };

  t.after(() => {
    plexService.isConfigured = originalIsConfigured;
    plexService.listUsers = originalListUsers;
    plexService.createInvite = originalCreateInvite;
  });

  await withTestServer(async (client) => {
    const loginResponse = await client.post('/customer/login', {
      body: { email: donor.email, password },
    });
    assert.equal(loginResponse.status, 200);
    await loginResponse.json();

    const trialResponse = await client.post('/customer/trial');
    assert.equal(trialResponse.status, 200);
  });

  assert.equal(createInviteCalls.length, 1);
  assert.equal(createInviteCalls[0].email, 'relay-or-plex@example.com');

  const generated = getRecentEvents(30).find(
    (item) => item.eventType === 'invite.trial.generated'
  );
  assert.ok(generated);
  const payload = JSON.parse(generated.payload);
  assert.equal(payload.donorEmailIsRelay, false);
  assert.equal(payload.plexEmailIsRelay, false);
  assert.equal(payload.emailsDiffer, true);
});
