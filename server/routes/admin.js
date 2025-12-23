const express = require('express');
const csurf = require('csurf');
const { authLimiter } = require('../middleware/rate-limit');
const { nanoid } = require('../utils/nanoid-shim');
const {
  listDonorsWithDetails,
  getDonorById,
  markInviteEmailSent,
  getLatestActiveInviteForDonor,
  getLatestInviteForDonor,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  updateDonorPlexIdentity,
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
  listSupportRequests,
  getSupportThreadById,
  markSupportRequestResolved,
  deleteSupportRequestById,
  addSupportMessageToRequest,
  listInvitesForDonor,
} = require('../db');
const { requireAdmin } = require('../middleware/auth');
const paypalService = require('../services/paypal');
const stripeService = require('../services/stripe');
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
const {
  normalizeValue,
  collectDonorEmailCandidates,
  collectDonorIdCandidates,
  annotateDonorWithPlex,
  loadPlexContext,
} = require('../utils/plex');

function notifyDonorOfSupportReply(thread) {
  if (!thread || !thread.request || !Array.isArray(thread.messages)) {
    return;
  }
  const latestMessage = thread.messages[thread.messages.length - 1];
  if (!latestMessage) {
    return;
  }
  const donorId = thread.request.donorId;
  if (!donorId) {
    return;
  }
  const donor = getDonorById(donorId);
  if (!donor || !donor.email) {
    return;
  }
  emailService
    .sendSupportResponseNotification({
      request: thread.request,
      message: latestMessage,
      donor,
    })
    .catch((err) => {
      logger.warn('Failed to send donor support notification email', {
        donorId,
        requestId: thread.request && thread.request.id,
        error: err && err.message,
      });
    });
}

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

function resolveEnvironmentTimezone() {
  const configured =
    typeof process.env.TZ === 'string' ? process.env.TZ.trim() : '';
  if (configured) {
    return configured;
  }

  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    if (resolved && resolved.timeZone) {
      return resolved.timeZone;
    }
  } catch (err) {
    /* noop */
  }

  return null;
}

async function buildDonorListWithPlex() {
  const donors = listDonorsWithDetails();
  const plexContext = await loadPlexContext({ logContext: 'admin dashboard' });
  const annotatedDonors = donors.map((donor) => annotateDonorWithPlex(donor, plexContext));
  return { donors: annotatedDonors, plexContext };
}

function buildPlexRevocationContext(donor) {
  const invites = listInvitesForDonor(donor.id);
  const activeInvite = invites.find((invite) => invite && !invite.revokedAt) || null;
  const latestInvite = getLatestInviteForDonor(donor.id);
  const inviteForPlex = activeInvite || latestInvite || null;
  const donorForCandidates = { ...donor, invites };
  const emailCandidates = collectDonorEmailCandidates(donorForCandidates);
  const idCandidates = collectDonorIdCandidates(donorForCandidates);

  return {
    invites,
    activeInvite,
    inviteForPlex,
    plexAccountId: idCandidates.length > 0 ? idCandidates[0] : null,
    plexEmail: emailCandidates.length > 0 ? emailCandidates[0] : null,
  };
}

async function revokePlexAccessForDonor(donor, context) {
  const revocationContext = context || buildPlexRevocationContext(donor);

  if (!plexService.isConfigured()) {
    return { success: false, skipped: true, reason: 'plex_not_configured' };
  }

  const { plexAccountId, plexEmail, inviteForPlex } = revocationContext;
  if (!plexAccountId && !plexEmail) {
    return { success: false, skipped: true, reason: 'missing_identifier' };
  }

  try {
    const result = await plexService.revokeUser({
      plexAccountId: plexAccountId || undefined,
      email: plexEmail || undefined,
    });

    const success = Boolean(result && result.success);
    if (success && inviteForPlex) {
      markPlexRevoked(inviteForPlex.id);
    }

    if (success) {
      // Clear Plex identity from donor record
      updateDonorPlexIdentity(donor.id, {
        plexAccountId: null,
        plexEmail: null,
      });

      logEvent('plex.access.revoked', {
        donorId: donor.id,
        email: plexEmail || donor.email,
        plexAccountId: plexAccountId || donor.plexAccountId,
        inviteId: inviteForPlex ? inviteForPlex.id : null,
        reason: 'admin_manual_revoke',
      });
    }

    return { ...result, success };
  } catch (err) {
    logger.warn('Failed to revoke Plex access', err.message);
    return { success: false, reason: err.message };
  }
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
  const timezone = resolveEnvironmentTimezone();
  res.json({
    authenticated,
    csrfToken: res.locals.csrfToken,
    adminUsername: authenticated ? account.username : null,
    timezone,
  });
});

