const fetch = require('node-fetch');
const { nanoid } = require('nanoid');
const { getWizarrSettings } = require('../state/settings');

const INVITE_ENDPOINT_BASES = [
  '/api/v1/invitations',
  '/api/v1/invites',
  '/api/invites',
  '/api/invitations',
  '/api/v2/invitations',
  '/api/v2/invites',
  '/api/v1/admin/invitations',
  '/api/v1/admin/invites',
  '/api/admin/invitations',
  '/api/admin/invites',
  '/api/v2/admin/invitations',
  '/api/v2/admin/invites',
  '/api/v1/invite',
  '/api/invite',
  '/api/v2/invite',
  '/api/v1/admin/invite',
  '/api/admin/invite',
  '/api/v2/admin/invite',
];

const INVITE_CREATION_ENDPOINTS = [
  ...INVITE_ENDPOINT_BASES,
  '/api/v1/invitations/create',
  '/api/invitations/create',
  '/api/v2/invitations/create',
  '/api/v1/admin/invitations/create',
  '/api/admin/invitations/create',
  '/api/v2/admin/invitations/create',
  '/api/invites/create',
  '/api/invite/create',
  '/api/v1/invites/create',
  '/api/v1/invite/create',
  '/api/v2/invites/create',
  '/api/v2/invite/create',
  '/api/admin/invites/create',
  '/api/admin/invite/create',
  '/api/v1/admin/invites/create',
  '/api/v1/admin/invite/create',
  '/api/v2/admin/invites/create',
  '/api/v2/admin/invite/create',
];

const AUTH_STRATEGIES = [
  {
    label: 'x-api-key',
    build: (url, apiKey) => ({
      url,
      headers: { 'X-API-KEY': apiKey },
    }),
  },
  {
    label: 'x-api-key-camel',
    build: (url, apiKey) => ({
      url,
      headers: { 'X-Api-Key': apiKey },
    }),
  },
  {
    label: 'bearer',
    build: (url, apiKey) => ({
      url,
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  },
  {
    label: 'token',
    build: (url, apiKey) => ({
      url,
      headers: { Authorization: `Token ${apiKey}` },
    }),
  },
  {
    label: 'raw-authorization',
    build: (url, apiKey) => ({
      url,
      headers: { Authorization: apiKey },
    }),
  },
  {
    label: 'query-param',
    build: (url, apiKey) => {
      const urlObj = new URL(url);
      urlObj.searchParams.set('api_key', apiKey);
      return {
        url: urlObj.toString(),
        headers: { 'X-API-KEY': apiKey },
      };
    },
  },
];

function sanitizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

function sanitizeInviteCode(value) {
  const stringValue = sanitizeString(value);
  if (!stringValue) {
    return null;
  }

  return stringValue.replace(/\s+/g, '-');
}

function toFiniteNumber(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}

function toPositiveInteger(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }

  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const results = [];
  values
    .map((value) => sanitizeString(value))
    .filter(Boolean)
    .forEach((value) => {
      const key = value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push(value);
      }
    });
  return results;
}

