const fetch = require('node-fetch');
const { getPlexSettings } = require('../state/settings');

function getPlexConfig() {
  return getPlexSettings();
}

function isConfigured() {
  const plex = getPlexConfig();
  return Boolean(plex.baseUrl && plex.token);
}

function buildUrl(pathname) {
  const plex = getPlexConfig();
  const base = plex.baseUrl.replace(/\/$/, '');
  const separator = pathname.includes('?') ? '&' : '?';
  return `${base}${pathname}${separator}X-Plex-Token=${encodeURIComponent(
    plex.token
  )}`;
}

async function listUsers() {
  if (!isConfigured()) {
    throw new Error('Plex integration is not configured');
  }

  const response = await fetch(buildUrl('/api/v2/home/users'), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch Plex users: ${text}`);
  }

  const data = await response.json();
  return data.users || data;
}

async function revokeUserByEmail(email) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'Plex integration disabled' };
  }
  const users = await listUsers();
  const target = users.find((user) => {
    const normalizedEmail = (user.email || user.username || '').toLowerCase();
    return normalizedEmail === email.toLowerCase();
  });

  if (!target) {
    return { success: false, reason: 'User not found on Plex server' };
  }

  const userId = target.id || target.uuid || target.userID;
  if (!userId) {
    return { success: false, reason: 'Unable to determine Plex user id' };
  }

  const response = await fetch(buildUrl(`/api/v2/home/users/${userId}`), {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to revoke Plex user: ${text}`);
  }

  return { success: true, user: target };
}

module.exports = {
  isConfigured,
  listUsers,
  revokeUserByEmail,
};