router.post(
  '/login',
  authLimiter,
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
        timezone: resolveEnvironmentTimezone(),
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
    logger.info('[REFRESH ENDPOINT HIT]', { donorId, rawId: req.params.id });

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

    logger.info('[REFRESH ENDPOINT] Donor found', {
      donorId: donor.id,
      email: donor.email,
      hasPlexAccountId: !!donor.plexAccountId,
      hasPlexEmail: !!donor.plexEmail
    });

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

    // Also sync Plex status for this donor
    let plexWasCleared = false;
    logger.info('[REFRESH DEBUG] Starting Plex sync check', {
      donorId,
      plexConfigured: plexService.isConfigured(),
    });

    if (plexService.isConfigured()) {
      // Get fresh donor data to check current Plex fields
      const freshDonor = getDonorById(donorId);
      logger.info('[REFRESH DEBUG] Fresh donor data', {
        donorId,
        hasPlexAccountId: !!freshDonor?.plexAccountId,
        hasPlexEmail: !!freshDonor?.plexEmail,
        plexAccountId: freshDonor?.plexAccountId,
        plexEmail: freshDonor?.plexEmail,
      });

      if (freshDonor && (freshDonor.plexAccountId || freshDonor.plexEmail)) {
        try {
          logger.info('[REFRESH DEBUG] Fetching current Plex shares...');
          const plexResult = await plexService.getCurrentPlexShares();
          logger.info('[REFRESH DEBUG] Plex shares result', {
            success: plexResult.success,
            shareCount: plexResult.shares?.length || 0,
            shares: plexResult.shares,
          });

          if (plexResult.success) {
            const hasShare = plexService.checkDonorHasPlexShare(freshDonor, plexResult.shares);
            logger.info('[REFRESH DEBUG] Donor share check result', {
              donorId: freshDonor.id,
              hasShare,
              donorPlexAccountId: freshDonor.plexAccountId,
              donorPlexEmail: freshDonor.plexEmail,
            });

            if (!hasShare) {
              // Donor doesn't have a current share, clear their Plex fields
              logger.info('[REFRESH DEBUG] CLEARING PLEX FIELDS - donor has no share', {
                donorId: freshDonor.id,
                email: freshDonor.email,
              });
              updateDonorPlexIdentity(freshDonor.id, {
                plexAccountId: null,
                plexEmail: null,
              });
              plexWasCleared = true;
              logger.info('Cleared stale Plex data during refresh', {
                donorId: freshDonor.id,
                email: freshDonor.email,
              });
            } else {
              logger.info('[REFRESH DEBUG] Donor still has active share, keeping Plex fields', {
                donorId: freshDonor.id,
              });
            }
          }
        } catch (plexErr) {
          logger.warn('[REFRESH DEBUG] Failed to sync Plex status during refresh', {
            donorId: donorId,
            error: plexErr.message,
            stack: plexErr.stack,
          });
        }
      } else {
        logger.info('[REFRESH DEBUG] Donor has no Plex fields to check');
      }
    } else {
      logger.info('[REFRESH DEBUG] Plex is not configured');
    }

    // Get updated donor list AFTER potential Plex sync
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

    if (!['paypal', 'stripe', 'smtp', 'plex'].includes(group)) {
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
      } else if (group === 'stripe') {
        const config = settingsStore.previewGroup('stripe', overrides);
        result = await stripeService.verifyConnection(config);
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

    const normalizedStatus = normalizeValue(donor.status || '');
    if (normalizedStatus !== 'active') {
      return res.status(403).json({
        error: 'Only subscribers with an active status can receive Plex invites.',
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
        invitedId: donor.plexAccountId || undefined,
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

router.get(
  '/support',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.locals.sessionToken = ensureSessionToken(req);
    const includeResolvedParam = String(req.query.includeResolved || '').trim();
    const includeResolved = includeResolvedParam
      ? !['0', 'false', 'no'].includes(includeResolvedParam.toLowerCase())
      : true;
    const requests = listSupportRequests({ includeResolved });
    const threads = requests
      .map((request) => getSupportThreadById(request.id))
      .filter(Boolean);
    res.json({ threads });
  })
);

router.get(
  '/support/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.locals.sessionToken = ensureSessionToken(req);
    const requestId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid support request id' });
    }
    const thread = getSupportThreadById(requestId);
    if (!thread) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    res.json({ thread });
  })
);

