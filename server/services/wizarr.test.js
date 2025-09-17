const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wizarrModulePath = path.join(__dirname, 'wizarr.js');
const nodeFetchModulePath = require.resolve('node-fetch');
const originalFetch = require(nodeFetchModulePath);
const fetchCacheEntry = require.cache[nodeFetchModulePath];

const settingsModulePath = path.join(__dirname, '../state/settings.js');
const settingsModule = require(settingsModulePath);
const originalGetWizarrSettings = settingsModule.getWizarrSettings;

function restoreModules() {
  delete require.cache[wizarrModulePath];
  if (fetchCacheEntry && originalFetch) {
    fetchCacheEntry.exports = originalFetch;
  }
  settingsModule.getWizarrSettings = originalGetWizarrSettings;
}

test('buildRequestUrl removes overlapping suffix segments', (t) => {
  restoreModules();
  t.after(restoreModules);
  const { buildRequestUrl } = require(wizarrModulePath);

  assert.equal(
    buildRequestUrl('https://host/wizarr/api', 'api/invitations'),
    'https://host/wizarr/api/invitations'
  );
  assert.equal(
    buildRequestUrl('https://host/wizarr/api', '/api/invitations/create'),
    'https://host/wizarr/api/invitations/create'
  );
  assert.equal(
    buildRequestUrl('https://host/wizarr/api/v1', 'api/v1/invite'),
    'https://host/wizarr/api/v1/invite'
  );
  assert.equal(
    buildRequestUrl('https://host/wizarr/api/v1/', '/api/v1/invites/demo'),
    'https://host/wizarr/api/v1/invites/demo'
  );
});

test('getPortalUrl returns a customer-facing Wizarr link', (t) => {
  restoreModules();
  t.after(restoreModules);
  const { getPortalUrl } = require(wizarrModulePath);

  assert.equal(
    getPortalUrl({ baseUrl: 'https://host/wizarr/api' }),
    'https://host/wizarr'
  );
  assert.equal(
    getPortalUrl({ baseUrl: 'https://host/wizarr/api/v1/' }),
    'https://host/wizarr'
  );
  assert.equal(
    getPortalUrl({ baseUrl: 'https://host/' }),
    'https://host'
  );
  assert.equal(
    getPortalUrl({ baseUrl: 'https://host' }),
    'https://host'
  );
  assert.equal(
    getPortalUrl({ baseUrl: 'wizarr.local/api/' }),
    'wizarr.local/api'
  );
  assert.equal(getPortalUrl({ baseUrl: '' }), '');
  assert.equal(getPortalUrl({}), '');
});

function createFetchMock(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (!response) {
      throw new Error('No mock response configured');
    }
    const body =
      typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body ?? '');
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => body,
    };
  };
  fn.default = fn;
  fn.calls = calls;
  return fn;
}

test('createInvite normalizes overlapping api segments in request URL', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 201,
      body: { code: 'abc123', url: 'https://invite.test/abc123' },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { createInvite } = require(wizarrModulePath);

  t.after(restoreModules);

  const result = await createInvite(
    { email: 'user@example.com', note: 'hi', expiresInDays: 5 },
    { baseUrl: 'https://host/wizarr/api', apiKey: 'key', defaultDurationDays: 7 }
  );

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].url, 'https://host/wizarr/api/v1/invitations');
  const requestBody = JSON.parse(fetchMock.calls[0].options.body);
  assert.equal(requestBody.email, 'user@example.com');
  assert.equal(requestBody.expires_in_days, 5);
  assert.ok(!Object.prototype.hasOwnProperty.call(requestBody, 'server_ids'));
  assert.equal(result.inviteCode, 'abc123');
  assert.equal(result.inviteUrl, 'https://invite.test/abc123');
});

test('createInvite includes configured server ids when provided', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 201,
      body: { code: 'withserver', url: 'https://invite.test/withserver' },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { createInvite } = require(wizarrModulePath);

  t.after(restoreModules);

  const result = await createInvite(
    { email: 'user@example.com', note: 'hi', expiresInDays: 5 },
    {
      baseUrl: 'https://host/wizarr/api',
      apiKey: 'key',
      defaultDurationDays: 7,
      defaultServerIds: '1, 2',
    }
  );

  assert.equal(fetchMock.calls.length, 1);
  const requestBody = JSON.parse(fetchMock.calls[0].options.body);
  assert.deepEqual(requestBody.server_ids, [1, 2]);
  assert.equal(result.inviteCode, 'withserver');
  assert.equal(result.inviteUrl, 'https://invite.test/withserver');
});

