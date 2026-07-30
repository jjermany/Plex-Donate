const settingsState = require('../state/settings');

const DEFAULT_BRAND_NAME = 'Member Hub';
const MAX_BRAND_LENGTH = 80;

function normalizeBrandValue(value, fallback = '') {
  const normalized = value == null ? '' : String(value).trim();
  return (normalized || fallback).slice(0, MAX_BRAND_LENGTH);
}

function getBranding(overrides) {
  let appSettings = overrides;
  if (!appSettings || typeof appSettings !== 'object') {
    try {
      appSettings = settingsState.getAppSettings();
    } catch (err) {
      appSettings = {};
    }
  }

  const brandName = normalizeBrandValue(
    appSettings && appSettings.brandName,
    DEFAULT_BRAND_NAME
  );
  return {
    brandName,
    emailSenderName: normalizeBrandValue(
      appSettings && appSettings.emailSenderName,
      brandName
    ),
    emailSignoff: normalizeBrandValue(
      appSettings && appSettings.emailSignoff,
      brandName
    ),
  };
}

function formatEmailFrom(from, branding = getBranding()) {
  const value = from == null ? '' : String(from).trim();
  if (!value) {
    return '';
  }

  const bracketMatch = value.match(/<([^<>]+)>/);
  const address = bracketMatch ? bracketMatch[1].trim() : value;
  if (!address || !address.includes('@')) {
    return value;
  }

  const senderName = normalizeBrandValue(
    branding && branding.emailSenderName,
    DEFAULT_BRAND_NAME
  ).replace(/["\\]/g, '');
  return `${senderName} <${address}>`;
}

module.exports = {
  DEFAULT_BRAND_NAME,
  getBranding,
  formatEmailFrom,
};
