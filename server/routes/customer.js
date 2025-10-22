const express = require('express');
const { nanoid } = require('nanoid');
const {
  getDonorById,
  getLatestActiveInviteForDonor,
  getLatestInviteForDonor,
  createInvite: createInviteRecord,
  createProspect,
  createOrUpdateShareLink,
  logEvent,
  updateDonorContact,
  getDonorAuthByEmail,
  updateDonorSubscriptionId,
  updateDonorPlexIdentity,
  clearDonorPlexIdentity,
  updateInvitePlexDetails,
  getDonorEmailVerificationToken,
  markDonorEmailVerified,
  markEmailVerificationTokenUsed,
  clearDonorEmailVerificationTokens,
  createSupportRequest,
  addSupportMessageToRequest,
  listSupportRequests,
  getSupportThreadForDonor,
  startDonorTrial,
} = require('../db');
const settingsStore = require('../state/settings');
const paypalService = require('../services/paypal');
const emailService = require('../services/email');
const logger = require('../utils/logger');
const { verifyPassword } = require('../utils/passwords');
const {
  getSubscriptionCheckoutUrl,
  getPaypalEnvironment,
  isSubscriptionCheckoutConfigured,
  buildSubscriberDetails,
} = require('../utils/paypal');
const plexOAuth = require('../services/plex-oauth');
const {
  ensureSessionToken,
  hasValidSessionToken,
} = require('../utils/session-tokens');
const {
  evaluateInviteCooldown,
  getInviteCreatedAtMs,
} = require('../utils/invite-cooldown');
const {
  normalizeSubscriptionId,
  isValidSubscriptionId,
  needsSubscriptionRefresh,
  refreshDonorSubscription,
} = require('../utils/donor-subscriptions');

const router = express.Router();

const PLEX_LINK_EXPIRY_GRACE_MS = 60 * 1000;
const ANNOUNCEMENT_TONES = new Set([
  'info',
  'success',
  'warning',
  'danger',
  'neutral',
]);

function resolveSupportDisplayName(donor, preferred) {
  const trimmedPreferred = typeof preferred === 'string' ? preferred.trim() : '';
  if (trimmedPreferred) {
    return trimmedPreferred;
  }
  if (donor && donor.name) {
    return donor.name;
  }
  if (donor && donor.email) {
    return donor.email;
  }
  return 'Supporter';
}

function notifyAdminOfSupportUpdate({ thread, donor, type }) {
  if (!thread || !thread.request || !Array.isArray(thread.messages)) {
    return;
  }
  const latestMessage = thread.messages[thread.messages.length - 1];
  if (!latestMessage) {
    return;
  }
  emailService
    .sendSupportRequestNotification({
      request: thread.request,
      message: latestMessage,
      donor,
      type,
    })
    .catch((err) => {
      logger.warn('Failed to send support notification email', {
        donorId: donor && donor.id,
        requestId: thread.request && thread.request.id,
        error: err && err.message,
      });
    });
}

