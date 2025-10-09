const express = require('express');
const { nanoid } = require('nanoid');
const {
  getShareLinkByToken,
  getDonorById,
  getDonorByEmailAddress,
  getDonorBySubscriptionId,
  getLatestActiveInviteForDonor,
  getLatestInviteForDonor,
  createInvite: createInviteRecord,
  createProspect,
  createOrUpdateShareLink,
  markShareLinkUsed,
  logEvent,
  updateDonorContact,
  updateDonorPassword,
  createDonor,
  updateDonorSubscriptionId,
  updateDonorStatus,
  getProspectById,
  assignShareLinkToDonor,
  markProspectConverted,
  updateInvitePlexDetails,
  setDonorAccessExpirationBySubscription,
} = require('../db');
const settingsStore = require('../state/settings');
const logger = require('../utils/logger');
const { hashPassword, isPasswordStrong } = require('../utils/passwords');
const paypalService = require('../services/paypal');
const {
  evaluateInviteCooldown,
  getInviteCreatedAtMs,
} = require('../utils/invite-cooldown');
const {
  getSubscriptionCheckoutUrl,
  getPaypalEnvironment,
  isSubscriptionCheckoutConfigured,
  buildSubscriberDetails,
  mapPaypalSubscriptionStatus,
} = require('../utils/paypal');

const router = express.Router();

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.use(express.json());

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
    details.url = `${origin}/share/${shareInvite.token}`;
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

function requiresPlexRelink(donor) {
  if (!donor || !donor.plexAccountId) {
    return false;
  }
  if (!donor.plexEmail || !donor.email) {
    return false;
  }
  return normalizeEmail(donor.plexEmail) !== normalizeEmail(donor.email);
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
  const shareInviteLink = mostRecentInvite && mostRecentInvite.plexInviteId
    ? getShareLinkByToken(mostRecentInvite.plexInviteId)
    : null;

  return {
    activeInvite: activeInvite || null,
    latestInvite: mostRecentInvite || null,
    inviteLimitReached,
    nextInviteAvailableAt,
    shareInvite: shareInviteLink || null,
  };
}

function needsSubscriptionRefresh(donor, subscriptionLinked) {
  if (!donor || !(donor.subscriptionId || '').trim()) {
    return false;
  }

  if (subscriptionLinked) {
    return true;
  }

  const status = (donor.status || '').toString().trim().toLowerCase();
  if (!status) {
    return true;
  }

  return ['pending', 'approval_pending', 'approved'].includes(status);
}

function buildShareResponse({
  shareLink,
  donor,
  invite,
  prospect,
  inviteLimitReached = Boolean(invite),
  nextInviteAvailableAt = null,
  shareInvite = null,
}) {
  const paypal = settingsStore.getPaypalSettings();
  const paypalEnvironment = getPaypalEnvironment(paypal.apiBase);
  const checkoutAvailable = isSubscriptionCheckoutConfigured(paypal);
  const subscriptionUrl = checkoutAvailable
    ? getSubscriptionCheckoutUrl({
        planId: paypal.planId,
        apiBase: paypal.apiBase,
      })
    : '';
  return {
    donor: donor
      ? {
          id: donor.id,
          email: donor.email,
          name: donor.name,
          status: donor.status,
          subscriptionId: donor.subscriptionId,
          lastPaymentAt: donor.lastPaymentAt,
          hasPassword: Boolean(donor.hasPassword),
          plexLinked: hasPlexLink(donor),
          plexAccountId: donor.plexAccountId || null,
          plexEmail: donor.plexEmail || '',
        }
      : null,
    prospect: prospect
      ? {
          id: prospect.id,
          email: prospect.email || '',
          name: prospect.name || '',
        }
      : null,
    invite: invite || null,
    shareLink: shareLink
      ? {
          token: shareLink.token,
          createdAt: shareLink.createdAt,
          lastUsedAt: shareLink.lastUsedAt,
          sessionToken: shareLink.sessionToken,
        }
      : null,
    paypal: {
      planId: paypal.planId || '',
      subscriptionPrice: paypal.subscriptionPrice || 0,
      currency: paypal.currency || '',
      environment: paypalEnvironment,
      subscriptionUrl,
      subscriptionCheckoutAvailable: checkoutAvailable,
    },
    inviteLimitReached: Boolean(inviteLimitReached),
    nextInviteAvailableAt:
      nextInviteAvailableAt instanceof Date
        ? nextInviteAvailableAt.toISOString()
        : typeof nextInviteAvailableAt === 'string'
        ? nextInviteAvailableAt
        : null,
    shareInvite: shareInvite ? { ...shareInvite } : null,
  };
}

