const express = require('express');
const csurf = require('csurf');
const { nanoid } = require('nanoid');
const {
  listDonorsWithDetails,
  getDonorById,
  markInviteEmailSent,
  getLatestActiveInviteForDonor,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  createOrUpdateShareLink,
  getShareLinkByDonorId,
  getShareLinkById,
  createProspect,
  updateProspect,
  getProspectById,
  getShareLinkByProspectId,
  deleteDonorById,
  listShareLinks,
  deleteShareLinkById,
  logEvent,
  getRecentEvents,
  createInvite: createInviteRecord,
} = require('../db');
const { requireAdmin } = require('../middleware/auth');
const paypalService = require('../services/paypal');
const emailService = require('../services/email');
const plexService = require('../services/plex');
const logger = require('../utils/logger');
const settingsStore = require('../state/settings');
const {
  getAdminAccount,
  verifyAdminCredentials,
  updateAdminCredentials,
} = require('../state/admin-credentials');
const { refreshDonorSubscription } = require('../utils/donor-subscriptions');

const router = express.Router();
const csrfProtection = csurf();
const {
  ensureSessionToken,
  hasValidSessionToken,
} = require('../utils/session-tokens');

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function resolvePublicBaseUrl(req) {
  let configured = '';
  try {
    const appSettings = settingsStore.getAppSettings();
    configured = appSettings && appSettings.publicBaseUrl
      ? String(appSettings.publicBaseUrl).trim()
      : '';
  } catch (err) {
    configured = '';
  }

  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
}

function normalizeValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function gatherStrings(candidate) {
  if (!candidate) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate.flatMap(gatherStrings);
  }
  if (typeof candidate === 'object') {
    return [];
  }
  const value = String(candidate).trim();
  return value ? [value] : [];
}