function sanitizeAnnouncement(settings) {
  const announcementSettings = settings || {};
  const enabled = Boolean(announcementSettings.bannerEnabled);
  const title = typeof announcementSettings.bannerTitle === 'string'
    ? announcementSettings.bannerTitle.trim()
    : '';
  const body = typeof announcementSettings.bannerBody === 'string'
    ? announcementSettings.bannerBody.trim()
    : '';
  const dismissible = Boolean(announcementSettings.bannerDismissible);
  const ctaEnabled = Boolean(announcementSettings.bannerCtaEnabled);
  const ctaLabel = typeof announcementSettings.bannerCtaLabel === 'string'
    ? announcementSettings.bannerCtaLabel.trim()
    : '';
  const ctaUrl = typeof announcementSettings.bannerCtaUrl === 'string'
    ? announcementSettings.bannerCtaUrl.trim()
    : '';
  const ctaOpenInNewTab = Boolean(announcementSettings.bannerCtaOpenInNewTab);
  const toneRaw = typeof announcementSettings.bannerTone === 'string'
    ? announcementSettings.bannerTone.trim().toLowerCase()
    : '';
  const tone = ANNOUNCEMENT_TONES.has(toneRaw) ? toneRaw : 'info';

  const cta = ctaEnabled && ctaLabel && ctaUrl
    ? {
        label: ctaLabel,
        url: ctaUrl,
        openInNewTab: ctaOpenInNewTab,
      }
    : null;

  return {
    enabled,
    title,
    body,
    tone,
    dismissible,
    cta,
  };
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.use(express.json());
router.use((req, res, next) => {
  res.locals.sessionToken = undefined;

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      let sessionToken = res.locals.sessionToken;
      if (sessionToken === undefined) {
        if (req.session && req.session.customerId && hasValidSessionToken(req)) {
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

function resolvePublicBaseUrl(req) {
  let configured = '';
  try {
    const appSettings = settingsStore.getAppSettings();
    configured =
      appSettings && appSettings.publicBaseUrl
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

function buildShareInviteDetails(shareInvite, origin) {
  if (!shareInvite) {
    return null;
  }

  const details = {
    id: shareInvite.id,
    token: shareInvite.token,
    createdAt: shareInvite.createdAt || null,
    lastUsedAt: shareInvite.lastUsedAt || null,
    expiresAt: shareInvite.expiresAt || null,
    usedAt: shareInvite.usedAt || null,
  };

  if (origin) {
    details.inviteUrl = `${origin}/share/${shareInvite.token}`;
  }

  return details;
}

function isShareInviteExpired(shareInvite) {
  if (!shareInvite || !shareInvite.expiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(shareInvite.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return Date.now() >= expiresAtMs;
}

function isShareInviteUsed(shareInvite) {
  if (!shareInvite) {
    return false;
  }
  if (!shareInvite.usedAt) {
    return false;
  }

  const usedAtMs = Date.parse(shareInvite.usedAt);
  if (!Number.isFinite(usedAtMs)) {
    return Boolean(shareInvite.usedAt);
  }

  return true;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  if (!email) {
    return false;
  }
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function hasPlexLink(donor) {
  return Boolean(donor && donor.plexAccountId);
}

function plexEmailsMatch(donor) {
  if (!donor || !donor.plexAccountId) {
    return false;
  }
  const plexEmail = normalizeEmail(donor.plexEmail);
  const contactEmail = normalizeEmail(donor.email);
  if (!plexEmail || !contactEmail) {
    return true;
  }
  return plexEmail === contactEmail;
}

function requiresPlexRelink(donor) {
  if (!donor || !donor.plexAccountId) {
    return false;
  }
  if (!donor.plexEmail || !donor.email) {
    return false;
  }
  return normalizeEmail(donor.plexEmail) !== normalizeEmail(donor.email);
}

function getActivePlexLinkSession(req, donor) {
  if (!req.session || !req.session.plexLink) {
    return null;
  }
  const link = req.session.plexLink;
  if (!link || !donor || link.donorId !== donor.id) {
    return null;
  }
  if (link.expiresAt) {
    const expiresAtMs = Date.parse(link.expiresAt);
    if (
      Number.isFinite(expiresAtMs) &&
      Date.now() > expiresAtMs + PLEX_LINK_EXPIRY_GRACE_MS
    ) {
      delete req.session.plexLink;
      return null;
    }
  }
  return link;
}

function getPendingPlexLink(req, donor) {
  const link = getActivePlexLinkSession(req, donor);
  if (!link) {
    return null;
  }
  return {
    code: link.code || '',
    authUrl: link.authUrl || '',
    expiresAt: link.expiresAt || null,
    pollIntervalMs:
      link.pollIntervalMs || plexOAuth.DEFAULT_POLL_INTERVAL_MS,
  };
}

function getMostRecentInvite(activeInvite, latestInvite) {
  if (activeInvite && latestInvite) {
    const activeCreatedAt = getInviteCreatedAtMs(activeInvite);
    const latestCreatedAt = getInviteCreatedAtMs(latestInvite);

    if (Number.isFinite(activeCreatedAt) && Number.isFinite(latestCreatedAt)) {
      return activeCreatedAt >= latestCreatedAt ? activeInvite : latestInvite;
    }

    if (Number.isFinite(activeCreatedAt)) {
      return activeInvite;
    }

    if (Number.isFinite(latestCreatedAt)) {
      return latestInvite;
    }
  }

  return activeInvite || latestInvite || null;
}

function getInviteState(donorId) {
  const activeInvite = getLatestActiveInviteForDonor(donorId);
  const latestInviteRecord = getLatestInviteForDonor(donorId);
  const mostRecentInvite = getMostRecentInvite(activeInvite, latestInviteRecord);
  const { nextInviteAvailableAt, cooldownActive } = mostRecentInvite
    ? evaluateInviteCooldown(mostRecentInvite)
    : { nextInviteAvailableAt: null, cooldownActive: false };
  const inviteLimitReached = mostRecentInvite
    ? nextInviteAvailableAt === null
      ? Boolean(activeInvite)
      : cooldownActive
    : false;

  return {
    activeInvite: activeInvite || null,
    latestInvite: mostRecentInvite || null,
    inviteLimitReached,
    nextInviteAvailableAt,
  };
}

function buildDashboardResponse({
  donor,
  invite,
  pendingPlexLink = null,
  inviteLimitReached = Boolean(invite),
  nextInviteAvailableAt = null,
  paypalError = '',
}) {
  const paypal = settingsStore.getPaypalSettings();
  let appSettings = {};
  try {
    appSettings = settingsStore.getAppSettings();
  } catch (err) {
    appSettings = {};
  }
  const overseerrUrlRaw =
    appSettings && appSettings.overseerrBaseUrl
      ? String(appSettings.overseerrBaseUrl).trim()
      : '';
  const overseerrUrl =
    overseerrUrlRaw && /^https?:\/\//i.test(overseerrUrlRaw)
      ? overseerrUrlRaw
      : '';
  let announcementSettings;
  try {
    announcementSettings = settingsStore.getAnnouncementSettings();
  } catch (err) {
    announcementSettings = {};
  }
  const paypalEnvironment = getPaypalEnvironment(paypal.apiBase);
  const checkoutAvailable = isSubscriptionCheckoutConfigured(paypal);
  const subscriptionUrl = checkoutAvailable
    ? getSubscriptionCheckoutUrl({
        planId: paypal.planId,
        apiBase: paypal.apiBase,
      })
    : '';
  return {
    authenticated: Boolean(donor),
    donor: donor
      ? {
          id: donor.id,
          email: donor.email,
          name: donor.name,
          status: donor.status,
          subscriptionId: donor.subscriptionId,
          lastPaymentAt: donor.lastPaymentAt,
          accessExpiresAt: donor.accessExpiresAt || null,
          hasPassword: Boolean(donor.hasPassword),
          emailVerified: Boolean(donor.emailVerified),
          emailVerifiedAt: donor.emailVerifiedAt || null,
          plexAccountId: donor.plexAccountId || '',
          plexEmail: donor.plexEmail || '',
          plexLinked: hasPlexLink(donor),
          plexEmailMatches: donor.plexAccountId ? plexEmailsMatch(donor) : true,
          plexRequiresRelink: requiresPlexRelink(donor),
        }
      : null,
    invite: invite || null,
    paypal: {
      planId: paypal.planId || '',
      subscriptionPrice: paypal.subscriptionPrice || 0,
      currency: paypal.currency || '',
      environment: paypalEnvironment,
      subscriptionUrl,
      subscriptionCheckoutAvailable: checkoutAvailable,
      refreshError: paypalError ? String(paypalError) : '',
    },
    plexLink: pendingPlexLink
      ? {
          pending: true,
          code: pendingPlexLink.code || '',
          authUrl: pendingPlexLink.authUrl || '',
          expiresAt: pendingPlexLink.expiresAt || null,
          pollIntervalMs:
            pendingPlexLink.pollIntervalMs ||
            plexOAuth.DEFAULT_POLL_INTERVAL_MS,
        }
      : { pending: false },
    inviteLimitReached: Boolean(inviteLimitReached),
    nextInviteAvailableAt:
      nextInviteAvailableAt instanceof Date
        ? nextInviteAvailableAt.toISOString()
        : typeof nextInviteAvailableAt === 'string'
        ? nextInviteAvailableAt
        : null,
    announcement: sanitizeAnnouncement(announcementSettings),
    integrations: {
      overseerr: {
        url: overseerrUrl,
        enabled: Boolean(overseerrUrl),
      },
    },
  };
}

function hasActiveSubscription(donor) {
  if (!donor) {
    return false;
  }
  const status = (donor.status || '').toLowerCase();
  return status === 'active';
}

function getAuthenticatedDonor(req) {
  if (!req.session || !req.session.customerId) {
    return null;
  }
  const donor = getDonorById(req.session.customerId);
  if (!donor) {
    delete req.session.customerId;
    return null;
  }
  return donor;
}

function requireCustomer(req, res, next) {
  const donor = getAuthenticatedDonor(req);
  if (!donor) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!hasValidSessionToken(req)) {
    return res.status(401).json({ error: 'Invalid session token' });
  }
  req.customer = { donor };
  return next();
}

router.get(
  '/session',
  asyncHandler(async (req, res) => {
    let donor = getAuthenticatedDonor(req);
    let subscriptionRefreshError = '';
    if (!donor) {
      res.locals.sessionToken = null;
      return res.json({ authenticated: false });
    }
    res.locals.sessionToken = ensureSessionToken(req);

    if (needsSubscriptionRefresh(donor, false)) {
      const donorForRefresh = donor;
      const { donor: refreshedDonor, error } = await refreshDonorSubscription(
        donorForRefresh,
        {
          onError: (err) =>
            logger.warn('Failed to refresh PayPal subscription during session load', {
              donorId: donorForRefresh.id,
              subscriptionId: donorForRefresh.subscriptionId,
              error: err && err.message,
            }),
        }
      );
      if (refreshedDonor) {
        donor = refreshedDonor;
      }
      subscriptionRefreshError = error || '';
    }

    const {
      activeInvite: invite,
      inviteLimitReached,
      nextInviteAvailableAt,
    } = getInviteState(donor.id);
    const pendingPlexLink = getPendingPlexLink(req, donor);
    return res.json(
      buildDashboardResponse({
        donor,
        invite,
        pendingPlexLink,
        inviteLimitReached,
        nextInviteAvailableAt,
        paypalError: subscriptionRefreshError,
      })
    );
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const providedPassword = typeof password === 'string' ? password : '';

    if (!normalizedEmail || !providedPassword) {
      return res.status(400).json({
        error: 'Email and password are required to sign in.',
      });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        error: 'Please provide a valid email address.',
      });
    }

    const authRecord = getDonorAuthByEmail(normalizedEmail);
    if (!authRecord || !authRecord.donor) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!authRecord.passwordHash) {
      return res.status(401).json({
        error:
          'This account is not yet set up. Follow your invite link to create a password.',
      });
    }

    let passwordMatches = false;
    try {
      passwordMatches = await verifyPassword(providedPassword, authRecord.passwordHash);
    } catch (err) {
      logger.warn('Password verification failed', err.message);
      passwordMatches = false;
    }

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!authRecord.donor.emailVerified) {
      return res.status(403).json({
        error:
          'Verify your email address from the link we sent before signing in.',
        verificationRequired: true,
      });
    }

    let donor = authRecord.donor;
    const existingPlexLink =
      req.session && req.session.plexLink && req.session.plexLink.donorId === donor.id
        ? { ...req.session.plexLink }
        : null;

    if (!req.session || typeof req.session.regenerate !== 'function') {
      logger.error('Session is not available for customer login regeneration');
      return res
        .status(500)
        .json({ error: 'Failed to sign in. Please try again shortly.' });
    }

    return req.session.regenerate(async (err) => {
      if (err) {
        logger.error('Failed to regenerate customer session', err);
        return res
          .status(500)
          .json({ error: 'Failed to sign in. Please try again shortly.' });
      }

      try {
        if (existingPlexLink) {
          req.session.plexLink = existingPlexLink;
        }

        let subscriptionRefreshError = '';
        if (needsSubscriptionRefresh(donor, false)) {
          const donorForRefresh = donor;
          const { donor: refreshedDonor, error } = await refreshDonorSubscription(
            donorForRefresh,
            {
              onError: (refreshErr) =>
                logger.warn('Failed to refresh PayPal subscription during login', {
                  donorId: donorForRefresh.id,
                  subscriptionId: donorForRefresh.subscriptionId,
                  error: refreshErr && refreshErr.message,
                }),
            }
          );
          if (refreshedDonor) {
            donor = refreshedDonor;
          }
          subscriptionRefreshError = error || '';
        }

        req.session.customerId = donor.id;
        logger.info('Customer signed in with email/password', {
          donorId: donor.id,
        });

        res.locals.sessionToken = ensureSessionToken(req);

        const {
          activeInvite: invite,
          inviteLimitReached,
          nextInviteAvailableAt,
        } = getInviteState(donor.id);
        const pendingPlexLink = getPendingPlexLink(req, donor);
        return res.json(
          buildDashboardResponse({
            donor,
            invite,
            pendingPlexLink,
            inviteLimitReached,
            nextInviteAvailableAt,
            paypalError: subscriptionRefreshError,
          })
        );
      } catch (handlerErr) {
        logger.error('Failed to finalize customer login', handlerErr);
        return res
          .status(500)
          .json({ error: 'Failed to sign in. Please try again shortly.' });
      }
    });
  })
);

router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const tokenInput =
      req.body && typeof req.body.token === 'string'
        ? req.body.token
        : req.query && typeof req.query.token === 'string'
        ? req.query.token
        : '';
    const token = tokenInput.trim();

    if (!token) {
      return res.status(400).json({
        error: 'A verification token is required to confirm your email.',
      });
    }

    const tokenRecord = getDonorEmailVerificationToken(token);
    if (!tokenRecord) {
      return res.status(400).json({
        error: 'This verification link is invalid or has expired.',
      });
    }

    if (tokenRecord.usedAt) {
      clearDonorEmailVerificationTokens(tokenRecord.donorId);
      return res.status(410).json({
        error: 'This verification link has already been used.',
      });
    }

    if (tokenRecord.expiresAt) {
      const expiresAtMs = Date.parse(tokenRecord.expiresAt);
      if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
        clearDonorEmailVerificationTokens(tokenRecord.donorId);
        return res.status(410).json({
          error: 'This verification link has expired. Request a new one.',
        });
      }
    }

    const donor = getDonorById(tokenRecord.donorId);
    if (!donor) {
      clearDonorEmailVerificationTokens(tokenRecord.donorId);
      return res.status(404).json({
        error: 'Account not found for this verification link.',
      });
    }

    const existingPlexLink =
      req.session && req.session.plexLink && req.session.plexLink.donorId === donor.id
        ? { ...req.session.plexLink }
        : null;

    if (!req.session || typeof req.session.regenerate !== 'function') {
      logger.error('Session is not available for email verification regeneration');
      return res
        .status(500)
        .json({ error: 'Failed to verify email. Please try again shortly.' });
    }

    return req.session.regenerate(async (err) => {
      if (err) {
        logger.error('Failed to regenerate session for email verification', err);
        return res
          .status(500)
          .json({ error: 'Failed to verify email. Please try again shortly.' });
      }

      try {
        if (existingPlexLink) {
          req.session.plexLink = existingPlexLink;
        }

        let verifiedDonor = markDonorEmailVerified(donor.id);
        markEmailVerificationTokenUsed(tokenRecord.id);
        clearDonorEmailVerificationTokens(verifiedDonor.id);

        let subscriptionRefreshError = '';
        if (needsSubscriptionRefresh(verifiedDonor, false)) {
          const donorForRefresh = verifiedDonor;
          const { donor: refreshedDonor, error } = await refreshDonorSubscription(
            donorForRefresh,
            {
              onError: (refreshErr) =>
                logger.warn('Failed to refresh PayPal subscription after verification', {
                  donorId: donorForRefresh.id,
                  subscriptionId: donorForRefresh.subscriptionId,
                  error: refreshErr && refreshErr.message,
                }),
            }
          );
          if (refreshedDonor) {
            verifiedDonor = refreshedDonor;
          }
          subscriptionRefreshError = error || '';
        }

        req.session.customerId = verifiedDonor.id;
        logger.info('Customer verified email and signed in', {
          donorId: verifiedDonor.id,
        });

        logEvent('customer.email.verified', {
          donorId: verifiedDonor.id,
          verificationTokenId: tokenRecord.id,
        });

        res.locals.sessionToken = ensureSessionToken(req);

        const {
          activeInvite: invite,
          inviteLimitReached,
          nextInviteAvailableAt,
        } = getInviteState(verifiedDonor.id);
        const pendingPlexLink = getPendingPlexLink(req, verifiedDonor);

        return res.json(
          buildDashboardResponse({
            donor: verifiedDonor,
            invite,
            pendingPlexLink,
            inviteLimitReached,
            nextInviteAvailableAt,
            paypalError: subscriptionRefreshError,
          })
        );
      } catch (handlerErr) {
        logger.error('Failed to finalize email verification', handlerErr);
        return res
          .status(500)
          .json({ error: 'Failed to verify email. Please try again shortly.' });
      }
    });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.session) {
      delete req.session.customerId;
    }
    res.locals.sessionToken = null;
    res.json({ success: true });
  })
);

