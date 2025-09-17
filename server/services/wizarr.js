const fetch = require('node-fetch');
const { getWizarrSettings } = require('../state/settings');

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
    pathCandidates: ['/api/invites', '/api/invite', '/api/v1/invites', '/api/v1/invite'],
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
    pathCandidates: [
      `/api/invites/${encodeURIComponent(inviteCode)}`,
      `/api/invite/${encodeURIComponent(inviteCode)}`,
      `/api/v1/invites/${encodeURIComponent(inviteCode)}`,
      `/api/v1/invite/${encodeURIComponent(inviteCode)}`,
    ],
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
    pathCandidates: ['/api/invites', '/api/invite', '/api/v1/invites', '/api/v1/invite'],
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

async function requestWithFallback({
  wizarr,
  method,
  pathCandidates,
  body,
}) {
  const attempts = [];
  for (const path of pathCandidates) {
    if (!path) {
      continue;
    }
    const url = `${getBaseUrl(wizarr)}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': wizarr.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();

    if (response.status === 404 || response.status === 405) {
      attempts.push({ path, status: response.status });
      continue;
    }

    return { response, text, url: path };
  }

  const attemptedSummary = attempts.length
    ? attempts.map((attempt) => `${attempt.path} (${attempt.status})`).join(', ')
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
