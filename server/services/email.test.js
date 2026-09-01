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

test('verifyConnection delegates to the underlying SMTP transport', async (t) => {
  let verifyCalls = 0;
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    verify: async () => {
      verifyCalls += 1;
    },
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const result = await emailService.verifyConnection(SMTP_SETTINGS);

  assert.equal(verifyCalls, 1);
  assert.equal(result.message, 'SMTP connection verified successfully.');
});

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

test('sendImportedPlexUserSetupEmail clearly explains free courtesy access and dashboard benefits', async (t) => {
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

  await emailService.sendImportedPlexUserSetupEmail(
    {
      to: 'existing@example.com',
      setupUrl: 'https://plex.example.com/share/setup-token',
      name: 'Existing User',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(
    message.subject,
    'You’re in! Your complimentary Member Hub is ready 🎉'
  );
  assert.match(message.html, /Complimentary Member/);
  assert.match(message.html, /Open My Member Hub/);
  assert.match(message.text, /No subscription, payment, or donation is required/);
  assert.match(message.text, /server resources, guides, useful links, and announcements/);
  assert.match(message.text, /Send support requests.*follow every reply/);
  assert.match(message.text, /Invite friends when you want to share the experience/);
  assert.match(message.text, /server outage, recovery, and shutdown alerts/);
  assert.match(message.text, /https:\/\/plex\.example\.com\/share\/setup-token/);
  assert.match(message.text, /Setup only takes a moment/);
  assert.doesNotMatch(message.html, /Open Dashboard/);
});

test('sendSetupLinkEmail sends a personal setup invitation without subscription framing', async (t) => {
  const messages = [];
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => messages.push(payload),
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  await emailService.sendSetupLinkEmail(
    {
      to: 'invitee@example.com',
      setupUrl: 'https://plex.example.com/share/personal-token',
      name: 'Invited User',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'invitee@example.com');
  assert.match(messages[0].subject, /invited/i);
  assert.match(messages[0].text, /Set up your account: https:\/\/plex\.example\.com\/share\/personal-token/);
  assert.doesNotMatch(messages[0].text, /subscription ID/i);
});

test('sendSetupLinkEmail presents courtesy accounts as complimentary and payment-free', async (t) => {
  const messages = [];
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => messages.push(payload),
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  await emailService.sendSetupLinkEmail(
    {
      to: 'complimentary@example.com',
      setupUrl: 'https://plex.example.com/share/courtesy-token',
      courtesyAccess: true,
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /complimentary/i);
  assert.match(messages[0].subject, /🎉/);
  assert.match(messages[0].text, /No subscription, payment, or donation is required/);
  assert.match(messages[0].text, /server resources, guides, useful links, and announcements/);
  assert.match(messages[0].text, /Send support requests and follow replies/);
  assert.match(messages[0].text, /Invite friends when you want to share the experience/);
  assert.match(messages[0].html, /Complimentary Member/);
  assert.match(messages[0].html, /Your Member Hub superpowers/);
  assert.match(messages[0].html, /Open My Member Hub/);
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
  assert.equal(message.subject, 'Thank you for supporting Member Hub');
  assert.match(message.text, /Thank you for your subscription!/);
  assert.match(message.text, /Payment received: 12\.00 USD/);
  assert.match(message.text, /Paid at: Fri, 02 Feb 2024 10:00:00 GMT/);
  assert.match(message.text, /Subscription ID: SUB-THANKS/);
  assert.match(message.text, /Open Dashboard: https:\/\/plex\.example\.com\/dashboard/);
  assert.match(message.html, /Thank you for your subscription!/);
  assert.match(message.html, /Payment received:/);
});

test('email delivery applies configured branding to sender, subject, header, and sign-off', async (t) => {
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
  settingsState.getAppSettings = () => ({
    brandName: 'Jalon Media Club',
    emailSenderName: 'Jalon Media Team',
    emailSignoff: 'The Jalon Media Team',
    publicBaseUrl: 'https://media.example.com',
  });
  t.after(() => {
    settingsState.getAppSettings = originalGetAppSettings;
  });

  await emailService.sendSubscriptionThankYouEmail(
    {
      to: 'supporter@example.com',
      name: 'Community Member',
      subscriptionId: 'SUB-BRANDING',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.from, 'Jalon Media Team <support@example.com>');
  assert.equal(message.subject, 'Thank you for supporting Jalon Media Club');
  assert.match(message.html, />Jalon Media Club<\/p>/);
  assert.match(message.html, /&mdash; The Jalon Media Team/);
  assert.match(message.text, /-- The Jalon Media Team/);
  assert.doesNotMatch(message.html, /\{\{BRAND_NAME\}\}|\{\{EMAIL_SIGNOFF\}\}/);
  assert.doesNotMatch(message.text, /\{\{BRAND_NAME\}\}|\{\{EMAIL_SIGNOFF\}\}/);
});

test('sendTrialEndedEmail tells the donor how to restore access', async (t) => {
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

  await emailService.sendTrialEndedEmail(
    {
      to: 'trial-user@example.com',
      name: 'Trial User',
      accessEndedAt: '2026-05-29T18:00:00Z',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.subject, 'Your Plex trial has ended');
  assert.match(message.text, /Your Plex trial access ended around Fri, 29 May 2026 18:00:00 GMT/);
  assert.match(message.text, /Start a subscription from your dashboard to restore access/);
  assert.match(message.text, /Open Dashboard: https:\/\/plex\.example\.com\/dashboard/);
  assert.match(message.html, /Trial Ended/);
});

test('sendTrialExtendedEmail includes new expiration and invite link', async (t) => {
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

  await emailService.sendTrialExtendedEmail(
    {
      to: 'trial-user@example.com',
      name: 'Trial User',
      accessExpiresAt: '2026-06-12T18:00:00Z',
      extensionDays: 7,
      inviteUrl: 'https://plex.example.com/invite/extended',
    },
    SMTP_SETTINGS
  );

  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.subject, 'Your Plex trial was extended');
  assert.match(message.text, /Your Plex trial has been extended by 7 days/);
  assert.match(message.text, /Fri, 12 Jun 2026 18:00:00 GMT/);
  assert.match(message.text, /Use this Plex invite link to restore access: https:\/\/plex\.example\.com\/invite\/extended/);
  assert.match(message.text, /Open Dashboard: https:\/\/plex\.example\.com\/dashboard/);
  assert.match(message.html, /Trial Extended/);
  assert.match(message.html, /Accept Plex Invite/);
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
