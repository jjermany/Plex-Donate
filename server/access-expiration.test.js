process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-expiration-db-'));
  process.env.DATABASE_FILE = path.join(testDbDir, 'database.sqlite');
}

const { test } = require('node:test');
const assert = require('node:assert/strict');

const webhookRouter = require('./routes/webhook');
const { processAccessExpirations } = require('./index');
const { db, createDonor, getDonorById } = require('./db');

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

test('access expiration sweep transitions trials to expired and revokes access', async (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const expirationTimestamp = new Date(Date.now() - 60 * 1000).toISOString();
  const donor = createDonor({
    email: 'sweep-trial@example.com',
    name: 'Sweep Trial',
    status: 'trial',
    accessExpiresAt: expirationTimestamp,
    plexAccountId: 'plex-sweep-trial',
    plexEmail: 'sweep-trial@example.com',
  });

  const revokeMock = t.mock.method(webhookRouter, 'revokeDonorAccess', async () => {});
  t.after(() => revokeMock.mock.restore());

  await processAccessExpirations();

  assert.equal(revokeMock.mock.callCount(), 1);
  const [revokedDonor, revokeOptions] = revokeMock.mock.calls[0].arguments;
  assert.ok(revokedDonor);
  assert.equal(revokedDonor.id, donor.id);
  assert.equal(revokedDonor.status, 'trial_expired');
  assert.deepEqual(revokeOptions, {
    context: 'trial-expiration',
    reason: 'trial_expired',
  });

  const updated = getDonorById(donor.id);
  assert.equal(updated.status, 'trial_expired');
  assert.equal(updated.accessExpiresAt, null);
});
