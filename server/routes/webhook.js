const express = require('express');
const paypalService = require('../services/paypal');
const {
  upsertDonor,
  updateDonorStatus,
  getDonorBySubscriptionId,
  getLatestActiveInviteForDonor,
  createInvite: createInviteRecord,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  recordPayment,
  logEvent,
  markInviteEmailSent,
  updateInvitePlexDetails,
  setDonorAccessExpirationBySubscription,
} = require('../db');
const plexService = require('../services/plex');
const emailService = require('../services/email');
const logger = require('../utils/logger');

const router = express.Router();

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const rawBody = req.body.toString('utf8');
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      logger.warn('Failed to parse PayPal webhook body', err.message);
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    logEvent('paypal.webhook.received', {
      id: event.id,
      eventType: event.event_type,
    });

    let verification;
    try {
      verification = await paypalService.verifyWebhookSignature(req.headers, event);
    } catch (err) {
      logger.error('PayPal webhook verification error', err.message);
      return res.status(400).json({ error: 'Webhook verification failed' });
    }

    if (!verification.verified) {
      logger.warn('PayPal webhook signature invalid', verification.reason);
      return res.status(400).json({ error: 'Webhook signature invalid' });
    }

    await handleEvent(event);

    res.status(200).json({ received: true });
  })
);

async function handleEvent(event) {
  const type = event.event_type;
  switch (type) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.UPDATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      await handleSubscriptionEvent(event);
      break;
    case 'PAYMENT.SALE.COMPLETED':
    case 'PAYMENT.CAPTURE.COMPLETED':
      await handlePaymentEvent(event);
      break;
    default:
      logger.info('Unhandled PayPal event type', type);
      break;
  }
}

