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


test('plexService.createInvite uses v2 when available', async () => {
  const calls = [];
  await withMockedFetch(async (url, options = {}) => {
    calls.push({ url, options });

    if (
      url ===
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'UnraidNAS',
              provides: 'server',
              clientIdentifier: 'd4e2machine',
              owned: '1',
              connections: [{ uri: 'https://example.com:32400' }],
            },
          ]),
      };
    }

    if (url === 'https://plex.tv/api/servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine" owned="1" name="UnraidNAS"/></MediaContainer>',
      };
    }

    if (url === 'https://plex.tv/api/servers/d4e2machine?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine"><Section id="10" key="/library/sections/1" title="Movies"/><Section id="12" key="/library/sections/2" title="TV"/></Server></MediaContainer>',
      };
    }

    if (
      url ===
      'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            users: [
              {
                id: '2001',
                email: 'friend@example.com',
                invitedId: 'INVITED-2001',
              },
            ],
          }),
      };
    }

    if (url === 'https://plex.tv/api/v2/shared_servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          invitation: {
            id: 'INV-100',
            uri: 'https://plex.example/invite/INV-100',
            status: 'pending',
            created_at: '2024-01-01T00:00:00Z',
            libraries: [
              { id: 10, title: 'Movies' },
              { id: 12, title: 'TV' },
            ],
          },
        }),
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    const result = await plexService.createInvite(
      { email: 'friend@example.com', librarySectionIds: ['10', '12'] },
      {
        baseUrl: 'https://plex.local',
        token: 'token123',
        serverIdentifier: 'd4e2machine',
        allowSync: true,
        allowCameraUpload: false,
        allowChannels: true,
      }
    );

    assert.equal(calls.length, 5);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(calls[2].url, 'https://plex.tv/api/servers/d4e2machine?X-Plex-Token=token123');
    assert.equal(
      calls[3].url,
      'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
    );
    assert.equal(calls[4].url, 'https://plex.tv/api/v2/shared_servers?X-Plex-Token=token123');
    const v2Payload = JSON.parse(calls[4].options.body);
    assert.deepEqual(v2Payload, {
      machineIdentifier: 'd4e2machine',
      librarySectionIds: ['10', '12'],
      invitedId: 'INVITED-2001',
      invitedEmail: 'friend@example.com',
      settings: { allowSync: '1', allowCameraUpload: '0', allowChannels: '1' },
    });

    assert.equal(result.inviteId, 'INV-100');
    assert.equal(result.inviteUrl, 'https://plex.example/invite/INV-100');
    assert.equal(result.status, 'pending');
    assert.equal(
      calls[4].options.headers['X-Plex-Client-Identifier'],
      'plex-donate-d4e2machine'
    );
  });
});

test('plexService.createInvite translates legacy configured section indices', async () => {
  const calls = [];
  await withMockedFetch(async (url, options = {}) => {
    calls.push({ url, options });

    if (
      url ===
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'UnraidNAS',
              provides: 'server',
              clientIdentifier: 'd4e2machine',
              owned: '1',
              connections: [{ uri: 'https://example.com:32400' }],
            },
          ]),
      };
    }

    if (url === 'https://plex.tv/api/servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine" owned="1" name="UnraidNAS"/></MediaContainer>',
      };
    }

    if (url === 'https://plex.tv/api/servers/d4e2machine?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine"><Section id="10" key="/library/sections/1" title="Movies"/><Section id="12" key="/library/sections/2" title="TV"/></Server></MediaContainer>',
      };
    }

    if (
      url ===
      'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            users: [
              {
                id: '2001',
                email: 'friend@example.com',
                invitedId: 'INVITED-2001',
              },
            ],
          }),
      };
    }

    if (url === 'https://plex.tv/api/v2/shared_servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          invitation: {
            id: 'INV-101',
            uri: 'https://plex.example/invite/INV-101',
            status: 'pending',
            libraries: [
              { id: 10, title: 'Movies' },
              { id: 12, title: 'TV' },
            ],
          },
        }),
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    const result = await plexService.createInvite(
      { email: 'friend@example.com' },
      {
        baseUrl: 'https://plex.local',
        token: 'token123',
        serverIdentifier: 'd4e2machine',
        librarySectionIds: '1,2',
      }
    );

    assert.equal(calls.length, 5);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(calls[2].url, 'https://plex.tv/api/servers/d4e2machine?X-Plex-Token=token123');
    assert.equal(
      calls[3].url,
      'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
    );
    assert.equal(calls[4].url, 'https://plex.tv/api/v2/shared_servers?X-Plex-Token=token123');
    const v2Payload = JSON.parse(calls[4].options.body);
    assert.deepEqual(v2Payload.librarySectionIds, ['10', '12']);

    assert.equal(result.inviteId, 'INV-101');
    assert.equal(result.inviteUrl, 'https://plex.example/invite/INV-101');
    assert.equal(result.status, 'pending');
  });
});

