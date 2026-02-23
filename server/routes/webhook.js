const express = require('express');
const { webhookLimiter } = require('../middleware/rate-limit');
const paypalService = require('../services/paypal');
const {
  upsertDonor,
  updateDonorStatus,
  getDonorBySubscriptionId,
  getLatestActiveInviteForDonor,
  getLatestInviteForDonor,
  createInvite: createInviteRecord,
  revokeInvite: revokeInviteRecord,
  markPlexRevoked,
  recordPayment,
  logEvent,
  markInviteEmailSent,
  updateInvitePlexDetails,
  setDonorAccessExpirationBySubscription,
  setDonorPreexistingAccess,
} = require('../db');
const plexService = require('../services/plex');
const emailService = require('../services/email');
const adminNotifications = require('../services/admin-notifications');
const logger = require('../utils/logger');
const { isInviteStale } = require('../utils/invite-stale');
const { getInviteEmailDiagnostics } = require('../utils/validation');

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

function buildCandidateEmails(donor, inviteRecipientEmail) {
  const seen = new Set();
  const ordered = [];
  [donor && donor.plexEmail, inviteRecipientEmail].forEach((value) => {
    const normalized = normalizeEmail(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ordered.push(normalized);
  });
  return ordered;
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
    // Ensure an invite is created/emailed when a subscription becomes active
    try {
      await ensureInviteForActiveDonor(donor);
    } catch (err) {
      logger.warn('Failed to create automatic invite when subscription activated', err.message);
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

  await revokeDonorAccess(donor, {
    context: 'paypal-webhook',
    reason: 'subscription_cancelled',
  });
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

async function revokeDonorAccess(donor, options = {}) {
  if (!donor.email && !donor.plexAccountId) {
    return;
  }

  // Preserve access for users who had it before subscribing
  if (donor.hadPreexistingAccess) {
    logger.info('Preserving Plex access for donor with pre-existing access', {
      donorId: donor.id,
      email: donor.email,
      plexAccountId: donor.plexAccountId,
    });
    logEvent('plex.access.preserved', {
      donorId: donor.id,
      email: donor.email,
      reason: 'had_preexisting_access',
    });
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
        adminNotifications
          .notifyPlexRevoked({
            donor,
            reason: options.reason,
            context: options.context,
          })
          .catch((err) =>
            logger.warn('Failed to send admin Plex revocation notification', err.message)
          );
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
  const donorWasMissing = !donor;
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

  if (donorWasMissing) {
    adminNotifications
      .notifyDonorCreated({
        donor,
        source: 'PayPal payment webhook',
      })
      .catch((err) =>
        logger.warn('Failed to send admin donor created notification', err.message)
      );
  }

  const amount =
    resource.amount && (resource.amount.total || resource.amount.value);
  const currency =
    resource.amount && (resource.amount.currency || resource.amount.currency_code);
  const paidAt = resource.create_time || new Date().toISOString();

  const previousStatus = (donor.status || '').toLowerCase();

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

  const becameActive = previousStatus !== 'active' && donor.status === 'active';

  if (becameActive && donor.email) {
    try {
      await emailService.sendSubscriptionThankYouEmail({
        to: donor.email,
        name: donor.name,
        subscriptionId,
        amount,
        currency,
        paidAt,
      });
      logEvent('donor.subscription.thank_you.email.sent', {
        donorId: donor.id,
        subscriptionId,
      });
    } catch (err) {
      logger.warn('Failed to send subscription thank-you email', err.message);
    }
  }

  // Clear pre-existing access flag on first successful payment
  // User is now managed by plex-donate subscription system
  if (donor.hadPreexistingAccess) {
    const transitionedDonor = setDonorPreexistingAccess(donor.id, false);
    if (transitionedDonor) {
      donor = transitionedDonor;
    }
    logEvent('donor.transitioned_to_subscription', {
      donorId: donor.id,
      email: donor.email,
      subscriptionId,
    });
  }

  logEvent('paypal.payment.recorded', {
    donorId: donor.id,
    amount,
    currency,
  });

  if (becameActive) {
    adminNotifications
      .notifySubscriptionStarted({
        donor,
        subscriptionId,
        amount,
        currency,
        paidAt,
        source: 'PayPal payment webhook',
      })
      .catch((err) =>
        logger.warn('Failed to send admin subscription notification', err.message)
      );
  }

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

  // Plex invite target email should use the Plex identity address when available.
  // Contact/billing notifications continue to use donor.email.
  const plexInviteEmail = ((donor.plexEmail || donor.email || '') + '').trim();
  const contactEmail = (donor.email || '').trim();
  const inviteEmailDiagnostics = getInviteEmailDiagnostics(donor.email, donor.plexEmail);
  if (!plexInviteEmail) {
    logger.info('Skipping automatic invite: Plex invite target email missing', {
      donorId: donor.id,
    });
    logEvent('invite.auto.skipped', {
      donorId: donor.id,
      subscriptionId: donor.subscriptionId,
      reason: 'missing_email',
      ...inviteEmailDiagnostics,
    });
    return;
  }

  if (!hasPlexLink(donor)) {
    logger.info('Skipping automatic invite: Plex account not linked', {
      donorId: donor.id,
    });
    logEvent('invite.auto.skipped', {
      donorId: donor.id,
      subscriptionId: donor.subscriptionId,
      reason: 'plex_not_linked',
      ...inviteEmailDiagnostics,
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

  const existingInvite = getLatestActiveInviteForDonor(donor.id);
  const candidateEmails = buildCandidateEmails(
    donor,
    existingInvite && existingInvite.recipientEmail
  );
  const normalizedAccountId = (donor.plexAccountId || '')
    .toString()
    .trim()
    .toLowerCase();
  let donorHasShare = false;
  let donorHasPendingShare = false;

  if (plexService.isConfigured()) {
    try {
      const plexUsers = await plexService.listUsers();
      if (Array.isArray(plexUsers) && plexUsers.length > 0) {
        const donorHasAccess = plexUsers.some((user) => {
          const candidateUserEmails = [
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
          const emailMatch = candidateEmails.some((candidateEmail) =>
            candidateUserEmails.some(
              (value) => normalizeEmail(value) === candidateEmail
            )
          );
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
          logEvent('invite.auto.skipped', {
            donorId: donor.id,
            subscriptionId: donor.subscriptionId,
            reason: 'already_on_server',
            ...inviteEmailDiagnostics,
          });
          const latestInvite =
            getLatestActiveInviteForDonor(donor.id) ||
            getLatestInviteForDonor(donor.id);
          const inviteNote = latestInvite && latestInvite.note ? latestInvite.note : '';
          const inviteIndicatesTrial = inviteNote
            .toLowerCase()
            .includes('auto-generated for trial');

          if (latestInvite) {
            logEvent('donor.access.granted_by_invite', {
              donorId: donor.id,
              email: donor.email,
              plexAccountId: donor.plexAccountId,
              inviteId: latestInvite.id,
              reason: inviteIndicatesTrial ? 'trial_invite' : 'invite_recorded',
            });
          } else if (!donor.hadPreexistingAccess) {
            // Mark this donor as having pre-existing access so we don't revoke it on cancellation
            setDonorPreexistingAccess(donor.id, true);
            logEvent('donor.preexisting_access.detected', {
              donorId: donor.id,
              email: donor.email,
              plexAccountId: donor.plexAccountId,
            });
          }
          return;
        }
      }
    } catch (err) {
      logger.warn('Unable to verify existing Plex users before inviting', err.message);
    }

    try {
      const shareState = await plexService.getCurrentPlexShares();
      if (shareState.success && Array.isArray(shareState.shares)) {
        shareState.shares.forEach((share) => {
          if (!share) {
            return;
          }
          const emails = Array.isArray(share.emails) ? share.emails : [];
          const ids = Array.isArray(share.userIds) ? share.userIds : [];
          const matchesEmail = candidateEmails.some((candidateEmail) =>
            emails.some((value) => normalizeEmail(value) === candidateEmail)
          );
          const matchesId =
            normalizedAccountId &&
            ids.some(
              (value) =>
                String(value || '')
                  .trim()
                  .toLowerCase() === normalizedAccountId
            );
          if (!matchesEmail && !matchesId) {
            return;
          }

          const statusValue = (share.status || '').toString().toLowerCase();
          const pending = Boolean(share.pending) || statusValue.includes('pending');
          if (pending) {
            donorHasPendingShare = true;
          } else {
            donorHasShare = true;
          }
        });
      }
    } catch (err) {
      logger.warn('Unable to verify Plex share status before inviting', err.message);
    }
  }

  // A direct share via /api/v2/shared_servers grants access immediately and
  // returns a plexInviteId but no inviteUrl. Treat those as usable too.
  const existingInviteUsable =
    existingInvite &&
    (existingInvite.inviteUrl || existingInvite.plexInviteId) &&
    !existingInvite.revokedAt;
  const existingInviteMatches =
    existingInviteUsable &&
    candidateEmails.some(
      (candidateEmail) =>
        normalizeEmail(existingInvite.recipientEmail) === candidateEmail
    );

  if (existingInvite) {
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

    if (!donorHasShare && !donorHasPendingShare) {
      const inviteIsStale = isInviteStale(invite);
      // A direct share (plexInviteId present, no inviteUrl) has already granted
      // access — no need to recreate just because there is no URL.
      const inviteMissingUrl = !invite.inviteUrl && !invite.plexInviteId;
      const shouldRecreateInvite = inviteIsStale || inviteMissingUrl;
      const shouldResendEmail =
        Boolean(invite.emailSentAt) && !inviteIsStale && !inviteMissingUrl;

      if (shouldRecreateInvite || shouldResendEmail) {
        let recreatedInvite = invite;
        let reinviteAction = null;
        let reinviteReason = null;

        if (shouldRecreateInvite) {
          reinviteAction = 'recreate_invite';
          reinviteReason = inviteMissingUrl ? 'missing_invite_url' : 'stale_invite';

          if (!plexService.isConfigured()) {
            logger.warn('Plex service not configured - cannot recreate invite');
          } else {
            try {
              const inviteData = await plexService.createInvite({
                email: plexInviteEmail,
                friendlyName: donor.name || undefined,
                invitedId: donor.plexAccountId || undefined,
              });

              recreatedInvite = updateInvitePlexDetails(invite.id, {
                plexInviteId: inviteData.inviteId,
                plexInviteUrl: inviteData.inviteUrl || '',
                plexInviteStatus: inviteData.status || null,
                plexInvitedAt: inviteData.invitedAt || new Date().toISOString(),
                plexSharedLibraries: Array.isArray(inviteData.sharedLibraries)
                  ? inviteData.sharedLibraries
                  : undefined,
                plexAccountId: donor.plexAccountId,
                plexEmail: donor.plexEmail,
              });
            } catch (err) {
              logger.warn('Failed to recreate Plex invite automatically', err.message);
            }
          }
        } else if (shouldResendEmail) {
          reinviteAction = 'resend_email';
          reinviteReason = 'email_already_sent';
        }

        if (reinviteAction) {
          logEvent('invite.auto.reinvited', {
            donorId: donor.id,
            inviteId: recreatedInvite.id,
            action: reinviteAction,
            reason: reinviteReason,
            plexInviteId: recreatedInvite.plexInviteId || null,
            source: 'payment-webhook',
          });
        }

        // When Plex uses a direct share (e.g. /api/v2/shared_servers), the user is
        // immediately granted access and no invite URL is returned. Fall back to the
        // Plex web app URL so the notification email can still be sent.
        const autoEmailInviteUrl = recreatedInvite.inviteUrl || 'https://app.plex.tv';
        try {
          await emailService.sendInviteEmail({
            // Notification email goes to billing/contact email by product behavior.
            to: contactEmail,
            inviteUrl: autoEmailInviteUrl,
            name: donor.name,
            subscriptionId: donor.subscriptionId,
          });
          recreatedInvite = markInviteEmailSent(recreatedInvite.id);
          logEvent('invite.auto.email_sent', {
            donorId: donor.id,
            inviteId: recreatedInvite.id,
            source: 'payment-webhook',
          });
        } catch (err) {
          logger.warn('Automatic invite email failed', err.message);
          if (
            reinviteAction === 'recreate_invite' &&
            recreatedInvite.plexInviteId &&
            recreatedInvite.inviteUrl
          ) {
            try {
              await plexService.cancelInvite(recreatedInvite.plexInviteId);
            } catch (cancelErr) {
              logger.warn(
                'Failed to cancel Plex invite after email failure',
                cancelErr.message
              );
            }
          }
        }

        return;
      }
    }

    if (existingInviteUsable && existingInviteMatches) {
      if (donorHasShare || donorHasPendingShare) {
        logEvent('invite.auto.skipped', {
          donorId: donor.id,
          subscriptionId: donor.subscriptionId,
          reason: donorHasPendingShare ? 'share_pending' : 'share_already_present',
          inviteId: invite.id,
          ...inviteEmailDiagnostics,
        });
        return;
      }
      if (!invite.emailSentAt) {
        const existingEmailUrl = invite.inviteUrl || 'https://app.plex.tv';
        try {
          await emailService.sendInviteEmail({
            // Notification email goes to billing/contact email by product behavior.
            to: contactEmail,
            inviteUrl: existingEmailUrl,
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
      } else {
        logEvent('invite.auto.skipped', {
          donorId: donor.id,
          subscriptionId: donor.subscriptionId,
          reason: 'existing_invite_reused',
          inviteId: invite.id,
          ...inviteEmailDiagnostics,
        });
      }
      return;
    }
  }

  try {
    const noteParts = ['Auto-generated after successful payment'];
    if (paymentId) {
      noteParts.push(`#${paymentId}`);
    }
    const note = noteParts.join(' ');

    const inviteData = await plexService.createInvite({
      email: plexInviteEmail,
      friendlyName: donor.name || undefined,
      invitedId: donor.plexAccountId || undefined,
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
      recipientEmail: plexInviteEmail,
      note,
      plexAccountId: donor.plexAccountId,
      plexEmail: donor.plexEmail,
    });

    logEvent('invite.auto.generated', {
      donorId: donor.id,
      inviteId: inviteRecord.id,
      source: 'payment-webhook',
      plexInviteId: inviteRecord.plexInviteId || inviteData.inviteId || null,
      ...inviteEmailDiagnostics,
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
        // Notification email goes to billing/contact email by product behavior.
        to: contactEmail,
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
    logEvent('invite.auto.failed', {
      donorId: donor.id,
      subscriptionId: donor.subscriptionId,
      reason: 'invite_create_failed',
      ...inviteEmailDiagnostics,
    });
  }
}

router.revokeDonorAccess = revokeDonorAccess;

module.exports = router;
module.exports.revokeDonorAccess = revokeDonorAccess;
