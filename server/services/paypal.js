const fetch = require('node-fetch');
const { getPaypalSettings } = require('../state/settings');

function getPaypalConfig(overrideSettings) {
  const settings = overrideSettings || getPaypalSettings();
  if (!settings.clientId || !settings.clientSecret) {
    throw new Error('PayPal credentials are not configured');
  }
  const apiBase = (settings.apiBase || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
  return { ...settings, apiBase };
}

async function getAccessToken(overrideSettings) {
  const paypal = getPaypalConfig(overrideSettings);
  const credentials = Buffer.from(
    `${paypal.clientId}:${paypal.clientSecret}`
  ).toString('base64');

  const response = await fetch(`${paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    await handleErrorResponse(response, 'PayPal access token request failed');
  }

  const data = await response.json();
  return data.access_token;
}

async function handleErrorResponse(response, defaultMessage) {
  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    text = '';
  }
  const trimmed = text && text.trim();
  const message = trimmed
    ? `${defaultMessage}: ${trimmed}`
    : `${defaultMessage} (status ${response.status})`;
  const error = new Error(message);
  error.status = response.status;
  error.details = trimmed;
  throw error;
}

async function parseJsonResponse(response, defaultMessage) {
  if (response.ok) {
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }
  await handleErrorResponse(response, defaultMessage);
}

function normalizeCurrency(currency) {
  const normalized = (currency || '').toString().trim().toUpperCase();
  return normalized || 'USD';
}

function formatPriceValue(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('A positive subscription price is required to generate a PayPal plan.');
  }
  return numeric.toFixed(2);
}

function truncate(value, maxLength) {
  if (value == null) {
    return '';
  }
  const stringValue = String(value);
  if (stringValue.length <= maxLength) {
    return stringValue;
  }
  return stringValue.slice(0, maxLength);
}

function buildPlanPayload({
  productId,
  planName,
  planDescription,
  priceValue,
  currencyCode,
}) {
  return {
    product_id: productId,
    name: planName,
    description: planDescription,
    billing_cycles: [
      {
        frequency: {
          interval_unit: 'MONTH',
          interval_count: 1,
        },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: {
            value: priceValue,
            currency_code: currencyCode,
          },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: 'CANCEL',
      payment_failure_threshold: 3,
    },
    taxes: {
      percentage: '0',
      inclusive: false,
    },
  };
}

async function getProduct(productId, overrideSettings) {
  if (!productId) {
    throw new Error('PayPal product ID is required');
  }
  const paypal = getPaypalConfig(overrideSettings);
  const token = await getAccessToken(overrideSettings);
  const response = await fetch(
    `${paypal.apiBase}/v1/catalogs/products/${productId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return parseJsonResponse(
    response,
    `Failed to fetch PayPal product ${productId}`
  );
}

async function createProduct({ name, description }, overrideSettings) {
  const paypal = getPaypalConfig(overrideSettings);
  const token = await getAccessToken(overrideSettings);
  const payload = {
    name: truncate(name || 'Plex Donate Subscription', 127),
    description: truncate(
      description || 'Recurring subscription for Plex server access support.',
      256
    ),
    type: 'SERVICE',
    category: 'SOFTWARE',
  };

  const response = await fetch(`${paypal.apiBase}/v1/catalogs/products`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseJsonResponse(response, 'Failed to create PayPal product');
}

async function ensureProduct({ productId, name, description }, overrideSettings) {
  const trimmedId = (productId || '').trim();
  if (trimmedId) {
    try {
      const product = await getProduct(trimmedId, overrideSettings);
      return { product, created: false };
    } catch (err) {
      if (err && err.status !== 404) {
        throw err;
      }
    }
  }

  const product = await createProduct({ name, description }, overrideSettings);
  return { product, created: true };
}

async function createPlan(planPayload, overrideSettings) {
  const paypal = getPaypalConfig(overrideSettings);
  const token = await getAccessToken(overrideSettings);
  const response = await fetch(`${paypal.apiBase}/v1/billing/plans`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(planPayload),
  });

  return parseJsonResponse(response, 'Failed to create PayPal billing plan');
}

async function activatePlan(planId, overrideSettings) {
  const paypal = getPaypalConfig(overrideSettings);
  const token = await getAccessToken(overrideSettings);
  const response = await fetch(
    `${paypal.apiBase}/v1/billing/plans/${planId}/activate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Activate plan' }),
    }
  );

  if (response.ok || response.status === 204) {
    return true;
  }

  await handleErrorResponse(response, `Failed to activate PayPal plan ${planId}`);
}

async function getPlan(planId, overrideSettings) {
  if (!planId) {
    throw new Error('PayPal plan ID is required');
  }
  const paypal = getPaypalConfig(overrideSettings);
  const token = await getAccessToken(overrideSettings);
  const response = await fetch(
    `${paypal.apiBase}/v1/billing/plans/${planId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return parseJsonResponse(response, `Failed to fetch PayPal plan ${planId}`);
}

function getPlanManagementUrl(planId, overrideSettings) {
  if (!planId) {
    return '';
  }
  const paypal = getPaypalConfig(overrideSettings);
  const isSandbox = (paypal.apiBase || '').toLowerCase().includes('sandbox');
  const base = isSandbox
    ? 'https://www.sandbox.paypal.com/billing/plans'
    : 'https://www.paypal.com/billing/plans';
  return `${base}/${encodeURIComponent(planId)}`;
}

async function generateSubscriptionPlan(
  {
    price,
    currency,
    existingProductId,
    productName,
    productDescription,
    planName,
    planDescription,
  } = {},
  overrideSettings
) {
  const priceValue = formatPriceValue(price);
  const currencyCode = normalizeCurrency(currency);
  const descriptor = `${priceValue} ${currencyCode}`;
  const uniqueSuffix = Date.now().toString(36).toUpperCase();
  const defaultPlanName = planName || `Plex Donate Monthly (${descriptor})`;
  const defaultPlanDescription =
    planDescription ||
    `Recurring Plex donation billed monthly at ${descriptor}.`;
  const defaultProductName = productName || 'Plex Donate Subscription';
  const defaultProductDescription =
    productDescription ||
    'Recurring subscription for Plex server access support.';

  const { product } = await ensureProduct(
    {
      productId: existingProductId,
      name: truncate(defaultProductName, 127),
      description: truncate(defaultProductDescription, 256),
    },
    overrideSettings
  );

  const planPayload = buildPlanPayload({
    productId: product.id,
    planName: truncate(`${defaultPlanName} ${uniqueSuffix}`, 127),
    planDescription: truncate(defaultPlanDescription, 127),
    priceValue,
    currencyCode,
  });

  const draftPlan = await createPlan(planPayload, overrideSettings);
  await activatePlan(draftPlan.id, overrideSettings);
  const plan = await getPlan(draftPlan.id, overrideSettings);

  return {
    plan,
    product,
    planId: plan.id,
    productId: product.id,
    priceValue,
    currencyCode,
  };
}

async function verifyConnection(overrideSettings) {
  const token = await getAccessToken(overrideSettings);
  return {
    message: 'PayPal credentials verified successfully.',
    tokenLength: typeof token === 'string' ? token.length : 0,
  };
}

async function verifyWebhookSignature(headers, body) {
  const paypal = getPaypalSettings();
  if (!paypal.webhookId) {
    return { verified: false, reason: 'Missing PayPal webhook id' };
  }
  const paypalConfig = getPaypalConfig();
  const token = await getAccessToken();

  const verificationPayload = {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: paypalConfig.webhookId,
    webhook_event: body,
  };

  const response = await fetch(
    `${paypalConfig.apiBase}/v1/notifications/verify-webhook-signature`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(verificationPayload),
    }
  );

  if (!response.ok) {
    await handleErrorResponse(response, 'PayPal webhook verification failed');
  }

  const data = await response.json();
  return { verified: data.verification_status === 'SUCCESS', raw: data };
}

async function getSubscription(subscriptionId) {
  const paypal = getPaypalConfig();
  const token = await getAccessToken();
  const response = await fetch(
    `${paypal.apiBase}/v1/billing/subscriptions/${subscriptionId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return parseJsonResponse(
    response,
    `Failed to fetch PayPal subscription ${subscriptionId}`
  );
}

async function createSubscription(planId, subscriber = {}, overrideSettings) {
  if (!planId) {
    throw new Error('PayPal plan ID is required to create a subscription');
  }

  const paypal = getPaypalConfig(overrideSettings);
  const token = await getAccessToken(overrideSettings);

  const payload = { plan_id: planId };
  if (
    subscriber &&
    typeof subscriber === 'object' &&
    Object.keys(subscriber).length > 0
  ) {
    payload.subscriber = subscriber;
  }

  const response = await fetch(`${paypal.apiBase}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await handleErrorResponse(response, 'Failed to create PayPal subscription');
  }

  const data = await response.json();
  const approvalLink = Array.isArray(data.links)
    ? data.links.find((link) => link && link.rel === 'approve')
    : null;

  if (!approvalLink || !approvalLink.href) {
    throw new Error(
      'PayPal subscription response did not include an approval URL'
    );
  }

  if (!data.id) {
    throw new Error('PayPal subscription response did not include an ID');
  }

  return {
    subscriptionId: data.id,
    approvalUrl: approvalLink.href,
  };
}

module.exports = {
  getPaypalConfig,
  getAccessToken,
  verifyWebhookSignature,
  getSubscription,
  verifyConnection,
  createSubscription,
  getProduct,
  createProduct,
  getPlan,
  activatePlan,
  generateSubscriptionPlan,
  getPlanManagementUrl,
};