test('plexService.createInvite throws when invitedId lookup fails', async () => {
  await withMockedFetch(async (url) => {
    if (
      url ===
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'UnraidNAS',
              provides: 'server',
              clientIdentifier: 'd4e2machine',
              owned: '1',
              connections: [{ uri: 'https://example.com:32400' }],
            },
          ]),
      };
    }

    if (url === 'https://plex.tv/api/servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine" owned="1"/></MediaContainer>',
      };
    }

    if (url === 'https://plex.tv/api/servers/d4e2machine?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine"><Section id="10" key="/library/sections/1" title="Movies"/></Server></MediaContainer>',
      };
    }

    if (
      url ===
      'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ users: [] }),
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    await assert.rejects(
      () =>
        plexService.createInvite(
          { email: 'friend@example.com' },
          {
            baseUrl: 'https://plex.local',
            token: 'token123',
            serverIdentifier: 'd4e2machine',
          }
        ),
      /invitedId/
    );
  });
});

test('plexService.createInvite surfaces Plex errors from v2 endpoint', async () => {
  await withMockedFetch(async (url) => {
    if (
      url ===
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              connections: [{ uri: 'https://example.com:32400' }],
            },
          ]),
      };
    }

    if (url === 'https://plex.tv/api/servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier=\"server-uuid\" owned=\"1\"/></MediaContainer>',
      };
    }

    if (url === 'https://plex.tv/api/servers/server-uuid?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier=\"server-uuid\"><Section id=\"1\" key=\"/library/sections/1\" title=\"Movies\"/></Server></MediaContainer>',
      };
    }

    if (
      url ===
      'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            users: [
              { id: '2001', email: 'friend@example.com', invitedId: 'INVITED-2001' },
            ],
          }),
      };
    }

    if (url === 'https://plex.tv/api/v2/shared_servers?X-Plex-Token=token123') {
      return {
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        text: async () => 'User cannot be invited',
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    await assert.rejects(
      () =>
        plexService.createInvite(
          { email: 'friend@example.com', friendlyName: 'Friend Example' },
          {
            baseUrl: 'https://plex.local',
            token: 'token123',
            serverIdentifier: 'server-uuid',
            allowSync: true,
            allowCameraUpload: false,
            allowChannels: true,
          }
        ),
      /User cannot be invited/
    );
  });
});