router.post(
  '/support/:id/replies',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.locals.sessionToken = ensureSessionToken(req);
    const requestId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid support request id' });
    }
    const existingThread = getSupportThreadById(requestId);
    if (!existingThread) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    const { message, authorName } = req.body || {};
    const adminName = typeof authorName === 'string' && authorName.trim()
      ? authorName.trim()
      : 'Admin';
    let thread;
    try {
      thread = addSupportMessageToRequest({
        requestId,
        donorId: existingThread.request.donorId,
        authorRole: 'admin',
        authorName: adminName,
        message,
      });
    } catch (err) {
      return res.status(400).json({
        error: err && err.message ? String(err.message) : 'Failed to send reply',
      });
    }
    if (!thread) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    notifyDonorOfSupportReply(thread);
    res.status(201).json({ thread });
  })
);

router.post(
  '/support/:id/resolve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.locals.sessionToken = ensureSessionToken(req);
    const requestId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid support request id' });
    }
    const { resolved = true } = req.body || {};
    const normalized = typeof resolved === 'string'
      ? !['0', 'false', 'no'].includes(resolved.trim().toLowerCase())
      : Boolean(resolved);
    const thread = markSupportRequestResolved(requestId, normalized);
    if (!thread) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    res.json({ thread });
  })
);

router.delete(
  '/support/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.locals.sessionToken = ensureSessionToken(req);
    const requestId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid support request id' });
    }
    const deleted = deleteSupportRequestById(requestId);
    if (!deleted) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    res.status(204).end();
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

    const revocationContext = buildPlexRevocationContext(donor);
    const invite = revocationContext.activeInvite;

    if (!invite && !plexService.isConfigured()) {
      return res.status(400).json({
        error: 'No active invite to revoke and Plex integration is not configured.',
      });
    }

    if (invite && invite.plexInviteId) {
      try {
        await plexService.cancelInvite(invite.plexInviteId);
      } catch (err) {
        logger.warn('Failed to cancel Plex invite', err.message);
      }
    }

    if (invite) {
      revokeInviteRecord(invite.id);
      logEvent('invite.revoked', { donorId: donor.id, inviteId: invite.id });
    }

    const plexResult = await revokePlexAccessForDonor(donor, revocationContext);

    if (!invite && !plexResult.success) {
      let message;
      if (plexResult.reason === 'missing_identifier') {
        message = 'Unable to determine which Plex account to revoke.';
      } else if (plexResult.reason === 'plex_not_configured') {
        message = 'Configure Plex settings before revoking access.';
      } else {
        message = plexResult.reason || 'Unable to revoke access for this subscriber.';
      }

      return res.status(400).json({ error: message });
    }

    const { donors, plexContext } = await buildDonorListWithPlex();
    const updatedDonor = donors.find((item) => item.id === donor.id) || null;

    const messageParts = [];
    if (invite) {
      messageParts.push('Invite revoked');
    }
    if (plexResult && plexResult.success) {
      messageParts.push('Plex access revoked');
    }

    res.json({
      success: Boolean(invite || (plexResult && plexResult.success)),
      message: messageParts.length > 0 ? `${messageParts.join(' and ')}.` : undefined,
      donor: updatedDonor,
      plex: {
        configured: plexContext.configured,
        error: plexContext.error,
      },
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.post(
  '/subscribers/:id/revoke-plex',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donorId = Number.parseInt(req.params.id, 10);
    const donor = getDonorById(donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }

    const revocationContext = buildPlexRevocationContext(donor);
    const plexResult = await revokePlexAccessForDonor(donor, revocationContext);

    if (!plexResult || !plexResult.success) {
      let message;
      if (plexResult && plexResult.reason === 'missing_identifier') {
        message = 'Unable to determine which Plex account to revoke.';
      } else if (plexResult && plexResult.reason === 'plex_not_configured') {
        message = 'Configure Plex settings before revoking access.';
      } else {
        message =
          (plexResult && plexResult.reason) ||
          'Unable to revoke Plex access for this subscriber.';
      }

      const status = plexResult && plexResult.skipped ? 400 : 502;
      return res.status(status).json({ error: message });
    }

    const { donors, plexContext } = await buildDonorListWithPlex();
    const updatedDonor = donors.find((item) => item.id === donor.id) || null;

    res.json({
      success: true,
      message: 'Plex access revoked.',
      donor: updatedDonor,
      plex: {
        configured: plexContext.configured,
        error: plexContext.error,
      },
      csrfToken: res.locals.csrfToken,
    });
  })
);

