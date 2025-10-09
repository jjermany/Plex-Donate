process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || 'admin-router-test-session';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const testDbDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plex-donate-admin-router-db-')
  );
  process.env.DATABASE_FILE = path.join(testDbDir, 'database.sqlite');
}

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const { test } = require('node:test');

const config = require('../config');

const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'plex-donate-admin-router-')
);
config.dataDir = testDataDir;

const { hashPasswordSync } = require('../utils/passwords');
const SESSION_COOKIE_NAME = 'plex-donate.sid';
const TEST_ADMIN_PASSWORD = 'AdminRouterTest123!';
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

seedAdminCredentials();

const adminRouter = require('./admin');
const {
  db,
  createDonor,
  createInvite,
  listDonorsWithDetails,
} = require('../db');
const settingsStore = require('../state/settings');
const plexService = require('../services/plex');
const emailService = require('../services/email');

function resetDatabase() {
  db.exec(`
    DELETE FROM invites;
    DELETE FROM invite_links;
    DELETE FROM payments;
    DELETE FROM events;
    DELETE FROM donors;
    DELETE FROM prospects;
    DELETE FROM settings;
  `);
}

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
    const url = new URL(path, this.baseUrl);
    const requestHeaders = { ...headers };

    if (this.sessionToken) {
      url.searchParams.set('session', this.sessionToken);
      requestHeaders['x-session-token'] = this.sessionToken;
    }

    const cookieHeader = this.buildCookieHeader();
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
  app.use('/api/admin', adminRouter);
  return http.createServer(app);
}

async function startServer(t) {
  seedAdminCredentials();
  const server = createTestServer();
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return new FetchAgent(baseUrl);
}

async function loginAgent(agent) {
  const sessionResponse = await agent.get('/api/admin/session');
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.ok(sessionBody.csrfToken);

  const loginResponse = await agent.post('/api/admin/login', {
    body: {
      username: process.env.ADMIN_USERNAME,
      password: TEST_ADMIN_PASSWORD,
      _csrf: sessionBody.csrfToken,
    },
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.ok(loginBody.csrfToken);
  return loginBody.csrfToken;
}

test('GET /api/admin/subscribers annotates Plex status for donors', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  const shared = createDonor({
    email: 'shared@example.com',
    name: 'Shared Supporter',
    status: 'active',
  });
  const pending = createDonor({
    email: 'pending@example.com',
    name: 'Pending Supporter',
    status: 'active',
  });
  createInvite({
    donorId: pending.id,
    inviteId: 'INVITE-123',
    inviteUrl: 'https://plex.test/invite/123',
    inviteStatus: 'pending',
    invitedAt: new Date().toISOString(),
    sharedLibraries: JSON.stringify([{ id: '1', title: 'Movies' }]),
    recipientEmail: pending.email,
  });
  const needs = createDonor({
    email: 'needs@example.com',
    name: 'Needs Invite',
    status: 'active',
  });
  createDonor({
    email: '',
    name: 'No Email',
    status: 'active',
  });

  settingsStore.updateGroup('plex', {
    baseUrl: 'https://plex.local',
    token: 'token-abc',
    serverIdentifier: 'server-123',
    librarySectionIds: '1,2',
  });

  const originalListUsers = plexService.listUsers;
  plexService.listUsers = async () => [
    { email: shared.email, status: 'accepted', id: 'user-1' },
    { email: pending.email, status: 'pending', id: 'user-2' },
  ];
  t.after(() => {
    plexService.listUsers = originalListUsers;
  });

  const response = await agent.get('/api/admin/subscribers');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.donors));

  const sharedDonor = body.donors.find((item) => item.email === shared.email);
  assert.ok(sharedDonor);
  assert.equal(sharedDonor.plexShared, true);
  assert.equal(sharedDonor.needsPlexInvite, false);

  const pendingDonor = body.donors.find((item) => item.email === pending.email);
  assert.ok(pendingDonor);
  assert.equal(pendingDonor.plexPending, true);
  assert.equal(pendingDonor.needsPlexInvite, false);

  const needsDonor = body.donors.find((item) => item.email === needs.email);
  assert.ok(needsDonor);
  assert.equal(needsDonor.plexShared, false);
  assert.equal(needsDonor.needsPlexInvite, true);

  const noEmailDonor = body.donors.find((item) => item.name === 'No Email');
  assert.ok(noEmailDonor);
  assert.equal(noEmailDonor.needsPlexInvite, false);

  assert.ok(body.plex);
  assert.equal(body.plex.configured, true);
  assert.equal(body.plex.error, null);
});

