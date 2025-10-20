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

function escapeHtml(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAnnouncementEmailPayload({
  announcement,
  subject,
  body,
  cta,
}) {
  const settings = announcement && typeof announcement === 'object' ? announcement : {};
  const resolvedSubject = subject && typeof subject === 'string'
    ? subject.trim()
    : typeof settings.bannerTitle === 'string'
    ? settings.bannerTitle.trim()
    : '';
  const resolvedBody = body && typeof body === 'string'
    ? body.trim()
    : typeof settings.bannerBody === 'string'
    ? settings.bannerBody.trim()
    : '';

  const hasConfiguredCta = Boolean(
    settings &&
      settings.bannerCtaEnabled &&
      settings.bannerCtaLabel &&
      settings.bannerCtaUrl
  );

  const announcementCta = cta
    ? {
        label: cta.label ? String(cta.label).trim() : '',
        url: cta.url ? String(cta.url).trim() : '',
      }
    : hasConfiguredCta
    ? {
        label: String(settings.bannerCtaLabel).trim(),
        url: String(settings.bannerCtaUrl).trim(),
      }
    : null;

  const normalizedCta =
    announcementCta && announcementCta.label && announcementCta.url
      ? announcementCta
      : null;

  return {
    subject: resolvedSubject,
    body: resolvedBody,
    cta: normalizedCta,
  };
}

function buildAnnouncementEmailHtml({ subject, body, cta, recipientName }) {
  const paragraphs = String(body || '')
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const htmlParagraphs =
    paragraphs.length > 0
      ? paragraphs
          .map(
            (paragraph) =>
              `<p style="margin:0 0 16px;">${escapeHtml(paragraph)}</p>`
          )
          .join('')
      : `<p style="margin:0 0 16px;">${escapeHtml(body || '')}</p>`;

  const ctaHtml = cta
    ? `
  <p style="margin:24px 0;text-align:center;">
    <a
      href="${escapeHtml(cta.url)}"
      style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;"
    >${escapeHtml(cta.label)}</a>
  </p>
  `
    : '';

  const greetingName = recipientName ? escapeHtml(recipientName) : 'there';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;line-height:1.6;">
    <h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(
      subject
    )}</h2>
    <p style="margin:0 0 16px;">Hi ${greetingName},</p>
    ${htmlParagraphs}
    ${ctaHtml}
    <p style="margin:24px 0 0;">— Plex Donate</p>
  </div>
  `;
}

function buildAnnouncementEmailText({ subject, body, cta, recipientName }) {
  const lines = [];
  lines.push(`Hi ${recipientName ? recipientName : 'there'},`);
  lines.push('');

  const bodyLines = String(body || '').split(/\r?\n/);
  bodyLines.forEach((line) => {
    lines.push(line);
  });

  if (cta) {
    lines.push('');
    lines.push(`${cta.label}: ${cta.url}`);
  }

  lines.push('');
  lines.push('— Plex Donate');

  return lines.join('\n');
}

async function sendAnnouncementEmail(
  { to, name, announcement, subject, body, cta },
  overrideSettings
) {
  if (!to) {
    throw new Error('Recipient email is required to send announcement email');
  }

  const normalized = normalizeAnnouncementEmailPayload({
    announcement,
    subject,
    body,
    cta,
  });

  if (!normalized.subject) {
    throw new Error('Announcement subject is required to send email');
  }
  if (!normalized.body) {
    throw new Error('Announcement body is required to send email');
  }

  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);

  const html = buildAnnouncementEmailHtml({
    subject: normalized.subject,
    body: normalized.body,
    cta: normalized.cta,
    recipientName: name,
  });
  const text = buildAnnouncementEmailText({
    subject: normalized.subject,
    body: normalized.body,
    cta: normalized.cta,
    recipientName: name,
  });

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject: normalized.subject,
    text,
    html,
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
  { to, name, loginUrl, verificationUrl },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  if (!verificationUrl) {
    throw new Error('verificationUrl is required to send welcome email');
  }

  const recipientName = name || 'there';
  const subject = 'Verify your Plex dashboard email';
  const dashboardUrl = loginUrl || verificationUrl;
  const text = `Hi ${recipientName},\n\nThanks for setting up your Plex Donate dashboard account. Confirm your email address to finish activating your access:\n\n${verificationUrl}\n\nOnce verified you can manage your dashboard at ${dashboardUrl}. If you did not request this email or need help, reply to this message.\n\n— Plex Donate`;

  const html = `
  <p>Hi ${recipientName},</p>
  <p>Thanks for setting up your Plex Donate dashboard account. Use the button below to confirm your email address.</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${verificationUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Verify Email</a>
  </p>
  <p>Once verified you can manage your dashboard anytime at <a href="${dashboardUrl}">${dashboardUrl}</a>.</p>
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

function formatSupportEmailHtml({ heading, subject, requestId, actorName, body }) {
  const safeHeading = escapeHtml(heading);
  const safeSubject = escapeHtml(subject || 'Support request');
  const safeActor = escapeHtml(actorName || 'Supporter');
  const paragraphs = String(body || '')
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p style="margin:0 0 12px;">${escapeHtml(paragraph)}</p>`)
    .join('');
  const bodyHtml = paragraphs || `<p style="margin:0 0 12px;">${escapeHtml(body || '')}</p>`;
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;line-height:1.6;">
    <h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${safeHeading}</h2>
    <p style="margin:0 0 12px;">Subject: <strong>${safeSubject}</strong></p>
    <p style="margin:0 0 12px;">Request ID: <strong>${escapeHtml(String(requestId || ''))}</strong></p>
    <p style="margin:12px 0 12px;">${safeActor} wrote:</p>
    <div style="background:#f8fafc;border:1px solid #cbd5f5;border-radius:8px;padding:16px;">${bodyHtml}</div>
    <p style="margin:24px 0 0;color:#4b5563;font-size:14px;">— Plex Donate</p>
  </div>
  `;
}

function formatSupportEmailText({ heading, subject, requestId, actorName, body }) {
  const lines = [];
  lines.push(heading || 'Support request update');
  lines.push('');
  if (subject) {
    lines.push(`Subject: ${subject}`);
  }
  if (requestId) {
    lines.push(`Request ID: ${requestId}`);
  }
  if (actorName) {
    lines.push('');
    lines.push(`${actorName} wrote:`);
  }
  lines.push('');
  lines.push(body || '');
  lines.push('');
  lines.push('— Plex Donate');
  return lines.join('\n');
}

async function sendSupportRequestNotification(
  { request, message, donor, adminEmail, type },
  overrideSettings
) {
  if (!request || !message) {
    throw new Error('request and message are required to send support notification');
  }
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  const recipient = adminEmail || smtp.supportNotificationEmail || smtp.from;
  if (!recipient) {
    throw new Error('Admin recipient email is required to send support notification');
  }
  const donorName =
    (request && request.donorDisplayName) ||
    (donor && (donor.name || donor.email)) ||
    (request && (request.donorName || request.donorEmail)) ||
    'Supporter';
  const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
  const heading = normalizedType === 'new'
    ? `New support request from ${donorName}`
    : `New message from ${donorName}`;
  const subject = `[Support] ${request.subject || 'Request'} (#${request.id})`;
  const html = formatSupportEmailHtml({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName: donorName,
    body: message.body,
  });
  const text = formatSupportEmailText({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName: donorName,
    body: message.body,
  });
  await mailer.sendMail({
    from: smtp.from,
    to: recipient,
    subject,
    text,
    html,
  });
}

async function sendSupportResponseNotification(
  { request, message, donor },
  overrideSettings
) {
  if (!request || !message || !donor || !donor.email) {
    throw new Error('request, message, and donor email are required to notify donor');
  }
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  const heading = 'Support reply from the Plex Donate team';
  const subject = `We replied: ${request.subject || 'Support request'} (#${request.id})`;
  const actorName = 'Plex Donate';
  const html = formatSupportEmailHtml({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName,
    body: message.body,
  });
  const text = formatSupportEmailText({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName,
    body: message.body,
  });
  await mailer.sendMail({
    from: smtp.from,
    to: donor.email,
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
  sendAnnouncementEmail,
  getSmtpConfig,
  verifyConnection,
  sendSupportRequestNotification,
  sendSupportResponseNotification,
};