function extractUserEmailCandidates(user) {
  if (!user) {
    return [];
  }
  const account = user.account || {};
  const values = [
    user.email,
    user.username,
    user.title,
    user.name,
    user.friendlyName,
    user.displayName,
    user.invitedEmail,
    account.email,
    account.username,
    account.title,
  ];
  if (Array.isArray(user.emails)) {
    values.push(...user.emails);
  }
  if (Array.isArray(user.invitations)) {
    values.push(
      ...user.invitations.flatMap((invitation) =>
        gatherStrings(invitation && (invitation.email || invitation.username))
      )
    );
  }
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function extractUserIdCandidates(user) {
  if (!user) {
    return [];
  }
  const account = user.account || {};
  const values = [
    user.id,
    user.uuid,
    user.userID,
    user.machineIdentifier,
    user.accountID,
    account.id,
    account.uuid,
    account.machineIdentifier,
  ];
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function isPlexUserPending(user) {
  if (!user) {
    return false;
  }
  if (user.pending === true) {
    return true;
  }
  const states = [user.status, user.state, user.friendStatus, user.requestStatus];
  return states
    .flatMap(gatherStrings)
    .map((value) => value.toLowerCase())
    .some((value) => value.includes('pending') || value.includes('invited'));
}

function preparePlexUserIndex(users) {
  return (Array.isArray(users) ? users : []).map((user) => ({
    user,
    emails: new Set(extractUserEmailCandidates(user)),
    ids: new Set(extractUserIdCandidates(user)),
    pending: isPlexUserPending(user),
  }));
}

function collectDonorEmailCandidates(donor) {
  const invites = Array.isArray(donor && donor.invites) ? donor.invites : [];
  const values = [donor && donor.email];
  invites.forEach((invite) => {
    values.push(invite && invite.recipientEmail);
    values.push(invite && invite.plexEmail);
  });
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function collectDonorIdCandidates(donor) {
  const invites = Array.isArray(donor && donor.invites) ? donor.invites : [];
  const values = [donor && donor.plexAccountId];
  invites.forEach((invite) => {
    values.push(invite && invite.plexAccountId);
    values.push(invite && invite.plexInviteId);
  });
  return values
    .flatMap(gatherStrings)
    .map(normalizeValue)
    .filter((value) => value);
}

function annotateDonorWithPlex(donor, context) {
  const invites = Array.isArray(donor.invites) ? donor.invites : [];
  const emailCandidates = collectDonorEmailCandidates(donor);
  const idCandidates = collectDonorIdCandidates(donor);
  const emailSet = new Set(emailCandidates);
  const idSet = new Set(idCandidates);
  const index = context && Array.isArray(context.index) ? context.index : [];
  const matchedEntry = index.find((entry) => {
    if (!entry) {
      return false;
    }
    const hasEmailMatch = emailCandidates.some((value) => entry.emails.has(value));
    const hasIdMatch = !hasEmailMatch && idCandidates.some((value) => entry.ids.has(value));
    return hasEmailMatch || hasIdMatch;
  });

  const plexShared = Boolean(matchedEntry && !matchedEntry.pending);
  const plexPendingFromUser = Boolean(matchedEntry && matchedEntry.pending);
  const hasActiveInvite = invites.some(
    (invite) => invite && !invite.revokedAt && (invite.plexInviteId || invite.inviteUrl)
  );
  const plexPending = plexPendingFromUser || (!plexShared && hasActiveInvite);
  const normalizedStatus = normalizeValue(donor.status || '');
  const statusIsRevoked = ['cancelled', 'canceled', 'expired', 'suspended'].includes(
    normalizedStatus
  );
  const statusIsActive = normalizedStatus === 'active';
  const hasEmail = emailSet.size > 0 && normalizeValue(donor.email || '') !== '';
  const canInvite = Boolean(
    context && context.configured && hasEmail && !statusIsRevoked && statusIsActive
  );
  const needsPlexInvite =
    canInvite && !plexShared && !plexPending && !hasActiveInvite;
  const plexShareState = plexShared
    ? 'shared'
    : plexPending
    ? 'pending'
    : 'not_shared';

  return {
    ...donor,
    plexShared,
    plexPending,
    needsPlexInvite,
    plexShareState,
  };
}

async function getPlexContext() {
  if (!plexService.isConfigured()) {
    return { configured: false, users: [], index: [], error: null };
  }
  try {
    const users = await plexService.listUsers();
    const index = preparePlexUserIndex(users);
    return { configured: true, users, index, error: null };
  } catch (err) {
    logger.warn('Failed to load Plex users for admin dashboard', err.message);
    return {
      configured: true,
      users: [],
      index: [],
      error: err && err.message ? String(err.message) : 'Failed to load Plex users',
    };
  }
}

async function buildDonorListWithPlex() {
  const donors = listDonorsWithDetails();
  const plexContext = await getPlexContext();
  const annotatedDonors = donors.map((donor) => annotateDonorWithPlex(donor, plexContext));
  return { donors: annotatedDonors, plexContext };
}

router.use(express.json());
router.use(csrfProtection);
router.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.sessionToken = undefined;

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (res.locals.csrfToken && body.csrfToken === undefined) {
        body.csrfToken = res.locals.csrfToken;
      }

      let sessionToken = res.locals.sessionToken;
      if (sessionToken === undefined) {
        if (req.session && req.session.isAdmin && hasValidSessionToken(req)) {
          sessionToken = ensureSessionToken(req);
        } else {
          sessionToken = null;
        }
      }

      if (body.sessionToken === undefined) {
        body.sessionToken = sessionToken;
      }
    }

    return originalJson(body);
  };

  next();
});

