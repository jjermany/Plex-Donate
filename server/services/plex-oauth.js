const fetch = require('node-fetch');
const { nanoid } = require('../utils/nanoid-shim');

const PLEX_API_BASE = 'https://plex.tv/api/v2';
const PLEX_APP_PRODUCT = 'Plex Donate';
const PLEX_APP_VERSION = '1.0';
const PLEX_APP_DEVICE = 'Plex Donate Server';
const PLEX_APP_PLATFORM = 'Web';
const PLEX_AUTH_BASE_URL = 'https://app.plex.tv/auth#';
const DEFAULT_POLL_INTERVAL_MS = 3000;

function buildHeaders(clientIdentifier, extra = {}) {
  if (!clientIdentifier) {
    throw new Error('clientIdentifier is required for Plex OAuth requests');
  }

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Plex-Product': PLEX_APP_PRODUCT,
    'X-Plex-Version': PLEX_APP_VERSION,
    'X-Plex-Device': PLEX_APP_DEVICE,
    'X-Plex-Device-Name': PLEX_APP_DEVICE,
    'X-Plex-Platform': PLEX_APP_PLATFORM,
    'X-Plex-Client-Identifier': clientIdentifier,
    ...extra,
  };
}

function buildAuthUrl({ code, clientIdentifier }) {
  const params = new URLSearchParams();
  if (code) {
    params.set('code', code);
  }
  if (clientIdentifier) {
    params.set('clientID', clientIdentifier);
  }
  return `${PLEX_AUTH_BASE_URL}${params.toString() ? `?${params.toString()}` : ''}`;
}

function coerceIsoTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

async function requestPin({ clientIdentifier } = {}) {
  const identifier = clientIdentifier || nanoid(24);
  const url = `${PLEX_API_BASE}/pins?strong=true`;

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(identifier),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to request Plex PIN: ${text}`);
  }

  const data = await response.json();
  const id = data.id || data.pin || null;
  const code = data.code || null;
  const expiresInSeconds = Number.parseInt(data.expires_in, 10);
  const expiresAt = data.expires_at
    ? coerceIsoTimestamp(data.expires_at)
    : Number.isFinite(expiresInSeconds)
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : null;

  return {
    pinId: id,
    code,
    clientIdentifier: identifier,
    authUrl: buildAuthUrl({ code, clientIdentifier: identifier }),
    expiresAt,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

async function pollPin({ pinId, clientIdentifier }) {
  if (!pinId) {
    throw new Error('pinId is required to poll Plex PIN status');
  }
  if (!clientIdentifier) {
    throw new Error('clientIdentifier is required to poll Plex PIN status');
  }

  const url = `${PLEX_API_BASE}/pins/${encodeURIComponent(pinId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(clientIdentifier),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to check Plex PIN status: ${text}`);
  }

  const data = await response.json();
  const authToken = data.auth_token || data.authToken || null;
  const code = data.code || null;
  const expiresAt = data.expires_at ? coerceIsoTimestamp(data.expires_at) : null;
  const expiresInSeconds = Number.parseInt(data.expires_in, 10);
  const expired =
    data.expired === true ||
    (expiresInSeconds != null && Number.isFinite(expiresInSeconds) && expiresInSeconds <= 0);

  return {
    pinId,
    code,
    clientIdentifier,
    authToken,
    expiresAt,
    expired,
  };
}

async function fetchIdentity({ authToken, clientIdentifier }) {
  if (!authToken) {
    throw new Error('authToken is required to fetch Plex identity');
  }
  if (!clientIdentifier) {
    throw new Error('clientIdentifier is required to fetch Plex identity');
  }

  const url = `${PLEX_API_BASE}/user`;
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(clientIdentifier, {
      'X-Plex-Token': authToken,
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Plex rejected the provided authentication token');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch Plex identity: ${text}`);
  }

  const data = await response.json();
  const user = data.user || data || {};

  const plexAccountId =
    user.uuid ||
    user.id ||
    user.userID ||
    (user.account ? user.account.id : null) ||
    null;

  const plexEmail =
    user.email ||
    (user.account ? user.account.email : null) ||
    user.username ||
    null;

  const plexUsername =
    user.username ||
    user.title ||
    (user.account ? user.account.username : null) ||
    null;

  return {
    plexAccountId: plexAccountId ? String(plexAccountId) : null,
    plexEmail: plexEmail ? String(plexEmail).trim() : null,
    plexUsername: plexUsername ? String(plexUsername).trim() : null,
    raw: user,
  };
}

module.exports = {
  requestPin,
  pollPin,
  fetchIdentity,
  buildAuthUrl,
  buildHeaders,
  DEFAULT_POLL_INTERVAL_MS,
};
