process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fetchModulePath = require.resolve('node-fetch');
const plexModulePath = path.join(__dirname, 'plex.js');

async function withMockedFetch(mockImpl, run) {
  require('node-fetch');
  const originalFetch = require.cache[fetchModulePath].exports;
  require.cache[fetchModulePath].exports = mockImpl;
  delete require.cache[plexModulePath];
  const plexService = require('./plex');
  try {
    return await run(plexService);
  } finally {
    delete require.cache[plexModulePath];
    require.cache[fetchModulePath].exports = originalFetch;
  }
}

test('plexService.createInvite posts to Plex API', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        invitation: {
          id: 'INV-123',
          uri: 'https://plex.example/invite/INV-123',
          status: 'pending',
          created_at: '2024-01-01T00:00:00Z',
          libraries: [{ id: 1, title: 'Movies' }],
        },
      }),
    };
  }, async (plexService) => {
    const result = await plexService.createInvite(
      {
        email: 'friend@example.com',
        friendlyName: 'Friend Example',
      },
      {
        baseUrl: 'https://plex.local',
        token: 'token123',
        serverIdentifier: 'server-uuid',
        librarySectionIds: '1, 2',
        allowSync: true,
        allowCameraUpload: false,
        allowChannels: true,
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://plex.local/api/v2/home/invitations?X-Plex-Token=token123'
    );
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(
      calls[0].options.headers['Content-Type'],
      'application/json'
    );
    const payload = JSON.parse(calls[0].options.body);
    assert.deepEqual(payload, {
      email: 'friend@example.com',
      friendlyName: 'Friend Example',
      server: { uuid: 'server-uuid' },
      settings: {
        allowSync: false,
        allowCameraUpload: false,
        allowChannels: false,
      },
      libraries: [{ id: '1' }, { id: '2' }],
    });

    assert.equal(result.inviteId, 'INV-123');
    assert.equal(result.inviteUrl, 'https://plex.example/invite/INV-123');
    assert.equal(result.status, 'pending');
    assert.equal(result.invitedAt, '2024-01-01T00:00:00.000Z');
    assert.deepEqual(result.sharedLibraries, [{ id: '1', title: 'Movies' }]);
  });
});

test('plexService.createInvite throws when Plex omits invite id', async () => {
  await withMockedFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }),
    async (plexService) => {
      await assert.rejects(
        () =>
          plexService.createInvite(
            { email: 'friend@example.com' },
            {
              baseUrl: 'https://plex.local',
              token: 'token123',
              serverIdentifier: 'server-uuid',
              librarySectionIds: '1',
            }
          ),
        /did not return an invite identifier/
      );
    }
  );
});

test('plexService.cancelInvite cancels invites and handles 404', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }, async (plexService) => {
    const success = await plexService.cancelInvite(
      'INV-123',
      {
        baseUrl: 'https://plex.local',
        token: 'token123',
        serverIdentifier: 'server-uuid',
        librarySectionIds: '1',
      }
    );
    assert.deepEqual(success, { success: true });

    const notFound = await plexService.cancelInvite(
      'INV-MISSING',
      {
        baseUrl: 'https://plex.local',
        token: 'token123',
        serverIdentifier: 'server-uuid',
        librarySectionIds: '1',
      }
    );
    assert.deepEqual(notFound, {
      success: false,
      reason: 'Invite not found on Plex server',
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.method, 'DELETE');
  });
});

test('plexService.verifyConnection checks invite endpoint and loads libraries', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/api/v2/home/invitations')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ invitations: [] }),
        text: async () => '',
      };
    }
    if (url.includes('/library/sections')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Directory: [
                { key: '/library/sections/1', title: 'Movies' },
                { key: '/library/sections/2', title: 'TV Shows' },
              ],
            },
          }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    const result = await plexService.verifyConnection({
      baseUrl: 'https://plex.local',
      token: 'token123',
      serverIdentifier: 'server-uuid',
      librarySectionIds: '1,2',
    });

    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      'https://plex.local/api/v2/home/invitations?X-Plex-Token=token123'
    );
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(
      calls[1].url,
      'https://plex.local/library/sections?X-Plex-Token=token123'
    );
    assert.equal(calls[1].options.method || 'GET', 'GET');
    assert.equal(result.details.serverIdentifier, 'server-uuid');
    assert.deepEqual(result.details.librarySectionIds, ['1', '2']);
    assert.deepEqual(result.libraries, [
      { id: '1', title: 'Movies' },
      { id: '2', title: 'TV Shows' },
    ]);
  });
});

test('plexService.verifyConnection parses XML library list responses', async () => {
  await withMockedFetch(async (url) => {
    if (url.includes('/api/v2/home/invitations')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ invitations: [] }),
        text: async () => '',
      };
    }
    if (url.includes('/library/sections')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          '<MediaContainer><Directory key="/library/sections/5" title="Kids" /><Directory key="/library/sections/9" title="Music" /></MediaContainer>',
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    const result = await plexService.verifyConnection({
      baseUrl: 'https://plex.local',
      token: 'token123',
      serverIdentifier: 'server-uuid',
      librarySectionIds: '',
    });

    assert.deepEqual(result.libraries, [
      { id: '5', title: 'Kids' },
      { id: '9', title: 'Music' },
    ]);
  });
});