test('plexService.createInvite validates requested sections against Plex server', async () => {
  await withMockedFetch(async (url) => {
    if (
      url ===
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'UnraidNAS',
              provides: 'server',
              clientIdentifier: 'd4e2machine',
              owned: '1',
              connections: [{ uri: 'https://example.com:32400' }],
            },
          ]),
      };
    }

    if (url === 'https://plex.tv/api/servers?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine" owned="1"/></MediaContainer>',
      };
    }

    if (url === 'https://plex.tv/api/servers/d4e2machine?X-Plex-Token=token123') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server machineIdentifier="d4e2machine"><Section id="10" key="/library/sections/1" title="Movies"/></Server></MediaContainer>',
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  }, async (plexService) => {
    await assert.rejects(
      () =>
        plexService.createInvite(
          { email: 'friend@example.com', librarySectionIds: ['99'] },
          {
            baseUrl: 'https://plex.local',
            token: 'token123',
            serverIdentifier: 'd4e2machine',
          }
        ),
      /None of the requested librarySectionIds exist on the Plex server. Requested=\["99"\] Available=\["10"\]/
    );
  });
});

test('getOrResolveServerIdentifier prefers /api/resources host match', async () => {
  const calls = [];
  await withMockedFetch(
    async (url) => {
      calls.push(url);
      if (url.startsWith('https://plex.tv/api/resources')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              {
                name: 'Primary PMS',
                provides: 'server',
                clientIdentifier: 'primary-server',
                connections: [
                  { uri: 'https://other.example:32400' },
                  { uri: 'https://plex.example:32400' },
                ],
              },
              {
                name: 'Secondary PMS',
                provides: 'server',
                clientIdentifier: 'secondary-server',
                connections: [{ uri: 'https://another.example:32400' }],
              },
            ]),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    async (plexService) => {
      const identifier = await plexService.getOrResolveServerIdentifier({
        baseUrl: 'https://plex.example:32400',
        token: 'token123',
      });

      assert.equal(identifier, 'primary-server');
      assert.equal(calls.length, 1);
    }
  );
});

test('getOrResolveServerIdentifier falls back to /api/servers when resources are ambiguous', async () => {
  const calls = [];
  await withMockedFetch(
    async (url) => {
      calls.push(url);
      if (url.startsWith('https://plex.tv/api/resources')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              {
                name: 'Primary PMS',
                provides: 'server',
                clientIdentifier: 'primary-server',
                connections: [{ uri: 'https://other.example:32400' }],
              },
              {
                name: 'Secondary PMS',
                provides: 'server',
                clientIdentifier: 'secondary-server',
                connections: [{ uri: 'https://another.example:32400' }],
              },
            ]),
        };
      }

      if (url.startsWith('https://plex.tv/api/servers')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              MediaContainer: {
                Server: [{ machineIdentifier: 'fallback-server' }],
              },
            }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    async (plexService) => {
      const identifier = await plexService.getOrResolveServerIdentifier({
        baseUrl: 'https://plex.example:32400',
        token: 'token123',
      });

      assert.equal(identifier, 'fallback-server');
      assert.deepEqual(
        calls.filter((url) => url.startsWith('https://plex.tv/api/')),
        [
          'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123',
          'https://plex.tv/api/servers?X-Plex-Token=token123',
        ]
      );
    }
  );
});

test('getOrResolveServerIdentifier errors when multiple servers remain ambiguous', async () => {
  await withMockedFetch(
    async (url) => {
      if (url.startsWith('https://plex.tv/api/resources')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              { provides: 'server', clientIdentifier: 'one' },
              { provides: 'server', clientIdentifier: 'two' },
            ]),
        };
      }

      if (url.startsWith('https://plex.tv/api/servers')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              MediaContainer: {
                Server: [
                  { machineIdentifier: 'one' },
                  { machineIdentifier: 'two' },
                ],
              },
            }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    async (plexService) => {
      await assert.rejects(
        () =>
          plexService.getOrResolveServerIdentifier({
            token: 'token123',
          }),
        /Multiple Plex servers found/
      );
    }
  );
});

