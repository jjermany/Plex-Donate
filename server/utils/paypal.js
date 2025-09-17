function getPaypalEnvironment(apiBase) {
  if (!apiBase) {
    return 'live';
  }
  const normalized = String(apiBase).toLowerCase();
  return normalized.includes('sandbox') ? 'sandbox' : 'live';
}

function getSubscriptionCheckoutUrl({ planId, apiBase } = {}) {
  if (!planId) {
    return '';
  }
  const environment = getPaypalEnvironment(apiBase);
  const baseUrl =
    environment === 'sandbox'
      ? 'https://www.sandbox.paypal.com/webapps/billing/subscriptions'
      : 'https://www.paypal.com/webapps/billing/subscriptions';
  return `${baseUrl}?plan_id=${encodeURIComponent(planId)}`;
}

function isSubscriptionCheckoutConfigured(settings = {}) {
  if (!settings || typeof settings !== 'object') {
    return false;
  }
  const planId = String(settings.planId || '').trim();
  const clientId = String(settings.clientId || '').trim();
  const clientSecret = String(settings.clientSecret || '').trim();
  return Boolean(planId && clientId && clientSecret);
}

function buildSubscriberDetails(primary = {}, fallback = {}) {
  const combined = {
    email: '',
    name: '',
    ...(fallback || {}),
    ...(primary || {}),
  };

  const details = {};

  const emailCandidate = (combined.email || '').toString().trim().toLowerCase();
  if (emailCandidate) {
    details.email_address = emailCandidate;
  }

  const displayName = (combined.name || '').toString().trim();
  if (displayName) {
    const parts = displayName.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      details.name = { given_name: parts[0] };
      if (parts.length > 1) {
        details.name.surname = parts.slice(1).join(' ');
      }
    }
  }

  return details;
}

module.exports = {
  getPaypalEnvironment,
  getSubscriptionCheckoutUrl,
  isSubscriptionCheckoutConfigured,
  buildSubscriberDetails,
};