router.get('/session', (req, res) => {
  const authenticated = Boolean(req.session && req.session.isAdmin);
  if (authenticated) {
    res.locals.sessionToken = ensureSessionToken(req);
  } else {
    res.locals.sessionToken = null;
  }
  const account = getAdminAccount();
  res.json({
    authenticated,
    csrfToken: res.locals.csrfToken,
    adminUsername: authenticated ? account.username : null,
  });
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    const providedPassword = typeof password === 'string' ? password : '';
    if (!normalizedUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!providedPassword) {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (!verifyAdminCredentials(normalizedUsername, providedPassword)) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    if (!req.session || typeof req.session.regenerate !== 'function') {
      logger.error('Session is not available for admin login regeneration');
      return res.status(500).json({ error: 'Failed to establish session' });
    }
    return req.session.regenerate((err) => {
      if (err) {
        logger.error('Failed to regenerate admin session', err);
        return res.status(500).json({ error: 'Failed to establish session' });
      }

      req.session.isAdmin = true;

      res.locals.sessionToken = ensureSessionToken(req);

      let csrfToken;
      try {
        csrfToken = req.csrfToken();
      } catch (tokenError) {
        logger.error('Failed to refresh CSRF token after admin login', tokenError);
        return res.status(500).json({ error: 'Failed to establish session' });
      }

      res.locals.csrfToken = csrfToken;
      const account = getAdminAccount();
      logger.info('Admin logged in');
      return res.json({
        success: true,
        csrfToken,
        adminUsername: account.username,
      });
    });
  })
);

router.get(
  '/account',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const account = getAdminAccount();
    res.json({
      username: account.username,
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.put(
  '/account',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { currentPassword, username, newPassword, confirmPassword } = req.body || {};
    const current = typeof currentPassword === 'string' ? currentPassword : '';
    if (!current) {
      return res.status(400).json({ error: 'Current password is required.' });
    }

    if (newPassword || confirmPassword) {
      if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
        return res.status(400).json({ error: 'New password and confirmation are required.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New password and confirmation must match.' });
      }
    }

    try {
      const result = updateAdminCredentials({
        currentPassword: current,
        username,
        newPassword,
      });
      logger.info('Admin credentials updated');
      res.json({
        success: true,
        username: result.username,
        csrfToken: res.locals.csrfToken,
      });
    } catch (err) {
      if (err && err.code === 'INVALID_CURRENT_PASSWORD') {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
      if (err && err.code === 'PASSWORD_TOO_WEAK') {
        return res.status(400).json({ error: err.message || 'New password is too weak.' });
      }
      if (err && err.code === 'CURRENT_PASSWORD_REQUIRED') {
        return res.status(400).json({ error: err.message || 'Current password is required.' });
      }
      logger.error('Failed to update admin credentials', err);
      throw err;
    }
  })
);

router.post(
  '/logout',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.locals.sessionToken = null;
    req.session.destroy(() => {
      res.json({ success: true, csrfToken: res.locals.csrfToken });
    });
  })
);

router.get(
  '/subscribers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { donors, plexContext } = await buildDonorListWithPlex();
    res.json({
      donors,
      plex: {
        configured: plexContext.configured,
        error: plexContext.error,
      },
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.post(
  '/subscribers/:id/refresh',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(donorId) || donorId <= 0) {
      return res.status(400).json({
        error: 'Invalid subscriber ID',
        csrfToken: res.locals.csrfToken,
      });
    }

    const donor = getDonorById(donorId);
    if (!donor) {
      return res.status(404).json({
        error: 'Subscriber not found',
        csrfToken: res.locals.csrfToken,
      });
    }

    const donorForRefresh = donor;
    const { donor: refreshedDonor, error } = await refreshDonorSubscription(
      donorForRefresh,
      {
        onError: (refreshErr) =>
          logger.warn('Failed to refresh PayPal subscription from admin dashboard', {
            donorId: donorForRefresh.id,
            subscriptionId: donorForRefresh.subscriptionId,
            error: refreshErr && refreshErr.message,
          }),
      }
    );

    const donorsWithDetails = listDonorsWithDetails();
    const detailedDonor =
      donorsWithDetails.find((item) => item.id === donorId) ||
      refreshedDonor ||
      donor;

    const normalizedError = error ? String(error) : '';
    const donorPayload = detailedDonor
      ? { ...detailedDonor, paypalRefreshError: normalizedError }
      : null;

    res.json({
      donor: donorPayload,
      error: normalizedError,
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.get(
  '/share-links',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const shareLinks = listShareLinks();
    res.json({ shareLinks, csrfToken: res.locals.csrfToken });
  })
);

router.get(
  '/events',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const events = getRecentEvents(100);
    res.json({ events, csrfToken: res.locals.csrfToken });
  })
);

router.get(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = settingsStore.getSettings();
    res.json({ settings, csrfToken: res.locals.csrfToken });
  })
);

