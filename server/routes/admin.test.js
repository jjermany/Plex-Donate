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
const nodemailer = require('nodemailer');
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
  getRecentEvents,
  createSupportRequest,
  addSupportMessageToRequest,
} = require('../db');
const settingsStore = require('../state/settings');
const plexService = require('../services/plex');

function resetDatabase() {
  db.exec(`
    DELETE FROM invites;
    DELETE FROM invite_links;
    DELETE FROM payments;
    DELETE FROM events;
    DELETE FROM donors;
    DELETE FROM prospects;
    DELETE FROM settings;
    DELETE FROM support_messages;
    DELETE FROM support_requests;
  `);
}

function parseLibrarySectionIds(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }

  if (!value && value !== 0) {
    return [];
  }

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildExpectedInviteRequest(payload, plexConfig) {
  const sections = parseLibrarySectionIds(
    Object.prototype.hasOwnProperty.call(payload, 'librarySectionIds')
      ? payload.librarySectionIds
      : plexConfig.librarySectionIds
  );

  const request = {
    server_id: plexConfig.serverIdentifier,
    shared_server: {
      library_section_ids: sections,
      invited_email: payload.email,
    },
    sharing_settings: {
      allow_sync: plexConfig.allowSync ? '1' : '0',
      allow_camera_upload: plexConfig.allowCameraUpload ? '1' : '0',
      allow_channels: plexConfig.allowChannels ? '1' : '0',
    },
  };

  if (payload.friendlyName) {
    request.shared_server.friendly_name = payload.friendlyName;
  }

  return request;
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

test('GET /api/admin/subscribers keeps Plex invite disabled for pending donors', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  const pendingDonor = createDonor({
    email: 'pending-status@example.com',
    name: 'Pending Status',
    status: 'pending',
  });

  settingsStore.updateGroup('plex', {
    baseUrl: 'https://plex.local',
    token: 'token-xyz',
    serverIdentifier: 'server-456',
    librarySectionIds: '5,6',
  });

  const originalListUsers = plexService.listUsers;
  plexService.listUsers = async () => [];
  t.after(() => {
    plexService.listUsers = originalListUsers;
  });

  const response = await agent.get('/api/admin/subscribers');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.donors));

  const donor = body.donors.find((item) => item.id === pendingDonor.id);
  assert.ok(donor);
  assert.equal(donor.status, 'pending');
  assert.equal(donor.plexShared, false);
  assert.equal(donor.plexPending, false);
  assert.equal(donor.needsPlexInvite, false);
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
  let createInviteRequest = null;
  plexService.createInvite = async (payload) => {
    const plexConfig = settingsStore.getPlexSettings();
    createInviteRequest = buildExpectedInviteRequest(payload, plexConfig);
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
  assert.ok(body.invite.inviteUrl);
  assert.ok(body.message.includes('Plex invite'));
  assert.ok(createInviteRequest);
  assert.equal(createInviteRequest.server_id, 'server-456');
  assert.deepEqual(createInviteRequest.shared_server, {
    library_section_ids: ['3', '4'],
    invited_email: donor.email,
    friendly_name: donor.name,
  });
  assert.deepEqual(createInviteRequest.sharing_settings, {
    allow_sync: '0',
    allow_camera_upload: '0',
    allow_channels: '0',
  });

  const donors = listDonorsWithDetails();
  const updated = donors.find((item) => item.id === donor.id);
  assert.ok(updated);
  assert.ok(Array.isArray(updated.invites));
  const latestInvite = updated.invites[0];
  assert.equal(latestInvite.plexInviteId, 'plex-123');
  assert.equal(latestInvite.inviteUrl, 'https://plex.local/invite/plex-123');

  assert.ok(body.donor);
  assert.equal(body.donor.needsPlexInvite, false);
  assert.equal(body.donor.plexPending, true);
});