test('plexService.createInvite throws when Plex omits invite id', async () => {
  await withMockedFetch(
    async (url) => {
      if (url.startsWith('https://plex.tv/api/resources')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              MediaContainer: {
                Device: [
                  {
                    name: 'Primary PMS',
                    provides: 'server',
                    clientIdentifier: 'server-uuid',
                    owned: 1,
                    accessToken: 'serverAccessToken',
                    connections: [{ uri: 'https://pms.example:32400' }],
                  },
                ],
              },
            }),
        };
      }

      if (url === 'https://plex.tv/api/servers/server-uuid?X-Plex-Token=token123') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<MediaContainer><Server machineIdentifier="server-uuid"><Section id="1" key="/library/sections/1" title="Movies"/></Server></MediaContainer>',
        };
      }

      if (url.startsWith('https://plex.tv/api/servers?')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              MediaContainer: {
                Server: [{ machineIdentifier: 'server-uuid' }],
              },
            }),
        };
      }

      if (
        url ===
        'https://plex.tv/api/home/users?invitedEmail=friend%40example.com&X-Plex-Token=token123'
      ) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              users: [
                { id: '2001', email: 'friend@example.com', invitedId: 'INVITED-2001' },
              ],
            }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    },
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
    if (url.startsWith('https://plex.tv/api/resources')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              accessToken: 'serverAccessToken',
              connections: [{ uri: 'https://pms.example:32400' }],
            },
          ]),
      };
    }

    if (url.startsWith('https://plex.tv/api/servers?')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Server: [{ id: 12345, machineIdentifier: 'server-uuid' }],
            },
          }),
      };
    }

    if (url.includes('/INV-123')) {
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

    assert.equal(calls.length, 4);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(calls[1].options.headers.Accept, undefined);
    assert.equal(
      calls[2].url,
      'https://plex.tv/api/servers/12345/shared_servers/INV-123?X-Plex-Token=token123'
    );
    assert.equal(
      calls[3].url,
      'https://plex.tv/api/servers/12345/shared_servers/INV-MISSING?X-Plex-Token=token123'
    );
    assert.equal(calls[2].options.method, 'DELETE');
  });
});

test('plexService.cancelInvite rejects when legacy server id is unavailable', async () => {
  await withMockedFetch(
    async (url) => {
      if (url.startsWith('https://plex.tv/api/resources')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              {
                name: 'Primary PMS',
                provides: 'server',
                clientIdentifier: 'server-uuid',
                owned: 1,
                accessToken: 'serverAccessToken',
                connections: [{ uri: 'https://pms.example:32400' }],
              },
            ]),
        };
      }

      if (url.startsWith('https://plex.tv/api/servers?')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              MediaContainer: {
                Server: [{ machineIdentifier: 'server-uuid' }],
              },
            }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
    async (plexService) => {
      await assert.rejects(
        () =>
          plexService.cancelInvite('INV-123', {
            baseUrl: 'https://plex.local',
            token: 'token123',
            serverIdentifier: 'server-uuid',
            librarySectionIds: '1',
          }),
        /cancelling invites is not supported/i
      );
    }
  );
});

test('plexService.verifyConnection checks invite endpoint and loads libraries', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://plex.tv/api/resources')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              accessToken: 'serverAccessToken',
              connections: [{ uri: 'https://pms.example:32400' }],
            },
          ]),
      };
    }
    if (url.startsWith('https://plex.tv/api/servers?')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Server: [{ id: 12345, machineIdentifier: 'server-uuid' }],
            },
          }),
      };
    }
    if (url.includes('/api/servers/12345/shared_servers')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ invitations: [] }),
        text: async () => '',
      };
    }
    if (url.startsWith('https://plex.tv/api/servers/server-uuid?')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server><Section id="10" key="/library/sections/1" title="Movies"/><Section id="12" key="/library/sections/2" title="TV"/></Server></MediaContainer>',
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

    assert.equal(calls.length, 5);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(calls[1].options.headers.Accept, undefined);
    assert.equal(
      calls[2].url,
      'https://plex.tv/api/servers/12345/shared_servers?X-Plex-Token=token123'
    );
    assert.equal(calls[2].options.method, 'GET');
    assert.equal(
      calls[2].options.headers['X-Plex-Client-Identifier'],
      'plex-donate-server-uuid'
    );
    assert.equal(calls[2].options.headers['X-Plex-Token'], 'token123');
    assert.match(
      calls[3].url,
      /^https:\/\/plex\.tv\/api\/servers\/[^/]+\?X-Plex-Token=token123$/
    );
    assert.equal(
      calls[4].url,
      'https://plex.local/library/sections?X-Plex-Token=token123'
    );
    assert.equal(calls[4].options.method || 'GET', 'GET');
    assert.equal(result.details.serverIdentifier, 'server-uuid');
    assert.deepEqual(result.details.librarySectionIds, ['10', '12']);
    assert.equal(result.details.inviteEndpointAvailable, true);
    assert.deepEqual(result.libraries, [
      { id: '10', title: 'Movies' },
      { id: '12', title: 'TV Shows' },
    ]);
    assert.equal(result.details.inviteEndpointVersion, 'legacy');
  });
});