router.put(
  '/settings/:group',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const group = req.params.group;
    const updates = req.body || {};
    try {
      const normalized = settingsStore.updateGroup(group, updates);
      const updatedKeys = Object.keys(updates || {});
      logEvent('settings.updated', { group, keys: updatedKeys });
      logger.info(`Updated settings group: ${group}`);
      res.json({ settings: normalized, csrfToken: res.locals.csrfToken });
    } catch (err) {
      logger.warn(`Failed to update settings for ${group}`, err.message);
      res.status(400).json({
        error: err.message,
        csrfToken: res.locals.csrfToken,
      });
    }
  })
);

router.post(
  '/settings/:group/test',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const group = req.params.group;
    const overrides = req.body || {};

    if (!['paypal', 'smtp', 'plex'].includes(group)) {
      return res.status(404).json({
        error: 'Unknown settings group',
        csrfToken: res.locals.csrfToken,
      });
    }

    try {
      let result;
      if (group === 'paypal') {
        const config = settingsStore.previewGroup('paypal', overrides);
        const verification = await paypalService.verifyConnection(config);
        const environment =
          (config.apiBase || '').includes('sandbox') ? 'sandbox' : 'live';
        result = {
          ...verification,
          environment,
          message: `PayPal credentials verified against the ${environment} environment.`,
        };
      } else if (group === 'smtp') {
        const config = settingsStore.previewGroup('smtp', overrides);
        result = await emailService.verifyConnection(config);
      } else if (group === 'plex') {
        const config = settingsStore.previewGroup('plex', overrides);
        result = await plexService.verifyConnection(config);
      }

      logger.info(`Verified ${group} settings`);
      res.json({ success: true, result, csrfToken: res.locals.csrfToken });
    } catch (err) {
      logger.warn(`Failed to verify ${group} settings`, err.message);
      res.status(400).json({
        success: false,
        error: err.message,
        csrfToken: res.locals.csrfToken,
      });
      }
  })
);