router.post(
  '/paypal-checkout',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const paypalSettings = settingsStore.getPaypalSettings();
    if (!isSubscriptionCheckoutConfigured(paypalSettings)) {
      return res
        .status(503)
        .json({ error: 'Subscription checkout is not available right now.' });
    }

    const donor = req.customer.donor;
    const overrides =
      req.body && typeof req.body === 'object'
        ? {
            email: req.body.email,
            name: req.body.name,
          }
        : {};

    const subscriber = buildSubscriberDetails(
      {
        email: overrides.email || donor.email,
        name: overrides.name || donor.name,
      },
      { email: donor.email, name: donor.name }
    );

    try {
      const checkout = await paypalService.createSubscription(
        paypalSettings.planId,
        subscriber,
        paypalSettings
      );

      let updatedDonor = donor;
      if (
        checkout.subscriptionId &&
        checkout.subscriptionId !== (donor.subscriptionId || '').trim()
      ) {
        updatedDonor = updateDonorSubscriptionId(
          donor.id,
          checkout.subscriptionId
        );
      }

      logEvent('paypal.checkout.created', {
        donorId: updatedDonor.id,
        subscriptionId: checkout.subscriptionId,
        context: 'customer-dashboard',
      });

      return res.json({
        approvalUrl: checkout.approvalUrl,
        subscriptionId: checkout.subscriptionId,
      });
    } catch (err) {
      logger.error('Failed to create PayPal checkout for donor', {
        donorId: donor.id,
        error: err && err.message,
      });
      return res.status(502).json({
        error: 'Failed to start PayPal subscription. Try again shortly.',
      });
    }
  })
);

