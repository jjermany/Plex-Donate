process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const testDbDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plex-donate-automation-db-')
  );
  process.env.DATABASE_FILE = path.join(testDbDir, 'database.sqlite');
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const automationRouter = require('./automation');
const config = require('../config');
const { db, createDonor, getRecentEvents, getSetting } = require('../db');
const settingsStore = require('../state/settings');
const emailService = require('../services/email');

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
    DELETE FROM events;
    DELETE FROM settings;
    DELETE FROM invites;
    DELETE FROM payments;
    DELETE FROM invite_links;
    DELETE FROM donors;
    DELETE FROM prospects;
    DELETE FROM sqlite_sequence WHERE name IN ('events','donors','prospects','invites','payments','invite_links');
  `);
}

function createApp() {
  const app = express();
  app.use('/', automationRouter);
  return app;
}

test('UPS automation route rejects missing or invalid bearer token', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';

  const app = createApp();
  const server = await startServer(app);

  try {
    let response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'power_outage' }),
    });
    assert.equal(response.status, 401);

    response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ event: 'power_outage' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('UPS automation route returns 503 when token is not configured', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = '';

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer anything',
      },
      body: JSON.stringify({ event: 'power_outage' }),
    });
    assert.equal(response.status, 503);
  } finally {
    await server.close();
  }
});

test('UPS automation route validates event values', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({ event: 'unexpected_value' }),
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('power_outage emails active and trial donors and persists outage state', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
    supportNotificationEmail: 'owner@example.com',
  });

  createDonor({
    email: 'active@example.com',
    name: 'Active User',
    status: 'active',
  });
  createDonor({
    email: 'trial@example.com',
    name: 'Trial User',
    status: 'trial',
  });
  createDonor({
    email: 'cancelled@example.com',
    name: 'Cancelled User',
    status: 'cancelled',
  });
  createDonor({
    email: '',
    name: 'No Email',
    status: 'active',
  });

  const sentEmails = [];
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async (payload) => {
    sentEmails.push(payload);
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({
        event: 'power_outage',
        upsName: 'apc-ups',
        batteryChargePercent: 82,
        runtimeSeconds: 2400,
        occurredAt: '2026-03-17T15:30:00Z',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.deduped, false);
    assert.equal(body.sent, 3);
    assert.equal(body.skipped, 0);

    assert.equal(sentEmails.length, 3);
    assert.deepEqual(
      sentEmails.map((entry) => entry.to).sort(),
      ['active@example.com', 'owner@example.com', 'trial@example.com']
    );

    const automationState = getSetting('automation_state');
    assert.equal(automationState.currentPowerState, 'outage');
    assert.equal(automationState.lastAcceptedEventType, 'power_outage');
    assert.equal(automationState.lastAcceptedEventAt, '2026-03-17T15:30:00.000Z');

    const event = getRecentEvents(5).find(
      (item) => item.eventType === 'automation.ups.event.accepted'
    );
    assert.ok(event);
    const payload = JSON.parse(event.payload);
    assert.equal(payload.event, 'power_outage');
    assert.equal(payload.recipientCount, 3);
    assert.equal(payload.batteryChargePercent, 82);
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('power_restored emails active and trial donors', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
    supportNotificationEmail: 'owner@example.com',
  });
  createDonor({
    email: 'active@example.com',
    name: 'Active User',
    status: 'active',
  });
  createDonor({
    email: 'trial@example.com',
    name: 'Trial User',
    status: 'trial',
  });

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run(
      'automation_state',
      JSON.stringify({
        currentPowerState: 'outage',
        lastAcceptedEventType: 'power_outage',
        lastAcceptedEventAt: '2026-03-17T15:30:00.000Z',
      })
    );

  const sentEmails = [];
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async (payload) => {
    sentEmails.push(payload);
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({
        event: 'power_restored',
        occurredAt: '2026-03-17T16:00:00Z',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sent, 3);
    assert.equal(sentEmails.length, 3);
    assert.ok(sentEmails.every((entry) => entry.event === 'power_restored'));

    const automationState = getSetting('automation_state');
    assert.equal(automationState.currentPowerState, 'normal');
    assert.equal(automationState.lastAcceptedEventType, 'power_restored');
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('shutdown_imminent emails active and trial donors while keeping outage state', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
    supportNotificationEmail: 'owner@example.com',
  });
  createDonor({
    email: 'active@example.com',
    name: 'Active User',
    status: 'active',
  });

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run(
      'automation_state',
      JSON.stringify({
        currentPowerState: 'outage',
        lastAcceptedEventType: 'power_outage',
        lastAcceptedEventAt: '2026-03-17T15:30:00.000Z',
      })
    );

  const sentEmails = [];
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async (payload) => {
    sentEmails.push(payload);
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({
        event: 'shutdown_imminent',
        batteryChargePercent: 12,
        runtimeSeconds: 180,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sent, 2);
    assert.ok(sentEmails.every((entry) => entry.event === 'shutdown_imminent'));

    const automationState = getSetting('automation_state');
    assert.equal(automationState.currentPowerState, 'outage');
    assert.equal(automationState.lastAcceptedEventType, 'shutdown_imminent');
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('UPS automation deduplicates admin recipient when it matches a donor email', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
    supportNotificationEmail: 'owner@example.com',
  });

  createDonor({
    email: 'owner@example.com',
    name: 'Owner',
    status: 'active',
  });

  const sentEmails = [];
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async (payload) => {
    sentEmails.push(payload);
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({ event: 'power_outage' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sent, 1);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, 'owner@example.com');
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('repeated power_outage is deduped when already in outage state', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
  });

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run(
      'automation_state',
      JSON.stringify({
        currentPowerState: 'outage',
        lastAcceptedEventType: 'power_outage',
        lastAcceptedEventAt: '2026-03-17T15:30:00.000Z',
      })
    );

  let sendCount = 0;
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async () => {
    sendCount += 1;
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({ event: 'power_outage' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.deduped, true);
    assert.equal(body.sent, 0);
    assert.equal(sendCount, 0);
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('repeated power_restored is deduped when already in normal state', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
  });

  let sendCount = 0;
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async () => {
    sendCount += 1;
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({ event: 'power_restored' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.deduped, true);
    assert.equal(body.sent, 0);
    assert.equal(sendCount, 0);
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});

test('repeated shutdown_imminent is deduped when already the latest accepted event', { concurrency: false }, async (t) => {
  resetDatabase();
  config.upsWebhookToken = 'test-ups-token';
  settingsStore.updateGroup('smtp', {
    host: 'smtp.example.com',
    port: 2525,
    secure: false,
    from: 'Plex Donate <notify@example.com>',
  });

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run(
      'automation_state',
      JSON.stringify({
        currentPowerState: 'outage',
        lastAcceptedEventType: 'shutdown_imminent',
        lastAcceptedEventAt: '2026-03-17T15:30:00.000Z',
      })
    );

  let sendCount = 0;
  const originalSendUpsStatusEmail = emailService.sendUpsStatusEmail;
  emailService.sendUpsStatusEmail = async () => {
    sendCount += 1;
  };
  t.after(() => {
    emailService.sendUpsStatusEmail = originalSendUpsStatusEmail;
  });

  const app = createApp();
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.origin}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-ups-token',
      },
      body: JSON.stringify({ event: 'shutdown_imminent' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.deduped, true);
    assert.equal(body.sent, 0);
    assert.equal(sendCount, 0);
  } finally {
    await server.close();
    config.upsWebhookToken = '';
  }
});
