process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('removing a subscriber cascades related records', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-'));
  const databaseFile = path.join(tempDir, 'delete-subscriber.db');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const script = `
    const {
      db,
      createDonor,
      createInvite,
      createOrUpdateShareLink,
      recordPayment,
      deleteDonorById,
      getDonorById,
      getShareLinkByDonorId,
      listDonorsWithDetails,
    } = require('./server/db');

    const donor = createDonor({
      email: 'remove-me@example.com',
      name: 'Remove Me',
      subscriptionId: 'I-REMOVE123',
      status: 'active',
    });

    createInvite({
      donorId: donor.id,
      code: 'CODE123',
      url: 'https://invite.test/CODE123',
      note: 'test',
      recipientEmail: 'remove-me@example.com',
    });

    createOrUpdateShareLink({
      donorId: donor.id,
      token: 'share-token',
      sessionToken: 'session-token',
    });

    recordPayment({
      donorId: donor.id,
      paypalPaymentId: 'PAYID-REMOVE',
      amount: 5,
      currency: 'USD',
      paidAt: new Date().toISOString(),
    });

    const removed = deleteDonorById(donor.id);
    const remainingDonor = getDonorById(donor.id);
    const remainingShareLink = getShareLinkByDonorId(donor.id);
    const donors = listDonorsWithDetails();
    const inviteCount = db.prepare('SELECT COUNT(*) AS count FROM invites').get().count;
    const paymentCount = db.prepare('SELECT COUNT(*) AS count FROM payments').get().count;
    const shareLinkCount = db
      .prepare('SELECT COUNT(*) AS count FROM invite_links')
      .get().count;

    console.log(
      JSON.stringify({
        removed,
        remainingDonor,
        remainingShareLink,
        inviteCount,
        paymentCount,
        shareLinkCount,
        donors,
      })
    );
    db.close();
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: databaseFile },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);

  assert.equal(payload.removed, true);
  assert.equal(payload.remainingDonor, null);
  assert.equal(payload.remainingShareLink, null);
  assert.equal(payload.inviteCount, 0);
  assert.equal(payload.paymentCount, 0);
  assert.equal(payload.shareLinkCount, 0);
  assert.equal(Array.isArray(payload.donors), true);
  assert.equal(payload.donors.length, 0);
});
