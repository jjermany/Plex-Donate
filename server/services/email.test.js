const assert = require('node:assert/strict');
const { test } = require('node:test');
const nodemailer = require('nodemailer');

const settingsState = require('../state/settings');
const emailService = require('./email');

const SMTP_SETTINGS = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  from: 'Plex Donate <support@example.com>',
};

test('resolveDashboardUrl falls back to the origin of a reference URL when no login is provided', async (t) => {
  const originalGetAppSettings = settingsState.getAppSettings;
  settingsState.getAppSettings = () => ({ publicBaseUrl: '' });
  t.after(() => {
    settingsState.getAppSettings = originalGetAppSettings;
  });

  const fallbackUrl = 'https://demo.example.com/invite?token=abc123';
  const resolved = emailService.resolveDashboardUrl({ fallbackUrls: [fallbackUrl] });

  assert.equal(resolved, 'https://demo.example.com/dashboard');
});

test('resolveDashboardUrl builds a dashboard link from publicBaseUrl', async (t) => {
  const originalGetAppSettings = settingsState.getAppSettings;
  settingsState.getAppSettings = () => ({ publicBaseUrl: 'https://dash.example.com/app' });
  t.after(() => {
    settingsState.getAppSettings = originalGetAppSettings;
  });

  const resolved = emailService.resolveDashboardUrl();

  assert.equal(resolved, 'https://dash.example.com/dashboard');
});

test('resolveAdminDashboardUrl returns the root URL from publicBaseUrl', async (t) => {
  const originalGetAppSettings = settingsState.getAppSettings;
  settingsState.getAppSettings = () => ({ publicBaseUrl: 'https://dash.example.com/app' });
  t.after(() => {
    settingsState.getAppSettings = originalGetAppSettings;
  });

  const resolved = emailService.resolveAdminDashboardUrl();

  assert.equal(resolved, 'https://dash.example.com');
});

test('sendInviteEmail includes the dashboard button and text link', async (t) => {
  const messages = [];
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      messages.push(payload);
    },
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const originalGetAppSettings = settingsState.getAppSettings;
  settingsState.getAppSettings = () => ({ publicBaseUrl: 'https://plex.example.com' });
  t.after(() => {
    settingsState.getAppSettings = originalGetAppSettings;
  });

  await emailService.sendInviteEmail(
    {
      to: 'user@example.com',
      inviteUrl: 'https://plex.example.com/invite/abc',
      name: 'Demo User',
      subscriptionId: 'sub_123',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.ok(message);
  assert.match(message.html, /Open Dashboard/);
  assert.match(message.html, /https:\/\/plex\.example\.com\/dashboard/);
  assert.match(message.text, /Open Dashboard: https:\/\/plex\.example\.com\/dashboard/);
});

test('sendSupportRequestNotification renders dashboard access details', async (t) => {
  const messages = [];
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      messages.push(payload);
    },
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const originalGetAppSettings = settingsState.getAppSettings;
  settingsState.getAppSettings = () => ({ publicBaseUrl: 'https://dash.example.com/app' });
  t.after(() => {
    settingsState.getAppSettings = originalGetAppSettings;
  });

  await emailService.sendSupportRequestNotification(
    {
      request: {
        id: 42,
        subject: 'Access issue',
        donorDisplayName: 'Sam Supporter',
      },
      message: {
        body: 'I cannot reach the dashboard right now.',
      },
      donor: { name: 'Sam Supporter' },
      adminEmail: 'admin@example.com',
      type: 'new',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.ok(message);
  assert.match(message.html, /Open Dashboard/);
  assert.match(message.html, /https:\/\/dash\.example\.com\/dashboard/);
  assert.match(message.text, /Open Dashboard: https:\/\/dash\.example\.com\/dashboard/);
});
