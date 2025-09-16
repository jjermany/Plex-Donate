const nodemailer = require('nodemailer');
const { getSmtpSettings } = require('../state/settings');

function getSmtpConfig() {
  const settings = getSmtpSettings();
  if (!settings.host) {
    throw new Error('SMTP configuration is missing');
  }
  if (!settings.from) {
    throw new Error('SMTP_FROM is required to send emails');
  }
  return settings;
}

async function sendInviteEmail({ to, inviteUrl, name, subscriptionId }) {
  const smtp = getSmtpConfig();
  const mailer = nodemailer.createTransport({
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
  const subject = 'Your Plex access invite';

  const text = `Hi ${name || 'there'},\n\nThank you for supporting our Plex server!\n\nYou can join using your personal Wizarr invite link: ${inviteUrl}\n\nSubscription ID: ${subscriptionId}\n\nIf you did not request this invite or need help, reply to this email.\n\n— Plex Donate`;

  const html = `
  <p>Hi ${name || 'there'},</p>
  <p>Thank you for supporting our Plex server! Use the button below to accept your invite.</p>
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

module.exports = {
  sendInviteEmail,
};