function hasActiveSubscription(donor) {
  if (!donor) {
    return false;
  }
  const status = (donor.status || '').toLowerCase();
  return status === 'active';
}

function getProvidedSessionToken(req) {
  const authorizationHeader = (req.get('authorization') || '').trim();
  let providedSessionToken = '';
  if (authorizationHeader.toLowerCase().startsWith('bearer ')) {
    providedSessionToken = authorizationHeader.slice(7).trim();
  }
  if (!providedSessionToken) {
    providedSessionToken = (req.get('x-share-session') || '').trim();
  }
  if (
    !providedSessionToken &&
    req.body &&
    typeof req.body.sessionToken === 'string'
  ) {
    providedSessionToken = req.body.sessionToken.trim();
  }
  return providedSessionToken;
}

async function refreshDonorFromPaypalSubscription(donor, { shareLinkId, context } = {}) {
  if (!donor || !(donor.subscriptionId || '').trim()) {
    return donor;
  }

  try {
    const subscription = await paypalService.getSubscription(
      donor.subscriptionId
    );
    const subscriptionStatus = (subscription && subscription.status) || '';
    const normalizedStatus = mapPaypalSubscriptionStatus(subscriptionStatus);
    const billingInfo = (subscription && subscription.billing_info) || {};
    const lastPaymentAt =
      (billingInfo.last_payment && billingInfo.last_payment.time) || null;

    let refreshedDonor = donor;

    if (normalizedStatus || lastPaymentAt) {
      const previousStatus = donor.status;
      const previousLastPaymentAt = donor.lastPaymentAt;
      const statusToApply = normalizedStatus || previousStatus || 'pending';
      const statusUpdated = updateDonorStatus(
        donor.subscriptionId,
        statusToApply,
        lastPaymentAt || previousLastPaymentAt || null
      );

      if (statusUpdated) {
        refreshedDonor = statusUpdated;
      }

      if (normalizedStatus === 'active') {
        const donorWithAccess = setDonorAccessExpirationBySubscription(
          donor.subscriptionId,
          null
        );
        if (donorWithAccess) {
          refreshedDonor = donorWithAccess;
        }
      }
    }

    return refreshedDonor;
  } catch (err) {
    logger.warn('Failed to refresh PayPal subscription after share link update', {
      donorId: donor && donor.id ? donor.id : null,
      subscriptionId: donor && donor.subscriptionId ? donor.subscriptionId : null,
      shareLinkId: shareLinkId || null,
      context: context || 'share-link',
      error: err && err.message,
    });
    return donor;
  }
}

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const shareLink = getShareLinkByToken(req.params.token);
    if (!shareLink) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    let donor = null;
    if (shareLink.donorId) {
      donor = getDonorById(shareLink.donorId);
    }

    let prospect = null;
    if (!donor && shareLink.prospectId) {
      prospect = getProspectById(shareLink.prospectId);
    }

    if (!donor && !prospect) {
      return res.status(404).json({ error: 'Share link is no longer valid' });
    }

    if (donor) {
      const {
        activeInvite,
        latestInvite,
        inviteLimitReached,
        nextInviteAvailableAt,
        shareInvite,
      } = getInviteState(donor.id);
      const origin = resolvePublicBaseUrl(req);
      const inviteForResponse = activeInvite || latestInvite || null;
      const shareInviteDetails = buildShareInviteDetails(shareInvite, origin);
      const invitePayload = inviteForResponse
        ? {
            ...inviteForResponse,
            plexInviteUrl:
              shareInviteDetails?.url || inviteForResponse.plexInviteUrl || '',
          }
        : null;
      if (invitePayload && shareInviteDetails) {
        invitePayload.shareLink = shareInviteDetails;
      }

      return res.json(
        buildShareResponse({
          shareLink,
          donor,
          invite: invitePayload,
          prospect: null,
          inviteLimitReached,
          nextInviteAvailableAt,
          shareInvite: shareInviteDetails,
        })
      );
    }

    return res.json(
      buildShareResponse({ shareLink, donor: null, invite: null, prospect })
    );
  })
);

