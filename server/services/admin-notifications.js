const settingsStore = require('../state/settings');
const emailService = require('./email');
const logger = require('../utils/logger');

function resolveRecipientEmail(settings) {
  const explicit = settings && settings.adminEmail
    ? String(settings.adminEmail).trim()
    : '';
  if (explicit) {
    return explicit;
  }

  try {
    const smtp = emailService.getSmtpConfig();
    const fallback = smtp.supportNotificationEmail || smtp.from || '';
    return fallback ? String(fallback).trim() : '';
  } catch (err) {
    return '';
  }
}

function shouldNotify(key) {
  try {
    const notifications = settingsStore.getNotificationSettings();
    return Boolean(notifications && notifications[key]);
  } catch (err) {
    return false;
  }
}

function formatDonorLabel(donor) {
  if (!donor) {
    return 'Unknown donor';
  }
  const name = donor.name && donor.name.trim();
  const email = donor.email && donor.email.trim();
  if (name && email) {
    return `${name} (${email})`;
  }
  return name || email || `Donor #${donor.id || 'unknown'}`;
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toUTCString();
}

async function sendNotification({
  enabledKey,
  subject,
  heading,
  intro,
  facts = [],
  dashboardUrl,
}) {
  if (!shouldNotify(enabledKey)) {
    return;
  }

  let notifications;
  try {
    notifications = settingsStore.getNotificationSettings();
  } catch (err) {
    notifications = null;
  }

  const recipient = resolveRecipientEmail(notifications);
  if (!recipient) {
    logger.warn('Admin notification skipped: no recipient configured');
    return;
  }

  try {
    await emailService.sendAdminNotificationEmail({
      to: recipient,
      subject,
      heading,
      intro,
      facts,
      dashboardUrl,
    });
  } catch (err) {
    logger.warn('Failed to send admin notification email', {
      subject,
      error: err && err.message,
    });
  }
}

async function notifyDonorCreated({ donor, source, shareLinkId, prospectId }) {
  const donorLabel = formatDonorLabel(donor);
  await sendNotification({
    enabledKey: 'onDonorCreated',
    subject: `[Admin] New donor account: ${donorLabel}`,
    heading: 'New donor account created',
    intro: `${donorLabel} just created a Plex Donate dashboard account.`,
    facts: [
      { label: 'Donor', value: donorLabel },
      { label: 'Email', value: donor && donor.email },
      { label: 'Source', value: source || 'Share link' },
      { label: 'Subscription ID', value: donor && donor.subscriptionId },
      { label: 'Share link ID', value: shareLinkId },
      { label: 'Prospect ID', value: prospectId },
    ],
    dashboardUrl: emailService.resolveDashboardUrl({ fallbackUrls: [] }),
  });
}

async function notifyTrialStarted({ donor, route, accessExpiresAt }) {
  const donorLabel = formatDonorLabel(donor);
  await sendNotification({
    enabledKey: 'onTrialStarted',
    subject: `[Admin] Trial started: ${donorLabel}`,
    heading: 'Trial access started',
    intro: `${donorLabel} started a Plex trial.`,
    facts: [
      { label: 'Donor', value: donorLabel },
      { label: 'Email', value: donor && donor.email },
      { label: 'Route', value: route || 'share' },
      { label: 'Trial ends', value: formatTimestamp(accessExpiresAt) },
    ],
    dashboardUrl: emailService.resolveDashboardUrl({ fallbackUrls: [] }),
  });
}

async function notifySubscriptionStarted({
  donor,
  subscriptionId,
  amount,
  currency,
  paidAt,
  source,
}) {
  const donorLabel = formatDonorLabel(donor);
  await sendNotification({
    enabledKey: 'onSubscriptionStarted',
    subject: `[Admin] Subscription started: ${donorLabel}`,
    heading: 'Subscription activated',
    intro: `${donorLabel} is now an active subscriber.`,
    facts: [
      { label: 'Donor', value: donorLabel },
      { label: 'Email', value: donor && donor.email },
      { label: 'Subscription ID', value: subscriptionId || (donor && donor.subscriptionId) },
      { label: 'Payment', value: amount ? `${amount} ${currency || ''}`.trim() : null },
      { label: 'Payment at', value: formatTimestamp(paidAt) },
      { label: 'Source', value: source || 'PayPal webhook' },
    ],
    dashboardUrl: emailService.resolveDashboardUrl({ fallbackUrls: [] }),
  });
}

async function notifyPlexRevoked({ donor, reason, context }) {
  if (context === 'admin-dashboard') {
    return;
  }
  const donorLabel = formatDonorLabel(donor);
  const donorEmail = donor && donor.email;
  const includesEmail = donorEmail && donorLabel.includes(donorEmail);
  await sendNotification({
    enabledKey: 'onPlexRevoked',
    subject: `[Admin] Plex access revoked: ${donorLabel}`,
    heading: 'Plex access revoked',
    intro: `${donorLabel} no longer has Plex access.`,
    facts: [
      { label: 'Donor', value: donorLabel },
      ...(includesEmail ? [] : [{ label: 'Email', value: donorEmail }]),
      { label: 'Reason', value: reason || 'revoked' },
      { label: 'Context', value: context || 'system' },
      { label: 'Plex Account ID', value: donor && donor.plexAccountId },
    ],
    dashboardUrl: emailService.resolveDashboardUrl({ fallbackUrls: [] }),
  });
}

module.exports = {
  notifyDonorCreated,
  notifyTrialStarted,
  notifySubscriptionStarted,
  notifyPlexRevoked,
};