test('announcements settings round-trip through admin API', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  let response = await agent.get('/api/admin/settings');
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.ok(body.csrfToken);
  assert.ok(body.settings);
  assert.ok(body.settings.announcements);
  assert.deepEqual(body.settings.announcements, {
    bannerEnabled: false,
    bannerTitle: '',
    bannerBody: '',
    bannerTone: 'info',
    bannerDismissible: true,
    bannerCtaEnabled: false,
    bannerCtaLabel: '',
    bannerCtaUrl: '',
    bannerCtaOpenInNewTab: true,
  });

  const updatePayload = {
    bannerEnabled: true,
    bannerTitle: 'Scheduled maintenance',
    bannerBody: 'Streaming access pauses tonight at 10:00 PM.',
    bannerTone: 'warning',
    bannerDismissible: false,
    bannerCtaEnabled: true,
    bannerCtaLabel: 'View status page',
    bannerCtaUrl: 'https://status.example.com',
    bannerCtaOpenInNewTab: false,
  };

  response = await agent.request('/api/admin/settings/announcements', {
    method: 'PUT',
    headers: { 'x-csrf-token': csrfToken },
    body: updatePayload,
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.ok(body.csrfToken);
  assert.ok(body.settings);
  assert.equal(body.settings.bannerEnabled, true);
  assert.equal(body.settings.bannerTitle, updatePayload.bannerTitle);
  assert.equal(body.settings.bannerBody, updatePayload.bannerBody);
  assert.equal(body.settings.bannerTone, 'warning');
  assert.equal(body.settings.bannerDismissible, false);
  assert.equal(body.settings.bannerCtaEnabled, true);
  assert.equal(body.settings.bannerCtaLabel, updatePayload.bannerCtaLabel);
  assert.equal(body.settings.bannerCtaUrl, updatePayload.bannerCtaUrl);
  assert.equal(body.settings.bannerCtaOpenInNewTab, false);

  response = await agent.get('/api/admin/settings');
  assert.equal(response.status, 200);
  body = await response.json();
  assert.ok(body.settings);
  assert.equal(body.settings.announcements.bannerEnabled, true);
  assert.equal(body.settings.announcements.bannerTitle, updatePayload.bannerTitle);
  assert.equal(body.settings.announcements.bannerBody, updatePayload.bannerBody);
  assert.equal(body.settings.announcements.bannerTone, 'warning');
  assert.equal(body.settings.announcements.bannerDismissible, false);
  assert.equal(body.settings.announcements.bannerCtaEnabled, true);
  assert.equal(
    body.settings.announcements.bannerCtaOpenInNewTab,
    updatePayload.bannerCtaOpenInNewTab
  );
  assert.equal(
    body.settings.announcements.bannerCtaUrl,
    updatePayload.bannerCtaUrl
  );
});

test('POST /api/admin/announcements/email sends announcement email to donors', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  const donorOne = createDonor({
    email: 'supporter.one@example.com',
    name: 'Supporter One',
    status: 'active',
  });
  const donorTwo = createDonor({
    email: 'supporter.two@example.com',
    name: 'Supporter Two',
    status: 'active',
  });
  createDonor({
    email: '',
    name: 'Missing Email',
    status: 'active',
  });

  settingsStore.updateGroup('announcements', {
    bannerEnabled: true,
    bannerTitle: 'Scheduled maintenance',
    bannerBody: 'Streaming access pauses tonight at 10:00 PM.\nThanks for your support!',
    bannerTone: 'warning',
    bannerCtaEnabled: true,
    bannerCtaLabel: 'View status page',
    bannerCtaUrl: 'https://status.example.com',
  });

  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
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

  const response = await agent.request('/api/admin/announcements/email', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.csrfToken);
  assert.equal(body.success, true);
  assert.equal(body.sent, 2);
  assert.equal(body.skipped, 1);

  assert.equal(sentMessages.length, 2);
  const recipients = sentMessages.map((mail) => mail.to).sort();
  assert.deepEqual(recipients, [donorOne.email, donorTwo.email].sort());

  const sampleMessage = sentMessages[0];
  assert.equal(sampleMessage.subject, 'Scheduled maintenance');
  assert.ok(sampleMessage.html.includes('Scheduled maintenance'));
  assert.ok(sampleMessage.html.includes('Streaming access pauses tonight'));
  assert.ok(sampleMessage.html.includes('https://status.example.com'));
  assert.ok(sampleMessage.text.includes('Streaming access pauses tonight'));

  const events = getRecentEvents(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'announcement.email.sent');
  const payload = JSON.parse(events[0].payload);
  assert.equal(payload.recipientCount, 2);
  assert.equal(payload.skippedCount, 1);
  assert.equal(payload.subject, 'Scheduled maintenance');
});

test('POST /api/admin/announcements/email uses request payload when provided', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  const donorOne = createDonor({
    email: 'supporter.one@example.com',
    name: 'Supporter One',
    status: 'active',
  });
  const donorTwo = createDonor({
    email: 'supporter.two@example.com',
    name: 'Supporter Two',
    status: 'active',
  });

  settingsStore.updateGroup('announcements', {
    bannerTitle: 'Saved announcement',
    bannerBody: 'Persisted announcement body.',
    bannerCtaEnabled: true,
    bannerCtaLabel: 'View saved',
    bannerCtaUrl: 'https://example.com/saved',
  });

  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
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

  const response = await agent.request('/api/admin/announcements/email', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    body: {
      bannerTitle: 'Updated announcement',
      bannerBody: 'New details will be sent immediately.',
      bannerTone: 'warning',
      bannerCtaEnabled: true,
      bannerCtaLabel: 'Read more',
      bannerCtaUrl: 'https://status.example.com/new',
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.csrfToken);
  assert.equal(body.success, true);
  assert.equal(body.sent, 2);
  assert.equal(body.skipped, 0);

  assert.equal(sentMessages.length, 2);
  const recipients = sentMessages.map((mail) => mail.to).sort();
  assert.deepEqual(recipients, [donorOne.email, donorTwo.email].sort());

  const sampleMessage = sentMessages[0];
  assert.equal(sampleMessage.subject, 'Updated announcement');
  assert.ok(sampleMessage.html.includes('New details will be sent immediately.'));
  assert.ok(sampleMessage.html.includes('Read more'));
  assert.ok(sampleMessage.html.includes('https://status.example.com/new'));

  const events = getRecentEvents(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'announcement.email.sent');
  const payload = JSON.parse(events[0].payload);
  assert.equal(payload.recipientCount, 2);
  assert.equal(payload.skippedCount, 0);
  assert.equal(payload.subject, 'Updated announcement');
});

