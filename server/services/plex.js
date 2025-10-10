const fetch = require('node-fetch');
const { getPlexSettings } = require('../state/settings');
const { buildHeaders: buildPlexClientHeaders } = require('./plex-oauth');

const USER_LIST_ENDPOINTS = ['/accounts', '/api/v2/home/users', '/api/home/users'];
const LIBRARY_SECTIONS_ENDPOINT = '/library/sections';
const PLEX_TV_BASE_URL = 'https://plex.tv';
const userListPathCache = new Map();
const serverIdCache = new Map();

function getPlexConfig(overrideSettings) {
  if (overrideSettings && typeof overrideSettings === 'object') {
    return overrideSettings;
  }
  return getPlexSettings();
}

function isConfigured() {
  const plex = getPlexConfig();
  return Boolean(plex.baseUrl && plex.token);
}

function parseLibrarySectionIds(value) {
  if (!value && value !== 0) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function ensureInviteConfiguration(plex) {
  if (!plex.baseUrl || !plex.token) {
    throw new Error('Plex base URL and token must be configured');
  }
  if (!plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }
}

async function buildInviteRequestBody({
  plex,
  email,
  friendlyName,
  librarySectionIds,
}) {
  const sections = parseLibrarySectionIds(
    librarySectionIds !== undefined ? librarySectionIds : plex.librarySectionIds
  );

  if (!sections.length) {
    throw new Error('At least one Plex library section ID must be configured');
  }

  const sharedServer = {
    library_section_ids: sections,
    invited_email: email,
  };

  if (friendlyName) {
    sharedServer.friendly_name = friendlyName;
  }

  const serializeBoolean = (value) => (value ? '1' : '0');

  const serverId = await resolveServerId(plex);

  return {
    server_id: serverId,
    shared_server: sharedServer,
    sharing_settings: {
      allow_sync: serializeBoolean(plex.allowSync),
      allow_camera_upload: serializeBoolean(plex.allowCameraUpload),
      allow_channels: serializeBoolean(plex.allowChannels),
    },
  };
}

function coerceArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function mapSharedLibrariesFromResponse(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return [];
  }

  const candidates =
    container.libraries ||
    container.sharedLibraries ||
    (container.Metadata && container.Metadata.Metadata);

  const libraries = coerceArray(candidates).flatMap((entry) => {
    if (!entry) {
      return [];
    }
    if (Array.isArray(entry)) {
      return entry;
    }
    return [entry];
  });

  return libraries
    .map((library) => ({
      id:
        (library.id !== undefined && library.id !== null
          ? String(library.id)
          : library.sectionID !== undefined
          ? String(library.sectionID)
          : library.key
          ? String(library.key).replace(/^[^\d]*/, '')
          : null) || null,
      title:
        library.title ||
        library.name ||
        (library.librarySectionTitle || library.sectionTitle) ||
        null,
    }))
    .filter((library) => library.id || library.title);
}

function extractInviteId(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate =
    container.id ||
    container.uuid ||
    container.inviteId ||
    container.identifier ||
    (container.Metadata && container.Metadata.id);

  if (candidate === undefined || candidate === null) {
    return null;
  }

  return String(candidate);
}

function extractInviteUrl(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate =
    container.inviteUrl ||
    container.shareUrl ||
    container.uri ||
    container.url ||
    container.invite_uri ||
    (container.links && container.links.invite);

  if (!candidate) {
    return null;
  }

  return String(candidate);
}

function extractInviteStatus(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate = container.status || container.state || null;
  return candidate ? String(candidate) : null;
}

function extractInviteTimestamp(data) {
  const container = data && (data.invitation || data);
  if (!container) {
    return null;
  }

  const candidate =
    container.created_at ||
    container.createdAt ||
    container.addedAt ||
    container.last_modified ||
    null;

  if (!candidate) {
    return null;
  }

  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function mapInviteResponse(data) {
  return {
    inviteId: extractInviteId(data),
    inviteUrl: extractInviteUrl(data),
    sharedLibraries: mapSharedLibrariesFromResponse(data),
    status: extractInviteStatus(data),
    invitedAt: extractInviteTimestamp(data),
  };
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return '';
  }
  return String(baseUrl).trim().replace(/\/+$/, '');
}

