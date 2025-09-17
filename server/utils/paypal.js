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

module.exports = {
  getPaypalEnvironment,
  getSubscriptionCheckoutUrl,
};
