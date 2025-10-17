const { getAllSettings, saveSettings } = require('../db');

const DEFAULT_SETTINGS = {
  app: {
    publicBaseUrl: '',
  },
  announcements: {
    bannerEnabled: false,
    bannerTitle: '',
    bannerBody: '',
    bannerTone: 'info',
    bannerDismissible: true,
    bannerCtaEnabled: false,
    bannerCtaLabel: '',
    bannerCtaUrl: '',
    bannerCtaOpenInNewTab: true,
  },
  paypal: {
    clientId: '',
    clientSecret: '',
    webhookId: '',
    apiBase: 'https://api-m.sandbox.paypal.com',
    planId: '',
    productId: '',
    subscriptionPrice: 0,
    currency: 'USD',
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
    serverIdentifier: '',
    librarySectionIds: '',
    allowSync: false,
    allowCameraUpload: false,
    allowChannels: false,
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

  if (name === 'plex') {
    normalized.allowSync = false;
    normalized.allowCameraUpload = false;
    normalized.allowChannels = false;
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

const ANNOUNCEMENT_TONES = new Set(['info', 'success', 'warning', 'danger', 'neutral']);

function normalizeAnnouncementValue(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function getAnnouncementSettings(overrides) {
  const baseGroup = getGroup('announcements');
  const group =
    overrides && typeof overrides === 'object'
      ? normalizeGroup('announcements', overrides, baseGroup)
      : baseGroup;
  const tone = typeof group.bannerTone === 'string' ? group.bannerTone.trim().toLowerCase() : '';
  const normalizedTone = ANNOUNCEMENT_TONES.has(tone) ? tone : 'info';

  return {
    bannerEnabled: Boolean(group.bannerEnabled),
    bannerTitle: normalizeAnnouncementValue(group.bannerTitle),
    bannerBody: normalizeAnnouncementValue(group.bannerBody),
    bannerTone: normalizedTone,
    bannerDismissible: Boolean(group.bannerDismissible),
    bannerCtaEnabled: Boolean(group.bannerCtaEnabled),
    bannerCtaLabel: normalizeAnnouncementValue(group.bannerCtaLabel),
    bannerCtaUrl: normalizeAnnouncementValue(group.bannerCtaUrl),
    bannerCtaOpenInNewTab: Boolean(group.bannerCtaOpenInNewTab),
  };
}

function getPaypalSettings() {
  return getGroup('paypal');
}

function getAppSettings() {
  return getGroup('app');
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
  getAppSettings,
  getPaypalSettings,
  getSmtpSettings,
  getPlexSettings,
  getAnnouncementSettings,
};
