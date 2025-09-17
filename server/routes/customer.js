const express = require('express');
const {
  getDonorById,
  getLatestActiveInviteForDonor,
  createInvite: createInviteRecord,
  logEvent,
  updateDonorContact,
  getDonorAuthByEmail,
  updateDonorSubscriptionId,
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

const router = express.Router();

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

function buildDashboardResponse({ donor, invite }) {
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
    return res.json(buildDashboardResponse({ donor, invite }));
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
    return res.json(buildDashboardResponse({ donor, invite }));
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
    return res.json(buildDashboardResponse({ donor: updatedDonor, invite }));
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

    const invite = getLatestActiveInviteForDonor(donor.id);
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

    if (canReuseInvite) {
      logEvent('invite.customer.reused', {
        donorId: donor.id,
        inviteId: invite.id,
      });
      return res.json(
        buildDashboardResponse({ donor: activeDonor, invite })
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
    });

    logEvent('invite.customer.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
    });

    return res.json(
      buildDashboardResponse({ donor: activeDonor, invite: inviteRecord })
    );
  })
);

module.exports = router;
