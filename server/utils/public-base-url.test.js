process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const settingsStore = require('../state/settings');
const {
  getConfiguredPublicBaseUrl,
  resolvePublicBaseUrl,
} = require('./public-base-url');

test('resolvePublicBaseUrl ignores request host fallback in production', () => {
  const originalProduction = config.isProduction;
  const originalEnv = config.env;

  settingsStore.updateGroup('app', { publicBaseUrl: '' });
  config.isProduction = true;
  config.env = 'production';

  try {
    const resolved = resolvePublicBaseUrl({
      protocol: 'https',
      get(name) {
        return name === 'host' ? 'evil.example' : '';
      },
    });

    assert.equal(getConfiguredPublicBaseUrl(), '');
    assert.equal(resolved, '');
  } finally {
    config.isProduction = originalProduction;
    config.env = originalEnv;
    settingsStore.updateGroup('app', { publicBaseUrl: '' });
  }
});

test('resolvePublicBaseUrl allows configured origin', () => {
  settingsStore.updateGroup('app', { publicBaseUrl: 'https://plex.example.com/app' });

  try {
    assert.equal(getConfiguredPublicBaseUrl(), 'https://plex.example.com');
    assert.equal(resolvePublicBaseUrl(null), 'https://plex.example.com');
  } finally {
    settingsStore.updateGroup('app', { publicBaseUrl: '' });
  }
});
