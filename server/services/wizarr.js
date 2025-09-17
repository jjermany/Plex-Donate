const fetch = require('node-fetch');
const { getWizarrSettings } = require('../state/settings');

const INVITE_ENDPOINT_BASES = [
  '/api/invites',
  '/api/invite',
  '/api/v1/invites',
  '/api/v1/invite',
  '/api/v2/invites',
  '/api/v2/invite',
  '/api/admin/invites',
  '/api/admin/invite',
  '/api/v1/admin/invites',
  '/api/v1/admin/invite',
  '/api/v2/admin/invites',
  '/api/v2/admin/invite',
];

const INVITE_CREATION_ENDPOINTS = [
  ...INVITE_ENDPOINT_BASES,
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

function buildRequestUrl(baseUrlString, path) {
  const sanitizedBase = (baseUrlString || '').replace(/\/+$/, '');
  const baseUrl = new URL(`${sanitizedBase}/`);
  const baseSegments = baseUrl.pathname.split('/').filter(Boolean);

  const normalizedPath = (path || '').replace(/^\/+/, '');
  const pathSegments = normalizedPath ? normalizedPath.split('/') : [];

  let dropIndex = 0;
  while (
    dropIndex < baseSegments.length &&
    dropIndex < pathSegments.length &&
    pathSegments[dropIndex].toLowerCase() === baseSegments[dropIndex].toLowerCase()
  ) {
    dropIndex += 1;
  }

  const remainingSegments = pathSegments.slice(dropIndex);
  const relativePath = remainingSegments.join('/');
  const resolvedUrl = new URL(relativePath || '', baseUrl);

  return resolvedUrl.toString();
}

async function createInvite({ email, note, expiresInDays }, overrideSettings) {
  const wizarr = getWizarrConfig(overrideSettings);
  const payload = {
    email,
    note: note || '',
    expires_in_days: expiresInDays || wizarr.defaultDurationDays || 7,
  };

  const { response, text } = await requestWithFallback({
    wizarr,
    method: 'POST',
    pathCandidates: INVITE_CREATION_ENDPOINTS,
    body: payload,
  });

  if (!response.ok) {
    throw new Error(`Failed to create Wizarr invite: ${text}`);
  }

  const data = safeParseJson(text);
  if (!data || typeof data !== 'object') {
    throw new Error('Unexpected response from Wizarr API while creating invite');
  }
  return {
    inviteCode: data.code || data.invite_code || data.id,
    inviteUrl: data.url || data.invite_url || data.link,
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
  const { response, text } = await requestWithFallback({
    wizarr,
    method: 'POST',
    pathCandidates: INVITE_CREATION_ENDPOINTS,
    body: { email: '', note: 'Connection test', expires_in_days: 1 },
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
};