router.post(
  '/profile',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    const email = normalizeEmail(req.body && req.body.email);
    const name = req.body && typeof req.body.name === 'string'
      ? req.body.name.trim()
      : '';
    const subscriptionInputRaw =
      req.body && typeof req.body.subscriptionId === 'string'
        ? req.body.subscriptionId
        : req.body && typeof req.body.paypalSubscriptionId === 'string'
        ? req.body.paypalSubscriptionId
        : '';
    const subscriptionInput = normalizeSubscriptionId(subscriptionInputRaw);
    const normalizedSubscriptionInput = subscriptionInput
      ? subscriptionInput.toUpperCase()
      : '';

    if (!email) {
      return res.status(400).json({
        error: 'A valid email is required to update your profile.',
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address.',
      });
    }

    if (subscriptionInput && !isValidSubscriptionId(subscriptionInput)) {
      return res.status(400).json({
        error: 'Enter a valid PayPal subscription ID (format like I-XXXX).',
      });
    }

    const updates = { email, name };
    let updatedDonor = updateDonorContact(donor.id, updates);
    const existingSubscription = normalizeSubscriptionId(
      updatedDonor.subscriptionId || ''
    );
    const normalizedExisting = existingSubscription
      ? existingSubscription.toUpperCase()
      : '';
    let subscriptionLinked = false;
    const profileUpdates = {
      email: updatedDonor.email,
      name: updatedDonor.name,
    };

    if (
      normalizedSubscriptionInput &&
      normalizedSubscriptionInput !== normalizedExisting
    ) {
      updatedDonor = updateDonorSubscriptionId(
        updatedDonor.id,
        normalizedSubscriptionInput
      );
      subscriptionLinked = true;
      logEvent('customer.subscription.linked', {
        donorId: donor.id,
        subscriptionId: updatedDonor.subscriptionId,
        context: 'customer-dashboard',
      });
    }

    const shouldRefreshSubscription = needsSubscriptionRefresh(
      updatedDonor,
      subscriptionLinked
    );

    const previousStatus = updatedDonor.status;
    const previousLastPaymentAt = updatedDonor.lastPaymentAt;

    let subscriptionRefreshError = '';
    if (shouldRefreshSubscription) {
      const donorForRefresh = updatedDonor;
      const { donor: refreshedDonor, error } = await refreshDonorSubscription(
        donorForRefresh,
        {
          onError: (err) =>
            logger.warn('Failed to refresh PayPal subscription after manual link', {
              donorId: donorForRefresh.id,
              subscriptionId: donorForRefresh.subscriptionId,
              error: err && err.message,
            }),
        }
      );
      if (refreshedDonor) {
        updatedDonor = refreshedDonor;
      }
      subscriptionRefreshError = error || '';
    }

    if (updatedDonor.status !== previousStatus) {
      profileUpdates.status = updatedDonor.status;
    }
    if (updatedDonor.lastPaymentAt !== previousLastPaymentAt) {
      profileUpdates.lastPaymentAt = updatedDonor.lastPaymentAt;
    }

    profileUpdates.email = updatedDonor.email;
    profileUpdates.name = updatedDonor.name;
    if (subscriptionLinked) {
      profileUpdates.subscriptionId = updatedDonor.subscriptionId;
    }

    logEvent('customer.profile.updated', {
      donorId: donor.id,
      updates: profileUpdates,
    });

    const {
      activeInvite: invite,
      inviteLimitReached,
      nextInviteAvailableAt,
    } = getInviteState(updatedDonor.id);
    const pendingPlexLink = getPendingPlexLink(req, updatedDonor);
    req.customer.donor = updatedDonor;
    return res.json(
      buildDashboardResponse({
        donor: updatedDonor,
        invite,
        pendingPlexLink,
        inviteLimitReached,
        nextInviteAvailableAt,
        paypalError: subscriptionRefreshError,
      })
    );
  })
);

