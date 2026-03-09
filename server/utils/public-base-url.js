const config = require('../config');
const settingsStore = require('../state/settings');

function normalizeConfiguredBaseUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.origin.replace(/\/+$/, '');
  } catch (err) {
    return '';
  }
}

function getConfiguredPublicBaseUrl() {
  try {
    const appSettings = settingsStore.getAppSettings();
    return normalizeConfiguredBaseUrl(appSettings && appSettings.publicBaseUrl);
  } catch (err) {
    return '';
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function getRequestOrigin(req) {
  if (!req || typeof req.get !== 'function') {
    return '';
  }

  const protocol = typeof req.protocol === 'string' ? req.protocol.trim() : '';
  const host = req.get('host');
  if (!protocol || !host) {
    return '';
  }

  try {
    const parsed = new URL(`${protocol}://${host}`);
    return parsed.origin.replace(/\/+$/, '');
  } catch (err) {
    return '';
  }
}

function resolvePublicBaseUrl(req) {
  const configured = getConfiguredPublicBaseUrl();
  if (configured) {
    return configured;
  }

  if (config.isProduction) {
    return '';
  }

  const fallbackOrigin = getRequestOrigin(req);
  if (!fallbackOrigin) {
    return '';
  }

  try {
    const parsed = new URL(fallbackOrigin);
    return isLoopbackHostname(parsed.hostname) ? fallbackOrigin : '';
  } catch (err) {
    return '';
  }
}

module.exports = {
  getConfiguredPublicBaseUrl,
  resolvePublicBaseUrl,
};