test('plexService.verifyConnection handles v2 shared servers when legacy id is missing', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://plex.tv/api/resources')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              accessToken: 'serverAccessToken',
              connections: [{ uri: 'https://pms.example:32400' }],
            },
          ]),
      };
    }

    if (url.startsWith('https://plex.tv/api/servers?')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Server: [{ machineIdentifier: 'server-uuid' }],
            },
          }),
      };
    }

    if (url.startsWith('https://plex.tv/api/servers/server-uuid?')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server><Section id="10" key="/library/sections/1" title="Movies"/><Section id="12" key="/library/sections/2" title="TV"/></Server></MediaContainer>',
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

    assert.equal(calls.length, 4);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(calls[1].options.headers.Accept, undefined);
    assert.equal(
      calls[2].url,
      'https://plex.tv/api/servers/server-uuid?X-Plex-Token=token123'
    );
    assert.equal(
      calls[3].url,
      'https://plex.local/library/sections?X-Plex-Token=token123'
    );
    assert.deepEqual(result.details.librarySectionIds, ['10', '12']);
    assert.deepEqual(result.libraries, [
      { id: '10', title: 'Movies' },
      { id: '12', title: 'TV Shows' },
    ]);
    assert.equal(result.details.inviteEndpointAvailable, true);
    assert.equal(result.details.inviteEndpointVersion, 'v2');
  });
});

test('plexService.verifyConnection falls back when shared server endpoint is missing', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://plex.tv/api/resources')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              accessToken: 'serverAccessToken',
              connections: [{ uri: 'https://pms.example:32400' }],
            },
          ]),
      };
    }
    if (url.startsWith('https://plex.tv/api/servers?')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Server: [{ id: 12345, machineIdentifier: 'server-uuid' }],
            },
          }),
      };
    }
    if (url.includes('/api/servers/12345/shared_servers')) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
      };
    }
    if (url.startsWith('https://plex.tv/api/servers/server-uuid?')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server><Section id="10" key="/library/sections/1" title="Movies"/><Section id="12" key="/library/sections/2" title="TV"/></Server></MediaContainer>',
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

    assert.equal(calls.length, 5);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(
      calls[2].url,
      'https://plex.tv/api/servers/12345/shared_servers?X-Plex-Token=token123'
    );
    assert.equal(
      calls[3].url,
      'https://plex.tv/api/servers/server-uuid?X-Plex-Token=token123'
    );
    assert.equal(
      calls[4].url,
      'https://plex.local/library/sections?X-Plex-Token=token123'
    );
    assert.equal(result.message, 'Plex invite configuration verified successfully.');
    assert.deepEqual(result.details.librarySectionIds, ['10', '12']);
    assert.deepEqual(result.libraries, [
      { id: '10', title: 'Movies' },
      { id: '12', title: 'TV Shows' },
    ]);
    assert.equal(result.details.inviteEndpointAvailable, false);
    assert.equal(result.details.inviteEndpointVersion, 'legacy');
  });
});

