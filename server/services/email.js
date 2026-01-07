const nodemailer = require('nodemailer');
const settingsState = require('../state/settings');

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

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function tryBuildAdminBaseUrl(base) {
  if (!base) {
    return '';
  }

  const trimmed = String(base).trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    return stripTrailingSlash(parsed.origin);
  } catch (err) {
    if (/^https?:\/\//i.test(trimmed)) {
      return stripTrailingSlash(trimmed);
    }
  }

  return '';
}

function tryBuildDashboardUrl(base) {
  if (!base) {
    return '';
  }

  const trimmed = String(base).trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    const dashboard = new URL('/dashboard', parsed);
    return stripTrailingSlash(dashboard.toString());
  } catch (err) {
    if (/^https?:\/\//i.test(trimmed)) {
      const sanitized = stripTrailingSlash(trimmed);
      return `${sanitized}/dashboard`;
    }
  }

  return '';
}

function resolveDashboardUrl({ loginUrl, fallbackUrls } = {}) {
  const normalizedLogin = loginUrl ? String(loginUrl).trim() : '';
  if (normalizedLogin) {
    return normalizedLogin;
  }

  let baseFromSettings = '';
  try {
    const appSettings = settingsState.getAppSettings
      ? settingsState.getAppSettings()
      : null;
    baseFromSettings =
      appSettings && appSettings.publicBaseUrl
        ? String(appSettings.publicBaseUrl).trim()
        : '';
  } catch (err) {
    baseFromSettings = '';
  }

  const derivedFromSettings = tryBuildDashboardUrl(baseFromSettings);
  if (derivedFromSettings) {
    return derivedFromSettings;
  }

  const references = Array.isArray(fallbackUrls)
    ? fallbackUrls
    : fallbackUrls
    ? [fallbackUrls]
    : [];

  for (const reference of references) {
    if (!reference) {
      continue;
    }
    try {
      const parsed = new URL(String(reference).trim());
      const candidate = tryBuildDashboardUrl(parsed.origin);
      if (candidate) {
        return candidate;
      }
    } catch (err) {
      const candidate = tryBuildDashboardUrl(reference);
      if (candidate) {
        return candidate;
      }
    }
  }

  return '';
}

function resolveAdminDashboardUrl() {
  let baseFromSettings = '';
  try {
    const appSettings = settingsState.getAppSettings
      ? settingsState.getAppSettings()
      : null;
    baseFromSettings =
      appSettings && appSettings.publicBaseUrl
        ? String(appSettings.publicBaseUrl).trim()
        : '';
  } catch (err) {
    baseFromSettings = '';
  }

  return tryBuildAdminBaseUrl(baseFromSettings);
}

function buildDashboardAccessHtml(dashboardUrl) {
  if (!dashboardUrl) {
    return '';
  }

  const safeUrl = escapeHtml(dashboardUrl);
  return `
  <p style="margin:24px 0;text-align:center;">
    <a
      href="${safeUrl}"
      style="display:inline-block;background:#111827;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;"
    >Open Dashboard</a>
  </p>
  <p style="margin:0 0 16px;text-align:center;font-size:14px;color:#4b5563;">
    Or open the dashboard directly:
    <a href="${safeUrl}" style="color:#6366f1;text-decoration:underline;">${safeUrl}</a>
  </p>
  `;
}

function buildDashboardAccessText(dashboardUrl) {
  if (!dashboardUrl) {
    return '';
  }

  return `Open Dashboard: ${dashboardUrl}`;
}

