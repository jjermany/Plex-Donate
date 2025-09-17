const express = require('express');
const {
  getShareLinkByToken,
  getDonorById,
  getLatestActiveInviteForDonor,
  createInvite: createInviteRecord,
  markShareLinkUsed,
  logEvent,
  updateDonorContact,
} = require('../db');
const settingsStore = require('../state/settings');
const wizarrService = require('../services/wizarr');
const logger = require('../utils/logger');

const router = express.Router();

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.use(express.json());

function buildShareResponse({ shareLink, donor, invite }) {
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

    const donor = getDonorById(shareLink.donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Share link is no longer valid' });
    }

    const status = (donor.status || '').toLowerCase();
    const blockedStatuses = new Set(['cancelled', 'suspended', 'expired']);
    if (blockedStatuses.has(status)) {
      return res.status(403).json({
        error: 'Subscription is not active. Contact the server admin for help.',
      });
    }

    const invite = getLatestActiveInviteForDonor(donor.id);

    return res.json(
      buildShareResponse({ shareLink, donor, invite })
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

    const donor = getDonorById(shareLink.donorId);
    if (!donor) {
      return res.status(404).json({ error: 'Share link is no longer valid' });
    }

    const providedSessionToken = getProvidedSessionToken(req);

    if (!providedSessionToken || providedSessionToken !== shareLink.sessionToken) {
      return res.status(401).json({ error: 'Invalid or missing share session token' });
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
      })
    );
  })
);

module.exports = router;