test('createInvite retries with single available server when none configured', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 400,
      body: {
        error: 'Server selection is required.',
        available_servers: [{ id: 3, name: 'Primary Plex', server_type: 'plex' }],
      },
    },
    {
      status: 201,
      body: { code: 'auto', url: 'https://invite.test/auto' },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { createInvite } = require(wizarrModulePath);

  t.after(restoreModules);

  const result = await createInvite(
    { email: 'user@example.com', note: 'hi', expiresInDays: 5 },
    { baseUrl: 'https://host/wizarr/api', apiKey: 'key', defaultDurationDays: 7 }
  );

  assert.equal(fetchMock.calls.length, 2);
  const firstRequest = JSON.parse(fetchMock.calls[0].options.body);
  assert.ok(!Object.prototype.hasOwnProperty.call(firstRequest, 'server_ids'));
  const secondRequest = JSON.parse(fetchMock.calls[1].options.body);
  assert.deepEqual(secondRequest.server_ids, [3]);
  assert.equal(result.inviteCode, 'auto');
  assert.equal(result.inviteUrl, 'https://invite.test/auto');
});

test('createInvite surfaces server selection guidance when multiple servers exist', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 400,
      body: {
        error: 'Server selection is required.',
        available_servers: [
          { id: 1, name: 'My Plex', server_type: 'plex' },
          { id: 2, name: 'Alt Jelly', server_type: 'jellyfin' },
        ],
      },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { createInvite } = require(wizarrModulePath);

  t.after(restoreModules);

  await assert.rejects(
    () =>
      createInvite(
        { email: 'user@example.com', note: 'hi', expiresInDays: 5 },
        { baseUrl: 'https://host/wizarr/api', apiKey: 'key', defaultDurationDays: 7 }
      ),
    (err) => {
      assert.match(
        err.message,
        /Update the Wizarr settings with default server IDs. Available servers: My Plex/i
      );
      assert.equal(err.status, 400);
      assert.ok(Array.isArray(err.availableServers));
      assert.equal(err.availableServers.length, 2);
      return true;
    }
  );

  assert.equal(fetchMock.calls.length, 1);
});

test('createInvite falls back to legacy invite endpoints when necessary', async (t) => {
  const fetchMock = createFetchMock([
    { status: 404, body: { detail: 'not here' } },
    { status: 404, body: { detail: 'still missing' } },
    { status: 201, body: { code: 'legacy', url: 'https://invite.test/legacy' } },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { createInvite } = require(wizarrModulePath);

  t.after(restoreModules);

  const result = await createInvite(
    { email: 'user@example.com', note: 'hi', expiresInDays: 5 },
    { baseUrl: 'https://host/wizarr/api', apiKey: 'key', defaultDurationDays: 7 }
  );

  assert.equal(fetchMock.calls.length, 3);
  assert.equal(fetchMock.calls[0].url, 'https://host/wizarr/api/v1/invitations');
  assert.equal(fetchMock.calls[1].url, 'https://host/wizarr/api/v1/invites');
  assert.equal(fetchMock.calls[2].url, 'https://host/wizarr/api/invites');
  assert.equal(result.inviteCode, 'legacy');
});

test('verifyConnection uses normalized invite endpoint', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 400,
      body: { detail: 'validation error' },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { verifyConnection } = require(wizarrModulePath);

  t.after(restoreModules);

  const result = await verifyConnection({
    baseUrl: 'https://host/wizarr/api',
    apiKey: 'key',
    defaultDurationDays: 7,
  });

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].url, 'https://host/wizarr/api/v1/invitations');
  const requestBody = JSON.parse(fetchMock.calls[0].options.body);
  assert.ok(!Object.prototype.hasOwnProperty.call(requestBody, 'server_ids'));
  assert.equal(result.status, 400);
});

test('verifyConnection includes configured server ids in request body', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 422,
      body: { detail: 'validation error' },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { verifyConnection } = require(wizarrModulePath);

  t.after(restoreModules);

  await verifyConnection({
    baseUrl: 'https://host/wizarr/api',
    apiKey: 'key',
    defaultDurationDays: 7,
    defaultServerIds: '5',
  });

  assert.equal(fetchMock.calls.length, 1);
  const requestBody = JSON.parse(fetchMock.calls[0].options.body);
  assert.deepEqual(requestBody.server_ids, [5]);
});

test('revokeInvite uses normalized invite endpoint', async (t) => {
  const fetchMock = createFetchMock([
    {
      status: 204,
      body: '',
    },
  ]);

  settingsModule.getWizarrSettings = () => ({
    baseUrl: 'https://host/wizarr/api',
    apiKey: 'key',
    defaultDurationDays: 7,
  });
  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }
  delete require.cache[wizarrModulePath];
  const { revokeInvite } = require(wizarrModulePath);

  t.after(restoreModules);

  const result = await revokeInvite('invite-code');

  assert.equal(result, true);
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(
    fetchMock.calls[0].url,
    'https://host/wizarr/api/v1/invitations/invite-code'
  );
});
