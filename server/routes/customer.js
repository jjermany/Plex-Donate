const express = require('express');
const {
  getDonorById,
  getLatestActiveInviteForDonor,
  createInvite: createInviteRecord,
  logEvent,
  updateDonorContact,
  getDonorAuthByEmail,
  updateDonorSubscriptionId,
  updateDonorPlexIdentity,
  clearDonorPlexIdentity,
  updateInvitePlexDetails,
} = require('../db');
const settingsStore = require('../state/settings');
const wizarrService = require('../services/wizarr');
const paypalService = require('../services/paypal');
const logger = require('../utils/logger');
const { verifyPassword } = require('../utils/passwords');
const {
  getSubscriptionCheckoutUrl,
  getPaypalEnvironment,
  isSubscriptionCheckoutConfigured,
  buildSubscriberDetails,
} = require('../utils/paypal');
const plexOAuth = require('../services/plex-oauth');

const router = express.Router();

const PLEX_LINK_EXPIRY_GRACE_MS = 60 * 1000;

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.use(express.json());

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

function buildDashboardResponse({ donor, invite, pendingPlexLink = null }) {
  const paypal = settingsStore.getPaypalSettings();
  const paypalEnvironment = getPaypalEnvironment(paypal.apiBase);
  const checkoutAvailable = isSubscriptionCheckoutConfigured(paypal);
  const subscriptionUrl = checkoutAvailable
    ? getSubscriptionCheckoutUrl({
        planId: paypal.planId,
        apiBase: paypal.apiBase,
      })
    : '';
  const wizarrSettings = settingsStore.getWizarrSettings();
  const wizarrBaseUrl = (wizarrSettings.baseUrl || '').trim();
  const wizarrPortalUrl = wizarrBaseUrl
    ? wizarrService.getPortalUrl(wizarrSettings)
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
          hasPassword: Boolean(donor.hasPassword),
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
    },
    wizarr: {
      baseUrl: wizarrBaseUrl,
      portalUrl: wizarrPortalUrl,
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
  req.customer = { donor };
  return next();
}

router.get(
  '/session',
  asyncHandler(async (req, res) => {
    const donor = getAuthenticatedDonor(req);
    if (!donor) {
      return res.json({ authenticated: false });
    }
    const invite = getLatestActiveInviteForDonor(donor.id);
    const pendingPlexLink = getPendingPlexLink(req, donor);
    return res.json(
      buildDashboardResponse({ donor, invite, pendingPlexLink })
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

    const donor = authRecord.donor;
    req.session.customerId = donor.id;
    logger.info('Customer signed in with email/password', { donorId: donor.id });

    const invite = getLatestActiveInviteForDonor(donor.id);
    const pendingPlexLink = getPendingPlexLink(req, donor);
    return res.json(
      buildDashboardResponse({ donor, invite, pendingPlexLink })
    );
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.session) {
      delete req.session.customerId;
    }
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

    const updates = { email, name };
    const updatedDonor = updateDonorContact(donor.id, updates);
    logEvent('customer.profile.updated', {
      donorId: donor.id,
      updates: {
        email: updatedDonor.email,
        name: updatedDonor.name,
      },
    });

    const invite = getLatestActiveInviteForDonor(donor.id);
    const pendingPlexLink = getPendingPlexLink(req, updatedDonor);
    req.customer.donor = updatedDonor;
    return res.json(
      buildDashboardResponse({
        donor: updatedDonor,
        invite,
        pendingPlexLink,
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

      const invite = getLatestActiveInviteForDonor(donor.id);
      const pendingPlexLink = getPendingPlexLink(req, donor);

      return res.json(
        buildDashboardResponse({ donor, invite, pendingPlexLink })
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
      const invite = getLatestActiveInviteForDonor(donor.id);
      return res.json(
        buildDashboardResponse({ donor, invite, pendingPlexLink: null })
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
          const invite = getLatestActiveInviteForDonor(donor.id);
          return res.status(410).json({
            error: 'Plex authentication expired. Start the link again.',
            payload: buildDashboardResponse({
              donor,
              invite,
              pendingPlexLink: null,
            }),
          });
        }

        const invite = getLatestActiveInviteForDonor(donor.id);
        const pendingPlexLink = getPendingPlexLink(req, donor);
        return res.json(
          buildDashboardResponse({ donor, invite, pendingPlexLink })
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

      return res.json(
        buildDashboardResponse({
          donor: updatedDonor,
          invite,
          pendingPlexLink: null,
        })
      );
    } catch (err) {
      logger.warn('Failed to complete Plex OAuth link', err.message);
      delete req.session.plexLink;
      const invite = getLatestActiveInviteForDonor(donor.id);
      return res.status(502).json({
        error: 'Failed to verify Plex authentication. Start the link again.',
        payload: buildDashboardResponse({
          donor,
          invite,
          pendingPlexLink: null,
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
    const invite = getLatestActiveInviteForDonor(donor.id);
    return res.json(
      buildDashboardResponse({ donor, invite, pendingPlexLink: null })
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

    return res.json(
      buildDashboardResponse({
        donor: updatedDonor,
        invite,
        pendingPlexLink: null,
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

    let invite = getLatestActiveInviteForDonor(donor.id);
    const canReuseInvite =
      invite &&
      invite.wizarrInviteUrl &&
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

    if (requiresPlexRelink(activeDonor)) {
      return res.status(409).json({
        error:
          'Please re-link your Plex account so we can keep your Plex and dashboard emails in sync before generating a new invite.',
      });
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
      });
      const pendingPlexLink = getPendingPlexLink(req, activeDonor);
      req.customer.donor = activeDonor;
      return res.json(
        buildDashboardResponse({
          donor: activeDonor,
          invite,
          pendingPlexLink,
        })
      );
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

    let inviteData;
    try {
      inviteData = await wizarrService.createInvite({
        email: requestedEmail,
        note,
        expiresInDays:
          req.body && Number.isFinite(Number(req.body.expiresInDays))
            ? Number(req.body.expiresInDays)
            : undefined,
        extraFields: {
          plex_account_id: activeDonor.plexAccountId || undefined,
          plexAccountId: activeDonor.plexAccountId || undefined,
          plex_email: activeDonor.plexEmail || undefined,
          plexEmail: activeDonor.plexEmail || undefined,
        },
      });
    } catch (err) {
      logger.warn('Failed to create invite via customer dashboard', err.message);
      return res.status(500).json({
        error: 'Failed to create Wizarr invite.',
        details: err.message,
      });
    }

    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      code: inviteData.inviteCode,
      url: inviteData.inviteUrl,
      recipientEmail: requestedEmail,
      note,
      plexAccountId: activeDonor.plexAccountId,
      plexEmail: activeDonor.plexEmail,
    });

    logEvent('invite.customer.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
    });

    const pendingPlexLink = getPendingPlexLink(req, activeDonor);
    req.customer.donor = activeDonor;
    return res.json(
      buildDashboardResponse({
        donor: activeDonor,
        invite: inviteRecord,
        pendingPlexLink,
      })
    );
  })
);

module.exports = router;
