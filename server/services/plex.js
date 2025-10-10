const fetch = require('node-fetch');
const { getPlexSettings } = require('../state/settings');
const { buildHeaders: buildPlexClientHeaders } = require('./plex-oauth');

const USER_LIST_ENDPOINTS = ['/accounts', '/api/v2/home/users', '/api/home/users'];
const LIBRARY_SECTIONS_ENDPOINT = '/library/sections';
const PLEX_TV_BASE_URL = 'https://plex.tv';
const userListPathCache = new Map();
const serverDescriptorCache = new Map();

const V2_SHARED_SERVERS_PATH = '/api/v2/shared_servers';
const LEGACY_SHARED_SERVERS_PATH = (serverId) =>
  `/api/servers/${encodeURIComponent(String(serverId))}/shared_servers`;
const HOME_USER_EMAIL_KEYS = [
  'email',
  'username',
  'title',
  'friendlyname',
  'friendly_name',
  'name',
  'invitedemail',
  'invited_email',
];
const HOME_USER_ID_KEYS = [
  'invitedid',
  'invited_id',
  'homeuserid',
  'home_user_id',
  'userid',
  'user_id',
  'useruuid',
  'user_uuid',
  'uuid',
  'id',
  'accountid',
  'account_id',
  'machineidentifier',
  'machine_id',
  'machineid',
];
const to01 = (value) => (value ? '1' : '0');

const asStringArray = (value) => {
  if (!value && value !== 0) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry);
  }

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry);
};

function normalizeId(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/-/g, '');
}

function hostFromUrl(url) {
  if (!url) {
    return '';
  }

  try {
    return new URL(url).host.toLowerCase();
  } catch (err) {
    return '';
  }
}

function isHttps(url) {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function mapConnectionUri(connection) {
  if (!connection) {
    return null;
  }

  if (typeof connection === 'string') {
    return connection;
  }

  return (
    connection.uri ||
    connection.address ||
    connection.host ||
    null
  );
}

function pickPrimaryConnection(device) {
  const rawConnections = Array.isArray(device && device.connections)
    ? device.connections
    : [];

  const uris = rawConnections
    .map((connection) => mapConnectionUri(connection))
    .filter(Boolean);

  if (!uris.length) {
    return null;
  }

  const scored = uris
    .map((uri) => {
      const host = hostFromUrl(uri);
      const normalizedHost = host || '';
      const score =
        (isHttps(uri) ? 10 : 0) +
        (normalizedHost.startsWith('192.168.') ||
        normalizedHost.startsWith('10.') ||
        normalizedHost.startsWith('172.16.') ||
        normalizedHost.startsWith('172.17.') ||
        normalizedHost.startsWith('172.18.') ||
        normalizedHost.startsWith('172.19.') ||
        normalizedHost.startsWith('172.20.') ||
        normalizedHost.startsWith('172.21.') ||
        normalizedHost.startsWith('172.22.') ||
        normalizedHost.startsWith('172.23.') ||
        normalizedHost.startsWith('172.24.') ||
        normalizedHost.startsWith('172.25.') ||
        normalizedHost.startsWith('172.26.') ||
        normalizedHost.startsWith('172.27.') ||
        normalizedHost.startsWith('172.28.') ||
        normalizedHost.startsWith('172.29.') ||
        normalizedHost.startsWith('172.30.') ||
        normalizedHost.startsWith('172.31.')
          ? 2
          : 0);

      return { uri, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0] ? scored[0].uri : null;
}

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
  return asStringArray(value);
}

function ensureBaseConfiguration(plex) {
  if (!plex.baseUrl || !plex.token) {
    throw new Error('Plex base URL and token must be configured');
  }
}

function ensureInviteConfiguration(plex) {
  ensureBaseConfiguration(plex);
  if (!plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }
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

function normalizeServerEntry(entry, defaults = {}) {
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
    entry.machine_id ||
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
  const clientIdentifier = entry.clientIdentifier
    ? String(entry.clientIdentifier).trim()
    : entry.clientidentifier
    ? String(entry.clientidentifier).trim()
    : entry.client_id
    ? String(entry.client_id).trim()
    : entry.clientID
    ? String(entry.clientID).trim()
    : null;
  const uuid = entry.uuid ? String(entry.uuid).trim() : null;
  const providesRaw =
    entry.provides !== undefined && entry.provides !== null
      ? entry.provides
      : defaults.defaultProvides !== undefined
      ? defaults.defaultProvides
      : null;
  const provides =
    providesRaw !== null && providesRaw !== undefined
      ? String(providesRaw).trim()
      : null;
  const nameCandidate =
    entry.name ||
    entry.friendlyName ||
    entry.device ||
    defaults.defaultName ||
    null;
  const name = nameCandidate ? String(nameCandidate).trim() : 'unknown';

  if (!id && !machineIdentifier && !clientIdentifier && !uuid) {
    return null;
  }

  return {
    id,
    machineIdentifier,
    clientIdentifier,
    uuid,
    provides,
    name,
  };
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
  if (Array.isArray(data)) {
    return data
      .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
      .filter(Boolean);
  }

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
      .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
      .filter(Boolean);
  }

  return rawEntries
    .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
    .filter(Boolean);
}

function extractXmlAttribute(tag, key) {
  if (!tag) {
    return null;
  }

  const pattern = new RegExp(`${key}="([^"]*)"`, 'i');
  const match = pattern.exec(tag);
  return match ? match[1] : null;
}

function parseServerListFromXml(payload) {
  if (!payload) {
    return [];
  }

  const xml = String(payload);
  const trimmed = xml.trim();
  if (!trimmed) {
    return [];
  }

  const containerMatch = /<MediaContainer[\s\S]*?>([\s\S]*?)<\/MediaContainer>/i.exec(trimmed);
  const body = containerMatch ? containerMatch[1] : trimmed;

  const results = [];
  const serverPattern = /<Server\b[^>]*\/?>(?:<\/Server>)?/gi;
  let match;

  while ((match = serverPattern.exec(body))) {
    const tag = match[0] || '';
    const rawAttributes = tag
      .replace(/^<Server\b/i, '')
      .replace(/\/?>(?:\s*<\/Server>)?$/i, '');
    const attributes = {};

    rawAttributes.replace(/([\w:-]+)="([^"]*)"/g, (_, key, value) => {
      attributes[key] = value;
      return '';
    });

    if (attributes.id == null) {
      const idValue = extractXmlAttribute(rawAttributes, 'id');
      if (idValue != null) {
        attributes.id = idValue;
      }
    }

    if (attributes.machineIdentifier == null) {
      const machine = extractXmlAttribute(rawAttributes, 'machineIdentifier');
      if (machine != null) {
        attributes.machineIdentifier = machine;
      }
    }

    if (attributes.clientIdentifier == null) {
      const client = extractXmlAttribute(rawAttributes, 'clientIdentifier');
      if (client != null) {
        attributes.clientIdentifier = client;
      }
    }

    if (attributes.provides == null) {
      attributes.provides = 'server';
    }

    results.push(attributes);
  }

  return results
    .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
    .filter(Boolean);
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
    const servers = Array.isArray(data)
      ? data
          .map((entry) => normalizeServerEntry(entry, { defaultProvides: 'server' }))
          .filter(Boolean)
      : parseServerListFromObject(data);

    if (servers.length) {
      return servers;
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  return parseServerListFromXml(trimmed);
}