router.post(
  '/announcements/email',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const overrides = req.body && typeof req.body === 'object' ? req.body : null;
    const announcement = settingsStore.getAnnouncementSettings(overrides);
    const subject =
      typeof announcement.bannerTitle === 'string'
        ? announcement.bannerTitle.trim()
        : '';
    const body =
      typeof announcement.bannerBody === 'string'
        ? announcement.bannerBody.trim()
        : '';

    if (!subject || !body) {
      return res.status(400).json({
        error: 'Announcement title and body are required to send an email.',
        csrfToken: res.locals.csrfToken,
      });
    }

    const donors = listDonorsWithDetails();
    const recipients = donors
      .map((donor) => ({
        email: donor && donor.email ? String(donor.email).trim() : '',
        name: donor && donor.name ? String(donor.name).trim() : '',
      }))
      .filter((entry) => entry.email);

    if (recipients.length === 0) {
      return res.status(400).json({
        error: 'No subscribers have an email address on file.',
        csrfToken: res.locals.csrfToken,
      });
    }

    let smtpConfig;
    try {
      smtpConfig = emailService.getSmtpConfig();
    } catch (err) {
      return res.status(400).json({
        error: err.message || 'SMTP configuration is missing',
        csrfToken: res.locals.csrfToken,
      });
    }

    const cta =
      announcement.bannerCtaEnabled &&
      announcement.bannerCtaLabel &&
      announcement.bannerCtaUrl
        ? {
            label: announcement.bannerCtaLabel,
            url: announcement.bannerCtaUrl,
          }
        : null;

    let sentCount = 0;

    try {
      for (const recipient of recipients) {
        // eslint-disable-next-line no-await-in-loop
        await emailService.sendAnnouncementEmail({
          to: recipient.email,
          name: recipient.name,
          subject,
          body,
          cta,
          announcement,
        }, smtpConfig);
        sentCount += 1;
      }
    } catch (err) {
      logger.error('Failed to send announcement email batch', err);
      return res.status(500).json({
        error: err.message || 'Failed to send announcement email.',
        csrfToken: res.locals.csrfToken,
      });
    }

    logEvent('announcement.email.sent', {
      subject,
      recipientCount: sentCount,
      skippedCount: donors.length - recipients.length,
    });

    return res.json({
      success: true,
      sent: sentCount,
      skipped: donors.length - recipients.length,
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.get(
  '/settings/paypal/plan',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const paypalSettings = settingsStore.getPaypalSettings();
    if (!paypalSettings.planId) {
      return res.json({
        plan: null,
        product: null,
        manageUrl: '',
        csrfToken: res.locals.csrfToken,
      });
    }

    try {
      const plan = await paypalService.getPlan(paypalSettings.planId, paypalSettings);
      let product = null;
      if (plan && plan.product_id) {
        try {
          product = await paypalService.getProduct(plan.product_id, paypalSettings);
        } catch (err) {
          if (!err || err.status !== 404) {
            throw err;
          }
        }
      }

      const manageUrl = paypalService.getPlanManagementUrl(
        paypalSettings.planId,
        paypalSettings
      );

      res.json({
        plan,
        product,
        manageUrl,
        csrfToken: res.locals.csrfToken,
      });
    } catch (err) {
      logger.warn(
        `Failed to load PayPal plan ${paypalSettings.planId}`,
        err.message
      );

      if (err && err.status === 404) {
        return res.json({
          plan: null,
          product: null,
          manageUrl: '',
          error: 'PayPal could not find the configured billing plan. Generate a new plan to continue.',
          csrfToken: res.locals.csrfToken,
        });
      }

      res.status(400).json({
        error: err.message,
        csrfToken: res.locals.csrfToken,
      });
    }
  })
);

router.post(
  '/settings/paypal/plan',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const overrides = req.body || {};
    const preview = settingsStore.previewGroup('paypal', overrides);

    try {
      const result = await paypalService.generateSubscriptionPlan(
        {
          price: preview.subscriptionPrice,
          currency: preview.currency,
          existingProductId: preview.productId,
        },
        preview
      );

      const updatedSettings = settingsStore.updateGroup('paypal', {
        planId: result.planId,
        productId: result.productId,
        subscriptionPrice: preview.subscriptionPrice,
        currency: preview.currency,
      });

      logEvent('paypal.plan.generated', {
        planId: result.planId,
        productId: result.productId,
        price: result.priceValue,
        currency: result.currencyCode,
      });
      logger.info(`Generated PayPal billing plan ${result.planId}`);

      const manageUrl = paypalService.getPlanManagementUrl(
        result.planId,
        updatedSettings
      );

      res.json({
        plan: result.plan,
        product: result.product,
        manageUrl,
        settings: updatedSettings,
        csrfToken: res.locals.csrfToken,
      });
    } catch (err) {
      logger.warn('Failed to generate PayPal subscription plan', err.message);
      res.status(400).json({
        error: err.message,
        csrfToken: res.locals.csrfToken,
      });
    }
  })
);