function buildUrlFromConfig(pathname, plex) {
  if (!plex || !plex.baseUrl) {
    throw new Error('Plex base URL is not configured');
  }
  if (!plex.token) {
    throw new Error('Plex token is not configured');
  }

  const base = normalizeBaseUrl(plex.baseUrl);
  const separator = pathname.includes('?') ? '&' : '?';
  return `${base}${pathname}${separator}X-Plex-Token=${encodeURIComponent(
    plex.token
  )}`;
}

function buildUrl(pathname, overrideSettings) {
  const plex = getPlexConfig(overrideSettings);
  return buildUrlFromConfig(pathname, plex);
}

async function extractErrorMessage(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return '';
    }
    if (/^</.test(trimmed)) {
      return '';
    }
    if (trimmed.length > 300) {
      return `${trimmed.slice(0, 297)}...`;
    }
    return trimmed;
  } catch (err) {
    return '';
  }
}

function getCacheKey(plex) {
  return normalizeBaseUrl(plex && plex.baseUrl);
}

function getServerIdCacheKey(plex) {
  if (!plex) {
    return null;
  }

  const token = plex.token ? String(plex.token).trim() : '';
  const identifier = plex.serverIdentifier
    ? String(plex.serverIdentifier).trim()
    : '';

  if (!token || !identifier) {
    return null;
  }

  return `${token}:${identifier}`;
}

