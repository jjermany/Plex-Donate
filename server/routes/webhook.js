const express = require('express');
const paypalService = require('../services/paypal');
const {
  upsertDonor,
  updateDonorStatus,
  getDonorBySubscriptionId,
  getLatestActiveInviteForDonor,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  recordPayment,
  logEvent,
} = require('../db');
const plexService = require('../services/plex');
const wizarrService = require('../services/wizarr');
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
      await handlePaymentEvent(event);
      break;
    default:
      logger.info('Unhandled PayPal event type', type);
      break;
  }
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

async function handleSubscriptionEvent(event) {
  const resource = event.resource || {};
  const subscriptionId = resource.id || resource.subscription_id;
  const status = (resource.status || '').toLowerCase();
  const billingInfo = resource.billing_info || {};
  const lastPaymentAt =
    (billingInfo.last_payment && billingInfo.last_payment.time) || null;
  const subscriber = extractSubscriber(resource);

  const donor = upsertDonor({
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

  if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED') {
    await handleCancellation(donor);
  }
}

async function handleCancellation(donor) {
  updateDonorStatus(donor.subscriptionId, 'cancelled');
  if (!donor.email) {
    return;
  }
  if (plexService.isConfigured()) {
    try {
      const result = await plexService.revokeUserByEmail(donor.email);
      if (result.success) {
        const invite = getLatestActiveInviteForDonor(donor.id);
        if (invite) {
          markPlexRevoked(invite.id);
        }
        logEvent('plex.access.revoked', {
          donorId: donor.id,
          email: donor.email,
        });
      }
    } catch (err) {
      logger.warn('Failed to revoke Plex access automatically', err.message);
    }
  }

  const invite = getLatestActiveInviteForDonor(donor.id);
  if (invite && invite.wizarrInviteCode) {
    try {
      await wizarrService.revokeInvite(invite.wizarrInviteCode);
      revokeInviteRecord(invite.id);
      logEvent('wizarr.invite.revoked', {
        donorId: donor.id,
        inviteId: invite.id,
      });
    } catch (err) {
      logger.warn('Failed to revoke Wizarr invite automatically', err.message);
    }
  }
}

async function handlePaymentEvent(event) {
  const resource = event.resource || {};
  const subscriptionId = resource.billing_agreement_id || resource.custom || null;
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

  updateDonorStatus(subscriptionId, 'active', paidAt);
  logEvent('paypal.payment.recorded', {
    donorId: donor.id,
    amount,
    currency,
  });
}

module.exports = router;
