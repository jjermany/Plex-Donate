process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const shareRouter = require('./share');
const {
  db,
  createDonor,
  createProspect,
  createOrUpdateShareLink,
  getShareLinkByToken,
  getProspectById,
} = require('../db');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/share', shareRouter);
  return app;
}

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

async function requestJson(server, method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${server.origin}${path}`, init);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, body: payload };
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

test('share routes handle donor and prospect flows', async (t) => {
  await t.test('existing donor can update account details', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const donor = createDonor({
        email: 'existing@example.com',
        name: 'Existing Donor',
        subscriptionId: 'I-123456789',
        status: 'active',
      });
      const shareLink = createOrUpdateShareLink({
        donorId: donor.id,
        token: 'donor-token',
        sessionToken: 'session-donor',
      });

      const viewResponse = await requestJson(server, 'GET', `/share/${shareLink.token}`);
      assert.equal(viewResponse.status, 200);
      assert.ok(viewResponse.body.donor);
      assert.equal(viewResponse.body.prospect, null);

      const accountResponse = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/account`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: 'updated@example.com',
            name: 'Updated Name',
            password: 'password123',
            confirmPassword: 'password123',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(accountResponse.status, 200);
      assert.equal(accountResponse.body.donor.email, 'updated@example.com');
      assert.equal(accountResponse.body.donor.name, 'Updated Name');
      assert.equal(accountResponse.body.donor.hasPassword, true);

      const row = db
        .prepare('SELECT password_hash FROM donors WHERE id = ?')
        .get(accountResponse.body.donor.id);
      assert.ok(row.password_hash && row.password_hash.startsWith('pbkdf2$'));
    } finally {
      await server.close();
    }
  });

  await t.test('prospect promotion creates donor record', async () => {
    resetDatabase();
    const app = createApp();
    const server = await startServer(app);

    try {
      const prospect = createProspect({
        email: 'future@example.com',
        name: 'Future Supporter',
      });
      const shareLink = createOrUpdateShareLink({
        prospectId: prospect.id,
        token: 'prospect-token',
        sessionToken: 'session-prospect',
      });

      const viewResponse = await requestJson(server, 'GET', `/share/${shareLink.token}`);
      assert.equal(viewResponse.status, 200);
      assert.equal(viewResponse.body.donor, null);
      assert.ok(viewResponse.body.prospect);
      assert.equal(viewResponse.body.prospect.email, 'future@example.com');

      const accountResponse = await requestJson(
        server,
        'POST',
        `/share/${shareLink.token}/account`,
        {
          headers: { Authorization: `Bearer ${shareLink.sessionToken}` },
          body: {
            email: 'future@example.com',
            name: 'Future Supporter',
            password: 'password123',
            confirmPassword: 'password123',
            subscriptionId: 'I-NEW123',
            sessionToken: shareLink.sessionToken,
          },
        }
      );

      assert.equal(accountResponse.status, 200);
      assert.ok(accountResponse.body.donor);
      assert.equal(accountResponse.body.donor.email, 'future@example.com');
      assert.equal(accountResponse.body.donor.subscriptionId, 'I-NEW123');
      assert.equal(accountResponse.body.prospect, null);

      const updatedLink = getShareLinkByToken(shareLink.token);
      assert.equal(updatedLink.donorId, accountResponse.body.donor.id);
      assert.equal(updatedLink.prospectId, null);

      const prospectRecord = getProspectById(prospect.id);
      assert.ok(prospectRecord && prospectRecord.convertedAt);

      const row = db
        .prepare('SELECT password_hash FROM donors WHERE id = ?')
        .get(accountResponse.body.donor.id);
      assert.ok(row.password_hash && row.password_hash.startsWith('pbkdf2$'));
    } finally {
      await server.close();
    }
  });
});