router.post(
  '/plex/sync-status-now',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!plexService.isConfigured()) {
      return res.status(400).json({ error: 'Plex is not configured' });
    }

    try {
      // Get all current shares from Plex
      const plexResult = await plexService.getCurrentPlexShares();
      if (!plexResult.success) {
        return res.status(502).json({ error: plexResult.reason || 'Failed to fetch Plex shares' });
      }

      const currentShares = plexResult.shares;
      logger.info(`Syncing Plex status - found ${currentShares.length} current shares on Plex server`);

      // Log what shares we found
      logger.info('[SYNC DEBUG] Current Plex shares:', JSON.stringify(currentShares.map(s => ({
        id: s.id,
        emails: s.emails,
        userIds: s.userIds,
        status: s.status
      })), null, 2));

      // Get all donors with Plex fields set
      const allDonors = listDonorsWithDetails();

      // Log ALL donors first to see what we're working with
      logger.info(`[SYNC DEBUG] Total donors in database: ${allDonors.length}`);
      logger.info('[SYNC DEBUG] ALL donors:', JSON.stringify(allDonors.map(d => ({
        id: d.id,
        email: d.email,
        plexEmail: d.plexEmail,
        plexAccountId: d.plexAccountId,
        plexEmailType: typeof d.plexEmail,
        plexAccountIdType: typeof d.plexAccountId
      })), null, 2));

      const donorsWithPlex = allDonors.filter(
        (d) => d.plexAccountId || d.plexEmail
      );

      logger.info(`[SYNC DEBUG] Found ${donorsWithPlex.length} donors with Plex fields (after filter)`);
      logger.info('[SYNC DEBUG] Donors with Plex:', JSON.stringify(donorsWithPlex.map(d => ({
        id: d.id,
        email: d.email,
        plexEmail: d.plexEmail,
        plexAccountId: d.plexAccountId
      })), null, 2));

      let clearedCount = 0;
      const clearedDonors = [];

      // Check each donor against current Plex shares
      for (const donor of donorsWithPlex) {
        const hasShare = plexService.checkDonorHasPlexShare(donor, currentShares);

        logger.info(`[SYNC DEBUG] Checking donor ${donor.id} (email: ${donor.email}, plexEmail: ${donor.plexEmail}, plexAccountId: ${donor.plexAccountId}) - hasShare: ${hasShare}`);

        // If donor doesn't have a current share, clear their Plex fields
        if (!hasShare) {
          updateDonorPlexIdentity(donor.id, {
            plexAccountId: null,
            plexEmail: null,
          });

          clearedCount++;
          clearedDonors.push({
            id: donor.id,
            email: donor.email,
            name: donor.name,
          });

          logger.info(`Cleared stale Plex data for donor ${donor.id} (${donor.email || donor.name})`);

          logEvent('plex.access.synced', {
            donorId: donor.id,
            email: donor.email,
            action: 'cleared_stale_data',
          });
        }
      }

      // Return updated donor list
      const { donors, plexContext } = await buildDonorListWithPlex();

      res.json({
        success: true,
        message: `Synced Plex status. Cleared ${clearedCount} stale record(s).`,
        totalShares: currentShares.length,
        donorsChecked: donorsWithPlex.length,
        clearedCount,
        clearedDonors,
        donors,
        plex: {
          configured: plexContext.configured,
          error: plexContext.error,
        },
        csrfToken: res.locals.csrfToken,
      });
    } catch (err) {
      logger.error('Failed to sync Plex status', err);
      res.status(502).json({ error: err.message });
    }
  })
);

