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

  const response = await fetch(`${getBaseUrl(wizarr)}/api/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': wizarr.apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create Wizarr invite: ${text}`);
  }

  const data = await response.json();
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

  const response = await fetch(`${getBaseUrl(wizarr)}/api/invites/${inviteCode}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': wizarr.apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to revoke Wizarr invite: ${text}`);
  }

  return true;
}

async function verifyConnection(overrideSettings) {
  const wizarr = getWizarrConfig(overrideSettings);
  const response = await fetch(`${getBaseUrl(wizarr)}/api/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': wizarr.apiKey,
    },
    body: JSON.stringify({ email: '', note: 'Connection test', expires_in_days: 1 }),
  });

  const text = await response.text();

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
