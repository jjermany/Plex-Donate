process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = ':memory:';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-test-password';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'share-test-session';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');

const shareRouter = require('./share');
const adminRouter = require('./admin');
const {
  db,
  createDonor,
  createProspect,
  createOrUpdateShareLink,
  getShareLinkByToken,
  getProspectById,
} = require('../db');
const paypalService = require('../services/paypal');
const settingsStore = require('../state/settings');
const SqliteSessionStore = require('../session-store');
const wizarrService = require('../services/wizarr');
const emailService = require('../services/email');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/share', shareRouter);
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
        cookieJar: [],
      });
    });
  });
}

async function requestJson(server, method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (server.cookieJar && server.cookieJar.length > 0) {
    init.headers.Cookie = server.cookieJar.join('; ');
  }

  const response = await fetch(`${server.origin}${path}`, init);
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.raw
        ? response.headers.raw()['set-cookie'] || []
        : (() => {
            const single = response.headers.get('set-cookie');
            return single ? [single] : [];
          })();

  if (Array.isArray(setCookies) && setCookies.length > 0) {
    server.cookieJar = server.cookieJar || [];
    setCookies.forEach((header) => {
      if (!header) {
        return;
      }
      const [cookiePart] = header.split(';');
      if (!cookiePart) {
        return;
      }
      const [name] = cookiePart.split('=');
      if (!name) {
        return;
      }
      server.cookieJar = server.cookieJar.filter((cookie) => !cookie.startsWith(`${name}=`));
      server.cookieJar.push(cookiePart);
    });
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, body: payload };
}

function resetDatabase() {
  db.exec(`
    DELETE FROM sessions;
    DELETE FROM invite_links;
    DELETE FROM invites;
    DELETE FROM payments;
    DELETE FROM events;
    DELETE FROM settings;
    DELETE FROM donors;
    DELETE FROM prospects;
    DELETE FROM sqlite_sequence WHERE name IN ('donors','prospects','invite_links','invites','payments','events');
  `);
}

function createAdminApp() {
  const app = express();
  const store = new SqliteSessionStore({ db, ttl: 1000 * 60 * 60 });
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store,
    })
  );
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

async function createAdminSession() {
  const app = createAdminApp();
  const server = await startServer(app);

  try {
    const sessionResponse = await requestJson(server, 'GET', '/api/admin/session');
    assert.equal(sessionResponse.status, 200);
    let csrfToken = sessionResponse.body.csrfToken;
    assert.ok(csrfToken);

    const loginResponse = await requestJson(server, 'POST', '/api/admin/login', {
      headers: { 'x-csrf-token': csrfToken },
      body: { password: process.env.ADMIN_PASSWORD },
    });
    assert.equal(loginResponse.status, 200);
    assert.equal(loginResponse.body.success, true);
    csrfToken = loginResponse.body.csrfToken;
    assert.ok(csrfToken);

    return { server, csrfToken };
  } catch (err) {
    await server.close();
    throw err;
  }
}