router.post(
  '/plex/sync-status',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!plexService.isConfigured()) {
      return res.status(400).json({ error: 'Plex is not configured' });
    }

    try {
      // Get all current shares from Plex
      const plexResult = await plexService.getCurrentPlexShares();
      if (!plexResult.success) {
        return res.status(502).json({ error: plexResult.reason || 'Failed to fetch Plex shares' });
      }

      const currentShares = plexResult.shares;

      // Get all donors with Plex fields set
      const allDonors = listDonorsWithDetails();
      const donorsWithPlex = allDonors.filter(
        (d) => d.plexAccountId || d.plexEmail
      );

      let clearedCount = 0;
      const clearedDonors = [];

      // Check each donor against current Plex shares
      for (const donor of donorsWithPlex) {
        const normalizedEmail = donor.plexEmail ? donor.plexEmail.toLowerCase().trim() : '';
        const normalizedAccountId = donor.plexAccountId ? String(donor.plexAccountId).toLowerCase().trim() : '';

        // Check if donor has a current share
        const hasShare = currentShares.some((share) => {
          // Check by email
          if (normalizedEmail && share.emails) {
            const shareHasEmail = share.emails.some(
              (email) => email.toLowerCase().trim() === normalizedEmail
            );
            if (shareHasEmail) return true;
          }

          // Check by user ID
          if (normalizedAccountId && share.userIds) {
            const shareHasId = share.userIds.some(
              (id) => String(id).toLowerCase().trim() === normalizedAccountId
            );
            if (shareHasId) return true;
          }

          return false;
        });

        // If donor doesn't have a current share, clear their Plex fields
        if (!hasShare) {
          updateDonorPlexIdentity(donor.id, {
            plexAccountId: null,
            plexEmail: null,
          });

          clearedCount++;
          clearedDonors.push({
            id: donor.id,
            email: donor.email,
            name: donor.name,
          });

          logger.info(`Cleared stale Plex data for donor ${donor.id} (${donor.email || donor.name})`);

          logEvent('plex.access.synced', {
            donorId: donor.id,
            email: donor.email,
            action: 'cleared_stale_data',
          });
        }
      }

      res.json({
        success: true,
        message: `Synced Plex status. Cleared ${clearedCount} stale record(s).`,
        totalShares: currentShares.length,
        donorsChecked: donorsWithPlex.length,
        clearedCount,
        clearedDonors,
      });
    } catch (err) {
      logger.error('Failed to sync Plex status', err);
      res.status(502).json({ error: err.message });
    }
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

    // Revoke Plex access before removing from database
    if (plexService.isConfigured() && (donor.plexAccountId || donor.plexEmail || donor.email)) {
      try {
        const result = await plexService.revokeUser({
          plexAccountId: donor.plexAccountId,
          email: donor.plexEmail || donor.email,
        });
        if (result.success) {
          logger.info('Revoked Plex access for removed user', {
            donorId: donor.id,
            email: donor.email,
          });
          logEvent('plex.access.revoked', {
            donorId: donor.id,
            email: donor.email,
            plexAccountId: donor.plexAccountId,
            reason: 'admin_removed_user',
          });
        } else {
          logger.warn('Failed to revoke Plex access for removed user', {
            donorId: donor.id,
            reason: result.reason,
          });
        }
      } catch (err) {
        logger.warn('Error revoking Plex access during user removal', {
          donorId: donor.id,
          error: err.message,
        });
      }
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
