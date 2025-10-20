process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'share-test-session';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const testDbDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plex-donate-share-db-')
  );
  process.env.DATABASE_FILE = path.join(testDbDir, 'database.sqlite');
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');

const config = require('../config');
const TEST_ADMIN_PASSWORD = 'admin-test-password';
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-test-data-'));
config.dataDir = testDataDir;

const shareRouter = require('./share');
const adminRouter = require('./admin');
const customerRouter = require('./customer');
const {
  db,
  createDonor,
  createProspect,
  createOrUpdateShareLink,
  getShareLinkByToken,
  getProspectById,
  assignShareLinkToDonor,
} = require('../db');
const paypalService = require('../services/paypal');
const settingsStore = require('../state/settings');
const SqliteSessionStore = require('../session-store');
const emailService = require('../services/email');
const plexService = require('../services/plex');
const { hashPassword, hashPasswordSync } = require('../utils/passwords');
const { ensureSessionToken } = require('../utils/session-tokens');

const credentialsFile = path.join(config.dataDir, 'admin-credentials.json');

function seedAdminCredentials(
  username = process.env.ADMIN_USERNAME,
  password = TEST_ADMIN_PASSWORD
) {
  const payload = {
    username,
    passwordHash: hashPasswordSync(password),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  fs.writeFileSync(credentialsFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/share', shareRouter);
  return app;
}

function createCustomerApp() {
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
  app.post('/test/login', (req, res) => {
    const rawId =
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'customerId')
        ? req.body.customerId
        : null;
    let parsedId = null;
    if (typeof rawId === 'number' && Number.isFinite(rawId)) {
      parsedId = rawId;
    } else if (typeof rawId === 'string' && rawId.trim()) {
      const numeric = Number.parseInt(rawId, 10);
      if (Number.isFinite(numeric)) {
        parsedId = numeric;
      }
    }

    if (parsedId) {
      req.session.customerId = parsedId;
    } else {
      delete req.session.customerId;
    }

    const sessionToken = ensureSessionToken(req);
    res.json({ success: Boolean(parsedId), sessionToken });
  });
  app.use('/customer', customerRouter);
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
        sessionToken: null,
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

  const url = new URL(path, server.origin);
  if (server.sessionToken) {
    url.searchParams.set('session', server.sessionToken);
    init.headers['x-session-token'] = server.sessionToken;
  }

  const response = await fetch(url.toString(), init);
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
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (Object.prototype.hasOwnProperty.call(payload, 'sessionToken')) {
      const token = payload.sessionToken;
      server.sessionToken = typeof token === 'string' && token ? token : null;
    }
  }
  return { status: response.status, body: payload };
}

let cachedShareDashboardScript = null;

function getShareDashboardScript() {
  if (!cachedShareDashboardScript) {
    const shareHtmlPath = path.join(__dirname, '..', '..', 'public', 'share.html');
    const html = fs.readFileSync(shareHtmlPath, 'utf8');
    const match = html.match(/<script>([\s\S]*)<\/script>/i);
    if (!match) {
      throw new Error('Unable to locate share dashboard script for tests');
    }
    cachedShareDashboardScript = match[1];
  }
  return cachedShareDashboardScript;
}

function createDomElementStub(id) {
  const element = {
    id,
    dataset: {},
    disabled: false,
    value: '',
    href: '',
    style: {},
    addEventListener() {},
    removeEventListener() {},
    removeAttribute(attr) {
      if (attr === 'href') {
        this.href = '';
      }
    },
    setAttribute(attr, value) {
      if (attr === 'href') {
        this.href = value;
      }
    },
    focus() {},
  };
  let classTokens = new Set();
  const syncClassName = () => {
    element._className = Array.from(classTokens).join(' ');
  };
  Object.defineProperty(element, 'className', {
    get() {
      return element._className || '';
    },
    set(value) {
      const stringValue = String(value || '');
      element._className = stringValue;
      classTokens = new Set(stringValue.split(/\s+/).filter(Boolean));
    },
  });
  element.classList = {
    add(...classes) {
      classes.flat().forEach((cls) => {
        if (cls) {
          classTokens.add(cls);
        }
      });
      syncClassName();
    },
    remove(...classes) {
      classes.flat().forEach((cls) => {
        classTokens.delete(cls);
      });
      syncClassName();
    },
    toggle(cls, force) {
      if (!cls) {
        return false;
      }
      if (force === undefined) {
        if (classTokens.has(cls)) {
          classTokens.delete(cls);
        } else {
          classTokens.add(cls);
        }
      } else if (force) {
        classTokens.add(cls);
      } else {
        classTokens.delete(cls);
      }
      syncClassName();
      return classTokens.has(cls);
    },
    contains(cls) {
      return classTokens.has(cls);
    },
  };
  Object.defineProperty(element, 'textContent', {
    get() {
      return element._textContent || '';
    },
    set(value) {
      element._textContent = value;
    },
  });
  return element;
}