function collectServerValues(value) {
  const results = [];
  const seen = new Set();

  const addValue = (candidate) => {
    if (candidate === undefined || candidate === null) {
      return;
    }

    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => addValue(entry));
      return;
    }

    if (typeof candidate === 'object') {
      const objectCandidates = [
        candidate.identifier,
        candidate.server,
        candidate.serverSlug,
        candidate.server_slug,
        candidate.serverId,
        candidate.server_id,
        candidate.id,
        candidate.value,
        candidate.key,
      ];
      let added = false;
      objectCandidates.forEach((entry) => {
        if (entry !== undefined && entry !== null) {
          added = true;
          addValue(entry);
        }
      });
      if (!added) {
        const fallback =
          candidate && typeof candidate.toString === 'function'
            ? candidate.toString()
            : '';
        const fallbackValue = sanitizeString(fallback);
        if (fallbackValue && fallbackValue !== '[object Object]') {
          addValue(fallbackValue);
        }
      }
      return;
    }

    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!trimmed) {
        return;
      }

      if (/^\[.*\]$/.test(trimmed) || /^\{.*\}$/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed);
          addValue(parsed);
          return;
        } catch (err) {
          // ignore JSON parse errors and fall back to delimiter split
        }
      }

      const parts = trimmed
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);

      if (parts.length > 1) {
        parts.forEach((part) => addValue(part));
        return;
      }

      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push(trimmed);
      }
      return;
    }

    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        return;
      }
      const key = `num:${candidate}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(String(candidate));
      }
      return;
    }

    const fallback = String(candidate).trim();
    if (!fallback || fallback === '[object Object]') {
      return;
    }
    const key = fallback.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(fallback);
    }
  };

  addValue(value);
  return results;
}

function stringifyServerId(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  return null;
}

function getWizarrConfig(overrideSettings) {
  const settings = overrideSettings || getWizarrSettings();
  if (!settings.baseUrl || !settings.apiKey) {
    throw new Error('Wizarr API is not configured');
  }
  return settings;
}

function getBaseUrl(wizarr) {
  return wizarr.baseUrl.replace(/\/$/, '');
}

function getPortalUrl(wizarr) {
  if (!wizarr || !wizarr.baseUrl) {
    return '';
  }

  const trimmed = wizarr.baseUrl.toString().trim();
  if (!trimmed) {
    return '';
  }

  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';

    const segments = url.pathname.split('/').filter(Boolean);
    const cutoffIndex = segments.findIndex(
      (segment) => segment && segment.toLowerCase() === 'api'
    );
    const normalizedSegments =
      cutoffIndex === -1 ? segments : segments.slice(0, cutoffIndex);

    if (normalizedSegments.length > 0) {
      url.pathname = `/${normalizedSegments.join('/')}`;
    } else {
      url.pathname = '/';
    }

    const normalized = url.toString();
    return normalized.endsWith('/') && url.pathname !== '/'
      ? normalized.replace(/\/+$/, '')
      : normalized.replace(/\/$/, '');
  } catch (err) {
    return trimmed.replace(/\/+$/, '');
  }
}

function buildInviteUrlFromCode(wizarr, inviteCode) {
  if (inviteCode === undefined || inviteCode === null) {
    return '';
  }

  const code = String(inviteCode).trim();
  if (!code) {
    return '';
  }

  const portalUrl = getPortalUrl(wizarr) || getBaseUrl(wizarr) || '';
  const sanitizedPortal = portalUrl.replace(/\/+$/, '');
  if (!sanitizedPortal) {
    return '';
  }

  return `${sanitizedPortal}/invite/${encodeURIComponent(code)}`;
}

function normalizeServerId(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'object') {
    const candidates = collectServerValues(value);
    if (candidates.length === 0) {
      return null;
    }
    return normalizeServerId(candidates[0]);
  }

  const stringValue = String(value).trim();
  if (!stringValue || stringValue === '[object Object]') {
    return null;
  }

  const numericValue = Number(stringValue);
  if (Number.isFinite(numericValue) && String(numericValue) === stringValue) {
    return numericValue;
  }

  return stringValue;
}

function parseServerIds(value) {
  const tokens = collectServerValues(value);
  if (tokens.length === 0) {
    return [];
  }

  const ids = [];
  const seen = new Set();

  tokens.forEach((token) => {
    if (!token) {
      return;
    }
    const numericValue = Number(token);
    const normalized =
      Number.isFinite(numericValue) && String(numericValue) === token
        ? numericValue
        : token;
    const key =
      typeof normalized === 'number'
        ? `#${normalized}`
        : `str:${String(normalized).toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ids.push(normalized);
  });

  return ids;
}

function extractServerIds(config) {
  if (!config || typeof config !== 'object') {
    return [];
  }

  const candidates = [
    config.server,
    config.serverSelection,
    config.serverSlug,
    config.server_slug,
    config.serverKey,
    config.server_key,
    config.serverIdentifier,
    config.server_identifier,
    config.server_ids,
    config.serverIds,
    config.defaultServerIds,
    config.default_server_ids,
    config.defaultServerId,
    config.default_server_id,
    config.defaultServer,
    config.default_server,
    config.defaultServerSelection,
    config.defaultServerSlug,
    config.default_server_slug,
    config.defaultServerKey,
    config.default_server_key,
    config.defaultServerIdentifier,
    config.default_server_identifier,
    config.serverId,
    config.server_id,
  ];

  for (const candidate of candidates) {
    const ids = parseServerIds(candidate);
    if (ids.length > 0) {
      return ids;
    }
  }

  return [];
}

function extractAvailableServers(details) {
  if (!details || typeof details !== 'object') {
    return [];
  }

  const serversRaw =
    details.available_servers || details.availableServers || details.servers || [];
  if (!Array.isArray(serversRaw)) {
    return [];
  }

  return serversRaw
    .map((server) => {
      if (!server || typeof server !== 'object') {
        return null;
      }
      const id = normalizeServerId(
        server.id ?? server.server_id ?? server.serverId ?? server.serverID
      );
      const identifierCandidates = collectServerValues([
        server.identifier,
        server.server,
        server.serverSlug,
        server.server_slug,
        server.serverKey,
        server.server_key,
        server.value,
        server.key,
        server.machine_identifier,
        server.machineIdentifier,
        id,
      ]);
      const identifier = identifierCandidates.length > 0 ? identifierCandidates[0] : null;
      if (identifier === null && id === null) {
        return null;
      }
      return {
        id,
        identifier: identifier || stringifyServerId(id),
        name: server.name || server.friendly_name || server.friendlyName || '',
        type: server.server_type || server.serverType || server.type || '',
      };
    })
    .filter(Boolean);
}

function formatServerOptions(servers) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return '';
  }

  return servers
    .map((server) => {
      if (!server) {
        return '';
      }
      const name = server.name ? String(server.name) : '';
      const type = server.type ? String(server.type) : '';
      const labelParts = [];
      if (name) {
        labelParts.push(name);
      }
      if (type) {
        labelParts.push(type.toUpperCase());
      }
      const identifier =
        sanitizeString(server.identifier) || stringifyServerId(server.id) || '';
      if (labelParts.length > 0) {
        const label = labelParts.join(' • ');
        return identifier ? `${label} (${identifier})` : label;
      }
      return identifier;
    })
    .filter(Boolean)
    .join(', ');
}

const SERVER_VALUE_KEYS = [
  'server',
  'serverSelection',
  'selectedServer',
  'preferredServer',
  'targetServer',
  'serverSlug',
  'server_slug',
  'serverKey',
  'server_key',
  'serverIdentifier',
  'server_identifier',
  'serverId',
  'server_id',
  'serverIds',
  'server_ids',
  'defaultServer',
  'default_server',
  'defaultServerSelection',
  'default_server_selection',
  'defaultServerSlug',
  'default_server_slug',
  'defaultServerKey',
  'default_server_key',
  'defaultServerIdentifier',
  'default_server_identifier',
  'defaultServerId',
  'default_server_id',
  'defaultServerIds',
  'default_server_ids',
  'identifier',
];

function collectServerPreferences(source) {
  if (!source || typeof source !== 'object') {
    return [];
  }

  const results = [];
  const seen = new Set();

  const addCandidate = (candidate) => {
    collectServerValues(candidate).forEach((entry) => {
      const value = stringifyServerId(entry);
      if (!value) {
        return;
      }
      const key = value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push(value);
      }
    });
  };

  SERVER_VALUE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      addCandidate(source[key]);
    }
  });

  return results;
}

function collectStringList(value) {
  if (value === undefined || value === null) {
    return [];
  }

  const results = [];
  const seen = new Set();

  const add = (candidate) => {
    if (candidate === undefined || candidate === null) {
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(add);
      return;
    }
    if (typeof candidate === 'object') {
      const objectCandidates = [
        candidate.value,
        candidate.name,
        candidate.label,
        candidate.identifier,
        candidate.slug,
        candidate.id,
      ];
      let added = false;
      objectCandidates.forEach((entry) => {
        if (entry !== undefined && entry !== null) {
          added = true;
          add(entry);
        }
      });
      if (!added) {
        const fallback =
          candidate && typeof candidate.toString === 'function'
            ? candidate.toString()
            : '';
        const fallbackValue = sanitizeString(fallback);
        if (fallbackValue && fallbackValue !== '[object Object]') {
          add(fallbackValue);
        }
      }
      return;
    }

    const stringValue = sanitizeString(candidate);
    if (!stringValue) {
      return;
    }

    if (stringValue.includes(',')) {
      stringValue
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach(add);
      return;
    }

    const key = stringValue.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(stringValue);
    }
  };

  add(value);
  return results;
}

let inviteCodeFallbackCounter = 0;

function generateInviteCode() {
  try {
    return nanoid(16);
  } catch (err) {
    inviteCodeFallbackCounter += 1;
    const fallback = `${Date.now().toString(36)}${inviteCodeFallbackCounter
      .toString(36)
      .padStart(2, '0')}${Math.random().toString(36).slice(2, 8)}`;
    const sanitized = fallback.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    return sanitized || `INVITE${inviteCodeFallbackCounter}`;
  }
}

function determineInviteCode(request) {
  const payload = (request && typeof request === 'object' && request) || {};
  const invitation =
    payload.invitation && typeof payload.invitation === 'object'
      ? payload.invitation
      : null;

  const candidates = [
    invitation && invitation.code,
    invitation && invitation.inviteCode,
    invitation && invitation.desiredCode,
    payload.code,
    payload.inviteCode,
    payload.desiredCode,
  ];

  for (const candidate of candidates) {
    const normalized = sanitizeInviteCode(candidate);
    if (normalized) {
      return normalized.slice(0, 64);
    }
  }

  return generateInviteCode();
}

function resolveServerContext(request, wizarr) {
  const configuredRaw = extractServerIds(wizarr);
  const configuredServers = uniqueStrings(
    (configuredRaw || []).map((value) => stringifyServerId(value)).filter(Boolean)
  );

  const payload = (request && typeof request === 'object' && request) || {};
  const invitation =
    payload.invitation && typeof payload.invitation === 'object'
      ? payload.invitation
      : null;

  const requestedServers = uniqueStrings([
    ...collectServerPreferences(payload),
    ...(invitation ? collectServerPreferences(invitation) : []),
  ]);

  const selectedServer =
    requestedServers.length > 0
      ? requestedServers[0]
      : configuredServers.length > 0
      ? configuredServers[0]
      : null;

  return { configuredServers, requestedServers, selectedServer };
}

function buildInvitationRequestBody({ request, wizarr, selectedServer }) {
  const payload = (request && typeof request === 'object' && request) || {};
  const invitation =
    payload.invitation && typeof payload.invitation === 'object'
      ? payload.invitation
      : {};

  const body = {};

  const serverCandidates = uniqueStrings([
    ...collectServerPreferences(invitation),
    ...collectServerPreferences(payload),
    selectedServer,
  ]).filter(Boolean);

  if (serverCandidates.length > 0) {
    body.server = serverCandidates[0];
  }

  body.code = determineInviteCode(payload);

  const maxUsesCandidates = [
    invitation.max_uses,
    invitation.maxUses,
    payload.max_uses,
    payload.maxUses,
    invitation.userLimit,
    invitation.user_limit,
    payload.userLimit,
    payload.user_limit,
  ];
  let maxUses = null;
  for (const candidate of maxUsesCandidates) {
    const numeric = toPositiveInteger(candidate);
    if (numeric !== null) {
      maxUses = numeric;
      break;
    }
  }
  if (maxUses === null) {
    maxUses = 1;
  }
  body.max_uses = maxUses;

  const durationCandidates = [
    invitation.duration,
    invitation.days,
    invitation.expiresInDays,
    payload.duration,
    payload.days,
    payload.expiresInDays,
    wizarr && wizarr.defaultDurationDays,
  ];
  let duration = null;
  for (const candidate of durationCandidates) {
    const numeric = toPositiveInteger(candidate);
    if (numeric !== null) {
      duration = numeric;
      break;
    }
  }
  if (duration === null) {
    duration = 7;
  }
  body.duration = duration;

  const profileCandidates = [
    invitation.profile,
    invitation.profileName,
    payload.profile,
    payload.profileName,
    wizarr && wizarr.defaultProfile,
  ];
  for (const candidate of profileCandidates) {
    const profile = sanitizeString(candidate);
    if (profile) {
      body.profile = profile;
      break;
    }
  }

  const libraryCandidates =
    invitation.libraries ??
    invitation.libraryIds ??
    payload.libraries ??
    payload.libraryIds ??
    (wizarr && wizarr.defaultLibraries);
  const libraries = collectStringList(libraryCandidates);
  if (libraries.length > 0) {
    body.libraries = libraries;
  }

  const messageCandidates = [
    invitation.message,
    invitation.note,
    payload.message,
    payload.note,
  ];
  for (const candidate of messageCandidates) {
    const message = sanitizeString(candidate);
    if (message) {
      body.message = message;
      break;
    }
  }

  const usernameCandidates = [
    invitation.username,
    invitation.name,
    payload.username,
    payload.name,
  ];
  for (const candidate of usernameCandidates) {
    const username = sanitizeString(candidate);
    if (username) {
      body.username = username;
      break;
    }
  }

  const emailCandidates = [invitation.email, invitation.recipientEmail];
  for (const candidate of emailCandidates) {
    const email = sanitizeString(candidate);
    if (email) {
      body.email = email;
      break;
    }
  }

  const extraSources = [];
  if (invitation.extraFields && typeof invitation.extraFields === 'object') {
    extraSources.push(invitation.extraFields);
  }
  if (payload.extraFields && typeof payload.extraFields === 'object') {
    extraSources.push(payload.extraFields);
  }

  extraSources.forEach((extra) => {
    Object.entries(extra).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        return;
      }
      body[key] = value;
    });
  });

  return body;
}

function buildRequestUrl(baseUrlString, path) {
  const sanitizedBase = (baseUrlString || '').replace(/\/+$/, '');
  const baseUrl = new URL(`${sanitizedBase}/`);
  const baseSegments = baseUrl.pathname.split('/').filter(Boolean);

  const normalizedPath = (path || '').replace(/^\/+/, '');
  const pathSegments = normalizedPath ? normalizedPath.split('/') : [];

  let overlap = 0;
  const maxOverlap = Math.min(baseSegments.length, pathSegments.length);
  for (let count = maxOverlap; count > 0; count -= 1) {
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      const baseSegment = baseSegments[baseSegments.length - count + index];
      const pathSegment = pathSegments[index];
      if (
        !baseSegment ||
        !pathSegment ||
        baseSegment.toLowerCase() !== pathSegment.toLowerCase()
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = count;
      break;
    }
  }

  const remainingSegments = pathSegments.slice(overlap);
  const relativePath = remainingSegments.join('/');
  const resolvedUrl = new URL(relativePath || '', baseUrl);

  return resolvedUrl.toString();
}

async function createInvite(requestOptions = {}, overrideSettings) {
  const wizarr = getWizarrConfig(overrideSettings);
  const options =
    requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
  const { configuredServers, selectedServer } = resolveServerContext(
    options,
    wizarr
  );

  let requestBody = buildInvitationRequestBody({
    request: options,
    wizarr,
    selectedServer,
  });

  if (!requestBody.server && selectedServer) {
    requestBody.server = selectedServer;
  }

  const sendRequest = (body) =>
    requestWithFallback({
      wizarr,
      method: 'POST',
      pathCandidates: INVITE_CREATION_ENDPOINTS,
      body,
    });

  let attempt = await sendRequest(requestBody);
  let { response } = attempt;
  let { text } = attempt;
  let details = response.ok ? null : safeParseJson(text);

  if (!response.ok) {
    const availableServers = extractAvailableServers(details);

    if (
      configuredServers.length === 0 &&
      (!requestBody.server || !sanitizeString(requestBody.server)) &&
      (response.status === 400 || response.status === 422)
    ) {
      if (availableServers.length === 1) {
        const fallbackServer =
          sanitizeString(availableServers[0].identifier) ||
          stringifyServerId(availableServers[0].id);
        if (fallbackServer) {
          requestBody = { ...requestBody, server: fallbackServer };
          attempt = await sendRequest(requestBody);
          response = attempt.response;
          text = attempt.text;
          details = response.ok ? null : safeParseJson(text);
        }
      } else if (availableServers.length > 1) {
        const optionsLabel = formatServerOptions(availableServers);
        const messageParts = [
          'Wizarr requires selecting a server before creating invites.',
          'Update the Wizarr settings with a default server selection.',
        ];
        if (optionsLabel) {
          messageParts.push(`Available servers: ${optionsLabel}.`);
        }
        const error = new Error(messageParts.join(' '));
        error.status = response.status;
        error.details = details;
        error.availableServers = availableServers;
        throw error;
      }
    }

    if (!response.ok) {
      const optionsLabel = formatServerOptions(availableServers);
      const messageParts = [];
      if (details && typeof details === 'object' && details.error) {
        messageParts.push(`Failed to create Wizarr invite: ${details.error}`);
      } else {
        messageParts.push(`Failed to create Wizarr invite: ${text}`);
      }
      if (optionsLabel) {
        messageParts.push(`Available servers: ${optionsLabel}.`);
      }
      const error = new Error(messageParts.join(' '));
      error.status = response.status;
      error.details = details;
      throw error;
    }
  }

  const data = safeParseJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Unexpected response from Wizarr API while creating invite');
  }

  const inviteCode = data.code || data.invite_code || data.inviteCode || data.id;
  const inviteUrlCandidate =
    data.url || data.invite_url || data.link || data.inviteUrl || data.full_url;
  const inviteUrlString =
    typeof inviteUrlCandidate === 'string' ? inviteUrlCandidate.trim() : '';
  const fallbackInviteUrl = buildInviteUrlFromCode(wizarr, inviteCode);

  return {
    inviteCode,
    inviteUrl: inviteUrlString || fallbackInviteUrl,
    raw: data,
  };
}

async function revokeInvite(inviteCode) {
  const wizarr = getWizarrConfig();
  if (!inviteCode) {
    throw new Error('inviteCode is required to revoke Wizarr invite');
  }

  const { response, text } = await requestWithFallback({
    wizarr,
    method: 'DELETE',
    pathCandidates: INVITE_ENDPOINT_BASES.map(
      (path) => `${path}/${encodeURIComponent(inviteCode)}`
    ),
  });

  if (!response.ok) {
    throw new Error(`Failed to revoke Wizarr invite: ${text}`);
  }

  return true;
}

async function verifyConnection(overrideSettings) {
  const wizarr = getWizarrConfig(overrideSettings);
  const { configuredServers, selectedServer } = resolveServerContext({}, wizarr);
  const requestPayload = {
    code: 'connection-test',
    maxUses: 1,
    duration: 1,
  };
  let body = buildInvitationRequestBody({
    request: requestPayload,
    wizarr,
    selectedServer,
  });

  if (!body.server && selectedServer) {
    body.server = selectedServer;
  }

  if (!body.server && configuredServers.length > 0) {
    body.server = configuredServers[0];
  }

  if (!body.duration) {
    body.duration =
      toPositiveInteger(wizarr && wizarr.defaultDurationDays) || 1;
  }

  if (!body.max_uses) {
    body.max_uses = 1;
  }

  const { response, text } = await requestWithFallback({
    wizarr,
    method: 'POST',
    pathCandidates: INVITE_CREATION_ENDPOINTS,
    body,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Wizarr API rejected the provided API key');
  }

  if (response.status === 400 || response.status === 422) {
    return {
      message: 'Wizarr API key accepted. Received validation error as expected.',
      status: response.status,
      details: safeParseJson(text),
    };
  }

  if (!response.ok) {
    throw new Error(`Wizarr verification failed (${response.status}): ${text}`);
  }

  return {
    message: 'Wizarr API responded successfully.',
    status: response.status,
    details: safeParseJson(text),
  };
}

function toFormBody(body) {
  const params = new URLSearchParams();
  if (!body || typeof body !== 'object') {
    return params.toString();
  }
  Object.entries(body).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    params.append(key, String(value));
  });
  return params.toString();
}

async function performRequest({ url, method, apiKey, body, format }) {
  const attempts = [];
  let lastResult = null;
  let lastError = null;

  for (const strategy of AUTH_STRATEGIES) {
    let requestUrl = url;
    let strategyHeaders = {};

    try {
      const built = strategy.build ? strategy.build(url, apiKey) : { url };
      requestUrl = built.url || url;
      strategyHeaders = built.headers || {};
    } catch (err) {
      attempts.push({
        url,
        status: err && err.message ? err.message : 'strategy error',
        strategy: strategy.label,
        format,
      });
      continue;
    }

    const headers = {
      Accept: 'application/json, text/plain, */*',
      ...strategyHeaders,
    };

    let requestBody;
    if (body && method && method.toUpperCase() !== 'GET') {
      if (format === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        requestBody = toFormBody(body);
      } else {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }
    }

    let response;
    let text = '';
    try {
      response = await fetch(requestUrl, {
        method,
        headers,
        body: requestBody,
      });
      text = await response.text();
    } catch (err) {
      attempts.push({
        url: requestUrl,
        status: err && err.message ? err.message : 'network error',
        strategy: strategy.label,
        format,
      });
      lastError = err;
      continue;
    }

    attempts.push({
      url: requestUrl,
      status: response.status,
      strategy: strategy.label,
      format,
    });

    if (response.status !== 401 && response.status !== 403) {
      return { response, text, url: requestUrl, attempts };
    }

    lastResult = { response, text, url: requestUrl };
  }

  if (lastResult) {
    return { ...lastResult, attempts };
  }

  const error =
    lastError || new Error('Wizarr request failed for all authentication strategies');
  error.attempts = attempts;
  throw error;
}

async function requestWithFallback({
  wizarr,
  method,
  pathCandidates,
  body,
}) {
  const attempts = [];
  const baseUrl = getBaseUrl(wizarr);
  for (const path of pathCandidates) {
    if (!path) {
      continue;
    }

    const url = buildRequestUrl(baseUrl, path);
    let response;
    let text = '';

    try {
      const result = await performRequest({
        url,
        method,
        apiKey: wizarr.apiKey,
        body,
        format: 'json',
      });
      response = result.response;
      text = result.text;
      if (result.attempts && result.attempts.length > 0) {
        attempts.push(...result.attempts);
      } else {
        attempts.push({
          url: result.url || url,
          status: response.status,
          format: 'json',
        });
      }
    } catch (err) {
      if (err && err.attempts && err.attempts.length > 0) {
        attempts.push(...err.attempts);
      } else {
        attempts.push({
          url,
          status: err && err.message ? err.message : 'network error',
          format: 'json',
        });
      }
      continue;
    }

    const lastAttempt = attempts[attempts.length - 1];
    const lastUrl = (lastAttempt && lastAttempt.url) || url;

    if (response.status === 404 || response.status === 405) {
      continue;
    }

    if (
      response.status === 415 &&
      body &&
      method &&
      method.toUpperCase() !== 'GET'
    ) {
      try {
        const result = await performRequest({
          url: lastUrl,
          method,
          apiKey: wizarr.apiKey,
          body,
          format: 'form',
        });
        response = result.response;
        text = result.text;
        if (result.attempts && result.attempts.length > 0) {
          attempts.push(...result.attempts);
        } else {
          attempts.push({
            url: result.url || lastUrl,
            status: response.status,
            format: 'form',
          });
        }
      } catch (err) {
        if (err && err.attempts && err.attempts.length > 0) {
          attempts.push(...err.attempts);
        } else {
          attempts.push({
            url: lastUrl,
            status: err && err.message ? err.message : 'network error',
            format: 'form',
          });
        }
        continue;
      }

      if (response.status === 404 || response.status === 405) {
        continue;
      }

      if (response.status === 415) {
        continue;
      }
    }

    const finalAttempt = attempts[attempts.length - 1];
    const finalUrl = finalAttempt && finalAttempt.url ? finalAttempt.url : url;
    return { response, text, url: finalUrl };
  }

  const attemptedSummary = attempts.length
    ? attempts
        .map((attempt) => {
          try {
            const { pathname } = new URL(attempt.url);
            const formatLabel = attempt.format ? ` [${attempt.format}]` : '';
            const strategyLabel = attempt.strategy
              ? ` {${attempt.strategy}}`
              : '';
            return `${pathname}${formatLabel}${strategyLabel} (${attempt.status})`;
          } catch (err) {
            const formatLabel = attempt.format ? ` [${attempt.format}]` : '';
            const strategyLabel = attempt.strategy
              ? ` {${attempt.strategy}}`
              : '';
            return `${attempt.url}${formatLabel}${strategyLabel} (${attempt.status})`;
          }
        })
        .join(', ')
    : pathCandidates.filter(Boolean).join(', ');
  throw new Error(
    `Wizarr API endpoint not found. Check the Wizarr base URL. Tried: ${attemptedSummary}`
  );
}

function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (err) {
    return value;
  }
}

module.exports = {
  createInvite,
  revokeInvite,
  getWizarrConfig,
  verifyConnection,
  buildRequestUrl,
  getPortalUrl,
};