test('POST /api/admin/subscribers/:id/invite creates a Plex invite', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);

  const donor = createDonor({
    email: 'plex-invite@example.com',
    name: 'Invite Target',
    status: 'active',
  });

  settingsStore.updateGroup('plex', {
    baseUrl: 'https://plex.local',
    token: 'token-abc',
    serverIdentifier: 'server-456',
    librarySectionIds: '3,4',
  });

  const originalCreateInvite = plexService.createInvite;
  const originalListUsers = plexService.listUsers;
  let createInvitePayload = null;
  plexService.createInvite = async (payload) => {
    createInvitePayload = payload;
    return {
      inviteId: 'plex-123',
      inviteUrl: 'https://plex.local/invite/plex-123',
      status: 'pending',
      invitedAt: new Date().toISOString(),
      sharedLibraries: [{ id: '3', title: 'TV' }],
    };
  };
  plexService.listUsers = async () => [];
  t.after(() => {
    plexService.createInvite = originalCreateInvite;
    plexService.listUsers = originalListUsers;
  });

  const response = await agent.post(`/api/admin/subscribers/${donor.id}/invite`, {
    headers: { 'x-csrf-token': csrfToken },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.invite);
  assert.equal(body.invite.plexInviteId, 'plex-123');
  assert.ok(body.invite.plexInviteUrl);
  assert.ok(body.message.includes('Plex invite'));
  assert.ok(createInvitePayload);
  assert.equal(createInvitePayload.email, donor.email);

  const donors = listDonorsWithDetails();
  const updated = donors.find((item) => item.id === donor.id);
  assert.ok(updated);
  assert.ok(Array.isArray(updated.invites));
  const latestInvite = updated.invites[0];
  assert.equal(latestInvite.plexInviteId, 'plex-123');
  assert.equal(latestInvite.plexInviteUrl, 'https://plex.local/invite/plex-123');

  assert.ok(body.donor);
  assert.equal(body.donor.needsPlexInvite, false);
  assert.equal(body.donor.plexPending, true);
});

test('POST /api/admin/settings/plex/test-invite uses Plex invite helper', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);

  settingsStore.updateGroup('plex', {
    baseUrl: 'https://plex.local',
    token: 'token-xyz',
    serverIdentifier: 'server-789',
    librarySectionIds: '5,6',
  });

  const originalCreateInvite = plexService.createInvite;
  let createInviteRequest = null;
  plexService.createInvite = async (payload) => {
    createInviteRequest = payload;
    return {
      inviteId: 'plex-test',
      inviteUrl: 'https://plex.local/invite/plex-test',
      status: 'pending',
      invitedAt: new Date().toISOString(),
      sharedLibraries: [{ id: '5', title: 'Movies' }],
    };
  };
  const originalGetSmtpConfig = emailService.getSmtpConfig;
  const originalSendInviteEmail = emailService.sendInviteEmail;
  let inviteEmailPayload = null;
  emailService.getSmtpConfig = () => ({
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    from: 'plex@example.com',
  });
  emailService.sendInviteEmail = async (payload) => {
    inviteEmailPayload = payload;
  };

  t.after(() => {
    plexService.createInvite = originalCreateInvite;
    emailService.getSmtpConfig = originalGetSmtpConfig;
    emailService.sendInviteEmail = originalSendInviteEmail;
  });

  const response = await agent.post('/api/admin/settings/plex/test-invite', {
    headers: { 'x-csrf-token': csrfToken },
    body: {
      email: 'tester@example.com',
      overrides: {
        allowSync: true,
      },
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.ok(body.message.includes('Plex'));
  assert.ok(createInviteRequest);
  assert.equal(createInviteRequest.email, 'tester@example.com');
  assert.ok(inviteEmailPayload);
  assert.equal(inviteEmailPayload.to, 'tester@example.com');
  assert.equal(inviteEmailPayload.inviteUrl, 'https://plex.local/invite/plex-test');
});
