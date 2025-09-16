const fetch = require('node-fetch');
const { getWizarrSettings } = require('../state/settings');

function getWizarrConfig() {
  const settings = getWizarrSettings();
  if (!settings.baseUrl || !settings.apiKey) {
    throw new Error('Wizarr API is not configured');
  }
  return settings;
}

async function createInvite({ email, note, expiresInDays }) {
  const wizarr = getWizarrConfig();
  const payload = {
    email,
    note: note || '',
    expires_in_days: expiresInDays || wizarr.defaultDurationDays || 7,
  };

  const response = await fetch(`${wizarr.baseUrl.replace(/\/$/, '')}/api/invites`, {
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

  const response = await fetch(
    `${wizarr.baseUrl.replace(/\/$/, '')}/api/invites/${inviteCode}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': wizarr.apiKey,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to revoke Wizarr invite: ${text}`);
  }

  return true;
}

module.exports = {
  createInvite,
  revokeInvite,
};