router.post(
  '/plex/link/start',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;

    try {
      const pin = await plexOAuth.requestPin({});
      if (!pin.pinId || !pin.code) {
        throw new Error('Plex did not return a valid PIN');
      }

      req.session.plexLink = {
        donorId: donor.id,
        pinId: pin.pinId,
        clientIdentifier: pin.clientIdentifier,
        code: pin.code,
        authUrl: pin.authUrl,
        expiresAt: pin.expiresAt,
        pollIntervalMs: pin.pollIntervalMs || plexOAuth.DEFAULT_POLL_INTERVAL_MS,
        createdAt: new Date().toISOString(),
      };

      logEvent('plex.link.started', {
        donorId: donor.id,
        pinId: pin.pinId,
      });

      const {
        activeInvite: invite,
        inviteLimitReached,
        nextInviteAvailableAt,
      } = getInviteState(donor.id);
      const pendingPlexLink = getPendingPlexLink(req, donor);

      return res.json(
        buildDashboardResponse({
          donor,
          invite,
          pendingPlexLink,
          inviteLimitReached,
          nextInviteAvailableAt,
        })
      );
    } catch (err) {
      logger.warn('Failed to start Plex OAuth link', err.message);
      return res.status(502).json({
        error: 'Failed to start Plex authentication. Try again shortly.',
      });
    }
  })
);

