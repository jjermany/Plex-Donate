const express = require('express');
const { webhookLimiter } = require('../middleware/rate-limit');
const stripeService = require('../services/stripe');
const {
  createDonor,
  getDonorByStripeSubscriptionId,
  getDonorByStripeCustomerId,
  updateDonorStripeInfo,
  updateDonorStatusByStripeSubscription,
  setDonorAccessExpirationByStripeSubscription,
  getLatestActiveInviteForDonor,
  createInvite: createInviteRecord,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  recordPayment,
  logEvent,
  markInviteEmailSent,
  updateInvitePlexDetails,
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
  webhookLimiter,
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      logger.warn('Stripe webhook missing signature');
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    let event;
    try {
      event = stripeService.constructWebhookEvent(req.body, signature);
    } catch (err) {
      logger.error('Stripe webhook verification error', err.message);
      return res.status(400).json({ error: 'Webhook verification failed' });
    }

    logEvent('stripe.webhook.received', {
      id: event.id,
      eventType: event.type,
    });

    await handleEvent(event);

    res.status(200).json({ received: true });
  })
);

async function handleEvent(event) {
  const type = event.type;

  switch (type) {
    // Checkout session events
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event);
      break;

    // Subscription events
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event);
      break;

    // Invoice payment events
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event);
      break;

    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event);
      break;

    default:
      logger.info('Unhandled Stripe event type', type);
      break;
  }
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  if (!customerId || !subscriptionId) {
    logger.warn('Checkout session missing customer or subscription', session.id);
    return;
  }

  logEvent('stripe.checkout.completed', {
    sessionId: session.id,
    customerId,
    subscriptionId,
  });

  // Fetch the subscription to get full details
  let subscription;
  try {
    subscription = await stripeService.getSubscription(subscriptionId);
  } catch (err) {
    logger.error('Failed to fetch subscription after checkout', err.message);
    return;
  }

  await handleSubscriptionUpdated({ data: { object: subscription } });
}

async function handleSubscriptionUpdated(event) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;
  const customerId = subscription.customer;
  const status = subscription.status;

  let donor = getDonorByStripeSubscriptionId(subscriptionId);

  if (!donor) {
    // Try to find by customer ID
    donor = getDonorByStripeCustomerId(customerId);
  }

  if (!donor) {
    // Create new donor if checkout session included email
    const customerEmail = typeof subscription.customer === 'object'
      ? subscription.customer.email
      : null;

    if (!customerEmail) {
      logger.warn('Cannot create donor without email', { subscriptionId, customerId });
      return;
    }

    donor = createDonor({
      email: customerEmail,
      name: typeof subscription.customer === 'object' ? subscription.customer.name : '',
      paymentProvider: 'stripe',
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      status: stripeService.mapStripeSubscriptionStatus(status),
    });

    logEvent('stripe.donor.created', {
      donorId: donor.id,
      subscriptionId,
      customerId,
    });
  } else if (!donor.stripeSubscriptionId || donor.stripeSubscriptionId !== subscriptionId) {
    // Update donor with Stripe info
    donor = updateDonorStripeInfo(donor.id, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });

    logEvent('stripe.donor.linked', {
      donorId: donor.id,
      subscriptionId,
      customerId,
    });
  }

  // Update subscription status
  const mappedStatus = stripeService.mapStripeSubscriptionStatus(status);

  if (mappedStatus === 'active') {
    // Subscription is active - grant unlimited access
    updateDonorStatusByStripeSubscription(subscriptionId, 'active');
    setDonorAccessExpirationByStripeSubscription(subscriptionId, null);

    logEvent('stripe.subscription.activated', {
      donorId: donor.id,
      subscriptionId,
      status,
    });

    // Create Plex invite if donor has Plex account linked
    await createAutoInvite(donor);
  } else if (['cancelled', 'expired', 'suspended'].includes(mappedStatus)) {
    // Subscription ended - set access expiration
    const expiresAt = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days grace

    updateDonorStatusByStripeSubscription(subscriptionId, mappedStatus);
    setDonorAccessExpirationByStripeSubscription(subscriptionId, expiresAt);

    logEvent('stripe.subscription.ended', {
      donorId: donor.id,
      subscriptionId,
      status: mappedStatus,
      expiresAt,
    });

    // Revoke Plex access
    await revokeAccessForDonor(donor);

    // Send cancellation email
    await sendCancellationEmail(donor);
  } else {
    // Other statuses (pending, trial, etc.)
    updateDonorStatusByStripeSubscription(subscriptionId, mappedStatus);

    logEvent('stripe.subscription.updated', {
      donorId: donor.id,
      subscriptionId,
      status: mappedStatus,
    });
  }
}