function createShareUiHarness() {
  const elementIds = [
    'loading',
    'error-panel',
    'content',
    'account-description',
    'account-form',
    'account-email',
    'account-name',
    'account-password',
    'account-confirm',
    'account-subscription-row',
    'account-subscription',
    'account-submit',
    'account-status',
    'invite-description',
    'invite-form',
    'recipient-email',
    'display-name',
    'generate-button',
    'action-status',
    'invite-ready',
    'invite-link',
    'invite-created',
    'invite-email',
  ];
  const elements = new Map();
  elementIds.forEach((id) => {
    elements.set(id, createDomElementStub(id));
  });
  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createDomElementStub(id));
      }
      return elements.get(id);
    },
    activeElement: null,
    title: '',
  };
  const windowStub = {
    location: { pathname: '/' },
    addEventListener() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
  };
  const navigatorStub = {
    serviceWorker: {
      register: async () => {},
    },
  };
  documentStub.defaultView = windowStub;
  windowStub.document = documentStub;
  windowStub.console = console;
  const context = {
    window: windowStub,
    document: documentStub,
    navigator: navigatorStub,
    console,
    fetch: async () => {
      throw new Error('fetch not implemented in test harness');
    },
  };
  return { context, elements };
}

function loadShareRendererForTest() {
  const script = getShareDashboardScript();
  const { context, elements } = createShareUiHarness();
  const vmContext = vm.createContext(context);
  vm.runInContext(script, vmContext, { filename: 'share.html' });
  const renderFn = vmContext.window.render || vmContext.render;
  if (typeof renderFn !== 'function') {
    throw new Error('Share renderer is not available');
  }
  return {
    render(data) {
      renderFn.call(vmContext.window, data);
    },
    elements: {
      actionStatus: elements.get('action-status'),
      inviteDescription: elements.get('invite-description'),
    },
  };
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
    seedAdminCredentials();
    const sessionResponse = await requestJson(server, 'GET', '/api/admin/session');
    assert.equal(sessionResponse.status, 200);
    let csrfToken = sessionResponse.body.csrfToken;
    assert.ok(csrfToken);

    const loginResponse = await requestJson(server, 'POST', '/api/admin/login', {
      headers: { 'x-csrf-token': csrfToken },
      body: { username: process.env.ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
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
  await t.test('existing donor can update account details', async (t) => {
    resetDatabase();
    const welcomeMock = t.mock.method(
      emailService,
      'sendAccountWelcomeEmail',
      async () => {}
    );
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
            password: 'password1234',
            confirmPassword: 'password1234',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(accountResponse.status, 200);
      assert.equal(accountResponse.body.donor.email, 'updated@example.com');
      assert.equal(accountResponse.body.donor.name, 'Updated Name');
      assert.equal(accountResponse.body.donor.hasPassword, true);

      assert.equal(welcomeMock.mock.callCount(), 1);
      const welcomeArgs = welcomeMock.mock.calls[0].arguments[0];
      assert.equal(welcomeArgs.to, 'updated@example.com');
      assert.equal(welcomeArgs.name, 'Updated Name');
      assert.equal(welcomeArgs.loginUrl, `${server.origin}/dashboard`);
      assert.ok(
        typeof welcomeArgs.verificationUrl === 'string' &&
          welcomeArgs.verificationUrl.startsWith(
            `${server.origin}/dashboard/verify?token=`
          )
      );

      const row = db
        .prepare('SELECT password_hash, email_verified_at FROM donors WHERE id = ?')
        .get(accountResponse.body.donor.id);
      assert.ok(row.password_hash && row.password_hash.startsWith('pbkdf2$'));
      assert.equal(row.email_verified_at, null);

      const tokenRow = db
        .prepare(
          'SELECT token, used_at FROM email_verification_tokens WHERE donor_id = ?'
        )
        .get(accountResponse.body.donor.id);
      assert.ok(tokenRow && tokenRow.token);
      assert.equal(tokenRow.used_at, null);
    } finally {
      welcomeMock.mock.restore();
      await server.close();
    }
  });

  await t.test('prospect promotion creates donor record', async (t) => {
    resetDatabase();
    const welcomeMock = t.mock.method(
      emailService,
      'sendAccountWelcomeEmail',
      async () => {}
    );
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
            password: 'password1234',
            confirmPassword: 'password1234',
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

      assert.equal(welcomeMock.mock.callCount(), 1);
      const welcomeArgs = welcomeMock.mock.calls[0].arguments[0];
      assert.equal(welcomeArgs.to, 'future@example.com');
      assert.equal(welcomeArgs.name, 'Future Supporter');
      assert.equal(welcomeArgs.loginUrl, `${server.origin}/dashboard`);
      assert.ok(
        typeof welcomeArgs.verificationUrl === 'string' &&
          welcomeArgs.verificationUrl.startsWith(
            `${server.origin}/dashboard/verify?token=`
          )
      );

      const updatedLink = getShareLinkByToken(shareLink.token);
      assert.equal(updatedLink.donorId, accountResponse.body.donor.id);
      assert.equal(updatedLink.prospectId, null);

      const prospectRecord = getProspectById(prospect.id);
      assert.ok(prospectRecord && prospectRecord.convertedAt);

      const row = db
        .prepare('SELECT password_hash, email_verified_at FROM donors WHERE id = ?')
        .get(accountResponse.body.donor.id);
      assert.ok(row.password_hash && row.password_hash.startsWith('pbkdf2$'));
      assert.equal(row.email_verified_at, null);

      const tokenRow = db
        .prepare(
          'SELECT token, used_at FROM email_verification_tokens WHERE donor_id = ?'
        )
        .get(accountResponse.body.donor.id);
      assert.ok(tokenRow && tokenRow.token);
      assert.equal(tokenRow.used_at, null);
    } finally {
      welcomeMock.mock.restore();
      await server.close();
    }
  });

  await t.test('share response marks donors already shared on Plex', async (t) => {
    resetDatabase();
    const plexConfiguredMock = t.mock.method(plexService, 'isConfigured', () => true);
    const plexListMock = t.mock.method(plexService, 'listUsers', async () => [
      { email: 'shared@example.com', id: 'plex-123', pending: false },
    ]);
    const app = createApp();
    const server = await startServer(app);

    try {
      const donor = createDonor({
        email: 'shared@example.com',
        name: 'Shared Donor',
        subscriptionId: 'I-SHARED',
        status: 'active',
        passwordHash: await hashPassword('SharedAccess123!'),
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'shared-token',
        sessionToken: 'shared-session',
      });

      const viewResponse = await requestJson(server, 'GET', `/share/${shareLink.token}`);
      assert.equal(viewResponse.status, 200);
      assert.ok(viewResponse.body.donor);
      assert.equal(viewResponse.body.donor.plexShared, true);
      assert.equal(viewResponse.body.donor.needsPlexInvite, false);
      assert.ok(viewResponse.body.shareState);
      assert.equal(viewResponse.body.shareState.plexShared, true);
      assert.equal(viewResponse.body.shareState.needsPlexInvite, false);
      assert.equal(viewResponse.body.shareState.plexShareState, 'shared');
      assert.ok(viewResponse.body.plex);
      assert.equal(viewResponse.body.plex.configured, true);
      assert.equal(viewResponse.body.plex.error, null);

      const renderer = loadShareRendererForTest();
      renderer.render(viewResponse.body);
      assert.equal(
        renderer.elements.actionStatus.textContent,
        'Plex access is already active—no new invite is needed.'
      );
      assert.equal(renderer.elements.actionStatus.className, 'status-text success');
      assert.equal(
        renderer.elements.inviteDescription.textContent,
        'Plex access is already active. Follow the link below if you ever need to restore it.'
      );
    } finally {
      plexConfiguredMock.mock.restore();
      plexListMock.mock.restore();
      await server.close();
    }
  });

  await t.test(
    'prospect promotion rejects takeover when donor already has password',
    async () => {
      resetDatabase();
      const app = createApp();
      const server = await startServer(app);

      try {
        const passwordHash = await hashPassword('ExistingPass123!');
        const donor = createDonor({
          email: 'secure@example.com',
          name: 'Secure Donor',
          status: 'pending',
          passwordHash,
        });

        const originalPasswordRow = db
          .prepare('SELECT password_hash FROM donors WHERE id = ?')
          .get(donor.id);

        const prospect = createProspect({
          email: donor.email,
          name: 'Secure Donor',
        });

        const shareLink = createOrUpdateShareLink({
          prospectId: prospect.id,
          token: 'prospect-secure-token',
          sessionToken: 'prospect-secure-session',
        });

        const takeoverAttempt = await requestJson(
          server,
          'POST',
          `/share/${shareLink.token}/account`,
          {
            headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
            body: {
              email: prospect.email,
              name: prospect.name,
              password: 'NewPassword123!',
              confirmPassword: 'NewPassword123!',
              sessionToken: shareLink.sessionToken,
            },
          }
        );

        assert.equal(takeoverAttempt.status, 409);
        assert.ok(
          takeoverAttempt.body &&
            typeof takeoverAttempt.body.error === 'string' &&
            takeoverAttempt.body.error.toLowerCase().includes('log in'),
          'response should include guidance to log in'
        );

        const updatedPasswordRow = db
          .prepare('SELECT password_hash FROM donors WHERE id = ?')
          .get(donor.id);
        assert.equal(updatedPasswordRow.password_hash, originalPasswordRow.password_hash);

        const refreshedLink = getShareLinkByToken(shareLink.token);
        assert.equal(refreshedLink.donorId, null);
        assert.equal(refreshedLink.prospectId, prospect.id);
      } finally {
        await server.close();
      }
    }
  );

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

  await t.test(
    'pending donor subscription refreshes when completing share account setup',
    async (t) => {
      resetDatabase();
      const app = createApp();
      const server = await startServer(app);

      const paypalMock = t.mock.method(
        paypalService,
        'getSubscription',
        async () => ({
          status: 'ACTIVE',
          billing_info: {
            last_payment: { time: '2024-01-02T03:04:05.000Z' },
          },
        })
      );

      const welcomeMock = t.mock.method(
        emailService,
        'sendAccountWelcomeEmail',
        async () => {}
      );

      try {
        const donor = createDonor({
          email: 'refresh@example.com',
          name: 'Refresh Donor',
          subscriptionId: 'I-REFRESH',
          status: 'pending',
        });
        const shareLink = createOrUpdateShareLink({
          donorId: donor.id,
          token: 'refresh-token',
          sessionToken: 'refresh-session',
        });

        const response = await requestJson(
          server,
          'POST',
          `/share/${shareLink.token}/account`,
          {
            headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
            body: {
              email: 'refresh@example.com',
              name: 'Refresh Donor',
              password: 'supersecure1',
              confirmPassword: 'supersecure1',
              sessionToken: shareLink.sessionToken,
            },
          }
        );

        assert.equal(response.status, 200);
        assert.ok(response.body.donor);
        assert.equal(response.body.donor.status, 'active');
        assert.equal(
          response.body.donor.lastPaymentAt,
          '2024-01-02T03:04:05.000Z'
        );
        assert.equal(paypalMock.mock.callCount(), 1);
        assert.equal(welcomeMock.mock.callCount(), 1);
        const welcomeArgs = welcomeMock.mock.calls[0].arguments[0];
        assert.equal(welcomeArgs.to, 'refresh@example.com');
        assert.equal(welcomeArgs.name, 'Refresh Donor');
        assert.equal(welcomeArgs.loginUrl, `${server.origin}/dashboard`);
      } finally {
        paypalMock.mock.restore();
        welcomeMock.mock.restore();
        await server.close();
      }
    }
  );

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

  await t.test('share link blocks checkout until the account is ready', async (t) => {
    resetDatabase();
    settingsStore.updateGroup('paypal', {
      planId: 'P-TEST',
      clientId: 'client',
      clientSecret: 'secret',
    });

    const app = createApp();
    const server = await startServer(app);

    const mock = t.mock.method(paypalService, 'createSubscription', async () => ({
      subscriptionId: 'I-READY',
      approvalUrl: 'https://paypal.example/ready',
    }));

    try {
      const prospect = createProspect({
        email: 'ready@example.com',
        name: 'Ready Prospect',
      });
      const shareLink = createOrUpdateShareLink({
        prospectId: prospect.id,
        token: 'ready-token',
        sessionToken: 'ready-session',
      });

      const viewResponse = await requestJson(server, 'GET', `/share/${shareLink.token}`);
      assert.equal(viewResponse.status, 200);
      assert.equal(viewResponse.body.donor, null);

      const blocked = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/paypal-checkout`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: { sessionToken: shareLink.sessionToken },
        }
      );

      assert.equal(blocked.status, 403);
      assert.ok(blocked.body.error.includes('Create your account'));
      assert.equal(mock.mock.callCount(), 0);

      const passwordHash = await hashPassword('AccountPass123!');
      const donor = createDonor({
        email: prospect.email,
        name: prospect.name,
        status: 'pending',
        passwordHash,
      });
      assignShareLinkToDonor(shareLink.id, donor.id);

      const refreshedLink = getShareLinkByToken(shareLink.token);
      const refreshedView = await requestJson(
        server,
        'GET',
        `/share/${shareLink.token}`
      );
      assert.equal(refreshedView.status, 200);
      assert.ok(refreshedView.body.donor);
      assert.equal(refreshedView.body.donor.id, donor.id);
      assert.equal(refreshedView.body.donor.hasPassword, true);

      const allowed = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/paypal-checkout`,
        {
          headers: { Authorization: `Bearer ${refreshedLink.sessionToken}` },
          body: { sessionToken: refreshedLink.sessionToken },
        }
      );

      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.subscriptionId, 'I-READY');
      assert.equal(allowed.body.approvalUrl, 'https://paypal.example/ready');
      assert.equal(mock.mock.callCount(), 1);
    } finally {
      mock.mock.restore();
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
      const passwordHash = await hashPassword('CheckoutPass123!');
      const donor = createDonor({
        email: 'checkout@example.com',
        name: 'Checkout Donor',
        status: 'pending',
        passwordHash,
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

  await t.test('share invite enforces cooldown window', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const firstInviteEmail = 'friend-one@example.com';
      const secondInviteEmail = 'friend-two@example.com';
      const donor = createDonor({
        email: 'cooldown@example.com',
        name: 'Cooldown Donor',
        subscriptionId: 'I-COOLDOWN',
        status: 'active',
        plexAccountId: 'plex-cooldown',
        plexEmail: 'cooldown@example.com',
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'cooldown-token',
        sessionToken: 'cooldown-session',
      });

      const firstResponse = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: firstInviteEmail,
            name: 'Friend One',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(firstResponse.status, 200);
      assert.equal(firstResponse.body.invite.recipientEmail, firstInviteEmail);
      assert.equal(firstResponse.body.inviteLimitReached, true);
      assert.equal(typeof firstResponse.body.nextInviteAvailableAt, 'string');
      const firstInviteId = firstResponse.body.invite.id;
      assert.ok(firstInviteId);
      const firstNextAvailable = firstResponse.body.nextInviteAvailableAt;

      const blocked = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: secondInviteEmail,
            name: 'Friend Two',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(blocked.status, 409);
      assert.ok(blocked.body.payload);
      assert.equal(blocked.body.payload.inviteLimitReached, true);
      assert.equal(blocked.body.payload.nextInviteAvailableAt, firstNextAvailable);

      const staleTimestamp = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000
      ).toISOString();
      db.prepare('UPDATE invites SET created_at = ? WHERE id = ?').run(
        staleTimestamp,
        firstInviteId
      );

      const allowed = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: secondInviteEmail,
            name: 'Friend Two',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(allowed.status, 200);
      assert.ok(allowed.body.invite);
      assert.notEqual(allowed.body.invite.id, firstInviteId);
      assert.equal(allowed.body.invite.recipientEmail, secondInviteEmail);
      assert.equal(allowed.body.inviteLimitReached, true);
      assert.equal(typeof allowed.body.nextInviteAvailableAt, 'string');
      assert.ok(Date.parse(allowed.body.nextInviteAvailableAt) > Date.now());

      const inviteCount = db.prepare('SELECT COUNT(*) AS count FROM invites').get()
        .count;
      assert.equal(inviteCount, 2);
    } finally {
      await server.close();
    }
  });

  await t.test('customer invite enforces cooldown window', async () => {
    resetDatabase();
    const app = createCustomerApp();
    const server = await startServer(app);

    try {
      const firstInviteEmail = 'friend-one@example.com';
      const secondInviteEmail = 'friend-two@example.com';
      const donor = createDonor({
        email: 'customer@example.com',
        name: 'Customer Donor',
        subscriptionId: 'I-CUSTOMER',
        status: 'active',
        plexAccountId: 'plex-customer',
        plexEmail: 'customer@example.com',
      });

      const loginResponse = await requestJson(server, 'POST', '/test/login', {
        body: { customerId: donor.id },
      });
      assert.equal(loginResponse.status, 200);
      assert.ok(loginResponse.body.sessionToken);

      const firstResponse = await requestJson(
        server,
        'POST',
        '/customer/invite',
        {
          body: {
            email: firstInviteEmail,
            name: 'Friend One',
          },
        }
      );

      assert.equal(firstResponse.status, 200);
      assert.equal(firstResponse.body.invite.recipientEmail, firstInviteEmail);
      assert.equal(firstResponse.body.inviteLimitReached, true);
      assert.equal(typeof firstResponse.body.nextInviteAvailableAt, 'string');
      const firstInviteId = firstResponse.body.invite.id;
      const firstNextAvailable = firstResponse.body.nextInviteAvailableAt;

      const blocked = await requestJson(
        server,
        'POST',
        '/customer/invite',
        {
          body: {
            email: secondInviteEmail,
            name: 'Friend Two',
          },
        }
      );

      assert.equal(blocked.status, 409);
      assert.ok(blocked.body.payload);
      assert.equal(blocked.body.payload.inviteLimitReached, true);
      assert.equal(blocked.body.payload.nextInviteAvailableAt, firstNextAvailable);

      const staleTimestamp = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000
      ).toISOString();
      db.prepare('UPDATE invites SET created_at = ? WHERE id = ?').run(
        staleTimestamp,
        firstInviteId
      );

      const allowed = await requestJson(
        server,
        'POST',
        '/customer/invite',
        {
          body: {
            email: secondInviteEmail,
            name: 'Friend Two',
          },
        }
      );

      assert.equal(allowed.status, 200);
      assert.ok(allowed.body.invite);
      assert.notEqual(allowed.body.invite.id, firstInviteId);
      assert.equal(allowed.body.invite.recipientEmail, secondInviteEmail);
      assert.equal(allowed.body.inviteLimitReached, true);
      assert.equal(typeof allowed.body.nextInviteAvailableAt, 'string');
      assert.ok(Date.parse(allowed.body.nextInviteAvailableAt) > Date.now());

      const inviteCount = db.prepare('SELECT COUNT(*) AS count FROM invites').get()
        .count;
      assert.equal(inviteCount, 2);
    } finally {
      await server.close();
    }
  });

});