test('plexService.verifyConnection notes when shared server endpoint is gone', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://plex.tv/api/resources')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              accessToken: 'serverAccessToken',
              connections: [{ uri: 'https://pms.example:32400' }],
            },
          ]),
      };
    }
    if (url.startsWith('https://plex.tv/api/servers?')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Server: [{ id: 12345, machineIdentifier: 'server-uuid' }],
            },
          }),
      };
    }
    if (url.includes('/api/servers/12345/shared_servers')) {
      return {
        ok: false,
        status: 410,
        statusText: 'Gone',
        text: async () => '',
      };
    }
    if (url.startsWith('https://plex.tv/api/servers/server-uuid?')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server><Section id="10" key="/library/sections/1" title="Movies"/><Section id="12" key="/library/sections/2" title="TV"/></Server></MediaContainer>',
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

    assert.equal(calls.length, 5);
    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(calls[1].url, 'https://plex.tv/api/servers?X-Plex-Token=token123');
    assert.equal(
      calls[2].url,
      'https://plex.tv/api/servers/12345/shared_servers?X-Plex-Token=token123'
    );
    assert.equal(
      calls[3].url,
      'https://plex.tv/api/servers/server-uuid?X-Plex-Token=token123'
    );
    assert.equal(
      calls[4].url,
      'https://plex.local/library/sections?X-Plex-Token=token123'
    );
    assert.equal(result.message, 'Plex invite configuration verified successfully.');
    assert.deepEqual(result.details.librarySectionIds, ['10', '12']);
    assert.deepEqual(result.libraries, [
      { id: '10', title: 'Movies' },
      { id: '12', title: 'TV Shows' },
    ]);
    assert.equal(result.details.inviteEndpointAvailable, false);
    assert.equal(result.details.inviteEndpointVersion, 'legacy');
  });
});

test('plexService.verifyConnection parses XML library list responses', async () => {
  const calls = [];
  await withMockedFetch(async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://plex.tv/api/resources')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              name: 'Primary PMS',
              provides: 'server',
              clientIdentifier: 'server-uuid',
              owned: 1,
              accessToken: 'serverAccessToken',
              connections: [{ uri: 'https://pms.example:32400' }],
            },
          ]),
      };
    }
    if (url.startsWith('https://plex.tv/api/servers?')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            MediaContainer: {
              Server: [{ id: 12345, machineIdentifier: 'server-uuid' }],
            },
          }),
      };
    }
    if (url.includes('/api/servers/12345/shared_servers')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ invitations: [] }),
        text: async () => '',
      };
    }
    if (url.startsWith('https://plex.tv/api/servers/server-uuid?')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<MediaContainer><Server><Section id="105" key="/library/sections/5" title="Kids"/><Section id="109" key="/library/sections/9" title="Music"/></Server></MediaContainer>',
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

    assert.equal(
      calls[0].url,
      'https://plex.tv/api/resources?includeHttps=1&includeRelay=1&X-Plex-Token=token123'
    );
    assert.equal(
      calls[1].url,
      'https://plex.tv/api/servers?X-Plex-Token=token123'
    );
    assert.equal(
      calls[2].url,
      'https://plex.tv/api/servers/12345/shared_servers?X-Plex-Token=token123'
    );
    assert.equal(
      calls[3].url,
      'https://plex.tv/api/servers/server-uuid?X-Plex-Token=token123'
    );
    assert.equal(
      calls[4].url,
      'https://plex.local/library/sections?X-Plex-Token=token123'
    );
    assert.equal(result.details.inviteEndpointAvailable, true);
    assert.deepEqual(result.libraries, [
      { id: '105', title: 'Kids' },
      { id: '109', title: 'Music' },
    ]);
    assert.equal(result.details.inviteEndpointVersion, 'legacy');
  });
});
