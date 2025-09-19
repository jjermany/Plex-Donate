const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const plexModulePath = path.join(__dirname, 'plex.js');
const nodeFetchModulePath = require.resolve('node-fetch');
const originalFetch = require(nodeFetchModulePath);
const fetchCacheEntry = require.cache[nodeFetchModulePath];

const settingsModulePath = path.join(__dirname, '../state/settings.js');
const settingsModule = require(settingsModulePath);
const originalGetPlexSettings = settingsModule.getPlexSettings;

function restoreModules() {
  delete require.cache[plexModulePath];
  if (fetchCacheEntry && originalFetch) {
    fetchCacheEntry.exports = originalFetch;
  }
  settingsModule.getPlexSettings = originalGetPlexSettings;
}

function createFetchMock(responses) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (!response) {
      throw new Error('No mock response configured');
    }
    if (response.error) {
      throw response.error;
    }
    const status = response.status ?? 200;
    const body = response.body;
    const bodyText =
      typeof body === 'string'
        ? body
        : body == null
        ? ''
        : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: response.statusText || '',
      headers: response.headers || {},
      async json() {
        if (typeof body === 'string') {
          if (!body) {
            throw new Error('Unexpected end of JSON input');
          }
          return JSON.parse(body);
        }
        if (body == null) {
          return {};
        }
        return body;
      },
      async text() {
        return bodyText;
      },
    };
  };
  fn.calls = calls;
  fn.default = fn;
  return fn;
}

test('listUsers queries /accounts endpoint when available', async (t) => {
  restoreModules();
  t.after(restoreModules);

  const fetchMock = createFetchMock([
    {
      status: 200,
      body: { users: [{ id: 'user-1' }] },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }

  settingsModule.getPlexSettings = () => ({
    baseUrl: 'https://plex-server.example:32400',
    token: 'TOKEN123',
  });

  delete require.cache[plexModulePath];
  const { listUsers } = require(plexModulePath);

  const users = await listUsers();

  assert.equal(fetchMock.calls.length, 1);
  assert.equal(
    fetchMock.calls[0].url,
    'https://plex-server.example:32400/accounts?X-Plex-Token=TOKEN123'
  );
  assert.ok(Array.isArray(users));
  assert.equal(users[0].id, 'user-1');
});

test('listUsers falls back to legacy endpoints when /accounts is missing', async (t) => {
  restoreModules();
  t.after(restoreModules);

  const fetchMock = createFetchMock([
    {
      status: 404,
      body: '',
      statusText: 'Not Found',
    },
    {
      status: 200,
      body: { users: [{ id: 'legacy-user' }] },
    },
  ]);

  if (fetchCacheEntry) {
    fetchCacheEntry.exports = fetchMock;
  }

  settingsModule.getPlexSettings = () => ({
    baseUrl: 'https://legacy-server.example:32400',
    token: 'TOKEN456',
  });

  delete require.cache[plexModulePath];
  const { listUsers } = require(plexModulePath);

  const users = await listUsers();

  assert.equal(fetchMock.calls.length, 2);
  assert.equal(
    fetchMock.calls[0].url,
    'https://legacy-server.example:32400/accounts?X-Plex-Token=TOKEN456'
  );
  assert.ok(
    fetchMock.calls[1].url.includes('/api/v2/home/users?X-Plex-Token=TOKEN456') ||
      fetchMock.calls[1].url.includes('/api/home/users?X-Plex-Token=TOKEN456')
  );
  assert.ok(Array.isArray(users));
  assert.equal(users[0].id, 'legacy-user');
});
