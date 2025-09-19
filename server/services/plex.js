const fetch = require('node-fetch');
const { getPlexSettings } = require('../state/settings');

const HOME_USERS_NOT_FOUND_ERROR_CODE = 'PLEX_HOME_USERS_NOT_FOUND';

const USER_ENDPOINTS = [
  {
    path: '/api/v2/home/users',
    managementPath: '/api/v2/home/users',
    parse: parseJsonUsersResponse,
  },
  {
    path: '/api/home/users',
    managementPath: '/api/home/users',
    parse: parseJsonUsersResponse,
  },
  {
    path: '/accounts',
    managementPath: null,
    parse: parseAccountsUsersResponse,
  },
];

const USER_REQUEST_HEADERS = {
  Accept: 'application/json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
};

const userEndpointCache = new Map();

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

function formatEndpointList(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return '';
  }
  if (paths.length === 1) {
    return paths[0];
  }
  return `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

function pickFirstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
      continue;
    }
    return candidate;
  }
  return null;
}

function toArray(value) {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'object') {
    return [value];
  }
  return [];
}

function extractUsersFromData(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== 'object') {
    return null;
  }

  const directKeys = ['users', 'Users', 'accounts', 'Accounts', 'user', 'User'];

  for (const key of directKeys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return toArray(data[key]);
    }
  }

  if (data.MediaContainer && typeof data.MediaContainer === 'object') {
    const container = data.MediaContainer;
    const containerKeys = ['Account', 'User', 'accounts', 'Users', 'users'];
    for (const key of containerKeys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) {
        return toArray(container[key]);
      }
    }
  }

  return null;
}

function normalizeAccountLikeUser(user) {
  if (!user || typeof user !== 'object') {
    return user;
  }

  const accountData =
    user.account && typeof user.account === 'object' ? user.account : {};

  const id = pickFirstNonEmpty(
    user.id,
    user.accountID,
    user.uuid,
    user.userID,
    user.machineIdentifier,
    accountData.id,
    accountData.uuid,
    accountData.machineIdentifier
  );

  const uuid = pickFirstNonEmpty(
    user.uuid,
    user.machineIdentifier,
    accountData.uuid,
    accountData.machineIdentifier,
    id
  );

  const email =
    pickFirstNonEmpty(user.email, user.userEmail, accountData.email) || '';

  const username =
    pickFirstNonEmpty(
      user.username,
      user.name,
      user.title,
      accountData.username,
      accountData.name,
      accountData.title,
      email
    ) || '';

  const title =
    pickFirstNonEmpty(
      user.title,
      user.name,
      accountData.title,
      accountData.name,
      username,
      email
    ) || '';

  const machineIdentifier = pickFirstNonEmpty(
    user.machineIdentifier,
    user.uuid,
    accountData.machineIdentifier,
    accountData.uuid,
    id
  );

  const normalizedAccount = {
    ...accountData,
    id:
      pickFirstNonEmpty(
        accountData.id,
        accountData.accountID,
        user.accountID,
        id,
        uuid,
        machineIdentifier
      ) ?? accountData.id ?? null,
    email,
    username,
    title,
  };

  if (accountData.thumb || user.thumb) {
    normalizedAccount.thumb = accountData.thumb || user.thumb;
  }

  return {
    ...user,
    id: id ?? user.id ?? null,
    uuid: uuid ?? user.uuid ?? null,
    email,
    username,
    title,
    machineIdentifier:
      machineIdentifier ?? user.machineIdentifier ?? null,
    account: normalizedAccount,
  };
}

async function parseJsonUsersResponse(response, endpoint) {
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(
      `Failed to parse Plex response from ${endpoint.path} as JSON: ${err.message}`
    );
  }

  const users = extractUsersFromData(data);
  if (users === null) {
    throw new Error(`Unexpected Plex response format from ${endpoint.path}.`);
  }

  return users.map((user) => normalizeAccountLikeUser(user));
}

async function parseAccountsUsersResponse(response, endpoint) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json') || contentType.includes('text/json')) {
    try {
      const data = await response.clone().json();
      const users = extractUsersFromData(data);
      if (users !== null) {
        return users.map((user) => normalizeAccountLikeUser(user));
      }
    } catch (err) {
      // Fall through to attempt XML/text parsing.
    }
  }

  const body = await response.text();
  const trimmed = body.trim();
  if (!trimmed) {
    return [];
  }

  const accounts = [];
  const accountRegex = /<Account\b([^>]*)>/gi;
  let match;
  while ((match = accountRegex.exec(trimmed))) {
    const attributes = parseXmlAttributes(match[1]);
    if (Object.keys(attributes).length === 0) {
      continue;
    }
    accounts.push(mapAccountAttributesToUser(attributes));
  }

  if (accounts.length === 0) {
    throw new Error(`Unexpected Plex response format from ${endpoint.path}.`);
  }

  return accounts.map((user) => normalizeAccountLikeUser(user));
}

function parseXmlAttributes(attributeString) {
  const attributes = {};
  if (!attributeString) {
    return attributes;
  }

  const attributeRegex = /([A-Za-z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = attributeRegex.exec(attributeString))) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }

  return attributes;
}

function decodeXmlEntities(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }

  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function mapAccountAttributesToUser(attributes) {
  const id = pickFirstNonEmpty(
    attributes.id,
    attributes.accountID,
    attributes.uuid,
    attributes.machineIdentifier
  );

  const uuid = pickFirstNonEmpty(
    attributes.uuid,
    attributes.machineIdentifier,
    id
  );

  const email = attributes.email ? attributes.email.trim() : '';
  const username =
    pickFirstNonEmpty(
      attributes.username,
      attributes.name,
      attributes.title,
      email
    ) || '';

  const title =
    pickFirstNonEmpty(attributes.title, attributes.name, username, email) || '';

  const machineIdentifier = pickFirstNonEmpty(
    attributes.machineIdentifier,
    attributes.uuid,
    id
  );

  const account = {
    id: pickFirstNonEmpty(attributes.accountID, id, uuid, machineIdentifier),
    email,
    username,
    title,
  };

  if (attributes.thumb) {
    account.thumb = attributes.thumb;
  }

  const user = {
    id: id ?? null,
    uuid: uuid ?? null,
    email,
    username,
    title,
    machineIdentifier: machineIdentifier ?? null,
    account,
  };

  if (attributes.thumb) {
    user.thumb = attributes.thumb;
  }

  if (attributes.home != null) {
    user.home = attributes.home === '1' || attributes.home === 'true';
  }

  if (attributes.restricted != null) {
    user.restricted =
      attributes.restricted === '1' || attributes.restricted === 'true';
  }

  return user;
}

async function fetchUsersList(plex) {
  const cacheKey = getCacheKey(plex);
  const preferredPath = cacheKey ? userEndpointCache.get(cacheKey) : null;
  const orderedEndpoints = preferredPath
    ? [
        ...USER_ENDPOINTS.filter((endpoint) => endpoint.path === preferredPath),
        ...USER_ENDPOINTS.filter((endpoint) => endpoint.path !== preferredPath),
      ]
    : USER_ENDPOINTS;

  const managementNotFound = [];
  let lastError = null;

  for (const endpoint of orderedEndpoints) {
    let response;
    try {
      response = await fetch(buildUrlFromConfig(endpoint.path, plex), {
        headers: USER_REQUEST_HEADERS,
      });
    } catch (err) {
      lastError = new Error(`Unable to connect to Plex server: ${err.message}`);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Plex rejected the provided token.');
    }

    if (response.status === 404) {
      if (endpoint.managementPath) {
        managementNotFound.push(endpoint.path);
      }
      if (cacheKey && userEndpointCache.get(cacheKey) === endpoint.path) {
        userEndpointCache.delete(cacheKey);
      }
      continue;
    }

    if (!response.ok) {
      const details = await extractErrorMessage(response);
      const statusText = response.statusText || 'Error';
      const suffix = details ? `: ${details}` : '';
      lastError = new Error(
        `Plex returned ${response.status} (${statusText}) for ${endpoint.path}${suffix}`
      );
      if (cacheKey && userEndpointCache.get(cacheKey) === endpoint.path) {
        userEndpointCache.delete(cacheKey);
      }
      continue;
    }

    try {
      const users = await endpoint.parse(response, endpoint);
      if (cacheKey) {
        userEndpointCache.set(cacheKey, endpoint.path);
      }
      return {
        users,
        basePath: endpoint.managementPath || null,
        endpoint: endpoint.path,
        supportsManagement: Boolean(endpoint.managementPath),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (cacheKey && userEndpointCache.get(cacheKey) === endpoint.path) {
        userEndpointCache.delete(cacheKey);
      }
    }
  }

  if (managementNotFound.length > 0) {
    const formattedPaths = formatEndpointList(managementNotFound);
    const error = new Error(
      `Plex returned 404 (Not Found) for the supported home users endpoints (${formattedPaths}). Confirm the base URL is correct and that the server supports the Plex home users API.`
    );
    error.code = HOME_USERS_NOT_FOUND_ERROR_CODE;
    throw error;
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to determine the Plex users endpoint.');
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
  if (!listResult.supportsManagement || !listResult.basePath) {
    return {
      success: false,
      reason: 'Plex home user management is unavailable on this server',
    };
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

async function verifyLibraryAccess(plex) {
  let response;
  try {
    response = await fetch(buildUrlFromConfig('/library/sections', plex), {
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
  } catch (err) {
    throw new Error(`Unable to connect to Plex server: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Plex returned ${response.status} (${statusText}) for /library/sections${suffix}`
    );
  }
}

async function verifyConnection(overrideSettings) {
  const plex = getPlexConfig(overrideSettings);
  if (!plex.baseUrl || !plex.token) {
    throw new Error('Plex base URL and token are required for testing');
  }

  try {
    const { users, supportsManagement } = await fetchUsersList(plex);
    const message = supportsManagement
      ? 'Plex connection verified successfully.'
      : 'Plex connection verified, but Plex Home user management is unavailable on this server.';
    return {
      message,
      details: {
        userCount: Array.isArray(users) ? users.length : undefined,
        homeUsersSupported: supportsManagement,
      },
    };
  } catch (err) {
    if (err && err.code === HOME_USERS_NOT_FOUND_ERROR_CODE) {
      try {
        await verifyLibraryAccess(plex);
        return {
          message:
            'Plex connection verified, but Plex Home user management is unavailable on this server.',
          details: {
            homeUsersSupported: false,
          },
        };
      } catch (fallbackErr) {
        throw new Error(`Failed to verify Plex connection: ${fallbackErr.message}`);
      }
    }

    throw new Error(`Failed to verify Plex connection: ${err.message}`);
  }
}

module.exports = {
  getPlexConfig,
  isConfigured,
  listUsers,
  revokeUser,
  revokeUserByEmail,
  verifyConnection,
};
