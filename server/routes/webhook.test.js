process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const testDbDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plex-donate-webhook-db-')
  );
  process.env.DATABASE_FILE = path.join(testDbDir, 'database.sqlite');
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const webhookRouter = require('./webhook');
const { db, createDonor, listDonorsWithDetails } = require('../db');
const paypalService = require('../services/paypal');
const settingsStore = require('../state/settings');
const emailService = require('../services/email');
const nodemailer = require('nodemailer');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function resetDatabase() {
  db.exec(`
    DELETE FROM sessions;
    DELETE FROM invite_links;
    DELETE FROM invites;
    DELETE FROM payments;
    DELETE FROM events;
    DELETE FROM settings;
    DELETE FROM donors;
    DELETE FROM prospects;
    DELETE FROM sqlite_sequence WHERE name IN ('donors','prospects','invite_links','invites','payments','events');
  `);
}

test('cancelling a subscription sends a cancellation email', { concurrency: false }, async (t) => {
  resetDatabase();

  const smtpConfig = {
    host: 'smtp.test',
    port: 2525,
    secure: false,
    user: '',
    pass: '',
    from: 'Plex Donate <support@example.com>',
  };
  settingsStore.updateGroup('smtp', smtpConfig);

  const sentMessages = [];
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (message) => {
      sentMessages.push(message);
      return { accepted: [message.to] };
    },
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const originalSendCancellationEmail = emailService.sendCancellationEmail;
  emailService.sendCancellationEmail = (details) =>
    originalSendCancellationEmail(details, smtpConfig);
  t.after(() => {
    emailService.sendCancellationEmail = originalSendCancellationEmail;
  });

  const originalVerifySignature = paypalService.verifyWebhookSignature;
  paypalService.verifyWebhookSignature = async () => ({ verified: true });
  t.after(() => {
    paypalService.verifyWebhookSignature = originalVerifySignature;
  });

  const originalGetSubscription = paypalService.getSubscription;
  paypalService.getSubscription = async () => {
    throw new Error('getSubscription should not be called');
  };
  t.after(() => {
    paypalService.getSubscription = originalGetSubscription;
  });

  const donor = createDonor({
    email: 'donor@example.com',
    name: 'Test Donor',
    subscriptionId: 'I-TESTSUB',
    status: 'active',
  });

  const app = express();
  app.use('/', webhookRouter);
  const server = await startServer(app);

  try {
    const event = {
      id: 'EVT-123',
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: {
        id: 'I-TESTSUB',
        status: 'CANCELLED',
        billing_info: {
          next_billing_time: '2030-01-01T00:00:00Z',
        },
        subscriber: {
          email_address: 'donor@example.com',
          name: { given_name: 'Test', surname: 'Donor' },
        },
      },
    };

    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { received: true });

    assert.equal(sentMessages.length, 1);
    const message = sentMessages[0];
    assert.equal(message.to, donor.email);
    assert.equal(message.from, 'Plex Donate <support@example.com>');
    assert.equal(message.subject, 'Your Plex access is scheduled to end');
    assert.match(message.text, /Thank you for supporting our Plex server\./);
    assert.match(
      message.text,
      /will remain active until Tue, 01 Jan 2030 00:00:00 GMT/
    );
    assert.match(
      message.text,
      /restart your support anytime by visiting the donation portal/
    );
    assert.match(message.text, /Subscription ID: I-TESTSUB/);
    assert.match(
      message.html,
      /<strong>Tue, 01 Jan 2030 00:00:00 GMT<\/strong>/
    );
  } finally {
    await server.close();
  }
});