router.get(
  '/plex/link/status',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    const sessionLink = getActivePlexLinkSession(req, donor);

    if (!sessionLink) {
      const {
        activeInvite: invite,
        inviteLimitReached,
        nextInviteAvailableAt,
      } = getInviteState(donor.id);
      return res.json(
        buildDashboardResponse({
          donor,
          invite,
          pendingPlexLink: null,
          inviteLimitReached,
          nextInviteAvailableAt,
        })
      );
    }

    try {
      const poll = await plexOAuth.pollPin({
        pinId: sessionLink.pinId,
        clientIdentifier: sessionLink.clientIdentifier,
      });

      if (poll.expiresAt) {
        req.session.plexLink.expiresAt = poll.expiresAt;
      }

      if (!poll.authToken) {
        if (poll.expired) {
          delete req.session.plexLink;
          const {
            activeInvite: invite,
            inviteLimitReached,
            nextInviteAvailableAt,
          } = getInviteState(donor.id);
          return res.status(410).json({
            error: 'Plex authentication expired. Start the link again.',
            payload: buildDashboardResponse({
              donor,
              invite,
              pendingPlexLink: null,
              inviteLimitReached,
              nextInviteAvailableAt,
            }),
          });
        }

        const {
          activeInvite: invite,
          inviteLimitReached,
          nextInviteAvailableAt,
        } = getInviteState(donor.id);
        const pendingPlexLink = getPendingPlexLink(req, donor);
        return res.json(
          buildDashboardResponse({
            donor,
            invite,
            pendingPlexLink,
            inviteLimitReached,
            nextInviteAvailableAt,
          })
        );
      }

      const identity = await plexOAuth.fetchIdentity({
        authToken: poll.authToken,
        clientIdentifier: sessionLink.clientIdentifier,
      });

      delete req.session.plexLink;

      const updatedDonor = updateDonorPlexIdentity(donor.id, {
        plexAccountId: identity.plexAccountId,
        plexEmail: identity.plexEmail,
      });

      let invite = getLatestActiveInviteForDonor(donor.id);
      if (invite) {
        invite = updateInvitePlexDetails(invite.id, {
          plexAccountId: identity.plexAccountId,
          plexEmail: identity.plexEmail,
        });
      }

      logEvent('plex.link.completed', {
        donorId: donor.id,
        plexAccountId: identity.plexAccountId,
        plexEmail: identity.plexEmail,
      });

      req.customer.donor = updatedDonor;

      const { inviteLimitReached, nextInviteAvailableAt } = getInviteState(
        updatedDonor.id
      );

      return res.json(
        buildDashboardResponse({
          donor: updatedDonor,
          invite,
          pendingPlexLink: null,
          inviteLimitReached,
          nextInviteAvailableAt,
        })
      );
    } catch (err) {
      logger.warn('Failed to complete Plex OAuth link', err.message);
      delete req.session.plexLink;
      const {
        activeInvite: invite,
        inviteLimitReached,
        nextInviteAvailableAt,
      } = getInviteState(donor.id);
      return res.status(502).json({
        error: 'Failed to verify Plex authentication. Start the link again.',
        payload: buildDashboardResponse({
          donor,
          invite,
          pendingPlexLink: null,
          inviteLimitReached,
          nextInviteAvailableAt,
        }),
      });
    }
  })
);

router.post(
  '/plex/link/cancel',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    if (req.session && req.session.plexLink) {
      delete req.session.plexLink;
    }
    const {
      activeInvite: invite,
      inviteLimitReached,
      nextInviteAvailableAt,
    } = getInviteState(donor.id);
    return res.json(
      buildDashboardResponse({
        donor,
        invite,
        pendingPlexLink: null,
        inviteLimitReached,
        nextInviteAvailableAt,
      })
    );
  })
);