function getSmtpConfig(overrideSettings) {
  const settings = overrideSettings || settingsState.getSmtpSettings();
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

function buildAnnouncementEmailHtml({
  subject,
  body,
  cta,
  recipientName,
  dashboardUrl,
}) {
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

  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const greetingName = recipientName ? escapeHtml(recipientName) : 'there';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;line-height:1.6;">
    <h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(
      subject
    )}</h2>
    <p style="margin:0 0 16px;">Hi ${greetingName},</p>
    ${htmlParagraphs}
    ${ctaHtml}
    ${dashboardHtml}
    <p style="margin:24px 0 0;">— Plex Donate</p>
  </div>
  `;
}

function buildAnnouncementEmailText({
  subject,
  body,
  cta,
  recipientName,
  dashboardUrl,
}) {
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

  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);
  if (dashboardTextLine) {
    lines.push('');
    lines.push(dashboardTextLine);
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

  const dashboardUrl = resolveDashboardUrl();

  const html = buildAnnouncementEmailHtml({
    subject: normalized.subject,
    body: normalized.body,
    cta: normalized.cta,
    recipientName: name,
    dashboardUrl,
  });
  const text = buildAnnouncementEmailText({
    subject: normalized.subject,
    body: normalized.body,
    cta: normalized.cta,
    recipientName: name,
    dashboardUrl,
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

  const dashboardUrl = resolveDashboardUrl({ fallbackUrls: [inviteUrl] });
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);

  const textLines = [
    `Hi ${name || 'there'},`,
    '',
    'Thank you for supporting our Plex server!',
    '',
    `Use your personal share link to accept the Plex invite: ${inviteUrl}`,
  ];

  if (dashboardTextLine) {
    textLines.push('');
    textLines.push(dashboardTextLine);
  }

  textLines.push('');
  textLines.push(`Subscription ID: ${subscriptionId}`);
  textLines.push('');
  textLines.push('If you did not request this invite or need help, reply to this email.');
  textLines.push('');
  textLines.push('— Plex Donate');

  const text = textLines.join('\n');

  const html = `
  <p>Hi ${name || 'there'},</p>
  <p>Thank you for supporting our Plex server! Use the button below to accept your Plex invite.</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${inviteUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Accept Invite</a>
  </p>
  ${dashboardHtml}
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
  const resolvedDashboardUrl = resolveDashboardUrl({
    loginUrl,
    fallbackUrls: [verificationUrl],
  });
  const dashboardUrl =
    resolvedDashboardUrl || loginUrl || verificationUrl || '';
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);
  let supportUrl = '';

  try {
    const appSettings = settingsState.getAppSettings();
    const configuredBase =
      appSettings && appSettings.publicBaseUrl
        ? String(appSettings.publicBaseUrl).trim()
        : '';
    if (configuredBase) {
      try {
        const parsed = new URL(configuredBase);
        supportUrl = `${parsed.origin}/support`;
      } catch (err) {
        supportUrl = `${configuredBase.replace(/\/+$/, '')}/support`;
      }
    }
  } catch (err) {
    supportUrl = '';
  }

  if (!supportUrl) {
    const fallbackBase = dashboardUrl || verificationUrl || loginUrl || '';
    if (fallbackBase && /^https?:\/\//i.test(fallbackBase)) {
      try {
        const parsed = new URL(fallbackBase);
        supportUrl = `${parsed.origin}/support`;
      } catch (err) {
        supportUrl = `${fallbackBase.replace(/\/+$/, '')}/support`;
      }
    }
  }

  const supportInstruction = supportUrl
    ? `If you did not request this email or need help, visit ${supportUrl} to contact support instead of replying.`
    : 'If you did not request this email or need help, visit your dashboard support center to contact us instead of replying.';

  const safeSupportUrl = supportUrl ? escapeHtml(supportUrl) : '';

  const lines = [
    `Hi ${recipientName},`,
    '',
    'Thanks for setting up your Plex Donate dashboard account. Confirm your email address to finish activating your access:',
    '',
    verificationUrl,
    '',
    `Once verified you can manage your dashboard at ${dashboardUrl}. ${supportInstruction}`,
  ];

  if (dashboardTextLine) {
    lines.push('');
    lines.push(dashboardTextLine);
  }

  lines.push('');
  lines.push('— Plex Donate');

  const text = lines.join('\n');

  const html = `
  <p>Hi ${recipientName},</p>
  <p>Thanks for setting up your Plex Donate dashboard account. Use the button below to confirm your email address.</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${verificationUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Verify Email</a>
  </p>
  <p>Once verified you can manage your dashboard anytime at <a href="${dashboardUrl}">${dashboardUrl}</a>.</p>
  ${dashboardHtml}
  <p>${
    supportUrl
      ? `If you did not request this email or need help, visit <a href="${safeSupportUrl}">${safeSupportUrl}</a> to contact support instead of replying.`
      : 'If you did not request this email or need help, visit your dashboard support center to contact us instead of replying.'
  }</p>
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

async function sendPasswordResetEmail(
  { to, name, resetUrl, loginUrl },
  overrideSettings
) {
  if (!resetUrl) {
    throw new Error('resetUrl is required to send password reset email');
  }

  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  const recipientName = name || 'there';
  const subject = 'Reset your Plex Donate password';
  const dashboardUrl = resolveDashboardUrl({
    loginUrl,
    fallbackUrls: [resetUrl],
  });
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);
  const safeResetUrl = escapeHtml(resetUrl);

  const textLines = [
    `Hi ${recipientName},`,
    '',
    'We received a request to reset your Plex Donate dashboard password.',
    'Use the link below to set a new password:',
    '',
    resetUrl,
    '',
    'If you did not request this, you can safely ignore this email.',
  ];

  if (dashboardTextLine) {
    textLines.push('');
    textLines.push(dashboardTextLine);
  }

  textLines.push('');
  textLines.push('— Plex Donate');

  const text = textLines.join('\n');

  const html = `
  <p>Hi ${escapeHtml(recipientName)},</p>
  <p>We received a request to reset your Plex Donate dashboard password. Use the button below to choose a new password.</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${safeResetUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Reset password</a>
  </p>
  <p style="font-size:14px;color:#4b5563;">If you did not request this, you can safely ignore this email.</p>
  ${dashboardHtml}
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

  const dashboardUrl = resolveDashboardUrl();
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);

  const textLines = [
    `Hi ${name || 'there'},`,
    '',
    `Thank you for supporting our Plex server. ${accessText}`,
    '',
    "If you'd like to come back, you can restart your support anytime by visiting the donation portal and starting a new subscription with the same email address.",
  ];

  if (dashboardTextLine) {
    textLines.push('');
    textLines.push(dashboardTextLine);
  }

  textLines.push('');
  textLines.push(`Subscription ID: ${subscriptionId}`);
  textLines.push('');
  textLines.push('If you have any questions, just reply to this email.');
  textLines.push('');
  textLines.push('— Plex Donate');

  const text = textLines.join('\n');

  const htmlAccessText = displayDate
    ? `Your Plex access will remain active until <strong>${displayDate}</strong>.`
    : 'Your Plex access has now ended.';

  const html = `
  <p>Hi ${name || 'there'},</p>
  <p>Thank you for supporting our Plex server.</p>
  <p>${htmlAccessText}</p>
  <p>If you'd like to come back, you can restart your support anytime by visiting the donation portal and starting a new subscription with the same email address.</p>
  ${dashboardHtml}
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

async function sendTrialEndingReminderEmail(
  { to, name, accessExpiresAt },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);

  const displayDate = formatAccessEndDate(accessExpiresAt);
  const subject = 'Your Plex trial ends soon';

  const dashboardUrl = resolveDashboardUrl();
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);

  const accessText = displayDate
    ? `Your Plex trial access will end around ${displayDate}.`
    : 'Your Plex trial access will end soon.';

  const textLines = [
    `Hi ${name || 'there'},`,
    '',
    `${accessText} Continue watching by starting a subscription before your trial expires.`,
  ];

  if (dashboardTextLine) {
    textLines.push('');
    textLines.push(dashboardTextLine);
  }

  textLines.push('');
  textLines.push('If you have questions or need help subscribing, just reply to this email.');
  textLines.push('');
  textLines.push('— Plex Donate');

  const text = textLines.join('\n');

  const safeAccessText = escapeHtml(accessText);
  const html = `
  <p>Hi ${escapeHtml(name || 'there')},</p>
  <p>${safeAccessText}</p>
  <p>Keep your Plex access going by starting a subscription before your trial ends.</p>
  ${dashboardHtml}
  <p style="font-size:14px;color:#4b5563;">If you need help subscribing, just reply to this email.</p>
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

function formatSupportEmailHtml({
  heading,
  subject,
  requestId,
  actorName,
  body,
  dashboardUrl,
}) {
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
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;line-height:1.6;">
    <h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${safeHeading}</h2>
    <p style="margin:0 0 12px;">Subject: <strong>${safeSubject}</strong></p>
    <p style="margin:0 0 12px;">Request ID: <strong>${escapeHtml(String(requestId || ''))}</strong></p>
    <p style="margin:12px 0 12px;">${safeActor} wrote:</p>
    <div style="background:#f8fafc;border:1px solid #cbd5f5;border-radius:8px;padding:16px;">${bodyHtml}</div>
    ${dashboardHtml}
    <p style="margin:24px 0 0;color:#4b5563;font-size:14px;">— Plex Donate</p>
  </div>
  `;
}

function formatSupportEmailText({
  heading,
  subject,
  requestId,
  actorName,
  body,
  dashboardUrl,
}) {
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

  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);
  if (dashboardTextLine) {
    lines.push('');
    lines.push(dashboardTextLine);
  }

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
  const fallbackDashboardUrls = [];
  if (request && request.dashboardUrl) {
    fallbackDashboardUrls.push(request.dashboardUrl);
  }
  if (message && message.dashboardUrl) {
    fallbackDashboardUrls.push(message.dashboardUrl);
  }
  const dashboardUrl = resolveDashboardUrl({ fallbackUrls: fallbackDashboardUrls });
  const html = formatSupportEmailHtml({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName: donorName,
    body: message.body,
    dashboardUrl,
  });
  const text = formatSupportEmailText({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName: donorName,
    body: message.body,
    dashboardUrl,
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
  const fallbackDashboardUrls = [];
  if (request && request.dashboardUrl) {
    fallbackDashboardUrls.push(request.dashboardUrl);
  }
  if (message && message.dashboardUrl) {
    fallbackDashboardUrls.push(message.dashboardUrl);
  }
  const dashboardUrl = resolveDashboardUrl({ fallbackUrls: fallbackDashboardUrls });
  const html = formatSupportEmailHtml({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName,
    body: message.body,
    dashboardUrl,
  });
  const text = formatSupportEmailText({
    heading,
    subject: request.subject,
    requestId: request.id,
    actorName,
    body: message.body,
    dashboardUrl,
  });
  await mailer.sendMail({
    from: smtp.from,
    to: donor.email,
    subject,
    text,
    html,
  });
}

function formatAdminFactsHtml(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return '';
  }

  const items = facts
    .filter((fact) => fact && fact.label)
    .map((fact) => {
      const label = escapeHtml(fact.label);
      const value = escapeHtml(
        fact.value == null ? 'Not provided' : String(fact.value)
      );
      return `
        <li style="margin-bottom:6px;font-size:15px;color:#0f172a;">
          <strong style="color:#111827;">${label}:</strong>
          <span style="color:#111827;">${value}</span>
        </li>
      `;
    })
    .join('');

  return `
    <ul style="list-style:none;padding:0;margin:12px 0 0;">${items}</ul>
  `;
}

function formatAdminFactsText(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return '';
  }

  return facts
    .filter((fact) => fact && fact.label)
    .map((fact) => {
      const label = fact.label || '';
      const value = fact.value == null ? 'Not provided' : String(fact.value);
      return `- ${label}: ${value}`;
    })
    .join('\n');
}

function formatAdminNotificationEmail({
  heading,
  intro,
  facts = [],
  dashboardUrl,
}) {
  const safeHeading = escapeHtml(heading || 'Admin notification');
  const safeIntro = escapeHtml(intro || 'A new event occurred in Plex Donate.');
  const factsHtml = formatAdminFactsHtml(facts);
  const factsText = formatAdminFactsText(facts);
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardText = buildDashboardAccessText(dashboardUrl);

  const textLines = [safeHeading, '', intro || 'A new event occurred.'];
  if (factsText) {
    textLines.push('');
    textLines.push(factsText);
  }
  if (dashboardText) {
    textLines.push('');
    textLines.push(dashboardText);
  }
  textLines.push('');
  textLines.push('— Plex Donate');

  const html = `
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="color-scheme" content="light dark">
      <meta name="supported-color-schemes" content="light dark">
      <style>
        @media (prefers-color-scheme: dark) {
          body,
          .email-shell {
            background-color: #0f172a !important;
          }
          .email-card {
            background-color: #111827 !important;
            border-color: #1f2937 !important;
          }
          .email-header {
            background-color: #111827 !important;
          }
          .email-body,
          .email-body p,
          .email-body li,
          .email-body span {
            color: #f8fafc !important;
          }
          .email-body a {
            color: #a5b4fc !important;
          }
          .email-kicker {
            color: #a5b4fc !important;
          }
          .email-footer {
            color: #cbd5f5 !important;
          }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;">
      <div class="email-shell" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;padding:20px;">
        <div class="email-card" style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 18px 50px -24px rgba(79,70,229,0.45);">
          <div class="email-header" style="background:#111827;color:#e5e7eb;padding:20px 24px;">
            <p class="email-kicker" style="margin:0 0 6px;font-size:14px;text-transform:uppercase;letter-spacing:0.08em;color:#a5b4fc;">Plex Donate</p>
            <h2 style="margin:0;font-size:22px;line-height:1.3;color:#f8fafc;background-color:#111827;">${safeHeading}</h2>
          </div>
          <div class="email-body" style="padding:22px 24px;color:#0f172a;">
            <p style="margin:0 0 12px;font-size:16px;color:#0f172a;background-color:#ffffff;">${safeIntro}</p>
            ${factsHtml}
            ${dashboardHtml}
            <p class="email-footer" style="margin:24px 0 0;color:#4b5563;font-size:14px;">— Plex Donate</p>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;

  return { html, text: textLines.join('\n') };
}

async function sendAdminNotificationEmail(
  { to, subject, heading, intro, facts, dashboardUrl },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  const recipient = to || smtp.supportNotificationEmail || smtp.from;
  if (!recipient) {
    throw new Error('Admin recipient email is required to send notification');
  }
  const title = subject || heading || 'Admin notification';
  const { html, text } = formatAdminNotificationEmail({
    heading: heading || title,
    intro,
    facts,
    dashboardUrl,
  });

  await mailer.sendMail({
    from: smtp.from,
    to: recipient,
    subject: title,
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
  sendPasswordResetEmail,
  sendCancellationEmail,
  sendTrialEndingReminderEmail,
  sendAnnouncementEmail,
  getSmtpConfig,
  verifyConnection,
  sendSupportRequestNotification,
  sendSupportResponseNotification,
  resolveDashboardUrl,
  resolveAdminDashboardUrl,
  sendAdminNotificationEmail,
};