function parseResourcesPayload(payload) {
  if (!payload) {
    return [];
  }

  const trimmed = String(payload).trim();
  if (!trimmed) {
    return [];
  }

  const mapConnections = (rawConnections) =>
    (Array.isArray(rawConnections) ? rawConnections : [])
      .map((connection) => {
        if (!connection || typeof connection !== 'object') {
          return null;
        }

        const uri =
          connection.uri ||
          connection.address ||
          connection.host ||
          connection.relay ||
          '';
        return { uri: uri ? String(uri) : '' };
      })
      .filter(Boolean);

  const mapDevice = (device) => {
    if (!device || typeof device !== 'object') {
      return null;
    }

    return {
      name: device.name || device.product || device.device || 'unknown',
      provides: String(device.provides || '').toLowerCase(),
      clientIdentifier: device.clientIdentifier || null,
      machineIdentifier: device.machineIdentifier || null,
      accessToken: device.accessToken || null,
      owned:
        device.owned !== undefined && device.owned !== null
          ? String(device.owned).trim().toLowerCase()
          : null,
      connections: mapConnections(device.connections || device.Connection),
    };
  };

  try {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json)) {
      return json.map(mapDevice).filter(Boolean);
    }

    const devices = json && json.MediaContainer && json.MediaContainer.Device;
    if (Array.isArray(devices)) {
      return devices.map(mapDevice).filter(Boolean);
    }
  } catch (err) {
    // fall back to XML parsing
  }

  const devices = [];
  const devicePattern = /<Device\b([^>]+)>([\s\S]*?)<\/Device>/gi;
  const attr = (source, key) => {
    const match = new RegExp(`${key}="([^"]*)"`, 'i').exec(source);
    return match ? match[1] : null;
  };
  const connectionPattern = /<Connection\b([^>]+?)\/?>(?:<\/Connection>)?/gi;

  let deviceMatch;
  while ((deviceMatch = devicePattern.exec(trimmed))) {
    const deviceAttributes = deviceMatch[1] || '';
    const inner = deviceMatch[2] || '';
    const provides = String(attr(deviceAttributes, 'provides') || '').toLowerCase();
    const clientIdentifier = attr(deviceAttributes, 'clientIdentifier');
    const machineIdentifier = attr(deviceAttributes, 'machineIdentifier');
    const name =
      attr(deviceAttributes, 'name') ||
      attr(deviceAttributes, 'product') ||
      attr(deviceAttributes, 'device') ||
      'unknown';
    const accessToken = attr(deviceAttributes, 'accessToken');
    const ownedAttr = attr(deviceAttributes, 'owned');

    const connections = [];
    let connectionMatch;
    while ((connectionMatch = connectionPattern.exec(inner))) {
      const connectionAttributes = connectionMatch[1] || '';
      const uri =
        attr(connectionAttributes, 'uri') ||
        attr(connectionAttributes, 'address') ||
        attr(connectionAttributes, 'host') ||
        attr(connectionAttributes, 'relay') ||
        '';
      connections.push({ uri: uri ? String(uri) : '' });
    }

    devices.push({
      name,
      provides,
      clientIdentifier,
      machineIdentifier,
      accessToken,
      owned: ownedAttr ? ownedAttr.toLowerCase() : null,
      connections,
    });
  }

  return devices;
}

