const fetch = require('node-fetch');
const { getPlexSettings } = require('../state/settings');

const USER_LIST_ENDPOINTS = ['/accounts', '/api/v2/home/users', '/api/home/users'];
const INVITE_ENDPOINT = '/api/v2/home/invitations';
const DEFAULT_INVITE_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};
const userListPathCache = new Map();

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

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return Boolean(fallback);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return Boolean(value);
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

function buildInviteRequestBody({
  plex,
  email,
  friendlyName,
  librarySectionIds,
  allowSync,
  allowCameraUpload,
  allowChannels,
}) {
  const sections = parseLibrarySectionIds(
    librarySectionIds !== undefined ? librarySectionIds : plex.librarySectionIds
  );

  if (!sections.length) {
    throw new Error('At least one Plex library section ID must be configured');
  }

  const payload = {
    email,
    server: {
      uuid: plex.serverIdentifier,
    },
    settings: {
      allowSync: normalizeBoolean(
        allowSync !== undefined ? allowSync : plex.allowSync
      ),
      allowCameraUpload: normalizeBoolean(
        allowCameraUpload !== undefined ? allowCameraUpload : plex.allowCameraUpload
      ),
      allowChannels: normalizeBoolean(
        allowChannels !== undefined ? allowChannels : plex.allowChannels
      ),
    },
    libraries: sections.map((id) => ({ id })),
  };

  if (friendlyName) {
    payload.friendlyName = friendlyName;
  }

  return payload;
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
  {
    email,
    friendlyName,
    librarySectionIds,
    allowSync,
    allowCameraUpload,
    allowChannels,
  } = {},
  overrideSettings
) {
  const plex = getPlexConfig(overrideSettings);
  ensureInviteConfiguration(plex);

  const normalizedEmail = email ? String(email).trim() : '';
  if (!normalizedEmail) {
    throw new Error('Recipient email is required to create Plex invites');
  }

  const requestBody = buildInviteRequestBody({
    plex,
    email: normalizedEmail,
    friendlyName,
    librarySectionIds,
    allowSync,
    allowCameraUpload,
    allowChannels,
  });

  let response;
  try {
    response = await fetch(buildUrlFromConfig(INVITE_ENDPOINT, plex), {
      method: 'POST',
      headers: DEFAULT_INVITE_HEADERS,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
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

  const encodedId = encodeURIComponent(String(inviteId));

  let response;
  try {
    response = await fetch(
      buildUrlFromConfig(`${INVITE_ENDPOINT}/${encodedId}`, plex),
      {
        method: 'DELETE',
        headers: DEFAULT_INVITE_HEADERS,
      }
    );
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (response.status === 404) {
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
  if (!sections.length) {
    throw new Error('At least one Plex library section ID must be configured');
  }

  let response;
  try {
    response = await fetch(buildUrlFromConfig(INVITE_ENDPOINT, plex), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`Failed to connect to Plex invite API: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided token.');
  }

  if (!response.ok) {
    const details = await extractErrorMessage(response);
    const statusText = response.statusText || 'Error';
    const suffix = details ? `: ${details}` : '';
    throw new Error(
      `Failed to verify Plex invite configuration: ${response.status} (${statusText})${suffix}`
    );
  }

  return {
    message: 'Plex invite configuration verified successfully.',
    details: {
      serverIdentifier: plex.serverIdentifier,
      librarySectionIds: sections,
    },
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
