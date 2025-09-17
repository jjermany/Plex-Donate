const express = require('express');
const {
  getShareLinkByToken,
  getDonorById,
  getDonorByEmailAddress,
  getDonorBySubscriptionId,
  getLatestActiveInviteForDonor,
  createInvite: createInviteRecord,
  markShareLinkUsed,
  logEvent,
  updateDonorContact,
  updateDonorPassword,
  createDonor,
  updateDonorSubscriptionId,
  getProspectById,
  assignShareLinkToDonor,
  markProspectConverted,
} = require('../db');
const settingsStore = require('../state/settings');
const wizarrService = require('../services/wizarr');
const logger = require('../utils/logger');
const { hashPassword, isPasswordStrong } = require('../utils/passwords');

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

function buildShareResponse({ shareLink, donor, invite, prospect }) {
  const paypal = settingsStore.getPaypalSettings();
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
    },
  };
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
      const status = (donor.status || '').toLowerCase();
      const blockedStatuses = new Set(['cancelled', 'suspended', 'expired']);
      if (blockedStatuses.has(status)) {
        return res.status(403).json({
          error: 'Subscription is not active. Contact the server admin for help.',
        });
      }

      const invite = getLatestActiveInviteForDonor(donor.id);

      return res.json(
        buildShareResponse({ shareLink, donor, invite, prospect: null })
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

    const status = (donor.status || '').toLowerCase();
    const blockedStatuses = new Set(['cancelled', 'suspended', 'expired']);
    if (blockedStatuses.has(status)) {
      return res.status(403).json({
        error: 'Subscription is not active. Contact the server admin for help.',
      });
    }

    const invite = getLatestActiveInviteForDonor(donor.id);
    const canReuseInvite =
      invite &&
      invite.wizarrInviteUrl &&
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

    if (canReuseInvite) {
      const updatedLink = markShareLinkUsed(shareLink.id) || shareLink;
      logEvent('invite.share.reused', {
        donorId: donor.id,
        inviteId: invite.id,
        shareLinkId: updatedLink.id,
      });
      return res.json(
        buildShareResponse({ shareLink: updatedLink, donor: activeDonor, invite })
      );
    }

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
      logger.warn('Failed to create invite via share link', err.message);
      return res
        .status(500)
        .json({ error: 'Failed to create Wizarr invite', details: err.message });
    }

    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      code: inviteData.inviteCode,
      url: inviteData.inviteUrl,
      recipientEmail: requestedEmail,
      note,
    });

    const updatedLink = markShareLinkUsed(shareLink.id) || shareLink;

    logEvent('invite.share.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      shareLinkId: updatedLink.id,
    });

    return res.json(
      buildShareResponse({
        shareLink: updatedLink,
        donor: activeDonor,
        invite: inviteRecord,
        prospect: null,
      })
    );
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

      if (
        subscriptionInput &&
        subscriptionInput !== (activeDonor.subscriptionId || '').trim()
      ) {
        activeDonor = updateDonorSubscriptionId(activeDonor.id, subscriptionInput);
      }

      activeDonor = updateDonorPassword(activeDonor.id, hashedPassword);

      const updatedLink = markShareLinkUsed(shareLink.id) || shareLink;
      const invite = getLatestActiveInviteForDonor(activeDonor.id);

      logEvent('share.account.password_set', {
        donorId: activeDonor.id,
        shareLinkId: updatedLink.id,
      });

      return res.json(
        buildShareResponse({
          shareLink: updatedLink,
          donor: activeDonor,
          invite,
          prospect: null,
        })
      );
    }

    // Prospect promotion flow
    let activeDonor = null;
    if (subscriptionInput) {
      activeDonor = getDonorBySubscriptionId(subscriptionInput);
    }
    if (!activeDonor) {
      activeDonor = getDonorByEmailAddress(normalizedEmail);
    }

    if (activeDonor) {
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
      if (
        subscriptionInput &&
        subscriptionInput !== (activeDonor.subscriptionId || '').trim()
      ) {
        activeDonor = updateDonorSubscriptionId(activeDonor.id, subscriptionInput);
      }
      activeDonor = updateDonorPassword(activeDonor.id, hashedPassword);
    } else {
      activeDonor = createDonor({
        email: normalizedEmail,
        name: providedName,
        subscriptionId: subscriptionInput || null,
        passwordHash: hashedPassword,
        status: 'pending',
      });
    }

    const reassignedLink = assignShareLinkToDonor(shareLink.id, activeDonor.id, {
      clearLastUsed: true,
    });
    const updatedLink = markShareLinkUsed(reassignedLink.id) || reassignedLink;
    const invite = getLatestActiveInviteForDonor(activeDonor.id);

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
        invite,
        prospect: null,
      })
    );
  })
);

module.exports = router;