router.post(
  '/:token',
  asyncHandler(async (req, res) => {
    const shareLink = getShareLinkByToken(req.params.token);
    if (!shareLink) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    let donor = null;
    if (shareLink.donorId) {
      donor = getDonorById(shareLink.donorId);
    }

    let prospect = null;
    if (!donor && shareLink.prospectId) {
      prospect = getProspectById(shareLink.prospectId);
    }

    if (!donor && !prospect) {
      return res.status(404).json({ error: 'Share link is no longer valid' });
    }

    const providedSessionToken = getProvidedSessionToken(req);

    if (!providedSessionToken || providedSessionToken !== shareLink.sessionToken) {
      return res.status(401).json({ error: 'Invalid or missing share session token' });
    }

    if (!donor) {
      return res.status(400).json({
        error: 'Set up your account first so we can connect your invite.',
      });
    }

    const requestedEmail =
      req.body && typeof req.body.email === 'string'
        ? req.body.email.trim()
        : '';

    if (!requestedEmail) {
      return res
        .status(400)
        .json({ error: 'Email is required to generate an invite' });
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(requestedEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    const requestedName =
      req.body && typeof req.body.name === 'string'
        ? req.body.name.trim()
        : '';

    if (!hasActiveSubscription(donor)) {
      return res.status(403).json({
        error: 'Start or resume your subscription to generate a new invite.',
      });
    }

    const {
      activeInvite: inviteFromState,
      latestInvite,
      inviteLimitReached,
      nextInviteAvailableAt,
      shareInvite,
    } = getInviteState(donor.id);
    let invite = inviteFromState || latestInvite || null;
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

    const providedNote =
      req.body && typeof req.body.note === 'string'
        ? req.body.note.trim()
        : '';
    const defaultNoteParts = ['Generated from share link'];
    if (requestedName) {
      defaultNoteParts.push(`for ${requestedName}`);
    }
    if (requestedEmail) {
      defaultNoteParts.push(`<${requestedEmail}>`);
    }
    const note = providedNote || defaultNoteParts.join(' ');

    if (!hasPlexLink(donor)) {
      return res.status(409).json({
        error:
          'Link your Plex account from the dashboard before generating a new invite.',
      });
    }

    let activeDonor = donor;
    const updates = {};
    if (
      requestedEmail &&
      requestedEmail.toLowerCase() !== (donor.email || '').toLowerCase()
    ) {
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
      logEvent('invite.share.reused', {
        donorId: donor.id,
        inviteId: invite.id,
        shareInviteId: shareInvite ? shareInvite.id : null,
      });
      const invitePayload = invite
        ? {
            ...invite,
            plexInviteUrl:
              currentShareInviteDetails?.url || invite.plexInviteUrl || '',
          }
        : null;
      if (invitePayload && currentShareInviteDetails) {
        invitePayload.shareLink = currentShareInviteDetails;
      }
      const response = buildShareResponse({
        shareLink,
        donor: activeDonor,
        invite: invitePayload,
        inviteLimitReached: true,
        nextInviteAvailableAt,
        shareInvite: currentShareInviteDetails,
      });
      if (warnings.length > 0) {
        response.warnings = warnings;
      }
      return res.json(response);
    }

    if (inviteLimitReached) {
      const invitePayload = invite
        ? {
            ...invite,
            plexInviteUrl:
              currentShareInviteDetails?.url || invite.plexInviteUrl || '',
          }
        : null;
      if (invitePayload && currentShareInviteDetails) {
        invitePayload.shareLink = currentShareInviteDetails;
      }
      const payload = buildShareResponse({
        shareLink,
        donor: activeDonor,
        invite: invitePayload,
        prospect: null,
        inviteLimitReached: true,
        nextInviteAvailableAt,
        shareInvite: currentShareInviteDetails,
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
      inviteUrl: shareInviteDetails ? shareInviteDetails.url : '',
      recipientEmail: requestedEmail,
      note,
      plexAccountId: activeDonor.plexAccountId,
      plexEmail: activeDonor.plexEmail,
    });

    logEvent('invite.share.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      shareInviteId: shareInviteRecord.id,
    });

    const { nextInviteAvailableAt: updatedNextInviteAvailableAt } =
      evaluateInviteCooldown(inviteRecord);
    const invitePayload = {
      ...inviteRecord,
      plexInviteUrl: shareInviteDetails ? shareInviteDetails.url : '',
    };
    if (shareInviteDetails) {
      invitePayload.shareLink = shareInviteDetails;
    }
    const response = buildShareResponse({
      shareLink,
      donor: activeDonor,
      invite: invitePayload,
      prospect: null,
      inviteLimitReached: true,
      nextInviteAvailableAt: updatedNextInviteAvailableAt,
      shareInvite: shareInviteDetails,
    });
    if (warnings.length > 0) {
      response.warnings = warnings;
    }
    return res.json(response);
  })
);

router.post(
  '/:token/paypal-checkout',
  asyncHandler(async (req, res) => {
    const shareLink = getShareLinkByToken(req.params.token);
    if (!shareLink) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const providedSessionToken = getProvidedSessionToken(req);
    if (!providedSessionToken || providedSessionToken !== shareLink.sessionToken) {
      return res.status(401).json({ error: 'Invalid or missing share session token' });
    }

    const paypalSettings = settingsStore.getPaypalSettings();
    if (!isSubscriptionCheckoutConfigured(paypalSettings)) {
      return res
        .status(503)
        .json({ error: 'Subscription checkout is not available right now.' });
    }

    let donor = null;
    if (shareLink.donorId) {
      donor = getDonorById(shareLink.donorId);
    }

    let prospect = null;
    if (!donor && shareLink.prospectId) {
      prospect = getProspectById(shareLink.prospectId);
    }

    if (!donor) {
      return res.status(403).json({
        error: 'Create your account before starting PayPal checkout.',
      });
    }

    if (!donor.hasPassword) {
      return res.status(403).json({
        error: 'Set up your dashboard password before starting PayPal checkout.',
      });
    }

    const overrides =
      req.body && typeof req.body === 'object'
        ? {
            email: req.body.email,
            name: req.body.name,
          }
        : {};

    const subscriber = buildSubscriberDetails(
      {
        email:
          overrides.email ||
          (donor && donor.email) ||
          (prospect && prospect.email) ||
          '',
        name:
          overrides.name ||
          (donor && donor.name) ||
          (prospect && prospect.name) ||
          '',
      },
      {}
    );

    try {
      const checkout = await paypalService.createSubscription(
        paypalSettings.planId,
        subscriber,
        paypalSettings
      );

      if (
        donor &&
        checkout.subscriptionId &&
        checkout.subscriptionId !== (donor.subscriptionId || '').trim()
      ) {
        donor = updateDonorSubscriptionId(donor.id, checkout.subscriptionId);
      }

      logEvent('paypal.checkout.created', {
        shareLinkId: shareLink.id,
        donorId: donor ? donor.id : null,
        prospectId: prospect ? prospect.id : null,
        subscriptionId: checkout.subscriptionId,
        context: donor ? 'share-donor' : 'share-prospect',
      });

      return res.json({
        approvalUrl: checkout.approvalUrl,
        subscriptionId: checkout.subscriptionId,
      });
    } catch (err) {
      logger.error('Failed to create PayPal checkout from share link', {
        shareLinkId: shareLink.id,
        error: err && err.message,
      });
      return res.status(502).json({
        error: 'Failed to start PayPal subscription. Try again shortly.',
      });
    }
  })
);

router.post(
  '/:token/account',
  asyncHandler(async (req, res) => {
    const shareLink = getShareLinkByToken(req.params.token);
    if (!shareLink) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    let donor = null;
    if (shareLink.donorId) {
      donor = getDonorById(shareLink.donorId);
    }

    let prospect = null;
    if (!donor && shareLink.prospectId) {
      prospect = getProspectById(shareLink.prospectId);
    }

    if (!donor && !prospect) {
      return res.status(404).json({ error: 'Share link is no longer valid' });
    }

    const providedSessionToken = getProvidedSessionToken(req);
    if (!providedSessionToken || providedSessionToken !== shareLink.sessionToken) {
      return res.status(401).json({ error: 'Invalid or missing share session token' });
    }

    const emailInput =
      req.body && typeof req.body.email === 'string'
        ? req.body.email
        : donor?.email || prospect?.email || '';
    const normalizedEmail = normalizeEmail(emailInput);
    const providedName =
      req.body && typeof req.body.name === 'string'
        ? req.body.name.trim()
        : donor?.name || prospect?.name || '';
    const password =
      req.body && typeof req.body.password === 'string' ? req.body.password : '';
    const confirmPassword =
      req.body && typeof req.body.confirmPassword === 'string'
        ? req.body.confirmPassword
        : '';
    const subscriptionInputRaw =
      req.body && typeof req.body.subscriptionId === 'string'
        ? req.body.subscriptionId
        : req.body && typeof req.body.paypalSubscriptionId === 'string'
        ? req.body.paypalSubscriptionId
        : '';
    const subscriptionInput = subscriptionInputRaw ? subscriptionInputRaw.trim() : '';
    const normalizedSubscriptionId = subscriptionInput
      ? subscriptionInput.toUpperCase()
      : '';

    if (!normalizedEmail) {
      return res.status(400).json({ error: 'Email is required to set up your account.' });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required to secure your account.' });
    }

    if (!isPasswordStrong(password)) {
      return res.status(400).json({
        error: 'Choose a password with at least 8 characters.',
      });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match. Please try again.' });
    }

    let hashedPassword;
    try {
      hashedPassword = await hashPassword(password);
    } catch (err) {
      logger.error('Failed to hash password from share link', err.message);
      return res.status(500).json({ error: 'Failed to save password. Try again.' });
    }

    if (donor) {
      const status = (donor.status || '').toLowerCase();
      const blockedStatuses = new Set(['cancelled', 'suspended', 'expired']);
      if (blockedStatuses.has(status)) {
        return res.status(403).json({
          error: 'Subscription is not active. Contact the server admin for help.',
        });
      }

      let activeDonor = donor;
      const updates = {};
      if (normalizedEmail && normalizedEmail !== normalizeEmail(donor.email)) {
        updates.email = normalizedEmail;
      }
      if (providedName && providedName !== (donor.name || '').trim()) {
        updates.name = providedName;
      }

      if (Object.keys(updates).length > 0) {
        activeDonor = updateDonorContact(donor.id, updates);
      }

      const existingSubscription = (activeDonor.subscriptionId || '').trim();
      let subscriptionLinked = false;
      if (
        normalizedSubscriptionId &&
        normalizedSubscriptionId !== existingSubscription.toUpperCase()
      ) {
        activeDonor = updateDonorSubscriptionId(
          activeDonor.id,
          normalizedSubscriptionId
        );
        subscriptionLinked = true;
      }

      const shouldRefreshSubscription = needsSubscriptionRefresh(
        activeDonor,
        subscriptionLinked
      );

      if (shouldRefreshSubscription) {
        activeDonor = await refreshDonorFromPaypalSubscription(activeDonor, {
          shareLinkId: shareLink.id,
          context: 'share-existing-account',
        });
      }

      activeDonor = updateDonorPassword(activeDonor.id, hashedPassword);

      const updatedLink = markShareLinkUsed(shareLink.id) || shareLink;
      const {
        activeInvite: invite,
        inviteLimitReached,
        nextInviteAvailableAt,
        shareInvite,
      } = getInviteState(activeDonor.id);
      const origin = resolvePublicBaseUrl(req);
      const shareInviteDetails = buildShareInviteDetails(shareInvite, origin);
      const invitePayload = invite
        ? {
            ...invite,
            plexInviteUrl:
              shareInviteDetails?.url || invite.plexInviteUrl || '',
          }
        : null;
      if (invitePayload && shareInviteDetails) {
        invitePayload.shareLink = shareInviteDetails;
      }

      logEvent('share.account.password_set', {
        donorId: activeDonor.id,
        shareLinkId: updatedLink.id,
      });

      return res.json(
        buildShareResponse({
          shareLink: updatedLink,
          donor: activeDonor,
          invite: invitePayload,
          prospect: null,
          inviteLimitReached,
          nextInviteAvailableAt,
          shareInvite: shareInviteDetails,
        })
      );
    }

    // Prospect promotion flow
    let activeDonor = null;
    if (normalizedSubscriptionId) {
      activeDonor =
        getDonorBySubscriptionId(normalizedSubscriptionId) ||
        getDonorBySubscriptionId(subscriptionInput);
    }
    if (!activeDonor) {
      activeDonor = getDonorByEmailAddress(normalizedEmail);
    }

    if (activeDonor) {
      if (activeDonor.hasPassword) {
        return res.status(409).json({
          error: 'This account already has a password. Please log in instead.',
        });
      }
      const updates = {};
      if (normalizedEmail && normalizedEmail !== normalizeEmail(activeDonor.email)) {
        updates.email = normalizedEmail;
      }
      if (providedName && providedName !== (activeDonor.name || '').trim()) {
        updates.name = providedName;
      }
      if (Object.keys(updates).length > 0) {
        activeDonor = updateDonorContact(activeDonor.id, updates);
      }
      const existingSubscription = (activeDonor.subscriptionId || '').trim();
      let subscriptionLinked = false;
      if (
        normalizedSubscriptionId &&
        normalizedSubscriptionId !== existingSubscription.toUpperCase()
      ) {
        activeDonor = updateDonorSubscriptionId(
          activeDonor.id,
          normalizedSubscriptionId
        );
        subscriptionLinked = true;
      }

      const shouldRefreshSubscription = needsSubscriptionRefresh(
        activeDonor,
        subscriptionLinked
      );

      if (shouldRefreshSubscription) {
        activeDonor = await refreshDonorFromPaypalSubscription(activeDonor, {
          shareLinkId: shareLink.id,
          context: 'share-prospect-promotion',
        });
      }
      activeDonor = updateDonorPassword(activeDonor.id, hashedPassword);
    } else {
      activeDonor = createDonor({
        email: normalizedEmail,
        name: providedName,
        subscriptionId: normalizedSubscriptionId || null,
        passwordHash: hashedPassword,
        status: 'pending',
      });
      if (normalizedSubscriptionId) {
        activeDonor = await refreshDonorFromPaypalSubscription(activeDonor, {
          shareLinkId: shareLink.id,
          context: 'share-prospect-created',
        });
      }
    }

    const reassignedLink = assignShareLinkToDonor(shareLink.id, activeDonor.id, {
      clearLastUsed: true,
    });
    const updatedLink = markShareLinkUsed(reassignedLink.id) || reassignedLink;
    const {
      activeInvite: invite,
      inviteLimitReached,
      nextInviteAvailableAt,
      shareInvite,
    } = getInviteState(activeDonor.id);
    const origin = resolvePublicBaseUrl(req);
    const shareInviteDetails = buildShareInviteDetails(shareInvite, origin);
    const invitePayload = invite
      ? {
          ...invite,
          plexInviteUrl:
            shareInviteDetails?.url || invite.plexInviteUrl || '',
        }
      : null;
    if (invitePayload && shareInviteDetails) {
      invitePayload.shareLink = shareInviteDetails;
    }

    if (prospect) {
      markProspectConverted(prospect.id, activeDonor.id);
    }

    logEvent('share.account.prospect_promoted', {
      donorId: activeDonor.id,
      shareLinkId: updatedLink.id,
      prospectId: prospect ? prospect.id : null,
    });

    return res.json(
      buildShareResponse({
        shareLink: updatedLink,
        donor: activeDonor,
        invite: invitePayload,
        prospect: null,
        inviteLimitReached,
        nextInviteAvailableAt,
        shareInvite: shareInviteDetails,
      })
    );
  })
);

module.exports = router;