async function fetchPlexResources(plex) {
  const headers = buildPlexClientHeaders(getClientIdentifier(plex), {
    'X-Plex-Token': plex.token,
  });
  delete headers['Content-Type'];
  delete headers.Accept;

  const url = buildPlexTvUrl('/api/resources?includeHttps=1&includeRelay=1', plex);
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`Failed to fetch Plex resources: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to fetch Plex resources: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  return parseResourcesPayload(payload);
}

function detectServerFromResources(resources, baseUrlHost) {
  const entries = Array.isArray(resources) ? resources : [];
  const serverDevices = entries.filter((device) => {
    if (!device || typeof device !== 'object') {
      return false;
    }

    return String(device.provides || '').includes('server');
  });

  if (!serverDevices.length) {
    return null;
  }

  if (baseUrlHost) {
    for (const device of serverDevices) {
      if (!device || !Array.isArray(device.connections)) {
        continue;
      }

      const hasMatch = device.connections.some((connection) => {
        if (!connection || !connection.uri) {
          return false;
        }
        return hostFromUrl(connection.uri) === baseUrlHost;
      });

      if (hasMatch && device.clientIdentifier) {
        return { type: 'clientIdentifier', value: device.clientIdentifier, source: device };
      }
    }
  }

  if (serverDevices.length === 1) {
    const device = serverDevices[0];
    if (device && device.clientIdentifier) {
      return { type: 'clientIdentifier', value: device.clientIdentifier, source: device };
    }
  }

  return { type: 'ambiguous', candidates: serverDevices };
}

async function fetchPlexServers(plex) {
  const headers = buildPlexClientHeaders(getClientIdentifier(plex), {
    'X-Plex-Token': plex.token,
  });
  delete headers['Content-Type'];
  delete headers.Accept;

  let response;
  try {
    response = await fetch(buildPlexTvUrl('/api/servers', plex), { headers });
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
  return parseServerListPayload(payload);
}

function detectServerFromServers(servers) {
  const list = Array.isArray(servers) ? servers.filter(Boolean) : [];
  if (list.length === 1) {
    const entry = list[0];
    const value = entry.machineIdentifier || entry.clientIdentifier || null;
    if (value) {
      return { type: 'machineIdentifier', value, source: entry };
    }
  }

  return null;
}

async function getOrResolveServerIdentifier(plex) {
  if (plex && plex.serverIdentifier) {
    const normalized = normalizeId(plex.serverIdentifier);
    if (normalized) {
      return String(plex.serverIdentifier).trim();
    }
  }

  const baseUrlHost = hostFromUrl(plex && plex.baseUrl);

  try {
    const resources = await fetchPlexResources(plex);
    const detected = detectServerFromResources(resources, baseUrlHost);
    if (detected && detected.type === 'clientIdentifier' && detected.value) {
      const normalized = normalizeId(detected.value);
      if (normalized) {
        return String(detected.value).trim();
      }
    }

    if (detected && detected.type === 'ambiguous') {
      // fall through to /api/servers to disambiguate
    }
  } catch (err) {
    // Ignore and fall back to /api/servers
  }

  try {
    const servers = await fetchPlexServers(plex);
    const detected = detectServerFromServers(servers);
    if (detected && detected.value) {
      const normalized = normalizeId(detected.value);
      if (normalized) {
        return String(detected.value).trim();
      }
    }

    const sample = summarizeServerIdentifiers(servers, 5);
    if (sample.length > 1) {
      throw new Error(
        `Multiple Plex servers found; set \"serverIdentifier\" or provide \"baseUrl\" to disambiguate. Candidates: ${JSON.stringify(
          sample
        )}`
      );
    }
  } catch (err) {
    throw new Error(`Failed to auto-detect Plex server identifier: ${err.message}`);
  }

  throw new Error('Failed to auto-detect Plex server identifier: No matching server found.');
}

function findServerMatch(servers, normalizedIdentifier) {
  if (!Array.isArray(servers) || !servers.length) {
    return null;
  }

  const matches = (value) => {
    const normalized = normalizeId(value);
    return normalized && normalized === normalizedIdentifier;
  };

  for (const server of servers) {
    if (!server || typeof server !== 'object') {
      continue;
    }

    const candidates = [
      server.machineIdentifier,
      server.clientIdentifier,
      server.uuid,
      server.id,
      server.server_id,
      server.serverId,
      server.serverID,
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
  const descriptor = await resolveServerDescriptor(plex);
  if (!descriptor.legacyNumericId) {
    const sample = summarizeServerIdentifiers([
      {
        name: descriptor.name,
        machineIdentifier: descriptor.machineIdentifier,
        id: descriptor.legacyNumericId,
      },
    ]);
    throw new Error(
      `Matched server but no numeric "id" field was found to use with the invite API. Matched: ${JSON.stringify(
        sample
      )}`
    );
  }

  return descriptor.legacyNumericId;
}

async function resolveServerDescriptor(plex) {
  if (!plex || !plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const machineIdentifier = String(plex.serverIdentifier).trim();
  if (!machineIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const cacheKey = getServerIdCacheKey(plex);
  if (cacheKey && serverDescriptorCache.has(cacheKey)) {
    return serverDescriptorCache.get(cacheKey);
  }

  const normalizedIdentifier = normalizeId(machineIdentifier);
  if (!normalizedIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  let resources;
  try {
    resources = await fetchPlexResources(plex);
  } catch (err) {
    throw new Error(`Failed to resolve Plex server via /api/resources: ${err.message}`);
  }

  const serversFromResources = Array.isArray(resources)
    ? resources.filter((device) => {
        if (!device || typeof device !== 'object') {
          return false;
        }

        return String(device.provides || '').toLowerCase().includes('server');
      })
    : [];

  if (!serversFromResources.length) {
    throw new Error(
      'No Plex servers were returned from /api/resources. Confirm the token owns the server and that it is published.'
    );
  }

  const ownedServers = serversFromResources.filter((device) => {
    const ownedValue = device.owned;
    if (ownedValue === undefined || ownedValue === null) {
      return false;
    }

    const normalized = String(ownedValue).trim().toLowerCase();
    return ownedValue === true || ownedValue === 1 || normalized === '1' || normalized === 'true' || normalized === 'yes';
  });

  if (!ownedServers.length) {
    const sample = summarizeServerIdentifiers(serversFromResources, 5);
    throw new Error(
      `/api/resources did not return any owned Plex servers. Ensure the server is claimed by this account. Servers=${JSON.stringify(sample)}`
    );
  }

  const candidates = ownedServers;
  let matchedDevice = candidates.find((device) => {
    const possible = [device.clientIdentifier, device.machineIdentifier];
    return possible.some((value) => normalizeId(value) === normalizedIdentifier);
  });

  if (!matchedDevice && candidates.length === 1) {
    matchedDevice = candidates[0];
  }

  if (!matchedDevice) {
    const sample = candidates.slice(0, 5).map((device) => ({
      name: device.name || 'unknown',
      clientIdentifier: device.clientIdentifier || null,
      owned: device.owned || null,
    }));
    throw new Error(
      `Plex server identifier "${machineIdentifier}" was not found in /api/resources. Owned servers: ${JSON.stringify(sample)}`
    );
  }

  if (matchedDevice.owned !== undefined && matchedDevice.owned !== null) {
    const normalizedOwned = String(matchedDevice.owned).trim().toLowerCase();
    const isOwned =
      matchedDevice.owned === true ||
      matchedDevice.owned === 1 ||
      normalizedOwned === '1' ||
      normalizedOwned === 'true' ||
      normalizedOwned === 'yes';

    if (!isOwned) {
      throw new Error(
        `Plex token does not own server "${matchedDevice.name || 'unknown'}". Ensure the PMS is claimed by this account.`
      );
    }
  }

  let legacyNumericId = null;
  try {
    const servers = await fetchPlexServers(plex);
    const match =
      findServerMatch(servers, normalizedIdentifier) ||
      findServerMatch(
        Array.isArray(servers)
          ? servers.filter((server) =>
              server && typeof server === 'object'
                ? String(server.provides || '').toLowerCase().includes('server')
                : false
            )
          : [],
        normalizedIdentifier
      );

    if (match && match.id != null) {
      legacyNumericId = String(match.id).trim();
    } else if (match && match.server_id != null) {
      legacyNumericId = String(match.server_id).trim();
    } else if (match && match.serverId != null) {
      legacyNumericId = String(match.serverId).trim();
    }
  } catch (err) {
    // Ignore failure; legacy id is only required for fallback paths.
  }

  const descriptor = {
    machineIdentifier: matchedDevice.clientIdentifier
      ? String(matchedDevice.clientIdentifier).trim()
      : machineIdentifier,
    legacyNumericId: legacyNumericId || null,
    name: matchedDevice.name || 'unknown',
    clientIdentifier: matchedDevice.clientIdentifier || null,
    device: matchedDevice,
  };

  if (cacheKey) {
    serverDescriptorCache.set(cacheKey, descriptor);
  }

  return descriptor;
}

async function buildSharedServersPath(plex) {
  if (!plex || !plex.serverIdentifier) {
    throw new Error('Plex server UUID must be configured to create invites');
  }

  const serverId = await resolveServerId(plex);
  return LEGACY_SHARED_SERVERS_PATH(serverId);
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

function normalizeSectionKeyParts(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) {
    return { raw: '', sanitized: '', numeric: '' };
  }

  const sanitized = raw.split(/[?#]/)[0].replace(/\/+$/, '');
  const numericMatch = sanitized.match(/(?:^|\/)(\d+)$/);
  const numeric = numericMatch && numericMatch[1] ? numericMatch[1] : '';

  return { raw, sanitized: sanitized || raw, numeric };
}

function parseServerSectionsPayload(payload) {
  if (!payload) {
    return { sectionIds: [], keyToIdMap: {} };
  }

  const sectionIds = new Set();
  const keyToIdMap = new Map();

  const addSectionId = (value) => {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = String(value).trim();
    if (!normalized) {
      return null;
    }

    sectionIds.add(normalized);
    return normalized;
  };

  const recordKeyMapping = (keyCandidate, idValue) => {
    if (idValue === undefined || idValue === null) {
      return;
    }

    const normalizedId = String(idValue).trim();
    if (!normalizedId) {
      return;
    }

    const parts = normalizeSectionKeyParts(keyCandidate);
    if (!parts.raw) {
      return;
    }

    keyToIdMap.set(parts.raw, normalizedId);
    if (parts.sanitized && parts.sanitized !== parts.raw) {
      keyToIdMap.set(parts.sanitized, normalizedId);
    }
    if (parts.numeric) {
      keyToIdMap.set(parts.numeric, normalizedId);
    }
  };

  const pushSectionLike = (section) => {
    if (!section) {
      return;
    }

    if (typeof section === 'object') {
      const hasExplicitId = Object.prototype.hasOwnProperty.call(section, 'id');
      const idValue = hasExplicitId ? section.id : section.ID;
      const hasUsableId =
        idValue !== undefined && idValue !== null && String(idValue).trim() !== '';

      const normalizedId = hasUsableId ? addSectionId(idValue) : null;

      const keyCandidate =
        Object.prototype.hasOwnProperty.call(section, 'key')
          ? section.key
          : Object.prototype.hasOwnProperty.call(section, 'Key')
          ? section.Key
          : undefined;

      if (normalizedId) {
        recordKeyMapping(keyCandidate, normalizedId);
      } else if (keyCandidate !== undefined) {
        const keyParts = normalizeSectionKeyParts(keyCandidate);
        if (keyParts.numeric) {
          const fallbackId = addSectionId(keyParts.numeric);
          if (fallbackId) {
            recordKeyMapping(keyCandidate, fallbackId);
          }
        }
      }

      return;
    }

    const fallbackId = addSectionId(section);
    if (fallbackId) {
      recordKeyMapping(section, fallbackId);
    }
  };

  try {
    const data = JSON.parse(payload);
    if (data && typeof data === 'object') {
      const container = data.MediaContainer || data.mediaContainer || data.container || data;
      const servers = coerceArray(
        (container && (container.Server || container.server)) ||
          (container && (container.Servers || container.servers)) ||
          []
      );

      servers.forEach((server) => {
        const sections = coerceArray(
          (server && (server.Section || server.section)) ||
            (server && (server.Sections || server.sections)) ||
            (server && (server.Directory || server.directory)) ||
            (server && (server.Metadata || server.metadata)) ||
            []
        );

        sections.forEach((section) => {
          pushSectionLike(section);
        });
      });
    }
  } catch (err) {
    // Ignore JSON parsing errors and fall back to XML parsing.
  }

  const pattern = /<Section\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const attributes = {};
    match[0].replace(/([\w-]+)="([^"]*)"/g, (_, attribute, value) => {
      attributes[String(attribute || '').toLowerCase()] = value;
      return '';
    });
    pushSectionLike({
      id: attributes.id,
      key: attributes.key,
    });
  }

  const normalizedKeyToIdMap = Object.fromEntries(
    Array.from(keyToIdMap.entries()).map(([key, value]) => [String(key), String(value)])
  );

  const normalizedSectionIds = Array.from(sectionIds).map((id) => String(id));
  normalizedSectionIds.forEach((id) => {
    normalizedKeyToIdMap[id] = id;
  });

  const mapValues = Object.values(normalizedKeyToIdMap);
  const uniqueMapValues = Array.from(new Set(mapValues));
  const finalSectionIds = normalizedSectionIds.length
    ? normalizedSectionIds
    : uniqueMapValues;

  return {
    sectionIds: finalSectionIds,
    keyToIdMap: normalizedKeyToIdMap,
  };
}

async function fetchSectionKeysFromPlexServer(plex, descriptor) {
  if (!descriptor || !descriptor.device) {
    throw new Error('Unable to determine Plex server details from /api/resources.');
  }

  const machineIdentifier =
    descriptor.device?.clientIdentifier || descriptor.machineIdentifier || plex.serverIdentifier;

  if (!machineIdentifier) {
    throw new Error('Unable to determine Plex server machine identifier from /api/resources.');
  }

  const path = `/api/servers/${encodeURIComponent(String(machineIdentifier))}`;
  const url = buildPlexTvUrl(path, plex);

  let response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new Error(`Failed to query Plex library sections from ${url}: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const statusText = response.statusText || 'Error';
    throw new Error(
      `Failed to query Plex library sections from ${url}: ${response.status} (${statusText})`
    );
  }

  const body = await response.text();
  const { sectionIds, keyToIdMap } = parseServerSectionsPayload(body);

  const normalizedSectionIds = Array.from(new Set(sectionIds.map((id) => String(id).trim()))).filter(
    Boolean
  );

  const fallbackSectionIds =
    normalizedSectionIds.length > 0
      ? normalizedSectionIds
      : Array.from(
          new Set(
            Object.values(keyToIdMap || {}).map((value) => String(value).trim()).filter(Boolean)
          )
        );

  if (!fallbackSectionIds.length) {
    throw new Error(
      'Plex did not return any library sections for the selected server; verify the server is reachable and published.'
    );
  }

  return {
    sectionIds: fallbackSectionIds,
    keyToIdMap: keyToIdMap || {},
  };
}