router.post(
  '/plex/unlink',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    const updatedDonor = clearDonorPlexIdentity(donor.id);
    if (req.session && req.session.plexLink) {
      delete req.session.plexLink;
    }

    let invite = getLatestActiveInviteForDonor(donor.id);
    if (invite) {
      invite = updateInvitePlexDetails(invite.id, {
        plexAccountId: updatedDonor.plexAccountId,
        plexEmail: updatedDonor.plexEmail,
      });
    }

    logEvent('plex.link.cleared', { donorId: donor.id });

    req.customer.donor = updatedDonor;

    const { inviteLimitReached, nextInviteAvailableAt } = getInviteState(
      updatedDonor.id
    );

    return res.json(
      buildDashboardResponse({
        donor: updatedDonor,
        invite,
        pendingPlexLink: null,
        inviteLimitReached,
        nextInviteAvailableAt,
      })
    );
  })
);

router.post(
  '/invite',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    const requestedEmail = normalizeEmail(
      req.body && (req.body.email || donor.email)
    );
    const requestedName = req.body && typeof req.body.name === 'string'
      ? req.body.name.trim()
      : donor.name || '';

    if (!requestedEmail) {
      return res
        .status(400)
        .json({ error: 'Email is required to generate an invite.' });
    }

    if (!isValidEmail(requestedEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (!hasActiveSubscription(donor)) {
      return res.status(403).json({
        error:
          'An active subscription is required to generate a new invite.',
      });
    }

    if (!hasPlexLink(donor)) {
      return res.status(409).json({
        error: 'Link your Plex account before generating a new invite.',
      });
    }

    const {
      activeInvite: activeInviteFromState,
      latestInvite,
      inviteLimitReached,
      nextInviteAvailableAt,
      shareInvite,
    } = getInviteState(donor.id);
    let invite = activeInviteFromState || latestInvite || null;
    const origin = resolvePublicBaseUrl(req);
    const currentShareInviteDetails = buildShareInviteDetails(shareInvite, origin);
    const shareInviteReusable =
      shareInvite &&
      !isShareInviteUsed(shareInvite) &&
      !isShareInviteExpired(shareInvite);
    const canReuseInvite =
      invite &&
      shareInviteReusable &&
      !invite.revokedAt &&
      invite.recipientEmail &&
      invite.recipientEmail.toLowerCase() === requestedEmail.toLowerCase();

    let activeDonor = donor;
    const updates = {};
    if (requestedEmail && requestedEmail !== normalizeEmail(donor.email)) {
      updates.email = requestedEmail;
    }
    if (requestedName && requestedName !== (donor.name || '').trim()) {
      updates.name = requestedName;
    }

    if (Object.keys(updates).length > 0) {
      activeDonor = updateDonorContact(donor.id, updates);
    }

    const warnings = [];
    if (requiresPlexRelink(activeDonor)) {
      warnings.push(
        'Your Plex account email does not match your dashboard email. The invite was processed, but consider re-linking Plex to keep them in sync.'
      );
    }

    if (canReuseInvite) {
      if (
        activeDonor.plexAccountId &&
        (!invite.plexAccountId ||
          invite.plexAccountId !== activeDonor.plexAccountId ||
          normalizeEmail(invite.plexEmail) !==
            normalizeEmail(activeDonor.plexEmail))
      ) {
        invite = updateInvitePlexDetails(invite.id, {
          plexAccountId: activeDonor.plexAccountId,
          plexEmail: activeDonor.plexEmail,
        });
      }
      logEvent('invite.customer.reused', {
        donorId: donor.id,
        inviteId: invite.id,
        shareInviteId: shareInvite ? shareInvite.id : null,
      });
      const pendingPlexLink = getPendingPlexLink(req, activeDonor);
      req.customer.donor = activeDonor;
      const invitePayload = invite
        ? {
            ...invite,
            inviteUrl:
              currentShareInviteDetails?.inviteUrl || invite.inviteUrl || '',
          }
        : null;
      if (invitePayload && currentShareInviteDetails) {
        invitePayload.shareLink = currentShareInviteDetails;
      }
      const response = buildDashboardResponse({
        donor: activeDonor,
        invite: invitePayload,
        pendingPlexLink,
        inviteLimitReached: true,
        nextInviteAvailableAt,
      });
      if (warnings.length > 0) {
        response.warnings = warnings;
      }
      return res.json(response);
    }

    if (inviteLimitReached) {
      const pendingPlexLink = getPendingPlexLink(req, activeDonor);
      req.customer.donor = activeDonor;
      const invitePayload = invite
        ? {
            ...invite,
            inviteUrl:
              currentShareInviteDetails?.inviteUrl || invite.inviteUrl || '',
          }
        : null;
      if (invitePayload && currentShareInviteDetails) {
        invitePayload.shareLink = currentShareInviteDetails;
      }
      const payload = buildDashboardResponse({
        donor: activeDonor,
        invite: invitePayload,
        pendingPlexLink,
        inviteLimitReached: true,
        nextInviteAvailableAt,
      });
      if (warnings.length > 0) {
        payload.warnings = warnings;
      }
      return res.status(409).json({
        error:
          'An invite has already been generated for this subscription. Contact the server admin if you need help updating access.',
        payload,
      });
    }

    const providedNote =
      req.body && typeof req.body.note === 'string'
        ? req.body.note.trim()
        : '';
    const noteParts = ['Generated from customer dashboard'];
    if (requestedName) {
      noteParts.push(`for ${requestedName}`);
    }
    if (requestedEmail) {
      noteParts.push(`<${requestedEmail}>`);
    }
    const note = providedNote || noteParts.join(' ');

    const prospectRecord = createProspect({
      email: requestedEmail,
      name: requestedName,
      note,
    });
    const shareInviteRecord = createOrUpdateShareLink({
      prospectId: prospectRecord.id,
      token: nanoid(36),
    });
    const shareInviteDetails = buildShareInviteDetails(
      shareInviteRecord,
      origin
    );
    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      inviteId: shareInviteRecord.token,
      inviteUrl: shareInviteDetails ? shareInviteDetails.inviteUrl : '',
      recipientEmail: requestedEmail,
      note,
      plexAccountId: activeDonor.plexAccountId,
      plexEmail: activeDonor.plexEmail,
    });

    logEvent('invite.customer.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      shareInviteId: shareInviteRecord.id,
    });

    const pendingPlexLink = getPendingPlexLink(req, activeDonor);
    req.customer.donor = activeDonor;
    const { nextInviteAvailableAt: updatedNextInviteAvailableAt } =
      evaluateInviteCooldown(inviteRecord);
    const invitePayload = {
      ...inviteRecord,
      inviteUrl: shareInviteDetails ? shareInviteDetails.inviteUrl : '',
    };
    if (shareInviteDetails) {
      invitePayload.shareLink = shareInviteDetails;
    }
    const response = buildDashboardResponse({
      donor: activeDonor,
      invite: invitePayload,
      pendingPlexLink,
      inviteLimitReached: true,
      nextInviteAvailableAt: updatedNextInviteAvailableAt,
    });
    if (warnings.length > 0) {
      response.warnings = warnings;
    }
    return res.json(response);
  })
);

