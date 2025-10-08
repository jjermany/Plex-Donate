process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = process.env.DATABASE_FILE || ':memory:';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'share-test-session';

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const TEST_ADMIN_PASSWORD = 'admin-test-password';
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-session-test-'));
config.dataDir = testDataDir;

const adminRouter = require('./admin');
const customerRouter = require('./customer');
const { createDonor } = require('../db');
const { hashPassword, hashPasswordSync } = require('../utils/passwords');

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

const SESSION_COOKIE_NAME = 'plex-donate.sid';

class FetchAgent {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.sessionToken = null;
  }

  getCookieValue(name) {
    const cookie = this.cookies.get(name);
    if (!cookie) {
      return null;
    }
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex === -1) {
      return null;
    }
    return cookie.slice(separatorIndex + 1);
  }

  buildCookieHeader() {
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

  async request(path, { method = 'GET', headers = {}, body } = {}) {
    const requestHeaders = { ...headers };
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      requestHeaders.cookie = cookieHeader;
    }

    const url = new URL(path, this.baseUrl);
    if (this.sessionToken) {
      url.searchParams.set('session', this.sessionToken);
      requestHeaders['x-session-token'] = this.sessionToken;
    }

    let requestBody = body;
    if (
      requestBody &&
      typeof requestBody === 'object' &&
      !Buffer.isBuffer(requestBody) &&
      !(requestBody instanceof URLSearchParams) &&
      !(typeof requestBody === 'string')
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
      response.cookieHeaders = rawHeaders;
    } else {
      response.cookieHeaders = [];
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
      // Ignore JSON parsing errors for session token updates.
    }

    return response;
  }

  get(path, options = {}) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path, options = {}) {
    return this.request(path, { ...options, method: 'POST' });
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
    const { preserved = null, plexLink = null } = req.body || {};
    if (preserved) {
      req.session.preserved = preserved;
    } else {
      delete req.session.preserved;
    }
    if (plexLink) {
      req.session.plexLink = plexLink;
    } else {
      delete req.session.plexLink;
    }
    res.json({
      sessionId: req.sessionID,
      preserved: req.session.preserved || null,
      plexLink: req.session.plexLink || null,
      customerId: req.session.customerId || null,
    });
  });

  app.get('/test/session-info', (req, res) => {
    res.json({
      sessionId: req.sessionID,
      preserved: req.session.preserved || null,
      plexLink: req.session.plexLink || null,
      customerId: req.session.customerId || null,
    });
  });

  app.use('/api/admin', adminRouter);
  app.use('/api/customer', customerRouter);

  return http.createServer(app);
}

async function startServer(t) {
  const server = createTestServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  t.after(() =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    })
  );

  seedAdminCredentials();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return new FetchAgent(baseUrl);
}

test('admin login regenerates the session and refreshes the CSRF token', async (t) => {
  const agent = await startServer(t);

  const sessionResponse = await agent.get('/api/admin/session');
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.authenticated, false);
  const initialToken = sessionBody.csrfToken;
  assert.ok(initialToken);

  const initialCookie = agent.getCookieValue(SESSION_COOKIE_NAME);
  assert.ok(initialCookie);

  const loginResponse = await agent.post('/api/admin/login', {
    body: {
      username: process.env.ADMIN_USERNAME,
      password: TEST_ADMIN_PASSWORD,
      _csrf: initialToken,
    },
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.success, true);
  assert.ok(loginBody.csrfToken);
  assert.notEqual(loginBody.csrfToken, initialToken);

  const refreshedCookie = agent.getCookieValue(SESSION_COOKIE_NAME);
  assert.ok(refreshedCookie);
  assert.notEqual(refreshedCookie, initialCookie);

  const authenticatedSession = await agent.get('/api/admin/session');
  assert.equal(authenticatedSession.status, 200);
  const authenticatedBody = await authenticatedSession.json();
  assert.equal(authenticatedBody.authenticated, true);

  const logoutResponse = await agent.post('/api/admin/logout', {
    body: { _csrf: loginBody.csrfToken },
  });
  assert.equal(logoutResponse.status, 200);
  const logoutBody = await logoutResponse.json();
  assert.equal(logoutBody.success, true);

  const finalSession = await agent.get('/api/admin/session');
  assert.equal(finalSession.status, 200);
  const finalBody = await finalSession.json();
  assert.equal(finalBody.authenticated, false);
});