function buildPlexTvUrl(pathname, plex) {
  if (!plex || !plex.token) {
    throw new Error('Plex token is not configured');
  }

  const raw = String(pathname || '').trim();
  const [pathPart, queryPart] = raw.split('?', 2);
  const normalizedPath = `/${String(pathPart || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')}`;
  const baseUrl = `${PLEX_TV_BASE_URL}${normalizedPath}${
    queryPart ? `?${queryPart}` : ''
  }`;

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}X-Plex-Token=${encodeURIComponent(plex.token)}`;
}

function normalizeServerEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const idCandidate =
    entry.id !== undefined && entry.id !== null
      ? entry.id
      : entry.serverID !== undefined && entry.serverID !== null
      ? entry.serverID
      : entry.serverId !== undefined && entry.serverId !== null
      ? entry.serverId
      : entry.server_id !== undefined && entry.server_id !== null
      ? entry.server_id
      : entry.serverid !== undefined && entry.serverid !== null
      ? entry.serverid
      : null;

  const machineIdentifierCandidate =
    entry.machineIdentifier ||
    entry.machine_identifier ||
    entry.machineID ||
    entry.machineid ||
    entry.uuid ||
    entry.clientIdentifier ||
    entry.clientidentifier ||
    entry.client_id ||
    entry.clientID ||
    null;

  const id = idCandidate != null ? String(idCandidate).trim() : null;
  const machineIdentifier = machineIdentifierCandidate
    ? String(machineIdentifierCandidate).trim()
    : null;

  if (!id && !machineIdentifier) {
    return null;
  }

  return { id, machineIdentifier };
}

function flattenServerEntries(value) {
  return coerceArray(value).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    if (entry.Server || entry.server) {
      return flattenServerEntries(entry.Server || entry.server);
    }

    return [entry];
  });
}

function parseServerListFromObject(data) {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const container =
    data.MediaContainer || data.mediaContainer || data.container || data;

  const rawEntries = [
    container.Server,
    container.server,
    container.Servers,
    container.servers,
    container.Items,
    container.items,
    container.children,
    container.Children,
  ]
    .flatMap((value) => flattenServerEntries(value))
    .filter((entry) => entry && typeof entry === 'object');

  if (!rawEntries.length) {
    return flattenServerEntries(container)
      .map((entry) => normalizeServerEntry(entry))
      .filter(Boolean);
  }

  return rawEntries.map((entry) => normalizeServerEntry(entry)).filter(Boolean);
}

function parseServerListFromXml(payload) {
  if (!payload) {
    return [];
  }

  const servers = [];
  const pattern = /<Server\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const attributes = {};
    match[0].replace(/([\w-]+)="([^"]*)"/g, (_, key, value) => {
      attributes[key] = value;
      return '';
    });
    servers.push(attributes);
  }

  return servers.map((entry) => normalizeServerEntry(entry)).filter(Boolean);
}

function parseServerListPayload(payload) {
  if (!payload) {
    return [];
  }

  const trimmed = String(payload).trim();
  if (!trimmed) {
    return [];
  }

  try {
    const data = JSON.parse(trimmed);
    const servers = parseServerListFromObject(data);
    if (servers.length) {
      return servers;
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  return parseServerListFromXml(trimmed);
}

function findServerMatch(servers, normalizedIdentifier) {
  if (!Array.isArray(servers) || !servers.length) {
    return null;
  }

  const matches = (value) =>
    typeof value === 'string' && value.trim().toLowerCase() === normalizedIdentifier;

  for (const server of servers) {
    if (!server || typeof server !== 'object') {
      continue;
    }
    const candidates = [
      server.machineIdentifier,
      server.clientIdentifier,
      server.id != null ? String(server.id) : null,
      server.uuid,
    ];

    if (candidates.some(matches)) {
      return server;
    }
  }

  return null;
}

function summarizeServerIdentifiers(servers, limit = 10) {
  if (!Array.isArray(servers) || !servers.length) {
    return [];
  }

  return servers.slice(0, limit).reduce((acc, server) => {
    if (!server || typeof server !== 'object') {
      return acc;
    }

    acc.push({
      name: server.name || server.friendlyName || server.device || 'unknown',
      machineIdentifier: server.machineIdentifier || null,
      clientIdentifier: server.clientIdentifier || null,
      id: server.id || null,
      uuid: server.uuid || null,
      provides: server.provides || null,
    });

    return acc;
  }, []);
}

async function resolveServerId(plex) {
  if (!plex || !plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const machineIdentifier = String(plex.serverIdentifier).trim();
  if (!machineIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const cacheKey = getServerIdCacheKey(plex);
  if (cacheKey && serverIdCache.has(cacheKey)) {
    return serverIdCache.get(cacheKey);
  }

  let response;
  try {
    const headers = buildPlexClientHeaders(getClientIdentifier(plex), {
      'X-Plex-Token': plex.token,
    });
    delete headers['Content-Type'];
    headers.Accept = 'application/json';

    response = await fetch(buildPlexTvUrl('/api/servers', plex), {
      headers,
    });
  } catch (err) {
    throw new Error(`Failed to resolve Plex server id: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to resolve Plex server id: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  const servers = parseServerListPayload(payload);
  const normalizedIdentifier = machineIdentifier.toLowerCase();
  const serverCandidates = Array.isArray(servers)
    ? servers.filter((server) => {
        if (!server || typeof server !== 'object') {
          return false;
        }
        const provides = (server.provides && String(server.provides)) || '';
        const normalizedProvides = provides.toLowerCase();
        return (
          normalizedProvides.includes('server') ||
          normalizedProvides.includes('plex media server')
        );
      })
    : [];

  const match =
    findServerMatch(serverCandidates, normalizedIdentifier) ||
    findServerMatch(servers, normalizedIdentifier);

  if (!match) {
    const sample = summarizeServerIdentifiers(servers);
    throw new Error(
      `Unable to resolve Plex server id for the configured machine identifier "${machineIdentifier}". Visible servers: ${JSON.stringify(
        sample
      )}`
    );
  }

  const resolvedId = String(match.id || match.server_id || match.serverId || '').trim();
  if (!resolvedId) {
    const sample = summarizeServerIdentifiers([match]);
    throw new Error(
      `Matched server but no numeric "id" field was found to use with the invite API. Matched: ${JSON.stringify(
        sample
      )}`
    );
  }

  if (cacheKey) {
    serverIdCache.set(cacheKey, resolvedId);
  }

  return resolvedId;
}

