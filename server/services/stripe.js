const Stripe = require('stripe');
const { getStripeSettings } = require('../state/settings');

function getStripeClient(overrideSettings) {
  const settings = overrideSettings || getStripeSettings();
  if (!settings.secretKey) {
    throw new Error('Stripe secret key is not configured');
  }

  return new Stripe(settings.secretKey, {
    apiVersion: '2024-12-18.acacia',
  });
}

function normalizeCurrency(currency) {
  const normalized = (currency || '').toString().trim().toLowerCase();
  return normalized || 'usd';
}

function formatPriceAmount(amount, currency = 'usd') {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('A positive subscription price is required to create a Stripe product.');
  }

  // Stripe expects amounts in cents for most currencies
  const zeroDecimalCurrencies = ['jpy', 'krw', 'clp', 'vnd'];
  if (zeroDecimalCurrencies.includes(currency.toLowerCase())) {
    return Math.round(numeric);
  }

  return Math.round(numeric * 100);
}

async function ensureProduct({ name, description }, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  const settings = overrideSettings || getStripeSettings();

  // Check if product already exists
  if (settings.productId) {
    try {
      const product = await stripe.products.retrieve(settings.productId);
      return product;
    } catch (err) {
      // Product doesn't exist, create a new one
    }
  }

  // Create new product
  const product = await stripe.products.create({
    name: name || 'Plex Access Subscription',
    description: description || 'Monthly subscription for Plex media server access',
    type: 'service',
  });

  return product;
}

async function ensurePrice({ productId, amount, currency, interval = 'month' }, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  const settings = overrideSettings || getStripeSettings();

  const normalizedCurrency = normalizeCurrency(currency);
  const priceAmount = formatPriceAmount(amount, normalizedCurrency);

  // Check if price already exists
  if (settings.priceId) {
    try {
      const price = await stripe.prices.retrieve(settings.priceId);
      // Verify it matches our requirements
      if (
        price.product === productId &&
        price.unit_amount === priceAmount &&
        price.currency === normalizedCurrency &&
        price.recurring?.interval === interval
      ) {
        return price;
      }
    } catch (err) {
      // Price doesn't exist or doesn't match, create a new one
    }
  }

  // Create new price
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: priceAmount,
    currency: normalizedCurrency,
    recurring: {
      interval: interval,
    },
  });

  return price;
}

async function generateSubscriptionPlan({ price, currency }, overrideSettings) {
  const product = await ensureProduct(
    {
      name: 'Plex Access Subscription',
      description: 'Monthly subscription for Plex media server access',
    },
    overrideSettings
  );

  const priceObj = await ensurePrice(
    {
      productId: product.id,
      amount: price,
      currency: currency,
      interval: 'month',
    },
    overrideSettings
  );

  return {
    product: product,
    price: priceObj,
    productId: product.id,
    priceId: priceObj.id,
  };
}

async function createCheckoutSession({ priceId, customerEmail, customerId, successUrl, cancelUrl }, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);

  const sessionParams = {
    mode: 'subscription',
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    subscription_data: {
      metadata: {
        source: 'plex-donate',
      },
    },
  };

  if (customerId) {
    sessionParams.customer = customerId;
  } else if (customerEmail) {
    sessionParams.customer_email = customerEmail;
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
  };
}

async function getCustomer(customerId, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  return await stripe.customers.retrieve(customerId);
}

async function createCustomer({ email, name, metadata = {} }, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);

  const customerParams = {
    email: email,
    metadata: {
      source: 'plex-donate',
      ...metadata,
    },
  };

  if (name) {
    customerParams.name = name;
  }

  return await stripe.customers.create(customerParams);
}

async function getSubscription(subscriptionId, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  return await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['latest_invoice', 'customer'],
  });
}

async function cancelSubscription(subscriptionId, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  return await stripe.subscriptions.cancel(subscriptionId);
}

async function createBillingPortalSession({ customerId, returnUrl }, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);

  return await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

async function getPaymentIntent(paymentIntentId, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  return await stripe.paymentIntents.retrieve(paymentIntentId);
}

async function getInvoice(invoiceId, overrideSettings) {
  const stripe = getStripeClient(overrideSettings);
  return await stripe.invoices.retrieve(invoiceId);
}

function constructWebhookEvent(payload, signature, overrideSettings) {
  const settings = overrideSettings || getStripeSettings();
  if (!settings.webhookSecret) {
    throw new Error('Stripe webhook secret is not configured');
  }

  const stripe = getStripeClient(overrideSettings);
  return stripe.webhooks.constructEvent(payload, signature, settings.webhookSecret);
}

function mapStripeSubscriptionStatus(status) {
  const statusMap = {
    'incomplete': 'pending',
    'incomplete_expired': 'expired',
    'trialing': 'trial',
    'active': 'active',
    'past_due': 'active', // Keep active but may need attention
    'canceled': 'cancelled',
    'unpaid': 'suspended',
    'paused': 'suspended',
  };

  return statusMap[status] || status;
}

function buildSubscriberDetails(donor) {
  const email = donor?.email || donor?.plexEmail;
  const name = donor?.name;

  return {
    email: email || '',
    name: name || '',
  };
}

async function verifyConnection(overrideSettings) {
  const settings = overrideSettings || getStripeSettings();

  // Validate required fields
  if (!settings.secretKey) {
    throw new Error('Stripe secret key is required');
  }

  if (!settings.publishableKey) {
    throw new Error('Stripe publishable key is required');
  }

  if (!settings.webhookSecret) {
    throw new Error('Stripe webhook secret is required');
  }

  // Validate webhook secret format
  if (!settings.webhookSecret.startsWith('whsec_')) {
    throw new Error('Webhook secret should start with "whsec_"');
  }

  // Test the API connection by retrieving account information
  const stripe = getStripeClient(overrideSettings);
  const balance = await stripe.balance.retrieve();

  // Check if we're in test mode or live mode
  const isTestMode = settings.secretKey.startsWith('sk_test_');
  const environment = isTestMode ? 'test' : 'live';

  return {
    message: `Stripe credentials verified successfully in ${environment} mode.`,
    environment,
    currency: balance.available?.[0]?.currency || 'usd',
  };
}

module.exports = {
  getStripeClient,
  ensureProduct,
  ensurePrice,
  generateSubscriptionPlan,
  createCheckoutSession,
  getCustomer,
  createCustomer,
  getSubscription,
  cancelSubscription,
  createBillingPortalSession,
  getPaymentIntent,
  getInvoice,
  constructWebhookEvent,
  mapStripeSubscriptionStatus,
  buildSubscriberDetails,
  verifyConnection,
};
