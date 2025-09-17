const express = require('express');
const csurf = require('csurf');
const config = require('../config');
const { nanoid } = require('nanoid');
const {
  listDonorsWithDetails,
  getDonorById,
  createInvite: createInviteRecord,
  markInviteEmailSent,
  getLatestActiveInviteForDonor,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  createOrUpdateShareLink,
  getShareLinkByDonorId,
  logEvent,
  getRecentEvents,
} = require('../db');
const { requireAdmin } = require('../middleware/auth');
const paypalService = require('../services/paypal');
const wizarrService = require('../services/wizarr');
const emailService = require('../services/email');
const plexService = require('../services/plex');
const logger = require('../utils/logger');
const settingsStore = require('../state/settings');

const router = express.Router();
const csrfProtection = csurf();

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.use(express.json());
router.use(csrfProtection);
router.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  next();
});

router.get('/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session && req.session.isAdmin),
    csrfToken: res.locals.csrfToken,
  });
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { password } = req.body || {};
    if (!config.adminPassword) {
      return res.status(500).json({ error: 'Admin password not configured' });
    }
    if (password !== config.adminPassword) {
      return res.status(401).json({ error: 'Invalid admin password' });
    }
    req.session.isAdmin = true;
    logger.info('Admin logged in');
    res.json({ success: true, csrfToken: res.locals.csrfToken });
  })
);

router.post(
  '/logout',
  requireAdmin,
  asyncHandler(async (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true, csrfToken: res.locals.csrfToken });
    });
  })
);

router.get(
  '/subscribers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const donors = listDonorsWithDetails();
    res.json({ donors, csrfToken: res.locals.csrfToken });
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

    if (!['paypal', 'wizarr', 'smtp', 'plex'].includes(group)) {
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
      } else if (group === 'wizarr') {
        const config = settingsStore.previewGroup('wizarr', overrides);
        result = await wizarrService.verifyConnection(config);
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

    const note = (req.body && req.body.note) || '';

    logger.info('Creating Wizarr invite for donor', donorId);
    const inviteData = await wizarrService.createInvite({
      email: donor.email,
      note,
      expiresInDays: req.body && req.body.expiresInDays,
    });

    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      code: inviteData.inviteCode,
      url: inviteData.inviteUrl,
      note,
      recipientEmail: donor.email,
    });

    try {
      await emailService.sendInviteEmail({
        to: inviteRecord.recipientEmail || donor.email,
        inviteUrl: inviteRecord.wizarrInviteUrl,
        name: donor.name,
        subscriptionId: donor.subscriptionId,
      });
      markInviteEmailSent(inviteRecord.id);
    } catch (err) {
      logger.error('Failed to send invite email', err.message);
      return res.status(500).json({
        error: 'Invite created but email delivery failed',
        details: err.message,
        invite: inviteRecord,
        csrfToken: res.locals.csrfToken,
      });
    }

    logEvent('invite.created', {
      donorId: donor.id,
      invite: inviteRecord,
    });

    res.json({
      invite: inviteRecord,
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

    const origin = `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
    const url = `${origin}/share/${shareLink.token}`;

    return res.json({
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
    if (!invite || !invite.wizarrInviteUrl) {
      return res.status(400).json({ error: 'No active invite to email' });
    }

    await emailService.sendInviteEmail({
      to: invite.recipientEmail || donor.email,
      inviteUrl: invite.wizarrInviteUrl,
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

    if (invite.wizarrInviteCode) {
      try {
        await wizarrService.revokeInvite(invite.wizarrInviteCode);
      } catch (err) {
        logger.warn('Failed to revoke Wizarr invite', err.message);
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

module.exports = router;