async function buildSharedServersPath(plex) {
  if (!plex || !plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const serverId = await resolveServerId(plex);
  const encodedId = encodeURIComponent(String(serverId));
  return `/api/servers/${encodedId}/shared_servers`;
}

async function buildSharedServerUrl(plex, inviteId) {
  const basePath = await buildSharedServersPath(plex);
  if (inviteId === undefined || inviteId === null) {
    return buildPlexTvUrl(basePath, plex);
  }

  const encodedId = encodeURIComponent(String(inviteId));
  return buildPlexTvUrl(`${basePath}/${encodedId}`, plex);
}

function getClientIdentifier(plex) {
  if (!plex) {
    return 'plex-donate';
  }

  if (plex.clientIdentifier) {
    return String(plex.clientIdentifier).trim() || 'plex-donate';
  }

  if (plex.serverIdentifier) {
    return `plex-donate-${String(plex.serverIdentifier).trim() || 'server'}`;
  }

  return 'plex-donate';
}

function buildSharedServerHeaders(plex, extra = {}) {
  if (!plex || !plex.token) {
    throw new Error('Plex token is not configured');
  }

  return buildPlexClientHeaders(getClientIdentifier(plex), {
    'X-Plex-Token': plex.token,
    ...extra,
  });
}

function normalizeLibraryList(libraries) {
  const seen = new Set();
  return mapSharedLibrariesFromResponse({ libraries })
    .map((library) => {
      if (!library) {
        return null;
      }
      const id = library.id != null ? String(library.id).trim() : '';
      if (!id) {
        return null;
      }
      const title = library.title ? String(library.title).trim() : '';
      return { id, title: title || id };
    })
    .filter((library) => {
      if (!library) {
        return false;
      }
      if (seen.has(library.id)) {
        return false;
      }
      seen.add(library.id);
      return true;
    });
}

function parseLibrarySectionsPayload(payload) {
  if (!payload) {
    return [];
  }

  try {
    const data = JSON.parse(payload);
    if (data && typeof data === 'object') {
      const container =
        data.MediaContainer || data.mediaContainer || data.container || data;
      if (container && typeof container === 'object') {
        const directories =
          container.Directory ||
          container.directory ||
          container.Metadata ||
          container.metadata ||
          [];
        const normalized = normalizeLibraryList(coerceArray(directories));
        if (normalized.length) {
          return normalized;
        }
      }
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  const directories = [];
  const pattern = /<Directory\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const tag = match[0];
    const attributes = {};
    tag.replace(/([\w-]+)="([^"]*)"/g, (_, key, value) => {
      attributes[key] = value;
      return '';
    });
    directories.push(attributes);
  }

  return normalizeLibraryList(directories);
}