test('POST /api/admin/announcements/email fails without SMTP configuration', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  createDonor({
    email: 'recipient@example.com',
    name: 'Recipient',
    status: 'active',
  });

  settingsStore.updateGroup('announcements', {
    bannerTitle: 'System update',
    bannerBody: 'We are upgrading our servers tonight.',
  });

  let createTransportCalls = 0;
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => {
    createTransportCalls += 1;
    return {
      sendMail: async () => {},
    };
  };
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const response = await agent.request('/api/admin/announcements/email', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.ok(body.csrfToken);
  assert.ok(/smtp/i.test(body.error));
  assert.equal(createTransportCalls, 0);
});

test('POST /api/admin/announcements/email validates announcement content', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  createDonor({
    email: 'recipient@example.com',
    name: 'Recipient',
    status: 'active',
  });

  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
  });

  let createTransportCalls = 0;
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => {
    createTransportCalls += 1;
    return {
      sendMail: async () => {},
    };
  };
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const response = await agent.request('/api/admin/announcements/email', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.ok(body.csrfToken);
  assert.equal(
    body.error,
    'Announcement title and body are required to send an email.'
  );
  assert.equal(createTransportCalls, 0);
});


test('admin support endpoints list, reply, resolve, and delete requests', async (t) => {
  resetDatabase();
  const agent = await startServer(t);
  const csrfToken = await loginAgent(agent);
  assert.ok(csrfToken);

  settingsStore.updateGroup('smtp', {
    host: 'smtp.test',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
  });

  const donor = createDonor({
    email: 'admin-support@example.com',
    name: 'Admin Support Donor',
    status: 'active',
  });

  const thread = createSupportRequest({
    donorId: donor.id,
    subject: 'Playback issue',
    message: 'Streaming stops after a few minutes.',
    donorDisplayName: 'Admin Support Donor',
    authorName: 'Admin Support Donor',
  });

  addSupportMessageToRequest({
    requestId: thread.request.id,
    donorId: donor.id,
    authorRole: 'donor',
    authorName: 'Admin Support Donor',
    message: 'It happened twice today.',
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

  const listResponse = await agent.get('/api/admin/support');
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.ok(Array.isArray(listBody.threads));
  assert.equal(listBody.threads.length, 1);
  assert.equal(listBody.threads[0].request.donorId, donor.id);
  assert.equal(listBody.threads[0].request.subject, 'Playback issue');

  const replyResponse = await agent.post(
    `/api/admin/support/${thread.request.id}/replies`,
    {
      headers: { 'x-csrf-token': csrfToken },
      body: { message: 'We adjusted the transcoder settings.' },
    }
  );
  assert.equal(replyResponse.status, 201);
  const replyBody = await replyResponse.json();
  assert.equal(replyBody.thread.messages.length, 3);
  assert.equal(replyBody.thread.messages[2].authorRole, 'admin');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, donor.email);
  assert.ok(sentMessages[0].subject.includes('Playback issue'));

  const resolveResponse = await agent.post(
    `/api/admin/support/${thread.request.id}/resolve`,
    {
      headers: { 'x-csrf-token': csrfToken },
      body: { resolved: true },
    }
  );
  assert.equal(resolveResponse.status, 200);
  const resolveBody = await resolveResponse.json();
  assert.equal(resolveBody.thread.request.resolved, true);
  assert.equal(resolveBody.thread.request.status, 'resolved');

  const deleteResponse = await agent.request(
    `/api/admin/support/${thread.request.id}`,
    {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrfToken },
    }
  );
  assert.equal(deleteResponse.status, 204);

  const afterDeleteList = await agent.get('/api/admin/support');
  assert.equal(afterDeleteList.status, 200);
  const afterDeleteBody = await afterDeleteList.json();
  assert.equal(afterDeleteBody.threads.length, 0);
});