test('capture payments are recorded for admin view', { concurrency: false }, async (t) => {
  resetDatabase();

  const originalVerifySignature = paypalService.verifyWebhookSignature;
  paypalService.verifyWebhookSignature = async () => ({ verified: true });
  t.after(() => {
    paypalService.verifyWebhookSignature = originalVerifySignature;
  });

  const originalGetSubscription = paypalService.getSubscription;
  paypalService.getSubscription = async () => {
    throw new Error('getSubscription should not be called for capture payments');
  };
  t.after(() => {
    paypalService.getSubscription = originalGetSubscription;
  });

  const donor = createDonor({
    email: 'capture@example.com',
    name: 'Capture Event',
    subscriptionId: 'I-CAPTURE',
    status: 'active',
  });

  const app = express();
  app.use('/', webhookRouter);
  const server = await startServer(app);

  try {
    const captureEvent = {
      id: 'WH-123',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAPTURE-1',
        status: 'COMPLETED',
        amount: {
          value: '15.25',
          currency_code: 'USD',
        },
        create_time: '2024-01-01T00:00:00Z',
        supplementary_data: {
          related_ids: {
            subscription_id: 'I-CAPTURE',
          },
        },
      },
    };

    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(captureEvent),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { received: true });

    const donors = listDonorsWithDetails();
    const updatedDonor = donors.find((candidate) => candidate.id === donor.id);
    assert(updatedDonor, 'expected donor to be present after capture');
    assert(Array.isArray(updatedDonor.payments), 'expected payments array');
    assert.equal(updatedDonor.payments.length, 1);
    const [payment] = updatedDonor.payments;
    assert.equal(payment.paypalPaymentId, 'CAPTURE-1');
    assert.equal(payment.amount, 15.25);
    assert.equal(payment.currency, 'USD');

    const formattedPayment = payment && payment.amount
      ? `${payment.amount} ${payment.currency || ''}`.trim()
      : 'No payment recorded';
    assert.equal(
      formattedPayment,
      '15.25 USD',
      'admin view should display captured payment amount'
    );
  } finally {
    await server.close();
  }
});

test('trial donor converts to active on payment without disrupting Plex access', { concurrency: false }, async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const plexService = require('../services/plex');
  const originalIsConfigured = plexService.isConfigured;
  const originalListUsers = plexService.listUsers;
  const originalCreateInvite = plexService.createInvite;

  // Mock Plex to show trial user already has access
  plexService.isConfigured = () => true;
  plexService.listUsers = async () => [
    {
      id: '12345',
      email: 'trial-user@example.com',
      username: 'TrialUser',
    },
  ];
  plexService.createInvite = async () => {
    throw new Error('createInvite should not be called for existing Plex users');
  };

  t.after(() => {
    plexService.isConfigured = originalIsConfigured;
    plexService.listUsers = originalListUsers;
    plexService.createInvite = originalCreateInvite;
  });

  const originalVerifySignature = paypalService.verifyWebhookSignature;
  paypalService.verifyWebhookSignature = async () => ({ verified: true });
  t.after(() => {
    paypalService.verifyWebhookSignature = originalVerifySignature;
  });

  const trialExpiration = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const donor = createDonor({
    email: 'trial-user@example.com',
    name: 'Trial User',
    subscriptionId: 'I-TRIAL-TO-ACTIVE',
    status: 'trial',
    accessExpiresAt: trialExpiration,
    plexAccountId: '12345',
    plexEmail: 'trial-user@example.com',
  });

  const app = express();
  app.use('/', webhookRouter);
  const server = await startServer(app);

  try {
    const paymentEvent = {
      id: 'WH-TRIAL-PAYMENT',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'PAYMENT-123',
        status: 'COMPLETED',
        amount: {
          value: '10.00',
          currency_code: 'USD',
        },
        create_time: '2024-01-15T00:00:00Z',
        supplementary_data: {
          related_ids: {
            subscription_id: 'I-TRIAL-TO-ACTIVE',
          },
        },
      },
    };

    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paymentEvent),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { received: true });

    const donors = listDonorsWithDetails();
    const updatedDonor = donors.find((d) => d.id === donor.id);

    // Verify status changed from trial to active
    assert.equal(updatedDonor.status, 'active', 'donor should be active after payment');

    // Verify access expiration was cleared (no longer expiring)
    assert.equal(updatedDonor.accessExpiresAt, null, 'active donors should not have expiration');

    // Verify payment was recorded
    assert.equal(updatedDonor.payments.length, 1);
    assert.equal(updatedDonor.payments[0].amount, 10.00);

    // Verify lastPaymentAt was updated
    assert.equal(updatedDonor.lastPaymentAt, '2024-01-15T00:00:00Z');
  } finally {
    await server.close();
  }
});
