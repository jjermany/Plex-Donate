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

function formatRuntimeDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return '';
  }

  const totalSeconds = Math.round(numeric);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
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

function getEmailTonePalette(tone = 'brand') {
  const palettes = {
    brand: {
      shell: '#0f172a',
      cardBorder: '#3b82f6',
      headerBg: '#111827',
      kicker: '#93c5fd',
      badgeBg: '#dbeafe',
      badgeColor: '#1d4ed8',
      panelBg: '#eff6ff',
      panelBorder: '#93c5fd',
      panelText: '#1e3a8a',
      buttonBg: '#2563eb',
      buttonColor: '#ffffff',
    },
    success: {
      shell: '#052e16',
      cardBorder: '#166534',
      headerBg: '#166534',
      kicker: '#bbf7d0',
      badgeBg: '#dcfce7',
      badgeColor: '#166534',
      panelBg: '#f0fdf4',
      panelBorder: '#86efac',
      panelText: '#14532d',
      buttonBg: '#166534',
      buttonColor: '#ffffff',
    },
    warning: {
      shell: '#3f2f05',
      cardBorder: '#d97706',
      headerBg: '#92400e',
      kicker: '#fde68a',
      badgeBg: '#fef3c7',
      badgeColor: '#92400e',
      panelBg: '#fffbeb',
      panelBorder: '#fcd34d',
      panelText: '#78350f',
      buttonBg: '#b45309',
      buttonColor: '#ffffff',
    },
    danger: {
      shell: '#450a0a',
      cardBorder: '#b91c1c',
      headerBg: '#991b1b',
      kicker: '#fecaca',
      badgeBg: '#fee2e2',
      badgeColor: '#b91c1c',
      panelBg: '#fef2f2',
      panelBorder: '#fca5a5',
      panelText: '#7f1d1d',
      buttonBg: '#b91c1c',
      buttonColor: '#ffffff',
    },
  };

  return palettes[tone] || palettes.brand;
}

function buildEmailActionButtonHtml(label, url, palette) {
  if (!label || !url) {
    return '';
  }

  return `
  <p style="margin:24px 0;text-align:center;">
    <a
      href="${escapeHtml(url)}"
      style="display:inline-block;background:${palette.buttonBg};color:${palette.buttonColor};padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700;letter-spacing:0.01em;"
    >${escapeHtml(label)}</a>
  </p>
  `;
}

function buildEmailDetailPanelHtml(title, lines, palette) {
  const normalizedLines = Array.isArray(lines)
    ? lines.filter((line) => typeof line === 'string' && line.trim())
    : [];

  if (normalizedLines.length === 0) {
    return '';
  }

  return `
  <div style="margin:0 0 20px;padding:16px 18px;background:${palette.panelBg};border:1px solid ${palette.panelBorder};border-radius:12px;">
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${palette.panelText};">${escapeHtml(
      title
    )}</p>
    <ul style="list-style:none;margin:0;padding:0;color:#111827;">
      ${normalizedLines
        .map((line) => {
          const separatorIndex = line.indexOf(':');
          if (separatorIndex === -1) {
            return `<li style="margin:0 0 10px;color:#0f172a;">${escapeHtml(line)}</li>`;
          }

          const label = line.slice(0, separatorIndex);
          const value = line.slice(separatorIndex + 1).trim();
          return `<li style="margin:0 0 10px;color:#0f172a;"><strong style="display:inline-block;min-width:170px;color:#111827;">${escapeHtml(
            label
          )}:</strong><span style="color:#334155;">${escapeHtml(value)}</span></li>`;
        })
        .join('')}
    </ul>
  </div>
  `;
}

