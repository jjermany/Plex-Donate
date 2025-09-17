const fetch = require('node-fetch');
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

  const stringValue = String(value).trim();
  if (!stringValue) {
    return null;
  }

  const numericValue = Number(stringValue);
  if (Number.isFinite(numericValue)) {
    return numericValue;
  }

  return stringValue;
}

function parseServerIds(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  const ids = [];
  const seen = new Set();

  const addId = (candidate) => {
    const normalized = normalizeServerId(candidate);
    if (normalized === null || normalized === undefined) {
      return;
    }
    const key = typeof normalized === 'number' ? `#${normalized}` : `str:${normalized}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ids.push(normalized);
  };

  if (Array.isArray(value)) {
    value.forEach(addId);
    return ids;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return ids;
    }

    if (/^\[.*\]$/.test(trimmed) || /^\{.*\}$/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        return parseServerIds(parsed);
      } catch (err) {
        // fall through to delimiter parsing when JSON parsing fails
      }
    }

    trimmed
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach(addId);

    return ids;
  }

  addId(value);
  return ids;
}

function extractServerIds(config) {
  if (!config || typeof config !== 'object') {
    return [];
  }

  const candidates = [
    config.server_ids,
    config.serverIds,
    config.defaultServerIds,
    config.default_server_ids,
    config.defaultServerId,
    config.serverId,
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
      const id =
        normalizeServerId(
          server.id ?? server.server_id ?? server.serverId ?? server.serverID
        );
      if (id === null || id === undefined) {
        return null;
      }
      return {
        id,
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
      const label = labelParts.length > 0 ? labelParts.join(' • ') : '';
      const idLabel = typeof server.id === 'number' ? `#${server.id}` : String(server.id);
      return label ? `${label} (${idLabel})` : idLabel;
    })
    .filter(Boolean)
    .join(', ');
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

async function createInvite({ email, note, expiresInDays }, overrideSettings) {
  const wizarr = getWizarrConfig(overrideSettings);
  const configuredServerIds = extractServerIds(wizarr);
  let requestBody = {
    email,
    note: note || '',
    expires_in_days: expiresInDays || wizarr.defaultDurationDays || 7,
  };

  if (configuredServerIds.length > 0) {
    requestBody = { ...requestBody, server_ids: configuredServerIds };
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
      configuredServerIds.length === 0 &&
      (!Array.isArray(requestBody.server_ids) || requestBody.server_ids.length === 0) &&
      (response.status === 400 || response.status === 422)
    ) {
      if (availableServers.length === 1) {
        const fallbackId = availableServers[0].id;
        if (fallbackId !== undefined && fallbackId !== null) {
          requestBody = { ...requestBody, server_ids: [fallbackId] };
          attempt = await sendRequest(requestBody);
          response = attempt.response;
          text = attempt.text;
          details = response.ok ? null : safeParseJson(text);
        }
      } else if (availableServers.length > 1) {
        const optionsLabel = formatServerOptions(availableServers);
        const messageParts = [
          'Wizarr requires selecting a server before creating invites.',
          'Update the Wizarr settings with default server IDs.',
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
  const serverIds = extractServerIds(wizarr);
  const body = { email: '', note: 'Connection test', expires_in_days: 1 };
  if (serverIds.length > 0) {
    body.server_ids = serverIds;
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