function resolveSectionSelectionId(rawValue, availableIdsSet, keyToIdMap = {}) {
  const parts = normalizeSectionKeyParts(rawValue);
  const candidates = [parts.raw, parts.sanitized, parts.numeric].filter(Boolean);

  for (const candidate of candidates) {
    if (availableIdsSet.has(candidate)) {
      return candidate;
    }

    const mapped = keyToIdMap[candidate];
    if (mapped !== undefined && mapped !== null) {
      const normalizedMapped = String(mapped).trim();
      if (!normalizedMapped) {
        continue;
      }

      if (availableIdsSet.has(normalizedMapped)) {
        return normalizedMapped;
      }

      const mappedParts = normalizeSectionKeyParts(normalizedMapped);
      if (mappedParts.raw && availableIdsSet.has(mappedParts.raw)) {
        return mappedParts.raw;
      }

      if (mappedParts.numeric && availableIdsSet.has(mappedParts.numeric)) {
        return mappedParts.numeric;
      }

      return normalizedMapped;
    }
  }

  return null;
}

async function resolveInvitedIdByEmail(plex, email) {
  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    return null;
  }

  const params = new URLSearchParams({ invitedEmail: normalizedEmail });
  const url = buildPlexTvUrl(`/api/home/users?${params.toString()}`, plex);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(
      `Failed to resolve Plex invitedId via /api/home/users: ${err.message}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const statusText = response.statusText || 'Error';
    const details = await extractErrorMessage(response);
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to resolve Plex invitedId via /api/home/users: ${response.status} (${statusText})${suffix}`
    );
  }

  const payload = await response.text();
  const invitedId = parseInvitedIdFromHomeUsersPayload(payload, normalizedEmail);
  if (invitedId) {
    return invitedId;
  }

  try {
    const { users } = await fetchUsersList(plex);
    const normalized = normalize(normalizedEmail);
    for (const user of coerceArray(users)) {
      if (!user || typeof user !== 'object') {
        continue;
      }

      const candidates = [user];
      if (user.account && typeof user.account === 'object') {
        candidates.push(user.account);
      }

      const hasMatch = candidates.some((entry) =>
        matchesEmail(entry, normalizedEmail) ||
        normalize(getCaseInsensitive(entry, 'email')) === normalized
      );

      if (!hasMatch) {
        continue;
      }

      for (const entry of candidates) {
        const id = extractIdFromCandidate(entry);
        if (id) {
          return id;
        }
      }

      const fallbackId = extractIdFromCandidate(user);
      if (fallbackId) {
        return fallbackId;
      }
    }
  } catch (err) {
    throw new Error(
      `Unable to determine Plex invitedId for ${normalizedEmail}: ${err.message}`
    );
  }

  return null;
}

function getCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }

  const target = String(key || '').toLowerCase();
  for (const entryKey of Object.keys(obj)) {
    if (String(entryKey || '').toLowerCase() === target) {
      return obj[entryKey];
    }
  }

  const attributes = obj.attributes || obj.$;
  if (attributes && typeof attributes === 'object') {
    return getCaseInsensitive(attributes, key);
  }

  return undefined;
}

function extractIdFromCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  for (const key of HOME_USER_ID_KEYS) {
    const value = getCaseInsensitive(candidate, key);
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function collectHomeUserCandidates(node, accumulator, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) {
    return;
  }

  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach((entry) => collectHomeUserCandidates(entry, accumulator, seen));
    return;
  }

  const keys = Object.keys(node).map((entry) => String(entry || '').toLowerCase());
  const looksLikeUser = keys.some((entry) =>
    entry.includes('user') || entry.includes('account') || entry.includes('email')
  );

  if (looksLikeUser) {
    accumulator.add(node);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectHomeUserCandidates(value, accumulator, seen);
    }
  }
}

function parseInvitedIdFromHomeUsersPayload(payload, email) {
  if (!payload) {
    return null;
  }

  const candidateSet = new Set();
  try {
    const data = JSON.parse(payload);
    collectHomeUserCandidates(data, candidateSet);
  } catch (err) {
    // Ignore JSON parsing errors and fall back to regex/XML parsing below.
  }

  const candidates = Array.from(candidateSet);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const relatedCandidates = [candidate];
    const account = getCaseInsensitive(candidate, 'account');
    if (account && typeof account === 'object') {
      relatedCandidates.push(account);
    }
    const user = getCaseInsensitive(candidate, 'user');
    if (user && typeof user === 'object') {
      relatedCandidates.push(user);
    }

    const matches = relatedCandidates.some((entry) => matchesEmail(entry, email));
    const invitedEmailCandidate = getCaseInsensitive(candidate, 'invitedEmail');
    const invitedEmailMatch =
      invitedEmailCandidate && normalize(invitedEmailCandidate) === normalize(email);

    if (!matches && !invitedEmailMatch) {
      continue;
    }

    for (const entry of relatedCandidates) {
      const id = extractIdFromCandidate(entry);
      if (id) {
        return id;
      }
    }

    const fallbackId = extractIdFromCandidate(candidate);
    if (fallbackId) {
      return fallbackId;
    }
  }

  const jsonRegexes = [
    /"invited(?:Id|_id)"\s*:\s*"([^"]+)"/i,
    /"invited(?:Id|_id)"\s*:\s*([\w:-]+)/i,
  ];

  for (const regex of jsonRegexes) {
    const match = regex.exec(payload);
    if (match && match[1]) {
      const normalized = String(match[1]).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  const pattern = /<(?:User|HomeUser)\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(payload))) {
    const tag = match[0];
    const attributes = {};
    tag.replace(/([\w:-]+)="([^"]*)"/g, (_, attribute, value) => {
      attributes[String(attribute || '').toLowerCase()] = value;
      return '';
    });

    const emails = HOME_USER_EMAIL_KEYS.map((key) => attributes[key]).filter(Boolean);
    const emailMatch =
      emails.some((entry) => normalize(entry) === normalize(email)) ||
      normalize(attributes.email) === normalize(email);

    if (!emailMatch) {
      continue;
    }

    for (const key of HOME_USER_ID_KEYS) {
      const value = attributes[key];
      if (value !== undefined && value !== null) {
        const normalized = String(value).trim();
        if (normalized) {
          return normalized;
        }
      }
    }
  }

  return null;
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
  ensureBaseConfiguration(plex);

  plex.serverIdentifier = await getOrResolveServerIdentifier(plex);
  ensureInviteConfiguration(plex);

  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    throw new Error('Recipient email is required to create Plex invites');
  }

  const descriptor = await resolveServerDescriptor(plex);
  const machineIdentifierCandidates = [];
  for (const candidate of [
    descriptor.device?.clientIdentifier,
    descriptor.device?.machineIdentifier,
    descriptor.machineIdentifier,
    plex.serverIdentifier,
  ]) {
    const normalizedCandidate =
      candidate === undefined || candidate === null ? '' : String(candidate).trim();
    if (!normalizedCandidate) {
      continue;
    }
    if (!machineIdentifierCandidates.includes(normalizedCandidate)) {
      machineIdentifierCandidates.push(normalizedCandidate);
    }
  }

  const machineIdentifier = machineIdentifierCandidates[0];

  if (!machineIdentifier) {
    throw new Error('Unable to determine Plex machine identifier for invites');
  }

  const requestedSections = parseLibrarySectionIds(
    librarySectionIds !== undefined ? librarySectionIds : plex.librarySectionIds
  ).map((id) => String(id));

  const { sectionIds: availableSectionIds, keyToIdMap } = await fetchSectionKeysFromPlexServer(
    plex,
    descriptor
  );

  const normalizedAvailableSectionIds = Array.from(
    new Set(availableSectionIds.map((id) => String(id).trim()))
  ).filter(Boolean);
  const availableSectionIdsSet = new Set(normalizedAvailableSectionIds);

  const translatedRequestedSections = requestedSections
    .map((id) => {
      const normalized = id === undefined || id === null ? '' : String(id).trim();
      if (!normalized) {
        return null;
      }

      const resolved =
        resolveSectionSelectionId(normalized, availableSectionIdsSet, keyToIdMap) || normalized;
      const normalizedResolved = String(resolved).trim();

      return normalizedResolved || null;
    })
    .filter(Boolean);

  const resolvedRequestedSections = Array.from(
    new Set(
      translatedRequestedSections.filter((id) => availableSectionIdsSet.has(id))
    )
  );

  const fallbackSectionIds =
    normalizedAvailableSectionIds.length > 0
      ? normalizedAvailableSectionIds
      : Array.from(
          new Set(
            Object.values(keyToIdMap || {}).map((value) => String(value).trim()).filter(Boolean)
          )
        );

  const hasRequestedSections = requestedSections.length > 0;
  const finalSectionIds = hasRequestedSections
    ? resolvedRequestedSections
    : fallbackSectionIds;

  const availableForMessage =
    normalizedAvailableSectionIds.length > 0
      ? normalizedAvailableSectionIds
      : fallbackSectionIds;

  if (!finalSectionIds.length) {
    throw new Error(
      `None of the requested librarySectionIds exist on the Plex server. Requested=${JSON.stringify(
        requestedSections
      )} Available=${JSON.stringify(availableForMessage)}`
    );
  }

  const sharedHeaders = buildSharedServerHeaders(plex, {
    'Content-Type': 'application/json',
  });

  const normalizedFriendlyName = friendlyName ? String(friendlyName).trim() : '';

  const invitedId = await resolveInvitedIdByEmail(plex, normalizedEmail);
  if (!invitedId) {
    throw new Error(
      `Plex did not return an invitedId for ${normalizedEmail}; verify the user has logged into Plex at least once.`
    );
  }

  const v2Body = {
    machineIdentifier,
    librarySectionIds: finalSectionIds,
    invitedId,
    invitedEmail: normalizedEmail,
    ...(normalizedFriendlyName ? { friendlyName: normalizedFriendlyName } : {}),
    settings: {
      allowSync: to01(plex?.allowSync),
      allowCameraUpload: to01(plex?.allowCameraUpload),
      allowChannels: to01(plex?.allowChannels),
    },
  };

  const v2Url =
    `https://plex.tv${V2_SHARED_SERVERS_PATH}?` +
    new URLSearchParams({ 'X-Plex-Token': plex.token }).toString();

  let response;
  try {
    response = await fetch(v2Url, {
      method: 'POST',
      headers: sharedHeaders,
      body: JSON.stringify(v2Body),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    const details = await extractErrorMessage(response);
    const suffix = details ? ` Details: ${details}` : '';
    throw new Error(`Plex rejected the provided token.${suffix}`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const statusText = response.statusText || 'Error';
    const suffix = bodyText ? `: ${bodyText}` : '';
    throw new Error(
      `Plex invite creation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    const details = await extractErrorMessage(response);
    const suffix = details ? `: ${details}` : '';
    throw new Error(`Plex rejected the provided token${suffix}`);
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Plex invite creation failed with ${response.status} (${statusText})${suffix}`
    );
  }

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

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
  ensureBaseConfiguration(plex);

  plex.serverIdentifier = await getOrResolveServerIdentifier(plex);
  ensureInviteConfiguration(plex);

  const descriptor = await resolveServerDescriptor(plex);
  if (!descriptor.legacyNumericId) {
    throw new Error(
      'Plex did not return a legacy numeric server id; cancelling invites is not supported via this token.'
    );
  }

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
  ensureBaseConfiguration(plex);

  plex.serverIdentifier = await getOrResolveServerIdentifier(plex);
  ensureInviteConfiguration(plex);

  const sections = parseLibrarySectionIds(plex.librarySectionIds);

  let inviteEndpointAvailable = true;
  let inviteEndpointVersion = 'legacy';
  let descriptor;

  try {
    descriptor = await resolveServerDescriptor(plex);
  } catch (err) {
    throw new Error(`Failed to verify Plex invite configuration: ${err.message}`);
  }

  if (descriptor.legacyNumericId) {
    inviteEndpointVersion = 'legacy';

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
  } else {
    inviteEndpointVersion = 'v2';
    inviteEndpointAvailable = true;
  }

  const { sectionIds: availableSectionIds, keyToIdMap } = await fetchSectionKeysFromPlexServer(
    plex,
    descriptor
  );
  const normalizedAvailableSectionIds = Array.from(
    new Set(availableSectionIds.map((id) => String(id).trim()))
  ).filter(Boolean);
  const fallbackAvailableSectionIds =
    normalizedAvailableSectionIds.length > 0
      ? normalizedAvailableSectionIds
      : Array.from(
          new Set(
            Object.values(keyToIdMap || {}).map((value) => String(value).trim()).filter(Boolean)
          )
        );
  const availableSectionIdsSet = new Set(fallbackAvailableSectionIds);

  const migratedConfiguredSections = sections
    .map((id) => {
      const normalized = id === undefined || id === null ? '' : String(id).trim();
      if (!normalized) {
        return null;
      }
      return (
        resolveSectionSelectionId(normalized, availableSectionIdsSet, keyToIdMap) || normalized
      );
    })
    .filter(Boolean);

  const libraries = await fetchLibrarySections(plex);
  if (!libraries.length) {
    throw new Error(
      'No Plex libraries were found. Confirm the token has access to your server.'
    );
  }

  const remappedLibraries = [];
  const seenLibraryIds = new Set();
  libraries.forEach((library) => {
    if (!library || typeof library !== 'object') {
      return;
    }

    const rawId = library.id === undefined || library.id === null ? '' : String(library.id).trim();
    const resolvedId =
      resolveSectionSelectionId(rawId, availableSectionIdsSet, keyToIdMap) || rawId;
    const normalizedId = resolvedId ? String(resolvedId).trim() : '';

    if (!normalizedId) {
      return;
    }

    if (seenLibraryIds.has(normalizedId)) {
      return;
    }

    seenLibraryIds.add(normalizedId);
    remappedLibraries.push({ ...library, id: normalizedId });
  });

  return {
    message: 'Plex invite configuration verified successfully.',
    details: {
      serverIdentifier: plex.serverIdentifier,
      librarySectionIds: migratedConfiguredSections,
      inviteEndpointAvailable,
      inviteEndpointVersion,
    },
    libraries: remappedLibraries,
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
  getOrResolveServerIdentifier,
};
