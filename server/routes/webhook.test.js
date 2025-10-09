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
const { db, createDonor } = require('../db');
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