test('customer login regenerates the session and preserves Plex link data', async (t) => {
  const agent = await startServer(t);

  const password = 'CustomerPass123!';
  const passwordHash = await hashPassword(password);
  const donorEmail = `customer-${Date.now()}@example.com`;
  const donor = createDonor({
    email: donorEmail,
    name: 'Customer Example',
    status: 'active',
    passwordHash,
  });

  const setupResponse = await agent.post('/test/setup-session', {
    body: {
      preserved: 'legacy-data',
      plexLink: {
        donorId: donor.id,
        code: 'CODE123',
        authUrl: 'https://plex.example/auth',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        pollIntervalMs: 5000,
      },
    },
  });
  assert.equal(setupResponse.status, 200);
  const setupBody = await setupResponse.json();
  assert.equal(setupBody.customerId, null);
  assert.equal(setupBody.preserved, 'legacy-data');
  assert.ok(setupBody.sessionId);

  const initialCookie = agent.getCookieValue(SESSION_COOKIE_NAME);
  assert.ok(initialCookie);

  const loginResponse = await agent.post('/api/customer/login', {
    body: { email: donor.email, password },
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.authenticated, true);
  assert.ok(loginBody.donor);
  assert.equal(loginBody.donor.id, donor.id);
  assert.equal(loginBody.plexLink && loginBody.plexLink.pending, true);
  assert.equal(loginBody.plexLink.code, 'CODE123');

  const refreshedCookie = agent.getCookieValue(SESSION_COOKIE_NAME);
  assert.ok(refreshedCookie);
  assert.notEqual(refreshedCookie, initialCookie);

  const sessionInfoResponse = await agent.get('/test/session-info');
  assert.equal(sessionInfoResponse.status, 200);
  const sessionInfo = await sessionInfoResponse.json();
  assert.equal(sessionInfo.customerId, donor.id);
  assert.equal(sessionInfo.preserved, null);
  assert.ok(sessionInfo.plexLink);
  assert.equal(sessionInfo.plexLink.code, 'CODE123');
  assert.notEqual(sessionInfo.sessionId, setupBody.sessionId);

  const logoutResponse = await agent.post('/api/customer/logout');
  assert.equal(logoutResponse.status, 200);
  const logoutBody = await logoutResponse.json();
  assert.equal(logoutBody.success, true);

  const finalInfoResponse = await agent.get('/test/session-info');
  assert.equal(finalInfoResponse.status, 200);
  const finalInfo = await finalInfoResponse.json();
  assert.equal(finalInfo.customerId, null);

  const finalSessionResponse = await agent.get('/api/customer/session');
  assert.equal(finalSessionResponse.status, 200);
  const finalSessionBody = await finalSessionResponse.json();
  assert.equal(finalSessionBody.authenticated, false);
});

test('customer can link an existing subscription from the profile form', async (t) => {
  const agent = await startServer(t);

  const password = 'LinkPass123!';
  const passwordHash = await hashPassword(password);
  const donorEmail = `linker-${Date.now()}@example.com`;
  const donor = createDonor({
    email: donorEmail,
    name: 'Link Donor',
    status: 'pending',
    passwordHash,
  });

  const loginResponse = await agent.post('/api/customer/login', {
    body: { email: donor.email, password },
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.authenticated, true);
  assert.equal(loginBody.donor.subscriptionId, null);

  const subscriptionId = 'I-LINK123456';
  const updateResponse = await agent.post('/api/customer/profile', {
    body: {
      email: donor.email,
      name: donor.name,
      subscriptionId,
    },
  });
  const updateBody = await updateResponse.json();
  assert.equal(
    updateResponse.status,
    200,
    updateBody && updateBody.error ? updateBody.error : 'Profile update should succeed'
  );
  assert.equal(updateBody.donor.subscriptionId, subscriptionId);
});

