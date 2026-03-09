const paypalService = require('../services/paypal');
const {
  updateDonorStatus,
  setDonorAccessExpirationBySubscription,
} = require('../db');
const logger = require('./logger');
const { mapPaypalSubscriptionStatus } = require('./paypal');
const { normalizeEmail } = require('./validation');

function normalizeSubscriptionId(subscriptionId) {
  if (typeof subscriptionId !== 'string') {
    return '';
  }
  return subscriptionId.trim();
}

function isValidSubscriptionId(subscriptionId) {
  const normalized = normalizeSubscriptionId(subscriptionId);
  if (!normalized) {
    return false;
  }
  if (normalized.length < 3 || normalized.length > 128) {
    return false;
  }
  return /^[a-z0-9-]+$/i.test(normalized);
}

function needsSubscriptionRefresh(donor, subscriptionLinked) {
  if (!donor) {
    return false;
  }

  const hasPayPalSubscription = normalizeSubscriptionId(donor.subscriptionId || '');

  if (!hasPayPalSubscription) {
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

function extractPaypalErrorMessage(err) {
  const defaultMessage = 'Unable to verify PayPal subscription. Try again shortly.';
  if (!err) {
    return defaultMessage;
  }

  const detailSource = err.details || err.message;
  if (detailSource == null) {
    return defaultMessage;
  }

  if (typeof detailSource === 'string') {
    const trimmed = detailSource.trim();
    if (!trimmed) {
      return defaultMessage;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if (parsed.message) {
          return String(parsed.message);
        }
        if (parsed.name) {
          return String(parsed.name);
        }
      }
    } catch (parseErr) {
      // Ignore JSON parse errors and fall back to the trimmed string.
    }
    return trimmed;
  }

  if (typeof detailSource === 'object') {
    if (detailSource.message) {
      return String(detailSource.message);
    }
    try {
      return JSON.stringify(detailSource);
    } catch (stringifyErr) {
      return defaultMessage;
    }
  }

  return defaultMessage;
}

function extractSubscriptionSubscriberEmail(subscription) {
  if (!subscription || typeof subscription !== 'object') {
    return '';
  }

  const subscriber = subscription.subscriber || subscription.payer || {};
  const candidates = [
    subscriber.email_address,
    subscriber.email,
    subscription.email_address,
    subscription.email,
  ];

  for (const value of candidates) {
    const normalized = normalizeEmail(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function createSubscriptionOwnershipError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function fetchVerifiedPayPalSubscription(subscriptionId, { expectedEmail } = {}) {
  const normalizedSubscriptionId = normalizeSubscriptionId(subscriptionId);
  if (!normalizedSubscriptionId) {
    throw createSubscriptionOwnershipError(
      'SUBSCRIPTION_ID_REQUIRED',
      'A PayPal subscription ID is required.'
    );
  }

  const subscription = await paypalService.getSubscription(normalizedSubscriptionId);
  const subscriberEmail = extractSubscriptionSubscriberEmail(subscription);
  const normalizedExpectedEmail = normalizeEmail(expectedEmail);

  if (normalizedExpectedEmail) {
    if (!subscriberEmail) {
      throw createSubscriptionOwnershipError(
        'SUBSCRIPTION_SUBSCRIBER_MISSING',
        'PayPal did not return a subscriber email for this subscription.'
      );
    }

    if (subscriberEmail !== normalizedExpectedEmail) {
      throw createSubscriptionOwnershipError(
        'SUBSCRIPTION_EMAIL_MISMATCH',
        'The PayPal subscription email does not match this account email.'
      );
    }
  }

  const billingInfo = (subscription && subscription.billing_info) || {};
  const subscriptionStatus = (subscription && subscription.status) || '';
  const lastPaymentAt =
    (billingInfo.last_payment && billingInfo.last_payment.time) || null;

  return {
    subscription,
    subscriberEmail,
    normalizedStatus: mapPaypalSubscriptionStatus(subscriptionStatus),
    lastPaymentAt,
  };
}

function applyPayPalSubscriptionSnapshot(donor, snapshot) {
  if (!donor || !snapshot) {
    return donor;
  }

  const statusToApply = snapshot.normalizedStatus || donor.status || 'pending';
  const statusUpdated = updateDonorStatus(
    donor.subscriptionId,
    statusToApply,
    snapshot.lastPaymentAt || donor.lastPaymentAt || null
  );

  let updatedDonor = statusUpdated || donor;

  if (snapshot.normalizedStatus === 'active') {
    const donorWithAccess = setDonorAccessExpirationBySubscription(
      donor.subscriptionId,
      null
    );
    if (donorWithAccess) {
      updatedDonor = donorWithAccess;
    }
  }

  return updatedDonor;
}

async function refreshDonorSubscription(donor, { onError } = {}) {
  if (!donor) {
    return { donor, error: '' };
  }

  return await refreshPayPalSubscription(donor, { onError });
}

async function refreshPayPalSubscription(donor, { onError } = {}) {
  const subscriptionId = normalizeSubscriptionId(donor.subscriptionId || '');
  if (!subscriptionId) {
    return { donor, error: '' };
  }

  try {
    const subscription = await paypalService.getSubscription(subscriptionId);
    const subscriptionStatus = (subscription && subscription.status) || '';
    const normalizedStatus = mapPaypalSubscriptionStatus(subscriptionStatus);
    const billingInfo = (subscription && subscription.billing_info) || {};
    const lastPaymentAt =
      (billingInfo.last_payment && billingInfo.last_payment.time) || null;

    if (!normalizedStatus && !lastPaymentAt) {
      return { donor, error: '' };
    }

    const statusToApply = normalizedStatus || donor.status || 'pending';
    const statusUpdated = updateDonorStatus(
      subscriptionId,
      statusToApply,
      lastPaymentAt || donor.lastPaymentAt || null
    );

    let updatedDonor = statusUpdated || donor;

    if (normalizedStatus === 'active') {
      const donorWithAccess = setDonorAccessExpirationBySubscription(
        subscriptionId,
        null
      );
      if (donorWithAccess) {
        updatedDonor = donorWithAccess;
      }
    }

    return { donor: updatedDonor, error: '' };
  } catch (err) {
    if (typeof onError === 'function') {
      try {
        onError(err);
      } catch (handlerError) {
        logger.warn('PayPal refresh error handler failed', {
          error: handlerError && handlerError.message,
        });
      }
    } else {
      logger.warn('Failed to refresh PayPal subscription', {
        donorId: donor.id,
        subscriptionId: donor.subscriptionId,
        error: err && err.message,
      });
    }

    const errorMessage = extractPaypalErrorMessage(err);
    return { donor, error: errorMessage || '' };
  }
}

module.exports = {
  normalizeSubscriptionId,
  isValidSubscriptionId,
  needsSubscriptionRefresh,
  refreshDonorSubscription,
  fetchVerifiedPayPalSubscription,
  extractSubscriptionSubscriberEmail,
  applyPayPalSubscriptionSnapshot,
};
