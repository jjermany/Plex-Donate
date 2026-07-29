process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('unchanged subscription refreshes preserve the donor modified date', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-refresh-'));
  const databaseFile = path.join(tempDir, 'donor-refresh.db');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const script = `
    const {
      db,
      createDonor,
      getDonorById,
      updateDonorStatus,
      setDonorAccessExpirationBySubscription,
    } = require('./server/db');

    const donor = createDonor({
      email: 'paid@example.com',
      name: 'Paid Donor',
      subscriptionId: 'I-PAID123',
      status: 'active',
      lastPaymentAt: '2026-07-01T12:00:00.000Z',
    });

    const originalModifiedAt = '2020-01-01 00:00:00';
    db.prepare('UPDATE donors SET updated_at = ? WHERE id = ?')
      .run(originalModifiedAt, donor.id);

    updateDonorStatus(
      donor.subscriptionId,
      donor.status,
      donor.lastPaymentAt
    );
    setDonorAccessExpirationBySubscription(donor.subscriptionId, null);

    const unchanged = getDonorById(donor.id);

    updateDonorStatus(donor.subscriptionId, 'suspended', null);
    const changed = getDonorById(donor.id);

    console.log(JSON.stringify({ unchanged, changed, originalModifiedAt }));
    db.close();
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: databaseFile },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);

  assert.equal(payload.unchanged.updatedAt, payload.originalModifiedAt);
  assert.equal(payload.unchanged.status, 'active');
  assert.equal(payload.unchanged.accessExpiresAt, null);
  assert.equal(payload.changed.status, 'suspended');
  assert.notEqual(payload.changed.updatedAt, payload.originalModifiedAt);
});
