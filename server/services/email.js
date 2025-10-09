const nodemailer = require('nodemailer');
const { getSmtpSettings } = require('../state/settings');

function formatAccessEndDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toUTCString();
}

function getSmtpConfig(overrideSettings) {
  const settings = overrideSettings || getSmtpSettings();
  if (!settings.host) {
    throw new Error('SMTP configuration is missing');
  }
  if (!settings.from) {
    throw new Error('SMTP_FROM is required to send emails');
  }
  return settings;
}

function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: Boolean(smtp.secure),
    auth:
      smtp.user && smtp.pass
        ? {
            user: smtp.user,
            pass: smtp.pass,
          }
        : undefined,
  });
}

async function sendInviteEmail(
  { to, inviteUrl, name, subscriptionId },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  const subject = 'Your Plex access invite';

  const text = `Hi ${name || 'there'},\n\nThank you for supporting our Plex server!\n\nUse your personal share link to accept the Plex invite: ${inviteUrl}\n\nSubscription ID: ${subscriptionId}\n\nIf you did not request this invite or need help, reply to this email.\n\n— Plex Donate`;

  const html = `
  <p>Hi ${name || 'there'},</p>
  <p>Thank you for supporting our Plex server! Use the button below to accept your Plex invite.</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${inviteUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Accept Invite</a>
  </p>
  <p style="font-size:14px;color:#4b5563;">Subscription ID: ${subscriptionId}</p>
  <p>If you need help, just reply to this email.</p>
  <p style="margin-top:24px;">— Plex Donate</p>
  `;

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    html,
  });
}

async function sendAccountWelcomeEmail(
  { to, name, loginUrl },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  if (!loginUrl) {
    throw new Error('loginUrl is required to send welcome email');
  }

  const recipientName = name || 'there';
  const subject = 'Welcome to your Plex dashboard';
  const text = `Hi ${recipientName},\n\nYour Plex Donate dashboard account is ready. Use the link below to sign in and confirm your email address:\n\n${loginUrl}\n\nIf you did not request this email or need help, reply to this message.\n\n— Plex Donate`;

  const html = `
  <p>Hi ${recipientName},</p>
  <p>Your Plex Donate dashboard account is ready. Use the button below to sign in and confirm your email address.</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${loginUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Open Dashboard</a>
  </p>
  <p>If you need help or did not request this email, just reply to this message.</p>
  <p style="margin-top:24px;">— Plex Donate</p>
  `;

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    html,
  });
}

async function sendCancellationEmail(
  { to, name, subscriptionId, paidThrough },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);

  const displayDate = formatAccessEndDate(paidThrough);
  const subject = 'Your Plex access is scheduled to end';

  const accessText = displayDate
    ? `Your Plex access will remain active until ${displayDate}.`
    : 'Your Plex access has now ended.';

  const text = `Hi ${name || 'there'},\n\nThank you for supporting our Plex server. ${accessText}\n\nIf you'd like to come back, you can restart your support anytime by visiting the donation portal and starting a new subscription with the same email address.\n\nSubscription ID: ${subscriptionId}\n\nIf you have any questions, just reply to this email.\n\n— Plex Donate`;

  const htmlAccessText = displayDate
    ? `Your Plex access will remain active until <strong>${displayDate}</strong>.`
    : 'Your Plex access has now ended.';

  const html = `
  <p>Hi ${name || 'there'},</p>
  <p>Thank you for supporting our Plex server.</p>
  <p>${htmlAccessText}</p>
  <p>If you'd like to come back, you can restart your support anytime by visiting the donation portal and starting a new subscription with the same email address.</p>
  <p style="font-size:14px;color:#4b5563;">Subscription ID: ${subscriptionId}</p>
  <p>If you have any questions, just reply to this email.</p>
  <p style="margin-top:24px;">— Plex Donate</p>
  `;

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    html,
  });
}

async function verifyConnection(overrideSettings) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  await mailer.verify();
  return {
    message: 'SMTP connection verified successfully.',
  };
}

module.exports = {
  sendInviteEmail,
  sendAccountWelcomeEmail,
  sendCancellationEmail,
  getSmtpConfig,
  verifyConnection,
};
