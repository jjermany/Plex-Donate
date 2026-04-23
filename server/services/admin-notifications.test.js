const assert = require('node:assert/strict');
const { test } = require('node:test');

const settingsStore = require('../state/settings');
const emailService = require('./email');
const adminNotifications = require('./admin-notifications');

function captureAdminNotifications(t) {
  const messages = [];
  const originalGetNotificationSettings = settingsStore.getNotificationSettings;
  const originalSendAdminNotificationEmail = emailService.sendAdminNotificationEmail;
  const originalResolveAdminDashboardUrl = emailService.resolveAdminDashboardUrl;

  settingsStore.getNotificationSettings = () => ({
    adminEmail: 'admin@example.com',
    onDonorCreated: true,
    onTrialStarted: true,
    onSubscriptionStarted: true,
    onPlexRevoked: true,
  });
  emailService.sendAdminNotificationEmail = async (payload) => {
    messages.push(payload);
  };
  emailService.resolveAdminDashboardUrl = () => 'https://plex.example.com';

  t.after(() => {
    settingsStore.getNotificationSettings = originalGetNotificationSettings;
    emailService.sendAdminNotificationEmail = originalSendAdminNotificationEmail;
    emailService.resolveAdminDashboardUrl = originalResolveAdminDashboardUrl;
  });

  return messages;
}

function getFactLabels(message) {
  return message.facts.map((fact) => fact.label);
}

test('notifyDonorCreated omits duplicate Email fact when donor label includes email', { concurrency: false }, async (t) => {
  const messages = captureAdminNotifications(t);

  await adminNotifications.notifyDonorCreated({
    donor: {
      id: 10,
      name: 'Sam Supporter',
      email: 'sam@example.com',
      subscriptionId: 'SUB-10',
    },
    source: 'Share link',
    shareLinkId: 5,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'admin@example.com');
  assert.deepEqual(getFactLabels(messages[0]), [
    'Donor',
    'Source',
    'Subscription ID',
    'Share link ID',
    'Prospect ID',
  ]);
  assert.equal(messages[0].facts[0].value, 'Sam Supporter (sam@example.com)');
});

test('notifySubscriptionStarted omits duplicate Email fact when donor label is the email', { concurrency: false }, async (t) => {
  const messages = captureAdminNotifications(t);

  await adminNotifications.notifySubscriptionStarted({
    donor: {
      id: 11,
      email: 'email-only@example.com',
      subscriptionId: 'SUB-11',
    },
    amount: '10.00',
    currency: 'USD',
    paidAt: '2024-02-02T10:00:00Z',
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(getFactLabels(messages[0]), [
    'Donor',
    'Subscription ID',
    'Payment',
    'Payment at',
    'Source',
  ]);
  assert.equal(messages[0].facts[0].value, 'email-only@example.com');
});

