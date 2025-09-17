const { getAllSettings, saveSettings } = require('../db');

const DEFAULT_SETTINGS = {
  paypal: {
    clientId: '',
    clientSecret: '',
    webhookId: '',
    apiBase: 'https://api-m.sandbox.paypal.com',
    planId: '',
    subscriptionPrice: 0,
    currency: 'USD',
  },
  wizarr: {
    baseUrl: '',
    apiKey: '',
    defaultDurationDays: 7,
  },
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '',
  },
  plex: {
    baseUrl: '',
    token: '',
  },
};

function coerceValue(value, defaultValue, fallbackValue) {
  if (typeof defaultValue === 'number') {
    if (value === '' || value === null || value === undefined) {
      return fallbackValue !== undefined ? fallbackValue : defaultValue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return fallbackValue !== undefined ? fallbackValue : defaultValue;
      }
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    } else {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
    return fallbackValue !== undefined ? fallbackValue : defaultValue;
  }

  if (typeof defaultValue === 'boolean') {
    if (value === undefined || value === null) {
      return fallbackValue !== undefined ? Boolean(fallbackValue) : defaultValue;
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
      if (normalized.length === 0) {
        return fallbackValue !== undefined
          ? Boolean(fallbackValue)
          : defaultValue;
      }
    }
    return Boolean(value);
  }

  if (value === undefined || value === null) {
    return fallbackValue !== undefined ? fallbackValue : '';
  }
  return String(value).trim();
}

function normalizeGroup(name, values = {}, baseValues) {
  const defaults = DEFAULT_SETTINGS[name];
  if (!defaults) {
    throw new Error(`Unknown settings group: ${name}`);
  }

  const normalized = { ...defaults };

  if (baseValues && typeof baseValues === 'object') {
    Object.keys(defaults).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(baseValues, key)) {
        normalized[key] = coerceValue(
          baseValues[key],
          defaults[key],
          defaults[key]
        );
      }
    });
  }

  if (values && typeof values === 'object') {
    Object.keys(defaults).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        normalized[key] = coerceValue(values[key], defaults[key], normalized[key]);
      }
    });
  }

  return normalized;
}

function getSettings() {
  const stored = getAllSettings();
  return Object.keys(DEFAULT_SETTINGS).reduce((acc, group) => {
    const persisted = stored[group];
    acc[group] = normalizeGroup(group, persisted);
    return acc;
  }, {});
}

function getGroup(name) {
  const settings = getSettings();
  return settings[name] || normalizeGroup(name, {});
}

function updateGroup(name, updates) {
  const current = getGroup(name);
  const normalized = normalizeGroup(name, updates, current);
  saveSettings({ [name]: normalized });
  return normalized;
}

function previewGroup(name, overrides) {
  const current = getGroup(name);
  return normalizeGroup(name, overrides, current);
}

function getPaypalSettings() {
  return getGroup('paypal');
}

function getWizarrSettings() {
  return getGroup('wizarr');
}

function getSmtpSettings() {
  return getGroup('smtp');
}

function getPlexSettings() {
  return getGroup('plex');
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  getGroup,
  updateGroup,
  previewGroup,
  getPaypalSettings,
  getWizarrSettings,
  getSmtpSettings,
  getPlexSettings,
};
