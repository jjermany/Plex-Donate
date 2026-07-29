#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TTL_SECONDS = 15 * 60;
const TEST_HOST = '127.0.0.1';

function readNumberOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = Number.parseInt(process.argv[index + 1], 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const handleError = (err) => {
      server.off('listening', handleListening);
      reject(err);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, TEST_HOST);
  });
}

function closeServer(server) {
  if (!server || !server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function seedTestSubscribers(dbApi) {
  const { createDonor, db, recordPayment } = dbApi;
  const paid = createDonor({
    email: 'paid.supporter@example.test',
    name: 'Paid Supporter',
    subscriptionId: 'I-TEST-PAID',
    status: 'active',
    lastPaymentAt: '2026-07-01T12:00:00.000Z',
    plexAccountId: 'test-plex-paid',
    plexEmail: 'paid.supporter@example.test',
    emailVerifiedAt: '2026-06-01T12:00:00.000Z',
  });
  createDonor({
    email: 'trial.supporter@example.test',
    name: 'Trial Supporter',
    status: 'trial',
    accessExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    emailVerifiedAt: '2026-06-15T12:00:00.000Z',
  });
  createDonor({
    email: 'setup.required@example.test',
    name: 'Setup Required',
    status: 'pending',
  });
  createDonor({
    email: 'courtesy.supporter@example.test',
    name: 'Courtesy Supporter',
    status: 'pending',
    courtesyAccess: true,
    hadPreexistingAccess: true,
  });

  recordPayment({
    donorId: paid.id,
    paypalPaymentId: 'TEST-PAYMENT-1',
    amount: 5,
    currency: 'USD',
    paidAt: paid.lastPaymentAt,
  });

  db.prepare(
    `UPDATE donors
        SET updated_at = CASE id
          WHEN ? THEN '2026-07-10 12:00:00'
          ELSE updated_at
        END`
  ).run(paid.id);
}

async function main() {
  const requestedPort = readNumberOption('--port', 0);
  const ttlSeconds = readNumberOption('--ttl', DEFAULT_TTL_SECONDS);
  const smokeOnly = process.argv.includes('--smoke');
  const shouldSeed = !process.argv.includes('--empty');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-live-test-'));
  const tempDataDir = path.join(tempRoot, 'data');
  const databaseFile = path.join(tempDataDir, 'plex-donate.sqlite');
  const adminPassword = `Test-${crypto.randomBytes(12).toString('base64url')}`;

  fs.mkdirSync(tempDataDir, { recursive: true });
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_FILE = databaseFile;
  process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.SESSION_COOKIE_SECURE = 'false';
  process.env.LOG_DIR = path.join(tempRoot, 'logs');

  const config = require('../server/config');
  config.dataDir = tempDataDir;

  const adminCredentials = require('../server/state/admin-credentials');
  adminCredentials.resetAdminCredentials({
    username: 'admin',
    password: adminPassword,
  });

  const dbApi = require('../server/db');
  if (shouldSeed) {
    seedTestSubscribers(dbApi);
  }

  const app = require('../server/index');
  const server = http.createServer(app);
  let ttlTimer = null;
  let stopReason = '';
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const requestStop = (reason) => {
    if (!stopReason) {
      stopReason = reason;
      resolveStop();
    }
  };

  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  try {
    await listen(server, requestedPort);
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : requestedPort;
    const origin = `http://${TEST_HOST}:${port}`;
    const details = {
      url: origin,
      adminUsername: 'admin',
      adminPassword,
      seeded: shouldSeed,
      ttlSeconds,
    };

    process.stdout.write(`PLEX_DONATE_TEST_ENV=${JSON.stringify(details)}\n`);
    process.stdout.write(
      `Isolated Plex Donate test environment ready at ${origin} (expires in ${ttlSeconds}s).\n`
    );

    const healthResponse = await fetch(`${origin}/api/health`);
    const health = await healthResponse.json();
    if (!healthResponse.ok || health.status !== 'ok') {
      throw new Error(`Health check failed: ${JSON.stringify(health)}`);
    }

    if (smokeOnly) {
      requestStop('smoke test complete');
    } else if (ttlSeconds > 0) {
      ttlTimer = setTimeout(() => requestStop('TTL expired'), ttlSeconds * 1000);
    }

    await stopped;
  } finally {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
    }
    await closeServer(server);
    if (dbApi.db && dbApi.db.open) {
      dbApi.db.close();
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.stdout.write(
      `Isolated Plex Donate test environment stopped (${stopReason || 'cleanup'}).\n`
    );
  }
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
