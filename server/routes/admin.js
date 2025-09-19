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
  if (req.session && req.session.isAdmin) {
    res.locals.sessionToken = ensureSessionToken(req);
  } else {
    res.locals.sessionToken = null;
  }
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
      logger.info('Admin logged in');
      return res.json({ success: true, csrfToken });
    });
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
    const donors = listDonorsWithDetails();
    res.json({ donors, csrfToken: res.locals.csrfToken });
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
  '/settings/wizarr/test-invite',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const emailRaw = body.email;
    const email = typeof emailRaw === 'string' ? emailRaw.trim() : '';
    if (!email) {
      return res.status(400).json({
        error: 'Enter an email address to send a test invite.',
        csrfToken: res.locals.csrfToken,
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address for the test invite.',
        csrfToken: res.locals.csrfToken,
      });
    }

    const noteRaw = body.note;
    const nameRaw = body.name;
    const expiresRaw = body.expiresInDays;
    const overrides =
      body && body.overrides && typeof body.overrides === 'object'
        ? body.overrides
        : undefined;

    const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
    const name =
      typeof nameRaw === 'string' && nameRaw.trim()
        ? nameRaw.trim()
        : 'Test Invite';
    let expiresInDays;
    if (expiresRaw !== undefined && expiresRaw !== null && `${expiresRaw}`.trim() !== '') {
      const parsed = Number.parseInt(expiresRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        expiresInDays = parsed;
      }
    }

    let wizarrConfig;
    try {
      wizarrConfig = settingsStore.previewGroup('wizarr', overrides);
    } catch (err) {
      logger.warn('Failed to preview Wizarr settings for test invite', err.message);
      return res.status(400).json({
        error: err.message || 'Wizarr settings are not configured',
        csrfToken: res.locals.csrfToken,
      });
    }

    let smtpConfig;
    try {
      smtpConfig = emailService.getSmtpConfig();
    } catch (err) {
      logger.warn('Cannot send test invite due to email configuration', err.message);
      return res.status(400).json({
        error: `Email settings are not configured: ${err.message}`,
        csrfToken: res.locals.csrfToken,
      });
    }

    let invite;
    try {
      invite = await wizarrService.createInvite(
        {
          email,
          note,
          expiresInDays,
        },
        wizarrConfig
      );
    } catch (err) {
      logger.warn('Failed to create Wizarr test invite', err.message);
      return res.status(500).json({
        error: err.message || 'Failed to create Wizarr invite',
        csrfToken: res.locals.csrfToken,
      });
    }

    if (!invite || !invite.inviteUrl) {
      logger.warn('Wizarr did not return an invite URL for test invite');
      return res.status(500).json({
        error: 'Wizarr did not return an invite link',
        csrfToken: res.locals.csrfToken,
      });
    }

    const inviteCode = invite.inviteCode;
    const inviteUrl = invite.inviteUrl;
    const subscriptionId = `TEST-${nanoid(10)}`;

    try {
      await emailService.sendInviteEmail(
        {
          to: email,
          inviteUrl,
          name,
          subscriptionId,
        },
        smtpConfig
      );
    } catch (err) {
      logger.warn('Failed to send Wizarr test invite email', err.message);
      if (inviteCode) {
        try {
          await wizarrService.revokeInvite(inviteCode);
        } catch (revokeErr) {
          logger.warn(
            'Failed to revoke Wizarr invite after test email failure',
            revokeErr.message
          );
        }
      }
      return res.status(500).json({
        error: 'Invite created but email delivery failed',
        details: err.message,
        csrfToken: res.locals.csrfToken,
      });
    }

    logEvent('wizarr.test_invite', {
      email,
      invite: {
        code: inviteCode,
        url: inviteUrl,
      },
      note: note || undefined,
      expiresInDays,
    });
    logger.info('Sent Wizarr test invite', { email });

    res.json({
      success: true,
      invite: {
        code: inviteCode,
        url: inviteUrl,
      },
      message: `Test invite sent to ${email}.`,
      csrfToken: res.locals.csrfToken,
    });
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