function buildEmailFrameHtml({
  tone = 'brand',
  subject,
  badge,
  recipientName,
  intro,
  bodyHtml = '',
  dashboardHtml = '',
  footerHtml = '',
}) {
  const palette = getEmailTonePalette(tone);

  return `
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="color-scheme" content="light dark">
      <meta name="supported-color-schemes" content="light dark">
    </head>
    <body style="margin:0;padding:0;">
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${palette.shell};padding:20px;">
        <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid ${palette.cardBorder};overflow:hidden;box-shadow:0 18px 50px -24px rgba(15,23,42,0.45);">
          <div style="background:${palette.headerBg};color:#f8fafc;padding:22px 24px;">
            <p style="margin:0 0 6px;font-size:14px;text-transform:uppercase;letter-spacing:0.08em;color:${palette.kicker};">Plex Donate</p>
            <h2 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#f8fafc;">${escapeHtml(
              subject
            )}</h2>
            ${
              badge
                ? `<span style="display:inline-block;padding:6px 10px;border-radius:999px;background:${palette.badgeBg};color:${palette.badgeColor};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(
                    badge
                  )}</span>`
                : ''
            }
          </div>
          <div style="padding:24px;color:#0f172a;line-height:1.65;">
            <p style="margin:0 0 16px;font-size:16px;">Hi ${escapeHtml(
              recipientName || 'there'
            )},</p>
            ${
              intro
                ? `<div style="margin:0 0 20px;padding:16px 18px;background:${palette.panelBg};border:1px solid ${palette.panelBorder};border-radius:12px;"><p style="margin:0;font-size:16px;color:#111827;">${escapeHtml(
                    intro
                  )}</p></div>`
                : ''
            }
            ${bodyHtml}
            ${dashboardHtml}
            ${footerHtml}
            <p style="margin:24px 0 0;color:#475569;font-size:14px;">&mdash; Plex Donate</p>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;
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
  const palette = getEmailTonePalette('brand');
  const paragraphs = String(body || '')
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const htmlParagraphs =
    paragraphs.length > 0
      ? paragraphs
          .map(
            (paragraph) =>
              `<p style="margin:0 0 16px;color:#0f172a;">${escapeHtml(paragraph)}</p>`
          )
          .join('')
      : `<p style="margin:0 0 16px;color:#0f172a;">${escapeHtml(body || '')}</p>`;

  const ctaHtml = cta
    ? buildEmailActionButtonHtml(cta.label, cta.url, palette)
    : '';

  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);

  return buildEmailFrameHtml({
    tone: 'brand',
    subject,
    badge: 'Announcement',
    recipientName,
    intro: 'We have an update for your Plex Donate account.',
    bodyHtml: `${htmlParagraphs}${ctaHtml}`,
    dashboardHtml,
  });
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
  textLines.push('-- Plex Donate');

  const text = textLines.join('\n');

  const html = buildEmailFrameHtml({
    tone: 'brand',
    subject,
    badge: 'Invite Ready',
    recipientName: name,
    intro: 'Thank you for supporting our Plex server. Your personal share link is ready.',
    bodyHtml:
      buildEmailActionButtonHtml(
        'Accept Invite',
        inviteUrl,
        getEmailTonePalette('brand')
      ) +
      buildEmailDetailPanelHtml(
        'Subscription details',
        [`Subscription ID: ${subscriptionId}`],
        getEmailTonePalette('brand')
      ) +
      '<p style="margin:0 0 16px;color:#0f172a;">If you need help, just reply to this email.</p>',
    dashboardHtml,
  });

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    html,
  });
}
async function sendSubscriptionThankYouEmail(
  { to, name, subscriptionId, amount, currency, paidAt },
  overrideSettings
) {
  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);

  const formattedAmount = amount
    ? `${amount} ${currency || ''}`.trim()
    : '';
  const formattedPaidAt = formatAccessEndDate(paidAt);

  const subject = 'Thank you for supporting Plex Donate';
  const dashboardUrl = resolveDashboardUrl();
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);

  const textLines = [
    `Hi ${name || 'there'},`,
    '',
    'Thank you for your subscription! Your support helps keep our Plex server running.',
  ];

  if (formattedAmount) {
    textLines.push('');
    textLines.push(`Payment received: ${formattedAmount}`);
  }

  if (formattedPaidAt) {
    textLines.push(`Paid at: ${formattedPaidAt}`);
  }

  if (dashboardTextLine) {
    textLines.push('');
    textLines.push(dashboardTextLine);
  }

  textLines.push('');
  textLines.push(`Subscription ID: ${subscriptionId}`);
  textLines.push('');
  textLines.push('If you have any questions, just reply to this email.');
  textLines.push('');
  textLines.push('-- Plex Donate');

  const text = textLines.join('\n');

  const htmlAmount = formattedAmount
    ? `<p style="margin:0 0 16px;color:#0f172a;">Payment received: <strong>${escapeHtml(
        formattedAmount
      )}</strong></p>`
    : '';
  const htmlPaidAt = formattedPaidAt
    ? `<p style="margin:0 0 16px;color:#0f172a;">Paid at: <strong>${escapeHtml(
        formattedPaidAt
      )}</strong></p>`
    : '';

  const html = buildEmailFrameHtml({
    tone: 'success',
    subject,
    badge: 'Subscription Active',
    recipientName: name,
    intro: 'Thank you for your subscription! Your support helps keep our Plex server running.',
    bodyHtml:
      htmlAmount +
      htmlPaidAt +
      buildEmailDetailPanelHtml(
        'Subscription details',
        [`Subscription ID: ${subscriptionId}`],
        getEmailTonePalette('success')
      ) +
      '<p style="margin:0 0 16px;color:#0f172a;">If you have any questions, just reply to this email.</p>',
    dashboardHtml,
  });

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
  lines.push('-- Plex Donate');

  const text = lines.join('\n');

  const html = buildEmailFrameHtml({
    tone: 'brand',
    subject,
    badge: 'Verify Email',
    recipientName,
    intro:
      'Thanks for setting up your Plex Donate dashboard account. Confirm your email address to finish activating your access.',
    bodyHtml:
      buildEmailActionButtonHtml(
        'Verify Email',
        verificationUrl,
        getEmailTonePalette('brand')
      ) +
      `<p style="margin:0 0 16px;color:#0f172a;">Once verified you can manage your dashboard anytime at <a href="${escapeHtml(
        dashboardUrl
      )}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(
        dashboardUrl
      )}</a>.</p>` +
      `<p style="margin:0 0 16px;color:#0f172a;">${
        supportUrl
          ? `If you did not request this email or need help, visit <a href="${safeSupportUrl}" style="color:#2563eb;text-decoration:underline;">${safeSupportUrl}</a> to contact support instead of replying.`
          : 'If you did not request this email or need help, visit your dashboard support center to contact us instead of replying.'
      }</p>`,
    dashboardHtml,
  });

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
  textLines.push('-- Plex Donate');

  const text = textLines.join('\n');

  const html = buildEmailFrameHtml({
    tone: 'warning',
    subject,
    badge: 'Password Reset',
    recipientName,
    intro: 'We received a request to reset your Plex Donate dashboard password.',
    bodyHtml:
      buildEmailActionButtonHtml(
        'Reset Password',
        resetUrl,
        getEmailTonePalette('warning')
      ) +
      '<p style="margin:0 0 16px;color:#0f172a;">If you did not request this, you can safely ignore this email.</p>',
    dashboardHtml,
  });

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
  textLines.push('-- Plex Donate');

  const text = textLines.join('\n');

  const htmlAccessText = displayDate
    ? `Your Plex access will remain active until <strong>${displayDate}</strong>.`
    : 'Your Plex access has now ended.';

  const html = buildEmailFrameHtml({
    tone: 'warning',
    subject,
    badge: 'Access Update',
    recipientName: name,
    intro: 'Thank you for supporting our Plex server.',
    bodyHtml:
      `<p style="margin:0 0 16px;color:#0f172a;">${htmlAccessText}</p>` +
      `<p style="margin:0 0 16px;color:#0f172a;">If you'd like to come back, you can restart your support anytime by visiting the donation portal and starting a new subscription with the same email address.</p>` +
      buildEmailDetailPanelHtml(
        'Subscription details',
        [`Subscription ID: ${subscriptionId}`],
        getEmailTonePalette('warning')
      ) +
      '<p style="margin:0 0 16px;color:#0f172a;">If you have any questions, just reply to this email.</p>',
    dashboardHtml,
  });

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
  textLines.push('-- Plex Donate');

  const text = textLines.join('\n');

  const html = buildEmailFrameHtml({
    tone: 'warning',
    subject,
    badge: 'Trial Ending',
    recipientName: name,
    intro: accessText,
    bodyHtml:
      '<p style="margin:0 0 16px;color:#0f172a;">Keep your Plex access going by starting a subscription before your trial ends.</p>' +
      '<p style="margin:0 0 16px;color:#0f172a;">If you need help subscribing, just reply to this email.</p>',
    dashboardHtml,
  });

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    html,
  });
}
async function sendUpsStatusEmail(
  {
    to,
    name,
    event,
    upsName,
    batteryChargePercent,
    runtimeSeconds,
    occurredAt,
  },
  overrideSettings
) {
  if (!to) {
    throw new Error('Recipient email is required to send UPS status email');
  }

  const normalizedEvent =
    typeof event === 'string' ? event.trim().toLowerCase() : '';
  if (
    !['power_outage', 'power_restored', 'shutdown_imminent'].includes(
      normalizedEvent
    )
  ) {
    throw new Error('Valid UPS event is required to send status email');
  }

  const smtp = getSmtpConfig(overrideSettings);
  const mailer = createTransport(smtp);
  const recipientName = name || 'there';
  const displayOccurredAt = formatAccessEndDate(occurredAt);
  const displayRuntime = formatRuntimeDuration(runtimeSeconds);
  const dashboardUrl = resolveDashboardUrl();
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardTextLine = buildDashboardAccessText(dashboardUrl);
  const hasBatteryPercent = Number.isFinite(Number(batteryChargePercent));
  const displayBatteryPercent = hasBatteryPercent
    ? `${Math.round(Number(batteryChargePercent))}%`
    : '';
  const displayUpsName =
    typeof upsName === 'string' && upsName.trim() ? upsName.trim() : '';
  const eventTone =
    normalizedEvent === 'power_restored'
      ? 'success'
      : normalizedEvent === 'shutdown_imminent'
      ? 'danger'
      : 'warning';
  const eventLabel =
    normalizedEvent === 'power_restored'
      ? 'Power Restored'
      : normalizedEvent === 'shutdown_imminent'
      ? 'Shutdown Imminent'
      : 'Power Outage';

  const subject =
    normalizedEvent === 'power_outage'
      ? 'Plex server power outage detected'
      : normalizedEvent === 'power_restored'
      ? 'Plex server power has been restored'
      : 'Plex server shutdown is imminent';

  const intro =
    normalizedEvent === 'power_outage'
      ? 'Our Plex server is currently running on UPS battery power and may shut down if the outage continues.'
      : normalizedEvent === 'power_restored'
      ? 'Commercial power has been restored and Plex service should be available again.'
      : 'Our Plex server is nearly out of battery runtime and is expected to shut down soon to protect the system.';

  const detailLines = [];
  if (displayUpsName) {
    detailLines.push(`UPS: ${displayUpsName}`);
  }
  if (displayBatteryPercent) {
    detailLines.push(`Battery charge: ${displayBatteryPercent}`);
  }
  if (displayRuntime) {
    detailLines.push(`Estimated runtime remaining: ${displayRuntime}`);
  }
  if (displayOccurredAt) {
    detailLines.push(`Reported at: ${displayOccurredAt}`);
  }

  const textLines = [`Hi ${recipientName},`, '', intro];

  if (detailLines.length > 0) {
    textLines.push('');
    textLines.push(...detailLines);
  }

  if (dashboardTextLine) {
    textLines.push('');
    textLines.push(dashboardTextLine);
  }

  textLines.push('');
  textLines.push(
    normalizedEvent === 'power_outage'
      ? 'We will send another update when power returns.'
      : normalizedEvent === 'power_restored'
      ? 'Thank you for your patience.'
      : 'Please expect Plex to go offline shortly until utility power returns.'
  );
  textLines.push('');
  textLines.push('-- Plex Donate');

  const htmlDetails = buildEmailDetailPanelHtml(
    'System details',
    detailLines,
    getEmailTonePalette(eventTone)
  );

  const html = buildEmailFrameHtml({
    tone: eventTone,
    subject,
    badge: eventLabel,
    recipientName,
    intro,
    bodyHtml:
      htmlDetails +
      `<p style="margin:0 0 16px;color:#0f172a;">${
        normalizedEvent === 'power_outage'
          ? 'We will send another update when power returns.'
          : normalizedEvent === 'power_restored'
          ? 'Thank you for your patience.'
          : 'Please expect Plex to go offline shortly until utility power returns.'
      }</p>`,
    dashboardHtml,
  });

  await mailer.sendMail({
    from: smtp.from,
    to,
    subject,
    text: textLines.join('\n'),
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
  const displayActor = actorName || 'Supporter';
  const paragraphs = String(body || '')
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px;color:#0f172a;">${escapeHtml(paragraph)}</p>`
    )
    .join('');
  const bodyHtml =
    paragraphs ||
    `<p style="margin:0 0 12px;color:#0f172a;">${escapeHtml(body || '')}</p>`;
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);

  return buildEmailFrameHtml({
    tone: 'brand',
    subject: heading || 'Support request update',
    badge: 'Support',
    recipientName: displayActor,
    intro: subject
      ? `Subject: ${subject} | Request ID: ${requestId || 'Not provided'}`
      : `Request ID: ${requestId || 'Not provided'}`,
    bodyHtml:
      `<p style="margin:0 0 12px;color:#0f172a;">${escapeHtml(
        displayActor
      )} wrote:</p>` +
      `<div style="background:#f8fafc;border:1px solid #cbd5f5;border-radius:12px;padding:16px;">${bodyHtml}</div>`,
    dashboardHtml,
  });
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

  return buildEmailDetailPanelHtml(
    'Key details',
    facts
      .filter((fact) => fact && fact.label)
      .map((fact) => {
        const value = fact.value == null ? 'Not provided' : String(fact.value);
        return `${fact.label}: ${value}`;
      }),
    getEmailTonePalette('brand')
  );
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
  const factsHtml = formatAdminFactsHtml(facts);
  const factsText = formatAdminFactsText(facts);
  const dashboardHtml = buildDashboardAccessHtml(dashboardUrl);
  const dashboardText = buildDashboardAccessText(dashboardUrl);

  const textLines = [heading || 'Admin notification', '', intro || 'A new event occurred.'];
  if (factsText) {
    textLines.push('');
    textLines.push(factsText);
  }
  if (dashboardText) {
    textLines.push('');
    textLines.push(dashboardText);
  }
  textLines.push('');
  textLines.push('-- Plex Donate');

  const html = buildEmailFrameHtml({
    tone: 'brand',
    subject: heading || 'Admin notification',
    badge: 'Admin',
    recipientName: 'Admin',
    intro: intro || 'A new event occurred in Plex Donate.',
    bodyHtml: factsHtml,
    dashboardHtml,
  });

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
  sendSubscriptionThankYouEmail,
  sendAccountWelcomeEmail,
  sendPasswordResetEmail,
  sendCancellationEmail,
  sendTrialEndingReminderEmail,
  sendUpsStatusEmail,
  sendAnnouncementEmail,
  getSmtpConfig,
  verifyConnection,
  sendSupportRequestNotification,
  sendSupportResponseNotification,
  resolveDashboardUrl,
  resolveAdminDashboardUrl,
  sendAdminNotificationEmail,
};