router.post(
  '/trial',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    res.locals.sessionToken = ensureSessionToken(req);

    if (!hasPlexLink(donor)) {
      return res.status(409).json({
        error: 'Link your Plex account before starting a trial.',
      });
    }

    const status = (donor.status || '').toLowerCase();
    if (status === 'active') {
      return res.status(409).json({
        error: 'Your access is already active.',
      });
    }

    if (status === 'trial') {
      return res.status(409).json({
        error: 'A trial is already in progress.',
      });
    }

    const trialDonor = startDonorTrial(donor.id);
    req.customer.donor = trialDonor;

    logEvent('donor.trial.started', {
      donorId: trialDonor.id,
      route: 'customer',
      accessExpiresAt: trialDonor.accessExpiresAt,
    });

    const {
      activeInvite: invite,
      inviteLimitReached,
      nextInviteAvailableAt,
    } = getInviteState(trialDonor.id);
    const pendingPlexLink = getPendingPlexLink(req, trialDonor);

    return res.json(
      buildDashboardResponse({
        donor: trialDonor,
        invite,
        pendingPlexLink,
        inviteLimitReached,
        nextInviteAvailableAt,
      })
    );
  })
);

router.get(
  '/support',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    res.locals.sessionToken = ensureSessionToken(req);
    const includeResolvedParam = String(req.query.includeResolved || '').trim();
    const includeResolved = includeResolvedParam
      ? !['0', 'false', 'no'].includes(includeResolvedParam.toLowerCase())
      : true;
    const requests = listSupportRequests({
      includeResolved,
      donorId: donor.id,
    });
    const threads = requests
      .map((request) => getSupportThreadForDonor(request.id, donor.id))
      .filter(Boolean);
    res.json({
      threads,
    });
  })
);

router.get(
  '/support/:id',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    res.locals.sessionToken = ensureSessionToken(req);
    const requestId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid support request id' });
    }
    const thread = getSupportThreadForDonor(requestId, donor.id);
    if (!thread) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    res.json({ thread });
  })
);

router.post(
  '/support',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    res.locals.sessionToken = ensureSessionToken(req);
    const { subject, message, displayName } = req.body || {};
    const donorDisplayName = resolveSupportDisplayName(donor, displayName);
    let thread;
    try {
      thread = createSupportRequest({
        donorId: donor.id,
        subject,
        message,
        donorDisplayName,
        authorName: donorDisplayName,
      });
    } catch (err) {
      return res.status(400).json({
        error: err && err.message ? String(err.message) : 'Failed to create support request',
      });
    }
    notifyAdminOfSupportUpdate({ thread, donor, type: 'new' });
    res.status(201).json({ thread });
  })
);

router.post(
  '/support/:id/replies',
  requireCustomer,
  asyncHandler(async (req, res) => {
    const donor = req.customer.donor;
    res.locals.sessionToken = ensureSessionToken(req);
    const requestId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'Invalid support request id' });
    }
    const existingThread = getSupportThreadForDonor(requestId, donor.id);
    if (!existingThread) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    const { message, displayName } = req.body || {};
    const donorDisplayName = resolveSupportDisplayName(donor, displayName);
    let thread;
    try {
      thread = addSupportMessageToRequest({
        requestId,
        donorId: donor.id,
        authorRole: 'donor',
        authorName: donorDisplayName,
        message,
      });
    } catch (err) {
      return res.status(400).json({
        error: err && err.message ? String(err.message) : 'Failed to send reply',
      });
    }
    if (!thread || thread.request.donorId !== donor.id) {
      return res.status(404).json({ error: 'Support request not found' });
    }
    notifyAdminOfSupportUpdate({ thread, donor, type: 'message' });
    res.status(201).json({ thread });
  })
);

module.exports = router;