function normalizeEmail(value) {
  if (!value) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function normalizeAccessExpirationTimestamp(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
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

function extractSubscriber(resource) {
  const subscriber = resource.subscriber || resource.payer || {};
  const name = subscriber.name || subscriber.payer_info || {};
  const displayName = [
    name.given_name || name.first_name,
    name.surname || name.last_name,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    email: subscriber.email_address || subscriber.email || resource.email_address || '',
    name: displayName || subscriber.full_name || '',
  };
}

async function resolveAccessExpirationTimestamp(subscriptionId, resource = {}) {
  if (!subscriptionId) {
    return { expiresAt: null, source: 'missing-subscription' };
  }

  const billingInfo = resource.billing_info || {};
  let nextBillingTime = billingInfo.next_billing_time;
  let source = 'webhook';

  if (!nextBillingTime) {
    try {
      const subscription = await paypalService.getSubscription(subscriptionId);
      nextBillingTime =
        subscription &&
        subscription.billing_info &&
        subscription.billing_info.next_billing_time;
      source = 'api';
    } catch (err) {
      logger.warn('Unable to fetch subscription to determine access expiration', {
        subscriptionId,
        message: err.message,
      });
    }
  }

  const normalized = normalizeAccessExpirationTimestamp(nextBillingTime);
  if (!normalized) {
    return { expiresAt: null, source: source || 'unknown' };
  }

  return { expiresAt: normalized, source };
}

async function handleSubscriptionEvent(event) {
  const resource = event.resource || {};
  const subscriptionId = resource.id || resource.subscription_id;
  const status = (resource.status || '').toLowerCase();
  const billingInfo = resource.billing_info || {};
  const lastPaymentAt =
    (billingInfo.last_payment && billingInfo.last_payment.time) || null;
  const subscriber = extractSubscriber(resource);

  let donor = upsertDonor({
    subscriptionId,
    email: subscriber.email,
    name: subscriber.name,
    status: status || 'active',
    lastPaymentAt,
  });

  logEvent('paypal.subscription.updated', {
    subscriptionId,
    status,
    donorId: donor.id,
  });

  const terminationEventStatusMap = {
    'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled',
    'BILLING.SUBSCRIPTION.EXPIRED': 'expired',
    'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended',
  };

  if (terminationEventStatusMap[event.event_type]) {
    const terminationStatus = status || terminationEventStatusMap[event.event_type];
    donor =
      (await handleCancellation(donor, {
        subscriptionId,
        resource,
        status: terminationStatus,
        eventType: event.event_type,
      })) || donor;
    return;
  }

  if (status === 'active') {
    const refreshed = setDonorAccessExpirationBySubscription(
      subscriptionId,
      null
    );
    if (refreshed) {
      donor = refreshed;
    }
  }
}

async function handleCancellation(
  donor,
  { subscriptionId, resource, status: statusOverride, eventType }
) {
  const normalizedStatus = (statusOverride || 'cancelled').toLowerCase();

  const updatedDonor = updateDonorStatus(subscriptionId, normalizedStatus);
  if (updatedDonor) {
    donor = updatedDonor;
  }

  const { expiresAt, source } = await resolveAccessExpirationTimestamp(
    subscriptionId,
    resource
  );

  let expirationSource = source || 'unknown';
  let accessExpiresAt = expiresAt;
  if (!accessExpiresAt) {
    accessExpiresAt = new Date().toISOString();
    expirationSource = `${expirationSource}-fallback-now`;
    logger.warn('Defaulting cancellation access expiration to immediate', {
      subscriptionId,
    });
  }

  const donorWithExpiration = setDonorAccessExpirationBySubscription(
    subscriptionId,
    accessExpiresAt
  );
  if (donorWithExpiration) {
    donor = donorWithExpiration;
  }

  logEvent('donor.access.expiration.scheduled', {
    donorId: donor.id,
    subscriptionId,
    accessExpiresAt: donor.accessExpiresAt,
    source: expirationSource,
    status: donor.status,
    eventType,
  });

  if (donor.email) {
    try {
      await emailService.sendCancellationEmail({
        to: donor.email,
        name: donor.name,
        subscriptionId,
        paidThrough: donor.accessExpiresAt,
      });
      logEvent('donor.cancellation.email.sent', {
        donorId: donor.id,
        subscriptionId,
        paidThrough: donor.accessExpiresAt,
      });
    } catch (err) {
      logger.warn('Failed to send cancellation email', err.message);
    }
  }

  if (!donor.accessExpiresAt) {
    return donor;
  }

  const expirationDate = new Date(donor.accessExpiresAt);
  if (Number.isNaN(expirationDate.getTime())) {
    logger.warn('Unable to parse donor access expiration timestamp', {
      donorId: donor.id,
      accessExpiresAt: donor.accessExpiresAt,
    });
    return donor;
  }

  if (expirationDate.getTime() > Date.now()) {
    return donor;
  }

  await revokeDonorAccess(donor);
  setDonorAccessExpirationBySubscription(subscriptionId, null);
  logEvent('donor.access.expiration.reached', {
    donorId: donor.id,
    subscriptionId,
    source: 'webhook-immediate',
    status: donor.status,
    eventType,
  });
  return donor;
}

async function revokeDonorAccess(donor) {
  if (!donor.email && !donor.plexAccountId) {
    return;
  }
  if (plexService.isConfigured()) {
    try {
      const result = await plexService.revokeUser({
        plexAccountId: donor.plexAccountId,
        email: donor.email,
      });
      if (result.success) {
        const invite = getLatestActiveInviteForDonor(donor.id);
        if (invite) {
          markPlexRevoked(invite.id);
        }
        logEvent('plex.access.revoked', {
          donorId: donor.id,
          email: donor.email,
          plexAccountId: donor.plexAccountId,
        });
      }
    } catch (err) {
      logger.warn('Failed to revoke Plex access automatically', err.message);
    }
  }

  const invite = getLatestActiveInviteForDonor(donor.id);
  if (invite && invite.plexInviteId) {
    try {
      await plexService.cancelInvite(invite.plexInviteId);
      revokeInviteRecord(invite.id);
      logEvent('plex.invite.cancelled', {
        donorId: donor.id,
        inviteId: invite.id,
      });
    } catch (err) {
      logger.warn('Failed to cancel Plex invite automatically', err.message);
    }
  }
}

function extractSubscriptionIdFromPayment(resource = {}) {
  const supplementaryData =
    resource.supplementary_data || resource.supplementaryData || {};
  const relatedIds =
    supplementaryData.related_ids || supplementaryData.relatedIds || {};

  const candidates = [
    relatedIds.subscription_id,
    relatedIds.billing_agreement_id,
    relatedIds.order_id,
    resource.subscription_id,
    resource.custom_id,
    resource.billing_agreement_id,
    resource.custom,
  ];

  for (const value of candidates) {
    if (value === undefined || value === null) {
      continue;
    }
    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

async function handlePaymentEvent(event) {
  const resource = event.resource || {};
  const subscriptionId = extractSubscriptionIdFromPayment(resource);
  if (!subscriptionId) {
    logger.warn('Payment event missing subscription reference');
    return;
  }

  let donor = getDonorBySubscriptionId(subscriptionId);
  if (!donor) {
    try {
      const subscription = await paypalService.getSubscription(subscriptionId);
      const subscriber = extractSubscriber(subscription || {});
      donor = upsertDonor({
        subscriptionId,
        email: subscriber.email,
        name: subscriber.name,
        status: (subscription.status || '').toLowerCase(),
        lastPaymentAt:
          (subscription.billing_info &&
            subscription.billing_info.last_payment &&
            subscription.billing_info.last_payment.time) ||
          null,
      });
    } catch (err) {
      logger.warn('Unable to fetch subscription for payment event', err.message);
    }
  }

  if (!donor) {
    logger.warn('Payment received for unknown donor', subscriptionId);
    return;
  }

  const amount =
    resource.amount && (resource.amount.total || resource.amount.value);
  const currency =
    resource.amount && (resource.amount.currency || resource.amount.currency_code);
  const paidAt = resource.create_time || new Date().toISOString();

  recordPayment({
    donorId: donor.id,
    paypalPaymentId: resource.id,
    amount,
    currency,
    paidAt,
  });

  const updatedDonor = updateDonorStatus(subscriptionId, 'active', paidAt);
  if (updatedDonor) {
    donor = updatedDonor;
  }
  const clearedDonor = setDonorAccessExpirationBySubscription(
    subscriptionId,
    null
  );
  if (clearedDonor) {
    donor = clearedDonor;
  }
  logEvent('paypal.payment.recorded', {
    donorId: donor.id,
    amount,
    currency,
  });

  try {
    await ensureInviteForActiveDonor(donor, {
      paymentId: resource.id,
    });
  } catch (err) {
    logger.warn('Automatic invite workflow failed after payment', err.message);
  }
}

async function ensureInviteForActiveDonor(donor, { paymentId } = {}) {
  if (!donor || (donor.status || '').toLowerCase() !== 'active') {
    return;
  }

  const email = (donor.email || '').trim();
  if (!email) {
    logger.info('Skipping automatic invite: donor email missing', {
      donorId: donor.id,
    });
    return;
  }

  if (!hasPlexLink(donor)) {
    logger.info('Skipping automatic invite: Plex account not linked', {
      donorId: donor.id,
    });
    return;
  }

  if (requiresPlexRelink(donor)) {
    logger.info('Proceeding with automatic invite despite Plex email mismatch', {
      donorId: donor.id,
      plexEmail: donor.plexEmail,
      donorEmail: donor.email,
    });
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedAccountId = (donor.plexAccountId || '')
    .toString()
    .trim()
    .toLowerCase();

  if (plexService.isConfigured()) {
    try {
      const plexUsers = await plexService.listUsers();
      if (Array.isArray(plexUsers) && plexUsers.length > 0) {
        const donorHasAccess = plexUsers.some((user) => {
          const candidateEmails = [
            user.email,
            user.username,
            user.title,
            user.account && user.account.email,
          ];
          const candidateIds = [
            user.id,
            user.uuid,
            user.userID,
            user.machineIdentifier,
            user.account && user.account.id,
          ];
          const emailMatch =
            normalizedEmail &&
            candidateEmails.some((value) => normalizeEmail(value) === normalizedEmail);
          const accountMatch =
            normalizedAccountId &&
            candidateIds.some((value) => {
              if (value === undefined || value === null) {
                return false;
              }
              return String(value).trim().toLowerCase() === normalizedAccountId;
            });
          return emailMatch || accountMatch;
        });

        if (donorHasAccess) {
          logger.info('Skipping automatic invite: donor already present on Plex server', {
            donorId: donor.id,
          });
          return;
        }
      }
    } catch (err) {
      logger.warn('Unable to verify existing Plex users before inviting', err.message);
    }
  }

  const existingInvite = getLatestActiveInviteForDonor(donor.id);
  const existingInviteUsable =
    existingInvite && existingInvite.inviteUrl && !existingInvite.revokedAt;
  const existingInviteMatches =
    existingInviteUsable &&
    normalizeEmail(existingInvite.recipientEmail) === normalizedEmail;

  if (existingInviteUsable && existingInviteMatches) {
    let invite = existingInvite;
    if (
      donor.plexAccountId &&
      (!invite.plexAccountId ||
        invite.plexAccountId !== donor.plexAccountId ||
        normalizeEmail(invite.plexEmail) !== normalizeEmail(donor.plexEmail))
    ) {
      invite = updateInvitePlexDetails(invite.id, {
        plexAccountId: donor.plexAccountId,
        plexEmail: donor.plexEmail,
      });
    }
    if (!invite.emailSentAt) {
      try {
        await emailService.sendInviteEmail({
          to: email,
          inviteUrl: invite.inviteUrl,
          name: donor.name,
          subscriptionId: donor.subscriptionId,
        });
        invite = markInviteEmailSent(invite.id);
        logEvent('invite.auto.email_sent', {
          donorId: donor.id,
          inviteId: invite.id,
          source: 'payment-webhook',
        });
      } catch (err) {
        logger.warn('Automatic invite email failed', err.message);
      }
    }
    return;
  }

  try {
    const noteParts = ['Auto-generated after successful payment'];
    if (paymentId) {
      noteParts.push(`#${paymentId}`);
    }
    const note = noteParts.join(' ');

    const inviteData = await plexService.createInvite({
      email,
      friendlyName: donor.name || undefined,
    });

    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      inviteId: inviteData.inviteId,
      inviteUrl: inviteData.inviteUrl || '',
      inviteStatus: inviteData.status || null,
      invitedAt: inviteData.invitedAt || new Date().toISOString(),
      sharedLibraries: Array.isArray(inviteData.sharedLibraries)
        ? inviteData.sharedLibraries
        : undefined,
      recipientEmail: email,
      note,
      plexAccountId: donor.plexAccountId,
      plexEmail: donor.plexEmail,
    });

    logEvent('invite.auto.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      source: 'payment-webhook',
      plexInviteId: inviteRecord.plexInviteId || inviteData.inviteId || null,
    });

    if (!inviteRecord.inviteUrl) {
      logger.warn('Plex invite created without a shareable URL', {
        donorId: donor.id,
        plexInviteId: inviteRecord.plexInviteId,
      });
      return;
    }

    try {
      await emailService.sendInviteEmail({
        to: email,
        inviteUrl: inviteRecord.inviteUrl,
        name: donor.name,
        subscriptionId: donor.subscriptionId,
      });
      markInviteEmailSent(inviteRecord.id);
      logEvent('invite.auto.email_sent', {
        donorId: donor.id,
        inviteId: inviteRecord.id,
        source: 'payment-webhook',
      });
    } catch (err) {
      logger.warn('Automatic invite email failed', err.message);
      if (inviteRecord.plexInviteId) {
        try {
          await plexService.cancelInvite(inviteRecord.plexInviteId);
        } catch (cancelErr) {
          logger.warn(
            'Failed to cancel Plex invite after email failure',
            cancelErr.message
          );
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to create automatic invite after payment', err.message);
  }
}

router.revokeDonorAccess = revokeDonorAccess;

module.exports = router;
module.exports.revokeDonorAccess = revokeDonorAccess;