test('share routes handle donor and prospect flows', { concurrency: false }, async (t) => {
  await t.test('existing donor can update account details', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const donor = createDonor({
        email: 'existing@example.com',
        name: 'Existing Donor',
        subscriptionId: 'I-123456789',
        status: 'active',
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'donor-token',
        sessionToken: 'session-donor',
      });

      const viewResponse = await requestJson(server, 'GET', `/share/${shareLink.token}`);
      assert.equal(viewResponse.status, 200);
      assert.ok(viewResponse.body.donor);
      assert.equal(viewResponse.body.prospect, null);

      const accountResponse = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/account`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: 'updated@example.com',
            name: 'Updated Name',
            password: 'password123',
            confirmPassword: 'password123',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(accountResponse.status, 200);
      assert.equal(accountResponse.body.donor.email, 'updated@example.com');
      assert.equal(accountResponse.body.donor.name, 'Updated Name');
      assert.equal(accountResponse.body.donor.hasPassword, true);

      const row = db
        .prepare('SELECT password_hash FROM donors WHERE id = ?')
        .get(accountResponse.body.donor.id);
      assert.ok(row.password_hash && row.password_hash.startsWith('pbkdf2$'));
    } finally {
      await server.close();
    }
  });

  await t.test('prospect promotion creates donor record', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const prospect = createProspect({
        email: 'future@example.com',
        name: 'Future Supporter',
      });
      const shareLink = createOrUpdateShareLink({
        prospectId: prospect.id,
        token: 'prospect-token',
        sessionToken: 'session-prospect',
      });

      const viewResponse = await requestJson(server, 'GET', `/share/${shareLink.token}`);
      assert.equal(viewResponse.status, 200);
      assert.equal(viewResponse.body.donor, null);
      assert.ok(viewResponse.body.prospect);
      assert.equal(viewResponse.body.prospect.email, 'future@example.com');

      const accountResponse = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/account`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: 'future@example.com',
            name: 'Future Supporter',
            password: 'password123',
            confirmPassword: 'password123',
            subscriptionId: 'I-NEW123',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(accountResponse.status, 200);
      assert.ok(accountResponse.body.donor);
      assert.equal(accountResponse.body.donor.email, 'future@example.com');
      assert.equal(accountResponse.body.donor.subscriptionId, 'I-NEW123');
      assert.equal(accountResponse.body.prospect, null);

      const updatedLink = getShareLinkByToken(shareLink.token);
      assert.equal(updatedLink.donorId, accountResponse.body.donor.id);
      assert.equal(updatedLink.prospectId, null);

      const prospectRecord = getProspectById(prospect.id);
      assert.ok(prospectRecord && prospectRecord.convertedAt);

      const row = db
        .prepare('SELECT password_hash FROM donors WHERE id = ?')
        .get(accountResponse.body.donor.id);
      assert.ok(row.password_hash && row.password_hash.startsWith('pbkdf2$'));
    } finally {
      await server.close();
    }
  });

  await t.test('pending donor cannot generate invite from share link', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const donor = createDonor({
        email: 'pending@example.com',
        name: 'Pending Donor',
        subscriptionId: 'I-PENDING',
        status: 'pending',
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'pending-token',
        sessionToken: 'pending-session',
      });

      const response = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: 'pending@example.com',
            name: 'Pending Donor',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(response.status, 403);
      assert.ok(
        response.body &&
          typeof response.body.error === 'string' &&
          response.body.error.toLowerCase().includes('subscription'),
        'response should include subscription error message'
      );
    } finally {
      await server.close();
    }
  });

  await t.test('suspended donor can view share link but invite remains blocked', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const donor = createDonor({
        email: 'suspended@example.com',
        name: 'Suspended Donor',
        subscriptionId: 'I-SUSPENDED',
        status: 'suspended',
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'suspended-token',
        sessionToken: 'suspended-session',
      });

      const viewResponse = await requestJson(
        server,
        'GET',
        `/share/${shareLink.token}`
      );
      assert.equal(viewResponse.status, 200);
      assert.equal(viewResponse.body.donor.status, 'suspended');

      const response = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: 'suspended@example.com',
            name: 'Suspended Donor',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }
  });

  await t.test('share link can create PayPal checkout approval URL', async (t) => {
    resetDatabase();
    settingsStore.updateGroup('paypal', {
      planId: 'P-TEST',
      clientId: 'client',
      clientSecret: 'secret',
    });

    const app = createApp();
    const server = await startServer(app);

    const mock = t.mock.method(paypalService, 'createSubscription', async () => ({
      subscriptionId: 'I-NEW',
      approvalUrl: 'https://paypal.example/checkout',
    }));

    try {
      const donor = createDonor({
        email: 'checkout@example.com',
        name: 'Checkout Donor',
        status: 'pending',
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'checkout-token',
        sessionToken: 'checkout-session',
      });

      const unauthorized = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/paypal-checkout`,
        { body: { sessionToken: 'wrong' } }
      );
      assert.equal(unauthorized.status, 401);

      const response = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/paypal-checkout`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: { sessionToken: shareLink.sessionToken },
        }
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.subscriptionId, 'I-NEW');
      assert.equal(response.body.approvalUrl, 'https://paypal.example/checkout');
      assert.equal(mock.mock.callCount(), 1);
    } finally {
      mock.mock.restore();
      await server.close();
    }
  });

  await t.test('admin can send Wizarr test invite email', async () => {
    resetDatabase();
    settingsStore.updateGroup('wizarr', {
      baseUrl: 'https://wizarr.saved/api',
      apiKey: 'saved-key',
      defaultDurationDays: 7,
    });

    const inviteCalls = [];
    const emailCalls = [];
    const revokeCalls = [];

    const originalCreateInvite = wizarrService.createInvite;
    const originalRevokeInvite = wizarrService.revokeInvite;
    const originalSendInviteEmail = emailService.sendInviteEmail;
    const originalGetSmtpConfig = emailService.getSmtpConfig;

    wizarrService.createInvite = async (payload, overrideConfig) => {
      inviteCalls.push({ payload, overrideConfig });
      return {
        inviteCode: 'CODE123',
        inviteUrl: 'https://wizarr/invite/CODE123',
      };
    };
    wizarrService.revokeInvite = async (code) => {
      revokeCalls.push(code);
    };
    emailService.sendInviteEmail = async (details, overrideConfig) => {
      emailCalls.push({ details, overrideConfig });
    };
    emailService.getSmtpConfig = () => ({
      host: 'smtp.example.com',
      port: 2525,
      secure: false,
      from: 'Plex Donate <noreply@example.com>',
    });

    const { server, csrfToken } = await createAdminSession();

    try {
      const response = await requestJson(
        server,
        'POST',
        '/api/admin/settings/wizarr/test-invite',
        {
          headers: { 'x-csrf-token': csrfToken },
          body: {
            email: 'tester@example.com',
            name: 'Tester Example',
            note: 'Integration check',
            expiresInDays: 3,
            overrides: {
              baseUrl: 'https://wizarr.preview/api',
              apiKey: 'preview-key',
              defaultDurationDays: 10,
            },
          },
        }
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.deepEqual(response.body.invite, {
        code: 'CODE123',
        url: 'https://wizarr/invite/CODE123',
      });

      assert.equal(inviteCalls.length, 1);
      assert.deepEqual(inviteCalls[0].payload, {
        email: 'tester@example.com',
        note: 'Integration check',
        expiresInDays: 3,
      });
      assert.equal(inviteCalls[0].overrideConfig.baseUrl, 'https://wizarr.preview/api');
      assert.equal(inviteCalls[0].overrideConfig.apiKey, 'preview-key');
      assert.equal(inviteCalls[0].overrideConfig.defaultDurationDays, 10);

      assert.equal(emailCalls.length, 1);
      assert.equal(emailCalls[0].details.to, 'tester@example.com');
      assert.equal(emailCalls[0].details.inviteUrl, 'https://wizarr/invite/CODE123');
      assert.equal(emailCalls[0].details.name, 'Tester Example');
      assert.ok(emailCalls[0].details.subscriptionId.startsWith('TEST-'));
      assert.equal(emailCalls[0].overrideConfig.host, 'smtp.example.com');

      assert.equal(revokeCalls.length, 0);

      const eventRow = db
        .prepare('SELECT event_type, payload FROM events ORDER BY id DESC LIMIT 1')
        .get();
      assert.equal(eventRow.event_type, 'wizarr.test_invite');
      const eventPayload = JSON.parse(eventRow.payload);
      assert.equal(eventPayload.email, 'tester@example.com');
      assert.equal(eventPayload.invite.code, 'CODE123');
      assert.equal(eventPayload.invite.url, 'https://wizarr/invite/CODE123');
      assert.equal(eventPayload.note, 'Integration check');
      assert.equal(eventPayload.expiresInDays, 3);
    } finally {
      await server.close();
      wizarrService.createInvite = originalCreateInvite;
      wizarrService.revokeInvite = originalRevokeInvite;
      emailService.sendInviteEmail = originalSendInviteEmail;
      emailService.getSmtpConfig = originalGetSmtpConfig;
    }
  });

  await t.test('admin test invite revokes when email fails', async () => {
    resetDatabase();

    const inviteCalls = [];
    const revokeCalls = [];
    let emailAttempts = 0;

    const originalCreateInvite = wizarrService.createInvite;
    const originalRevokeInvite = wizarrService.revokeInvite;
    const originalSendInviteEmail = emailService.sendInviteEmail;
    const originalGetSmtpConfig = emailService.getSmtpConfig;

    wizarrService.createInvite = async (payload) => {
      inviteCalls.push(payload);
      return {
        inviteCode: 'FAIL123',
        inviteUrl: 'https://wizarr/invite/FAIL123',
      };
    };
    wizarrService.revokeInvite = async (code) => {
      revokeCalls.push(code);
    };
    emailService.sendInviteEmail = async () => {
      emailAttempts += 1;
      throw new Error('SMTP failure');
    };
    emailService.getSmtpConfig = () => ({
      host: 'smtp.example.com',
      port: 2525,
      secure: false,
      from: 'Plex Donate <noreply@example.com>',
    });

    const { server, csrfToken } = await createAdminSession();

    try {
      const response = await requestJson(
        server,
        'POST',
        '/api/admin/settings/wizarr/test-invite',
        {
          headers: { 'x-csrf-token': csrfToken },
          body: { email: 'failure@example.com' },
        }
      );

      assert.equal(response.status, 500);
      assert.equal(response.body.error, 'Invite created but email delivery failed');
      assert.equal(inviteCalls.length, 1);
      assert.equal(inviteCalls[0].email, 'failure@example.com');
      assert.equal(emailAttempts, 1);
      assert.deepEqual(revokeCalls, ['FAIL123']);

      const eventCount = db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE event_type = ?')
        .get('wizarr.test_invite');
      assert.equal(eventCount.count, 0);
    } finally {
      await server.close();
      wizarrService.createInvite = originalCreateInvite;
      wizarrService.revokeInvite = originalRevokeInvite;
      emailService.sendInviteEmail = originalSendInviteEmail;
      emailService.getSmtpConfig = originalGetSmtpConfig;
    }
  });
});
