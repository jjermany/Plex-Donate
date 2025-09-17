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
    const text = await response.text();
    throw new Error(`PayPal access token request failed: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
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
    const text = await response.text();
    throw new Error(`PayPal webhook verification failed: ${text}`);
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to fetch PayPal subscription ${subscriptionId}: ${text}`
    );
  }

  return response.json();
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
    const text = await response.text();
    throw new Error(`Failed to create PayPal subscription: ${text}`);
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
};
