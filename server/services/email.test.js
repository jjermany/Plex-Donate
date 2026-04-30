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

test('sendSubscriptionThankYouEmail includes payment and subscription details', async (t) => {
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

  await emailService.sendSubscriptionThankYouEmail(
    {
      to: 'supporter@example.com',
      name: 'Plex Supporter',
      subscriptionId: 'SUB-THANKS',
      amount: '12.00',
      currency: 'USD',
      paidAt: '2024-02-02T10:00:00Z',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.ok(message);
  assert.equal(message.subject, 'Thank you for supporting Plex Donate');
  assert.match(message.text, /Thank you for your subscription!/);
  assert.match(message.text, /Payment received: 12\.00 USD/);
  assert.match(message.text, /Paid at: Fri, 02 Feb 2024 10:00:00 GMT/);
  assert.match(message.text, /Subscription ID: SUB-THANKS/);
  assert.match(message.text, /Open Dashboard: https:\/\/plex\.example\.com\/dashboard/);
  assert.match(message.html, /Thank you for your subscription!/);
  assert.match(message.html, /Payment received:/);
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

test('sendUpsStatusEmail renders outage details with battery metadata', async (t) => {
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

  await emailService.sendUpsStatusEmail(
    {
      to: 'user@example.com',
      name: 'Outage User',
      event: 'power_outage',
      upsName: 'apc-ups',
      batteryChargePercent: 82,
      runtimeSeconds: 2400,
      occurredAt: '2026-03-17T15:30:00Z',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.subject, 'Plex server power outage detected');
  assert.match(message.text, /running on UPS battery power/i);
  assert.match(message.text, /Battery charge: 82%/);
  assert.match(message.text, /Estimated runtime remaining: 40 minutes/);
  assert.match(message.text, /Reported at: Tue, 17 Mar 2026 15:30:00 GMT/);
  assert.match(message.html, /apc-ups/);
  assert.match(message.html, /82%/);
});

test('sendUpsStatusEmail renders restore copy', async (t) => {
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

  await emailService.sendUpsStatusEmail(
    {
      to: 'user@example.com',
      name: 'Restore User',
      event: 'power_restored',
      upsName: 'apc-ups',
      batteryChargePercent: 82,
      runtimeSeconds: 1326,
      occurredAt: '2026-03-17T16:00:00Z',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.subject, 'Plex server power has been restored');
  assert.match(message.text, /power has been restored/i);
  assert.match(message.text, /service should be available again/i);
  assert.match(message.text, /Battery charge: 82%/);
  assert.doesNotMatch(message.text, /Estimated runtime remaining/i);
  assert.doesNotMatch(message.html, /22 minutes/i);
  assert.match(message.html, /Thank you for your patience\./);
});

test('sendUpsStatusEmail renders shutdown imminent copy', async (t) => {
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

  await emailService.sendUpsStatusEmail(
    {
      to: 'user@example.com',
      name: 'Shutdown User',
      event: 'shutdown_imminent',
      upsName: 'apc-ups',
      batteryChargePercent: 12,
      runtimeSeconds: 180,
      occurredAt: '2026-03-17T16:05:00Z',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.subject, 'Plex server shutdown is imminent');
  assert.match(message.text, /expected to shut down soon/i);
  assert.match(message.text, /Battery charge: 12%/);
  assert.match(message.text, /Estimated runtime remaining: 3 minutes/);
  assert.match(message.text, /go offline shortly/i);
});