async function handleSubscriptionDeleted(event) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;

  const donor = getDonorByStripeSubscriptionId(subscriptionId);
  if (!donor) {
    logger.warn('Subscription deleted for unknown donor', subscriptionId);
    return;
  }

  // Set access expiration to now
  const expiresAt = new Date().toISOString();
  updateDonorStatusByStripeSubscription(subscriptionId, 'cancelled');
  setDonorAccessExpirationByStripeSubscription(subscriptionId, expiresAt);

  logEvent('stripe.subscription.deleted', {
    donorId: donor.id,
    subscriptionId,
  });

  // Revoke Plex access immediately
  await revokeAccessForDonor(donor);

  // Send cancellation email
  await sendCancellationEmail(donor);
}

async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data.object;
  const subscriptionId = invoice.subscription;
  const paymentIntentId = invoice.payment_intent;

  if (!subscriptionId) {
    return; // Not a subscription payment
  }

  const donor = getDonorByStripeSubscriptionId(subscriptionId);
  if (!donor) {
    logger.warn('Payment succeeded for unknown subscription', subscriptionId);
    return;
  }

  // Record the payment
  recordPayment({
    donorId: donor.id,
    paymentProvider: 'stripe',
    stripePaymentId: paymentIntentId,
    amount: invoice.amount_paid / 100, // Convert from cents
    currency: invoice.currency.toUpperCase(),
    paidAt: new Date(invoice.created * 1000).toISOString(),
  });

  // Update last payment date
  updateDonorStatusByStripeSubscription(
    subscriptionId,
    'active',
    new Date(invoice.created * 1000).toISOString()
  );

  logEvent('stripe.payment.succeeded', {
    donorId: donor.id,
    subscriptionId,
    amount: invoice.amount_paid / 100,
    currency: invoice.currency,
  });

  // Create auto-invite if donor has Plex account
  await createAutoInvite(donor);
}

async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object;
  const subscriptionId = invoice.subscription;

  if (!subscriptionId) {
    return;
  }

  const donor = getDonorByStripeSubscriptionId(subscriptionId);
  if (!donor) {
    logger.warn('Payment failed for unknown subscription', subscriptionId);
    return;
  }

  logEvent('stripe.payment.failed', {
    donorId: donor.id,
    subscriptionId,
    attemptCount: invoice.attempt_count,
  });

  // Send payment failure notification
  try {
    await emailService.sendPaymentFailedEmail(donor);
  } catch (err) {
    logger.error('Failed to send payment failure email', err.message);
  }
}

async function createAutoInvite(donor) {
  if (!donor.plexAccountId && !donor.plexEmail) {
    return;
  }

  const existingInvite = getLatestActiveInviteForDonor(donor.id);
  if (existingInvite) {
    return;
  }

  try {
    const invite = await plexService.inviteFriend({
      plexAccountId: donor.plexAccountId,
      plexEmail: donor.plexEmail,
    });

    const inviteRecord = createInviteRecord({
      donorId: donor.id,
      inviteId: invite.id,
      inviteUrl: invite.url,
      invitedAt: new Date().toISOString(),
      inviteStatus: invite.status,
      sharedLibraries: invite.sharedLibraries,
      plexAccountId: donor.plexAccountId,
      plexEmail: donor.plexEmail,
      recipientEmail: donor.plexEmail,
    });

    logEvent('stripe.invite.created', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
    });

    await emailService.sendInviteEmail(donor, inviteRecord);
    markInviteEmailSent(inviteRecord.id);
  } catch (err) {
    logger.error('Failed to create auto-invite for Stripe donor', err.message);
  }
}

async function revokeAccessForDonor(donor) {
  const activeInvite = getLatestActiveInviteForDonor(donor.id);
  if (!activeInvite) {
    return;
  }

  try {
    await plexService.removeFriend({
      plexAccountId: activeInvite.plexAccountId,
      plexEmail: activeInvite.plexEmail,
    });

    revokeInviteRecord(activeInvite.id);
    markPlexRevoked(activeInvite.id);

    logEvent('stripe.invite.revoked', {
      donorId: donor.id,
      inviteId: activeInvite.id,
    });
  } catch (err) {
    logger.error('Failed to revoke Plex access', err.message);
  }
}

async function sendCancellationEmail(donor) {
  try {
    await emailService.sendSubscriptionCancelledEmail(donor);
  } catch (err) {
    logger.error('Failed to send cancellation email', err.message);
  }
}

module.exports = router;