router.post(
  '/subscribers/:id/invite',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    const donor = getDonorById(donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    if (!donor.email) {
      return res.status(400).json({ error: 'Subscriber is missing email' });
    }

    if (!plexService.isConfigured()) {
      return res.status(400).json({
        error: 'Configure Plex settings before sending invites.',
        csrfToken: res.locals.csrfToken,
      });
    }

    const note = typeof req.body === 'object' && req.body !== null ? req.body.note : '';
    const normalizedNote = typeof note === 'string' ? note.trim() : '';

    let plexInvite;
    try {
      plexInvite = await plexService.createInvite({
        email: donor.email,
        friendlyName: donor.name || donor.email,
      });
    } catch (err) {
      logger.error('Failed to create Plex invite for donor', {
        donorId: donor.id,
        error: err && err.message,
      });
      return res.status(502).json({
        error: err && err.message ? `Plex invite failed: ${err.message}` : 'Failed to create Plex invite',
        csrfToken: res.locals.csrfToken,
      });
    }

    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      inviteId: plexInvite && plexInvite.inviteId,
      inviteUrl: plexInvite && plexInvite.inviteUrl,
      inviteStatus: plexInvite && plexInvite.status,
      invitedAt: plexInvite && plexInvite.invitedAt,
      sharedLibraries: plexInvite && plexInvite.sharedLibraries,
      note: normalizedNote,
      recipientEmail: donor.email,
      plexEmail: donor.email,
    });

    logEvent('plex.invite.admin_sent', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      plexInviteId: inviteRecord.plexInviteId,
      note: normalizedNote || undefined,
    });
    logger.info('Created Plex invite for donor', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      plexInviteId: inviteRecord.plexInviteId,
    });

    const { donors, plexContext } = await buildDonorListWithPlex();
    const annotatedDonor = donors.find((item) => item.id === donor.id) || null;

    res.json({
      invite: inviteRecord,
      donor: annotatedDonor,
      message: `Plex invite created for ${donor.email}.`,
      plex: {
        configured: plexContext.configured,
        error: plexContext.error,
      },
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.post(
  '/subscribers/:id/share-link',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    const donor = getDonorById(donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    let shareLink = getShareLinkByDonorId(donor.id);
    const regenerate = Boolean(req.body && req.body.regenerate);

    if (!shareLink || regenerate) {
      const token = nanoid(36);
      const sessionToken = nanoid(48);
      shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token,
        sessionToken,
      });
      logEvent('share_link.generated', {
        donorId: donor.id,
        shareLinkId: shareLink.id,
        regenerated: Boolean(shareLink && regenerate),
      });
      logger.info('Created shareable invite link for donor', {
        donorId: donor.id,
        shareLinkId: shareLink.id,
      });
    }

    const origin = resolvePublicBaseUrl(req);
    const url = `${origin}/share/${shareLink.token}`;

    return res.json({
      shareLink: { ...shareLink, url },
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.delete(
  '/share-links/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const linkId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(linkId) || linkId <= 0) {
      return res.status(400).json({
        error: 'Invalid share link ID',
        csrfToken: res.locals.csrfToken,
      });
    }

    const shareLink = getShareLinkById(linkId);
    if (!shareLink) {
      return res.status(404).json({
        error: 'Share link not found',
        csrfToken: res.locals.csrfToken,
      });
    }

    const removed = deleteShareLinkById(linkId);
    if (!removed) {
      return res.status(500).json({
        error: 'Failed to remove share link',
        csrfToken: res.locals.csrfToken,
      });
    }

    logEvent('share_link.deleted', {
      shareLinkId: shareLink.id,
      donorId: shareLink.donorId || null,
      prospectId: shareLink.prospectId || null,
    });
    logger.info('Deleted shareable invite link', {
      shareLinkId: shareLink.id,
      donorId: shareLink.donorId || null,
      prospectId: shareLink.prospectId || null,
    });

    return res.json({ success: true, csrfToken: res.locals.csrfToken });
  })
);

router.post(
  '/share-links/prospect',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const note =
      payload && typeof payload.note === 'string' ? payload.note.trim() : '';
    const email =
      payload && typeof payload.email === 'string' ? payload.email.trim() : '';
    const name =
      payload && typeof payload.name === 'string' ? payload.name.trim() : '';
    const prospectIdRaw = payload && payload.prospectId;
    const regenerate = Boolean(payload && payload.regenerate);

    let prospect = null;
    const parsedProspectId = Number.parseInt(prospectIdRaw, 10);
    if (Number.isFinite(parsedProspectId) && parsedProspectId > 0) {
      const existing = getProspectById(parsedProspectId);
      if (!existing) {
        return res.status(404).json({ error: 'Prospect not found' });
      }
      prospect = updateProspect(parsedProspectId, { email, name, note });
    }

    if (!prospect) {
      prospect = createProspect({ email, name, note });
    }

    let shareLink = getShareLinkByProspectId(prospect.id);
    const hadExistingLink = Boolean(shareLink);

    if (!shareLink || regenerate) {
      const token = nanoid(36);
      const sessionToken = nanoid(48);
      shareLink = createOrUpdateShareLink({
        prospectId: prospect.id,
        token,
        sessionToken,
      });
      const wasRegenerated = hadExistingLink && regenerate;
      logEvent('share_link.generated', {
        prospectId: prospect.id,
        shareLinkId: shareLink.id,
        regenerated: wasRegenerated,
      });
      logger.info('Created shareable invite link for prospect', {
        prospectId: prospect.id,
        shareLinkId: shareLink.id,
        regenerated: wasRegenerated,
      });
    }

    const origin = resolvePublicBaseUrl(req);
    const url = `${origin}/share/${shareLink.token}`;

    return res.json({
      prospect,
      shareLink: { ...shareLink, url },
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.post(
  '/subscribers/:id/email',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    const donor = getDonorById(donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    const invite = getLatestActiveInviteForDonor(donor.id);
    if (!invite || !invite.inviteUrl) {
      return res.status(400).json({ error: 'No active invite to email' });
    }

    await emailService.sendInviteEmail({
      to: invite.recipientEmail || donor.email,
      inviteUrl: invite.inviteUrl,
      name: donor.name,
      subscriptionId: donor.subscriptionId,
    });
    markInviteEmailSent(invite.id);
    logEvent('invite.resent', { donorId: donor.id, inviteId: invite.id });

    res.json({ success: true, csrfToken: res.locals.csrfToken });
  })
);

router.post(
  '/subscribers/:id/revoke',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    const donor = getDonorById(donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    const invite = getLatestActiveInviteForDonor(donor.id);
    if (!invite) {
      return res.status(400).json({ error: 'No invite to revoke' });
    }

    if (invite.plexInviteId) {
      try {
        await plexService.cancelInvite(invite.plexInviteId);
      } catch (err) {
        logger.warn('Failed to cancel Plex invite', err.message);
      }
    }

    revokeInviteRecord(invite.id);

    if (plexService.isConfigured()) {
      try {
        const result = await plexService.revokeUserByEmail(donor.email);
        if (result.success) {
          markPlexRevoked(invite.id);
        }
      } catch (err) {
        logger.warn('Failed to revoke Plex access', err.message);
      }
    }

    logEvent('invite.revoked', { donorId: donor.id, inviteId: invite.id });

    res.json({ success: true, csrfToken: res.locals.csrfToken });
  })
);

router.delete(
  '/subscribers/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    const donor = getDonorById(donorId);

    if (!donor) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    const removed = deleteDonorById(donor.id);
    if (!removed) {
      return res.status(500).json({ error: 'Failed to remove subscriber' });
    }

    logEvent('subscriber.removed', {
      donorId: donor.id,
      email: donor.email,
    });

    res.json({ success: true, csrfToken: res.locals.csrfToken });
  })
);

module.exports = router;