async function fetchLibrarySections(plex) {
  let response;
  try {
    response = await fetch(buildUrlFromConfig(LIBRARY_SECTIONS_ENDPOINT, plex), {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex library API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to load Plex library sections: ${response.status} (${statusText})${suffix}`
    );
  }

  const body = await response.text();
  return parseLibrarySectionsPayload(body);
}

async function fetchUsersList(plex) {
  const cacheKey = getCacheKey(plex);
  const preferredPath = cacheKey ? userListPathCache.get(cacheKey) : null;
  const endpoints = preferredPath
    ? [
        preferredPath,
        ...USER_LIST_ENDPOINTS.filter((path) => path !== preferredPath),
      ]
    : USER_LIST_ENDPOINTS;

  const attemptedNotFound = [];

  for (const basePath of endpoints) {
    let response;
    try {
      response = await fetch(buildUrlFromConfig(basePath, plex), {
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new Error(`Unable to connect to Plex server: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Plex rejected the provided token.');
    }

    if (response.status === 404) {
      if (!attemptedNotFound.includes(basePath)) {
        attemptedNotFound.push(basePath);
      }
      if (preferredPath === basePath && cacheKey) {
        userListPathCache.delete(cacheKey);
      }
      continue;
    }

    if (!response.ok) {
      const details = await extractErrorMessage(response);
      const statusText = response.statusText || 'Error';
      const suffix = details ? `: ${details}` : '';
      throw new Error(
        `Plex returned ${response.status} (${statusText}) for ${basePath}${suffix}`
      );
    }

    const data = await response.json().catch(() => ({}));
    const users = data.users || data;

    if (cacheKey) {
      userListPathCache.set(cacheKey, basePath);
    }

    return { users, basePath };
  }

  if (attemptedNotFound.length > 0) {
    const formattedPaths =
      attemptedNotFound.length === 1
        ? attemptedNotFound[0]
        : `${attemptedNotFound
            .slice(0, -1)
            .join(', ')} and ${attemptedNotFound[attemptedNotFound.length - 1]}`;
    throw new Error(
      `Plex returned 404 (Not Found) for the supported user list endpoints (${formattedPaths}). Confirm the base URL is correct and that the server supports the Plex accounts or home users API.`
    );
  }

  throw new Error('Unable to determine the Plex home users endpoint.');
}

async function listUsers() {
  if (!isConfigured()) {
    throw new Error('Plex integration is not configured');
  }

  const plex = getPlexConfig();

  try {
    const { users } = await fetchUsersList(plex);
    return users;
  } catch (err) {
    throw new Error(`Failed to fetch Plex users: ${err.message}`);
  }
}

async function revokeUserByEmail(email) {
  return revokeUser({ email });
}

function normalize(value) {
  if (value == null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function matchesAccountId(user, accountId) {
  const normalized = normalize(accountId);
  if (!normalized) {
    return false;
  }
  const candidates = [
    user.id,
    user.uuid,
    user.userID,
    user.machineIdentifier,
    user.account && user.account.id,
  ];
  return candidates.some((candidate) => normalize(candidate) === normalized);
}

function matchesEmail(user, email) {
  const normalized = normalize(email);
  if (!normalized) {
    return false;
  }
  const candidates = [user.email, user.username, user.title, user.account && user.account.email];
  return candidates.some((candidate) => normalize(candidate) === normalized);
}

async function revokeUser({ plexAccountId, email }) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'Plex integration disabled' };
  }

  const plex = getPlexConfig();
  let listResult;
  try {
    listResult = await fetchUsersList(plex);
  } catch (err) {
    throw new Error(`Failed to fetch Plex users: ${err.message}`);
  }
  const users = listResult.users;
  let target = null;

  if (plexAccountId) {
    target = users.find((user) => matchesAccountId(user, plexAccountId));
  }

  if (!target && email) {
    target = users.find((user) => matchesEmail(user, email));
  }

  if (!target) {
    return { success: false, reason: 'User not found on Plex server' };
  }

  const userId = target.id || target.uuid || target.userID;
  if (!userId) {
    return { success: false, reason: 'Unable to determine Plex user id' };
  }

  const response = await fetch(
    buildUrlFromConfig(`${listResult.basePath}/${userId}`, plex),
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
      },
    }
  );

  if (response.status === 404) {
    return { success: false, reason: 'User not found on Plex server' };
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to revoke Plex user: Plex returned ${response.status} (${statusText})${suffix}`
    );
  }

  return { success: true, user: target };
}

async function createInvite(
  { email, friendlyName, librarySectionIds } = {},
  overrideSettings
) {
  const plex = getPlexConfig(overrideSettings);
  ensureInviteConfiguration(plex);

  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    throw new Error('Recipient email is required to create Plex invites');
  }

  const requestBody = await buildInviteRequestBody({
    plex,
    email: normalizedEmail,
    friendlyName,
    librarySectionIds,
  });

  let response;
  try {
    const sharedServerUrl = await buildSharedServerUrl(plex);
    response = await fetch(sharedServerUrl, {
      method: 'POST',
      headers: buildSharedServerHeaders(plex, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404 || response.status === 410) {
    throw new Error('Plex server was not found when creating invite.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Plex invite creation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  const data = await response.json().catch(() => ({}));
  const mapped = mapInviteResponse(data);

  if (!mapped.inviteId && !mapped.inviteUrl) {
    throw new Error('Plex did not return an invite identifier');
  }

  return mapped;
}

async function cancelInvite(inviteId, overrideSettings) {
  if (!inviteId) {
    throw new Error('Invite id is required to cancel Plex invites');
  }

  const plex = getPlexConfig(overrideSettings);
  ensureInviteConfiguration(plex);

  let response;
  try {
    const sharedServerUrl = await buildSharedServerUrl(plex, inviteId);
    response = await fetch(sharedServerUrl, {
      method: 'DELETE',
      headers: buildSharedServerHeaders(plex),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404 || response.status === 410) {
    return { success: false, reason: 'Invite not found on Plex server' };
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Plex invite cancellation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  return { success: true };
}

async function verifyConnection(overrideSettings) {
  const plex = getPlexConfig(overrideSettings);
  ensureInviteConfiguration(plex);

  const sections = parseLibrarySectionIds(plex.librarySectionIds);

  let inviteEndpointAvailable = true;

  let response;
  try {
    const sharedServerUrl = await buildSharedServerUrl(plex);
    response = await fetch(sharedServerUrl, {
      method: 'GET',
      headers: buildSharedServerHeaders(plex),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404 || response.status === 410) {
    inviteEndpointAvailable = false;
  } else if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to verify Plex invite configuration: ${response.status} (${statusText})${suffix}`
    );
  }

  const libraries = await fetchLibrarySections(plex);
  if (!libraries.length) {
    throw new Error(
      'No Plex libraries were found. Confirm the token has access to your server.'
    );
  }

  return {
    message: 'Plex invite configuration verified successfully.',
    details: {
      serverIdentifier: plex.serverIdentifier,
      librarySectionIds: sections,
      inviteEndpointAvailable,
    },
    libraries,
  };
}

module.exports = {
  getPlexConfig,
  isConfigured,
  createInvite,
  cancelInvite,
  listUsers,
  revokeUser,
  revokeUserByEmail,
  verifyConnection,
};
