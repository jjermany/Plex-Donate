const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const logger = require('../utils/logger');
const {
  hashPasswordSync,
  verifyPasswordSync,
  isSerializedHash,
} = require('../utils/passwords');

const CREDENTIALS_FILE = path.join(config.dataDir, 'admin-credentials.json');
const MIN_PASSWORD_LENGTH = 12;

let cache = null;
const DEFAULT_TWO_FACTOR = Object.freeze({
  enabled: false,
  secret: '',
  setupCompletedAt: '',
  setupSkippedAt: '',
});

function normalizeUsername(username) {
  if (typeof username !== 'string') {
    return '';
  }
  return username.trim();
}

function readCredentialsFile() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const username = normalizeUsername(parsed.username) || 'admin';
    const rawHash =
      typeof parsed.passwordHash === 'string' && parsed.passwordHash.trim()
        ? parsed.passwordHash.trim()
        : '';
    const passwordHash = rawHash && isSerializedHash(rawHash) ? rawHash : '';
    const twoFactor = normalizeTwoFactor(parsed.twoFactor);
    if (passwordHash) {
      return { username, passwordHash, twoFactor };
    }

    const legacyPassword =
      typeof parsed.password === 'string' && parsed.password.trim()
        ? parsed.password
        : '';
    if (legacyPassword) {
      return { username, legacyPassword, twoFactor };
    }

    return null;
  } catch (err) {
    return null;
  }
}

function normalizeTwoFactor(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const secret =
    typeof raw.secret === 'string' ? raw.secret.trim().toUpperCase() : '';
  const enabled = Boolean(raw.enabled && secret);
  return {
    enabled,
    secret: enabled ? secret : '',
    setupCompletedAt:
      typeof raw.setupCompletedAt === 'string' ? raw.setupCompletedAt.trim() : '',
    setupSkippedAt:
      typeof raw.setupSkippedAt === 'string' ? raw.setupSkippedAt.trim() : '',
  };
}

function writeCredentialsFile({ username, passwordHash, twoFactor }) {
  const payload = {
    username,
    passwordHash,
    twoFactor: normalizeTwoFactor(twoFactor),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function generateRandomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function resetAdminCredentials({ username, password } = {}) {
  const nextUsername = normalizeUsername(username) || normalizeUsername(config.adminUsername) || 'admin';
  const providedPassword = typeof password === 'string' ? password : '';
  let nextPassword = providedPassword.trim();
  let generated = false;

  if (!nextPassword) {
    nextPassword = generateRandomPassword();
    generated = true;
  }

  if (nextPassword.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(
      `Admin password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
    );
    err.code = 'PASSWORD_TOO_WEAK';
    throw err;
  }

  const passwordHash = hashPasswordSync(nextPassword);
  const existing = readCredentialsFile();
  writeCredentialsFile({
    username: nextUsername,
    passwordHash,
    twoFactor: existing && existing.twoFactor ? existing.twoFactor : undefined,
  });
  cache = {
    username: nextUsername,
    passwordHash,
    twoFactor:
      existing && existing.twoFactor
        ? normalizeTwoFactor(existing.twoFactor)
        : { ...DEFAULT_TWO_FACTOR },
  };

  return {
    username: nextUsername,
    password: nextPassword,
    generated,
  };
}

function ensureCache() {
  if (cache) {
    return cache;
  }

  const stored = readCredentialsFile();
  if (stored) {
    if (stored.passwordHash) {
      cache = {
        username: stored.username,
        passwordHash: stored.passwordHash,
        twoFactor: normalizeTwoFactor(stored.twoFactor),
      };
      return cache;
    }

    if (stored.legacyPassword) {
      const passwordHash = hashPasswordSync(stored.legacyPassword);
      writeCredentialsFile({
        username: stored.username,
        passwordHash,
        twoFactor: stored.twoFactor,
      });
      cache = {
        username: stored.username,
        passwordHash,
        twoFactor: normalizeTwoFactor(stored.twoFactor),
      };

      logger.info(
        `Migrated legacy admin credentials to hashed format for account: ${stored.username}`
      );

      return cache;
    }
  }

  const username = normalizeUsername(config.adminUsername) || 'admin';
  const password = generateRandomPassword();
  const passwordHash = hashPasswordSync(password);
  const existing = readCredentialsFile();
  writeCredentialsFile({
    username,
    passwordHash,
    twoFactor: existing && existing.twoFactor ? existing.twoFactor : undefined,
  });
  cache = {
    username,
    passwordHash,
    twoFactor:
      existing && existing.twoFactor
        ? normalizeTwoFactor(existing.twoFactor)
        : { ...DEFAULT_TWO_FACTOR },
  };

  logger.info(
    `Generated admin credentials for first-time setup. Username: ${username}. Run the reset-admin command to set a known password securely.`
  );

  return cache;
}

function initializeAdminCredentials() {
  return ensureCache();
}

function getAdminAccount() {
  const details = ensureCache();
  return {
    username: details.username,
    twoFactor: getAdminTwoFactorStatus(),
  };
}

function getAdminTwoFactorStatus() {
  const details = ensureCache();
  const twoFactor = normalizeTwoFactor(details.twoFactor);
  return {
    enabled: Boolean(twoFactor.enabled && twoFactor.secret),
    setupCompletedAt: twoFactor.setupCompletedAt || null,
    setupSkippedAt: twoFactor.setupSkippedAt || null,
    setupRequired:
      !twoFactor.enabled &&
      !twoFactor.setupCompletedAt &&
      !twoFactor.setupSkippedAt,
  };
}

function getAdminTwoFactorSecret() {
  const details = ensureCache();
  const twoFactor = normalizeTwoFactor(details.twoFactor);
  return twoFactor.enabled ? twoFactor.secret : '';
}

function persistCredentials(nextDetails) {
  writeCredentialsFile(nextDetails);
  cache = {
    username: nextDetails.username,
    passwordHash: nextDetails.passwordHash,
    twoFactor: normalizeTwoFactor(nextDetails.twoFactor),
  };
  return cache;
}

function verifyAdminCredentials(username, password) {
  const details = ensureCache();
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || normalizedUsername !== details.username) {
    return false;
  }
  return verifyPasswordSync(String(password || ''), details.passwordHash);
}

function updateAdminCredentials({ currentPassword, username, newPassword }) {
  const details = ensureCache();
  const current = typeof currentPassword === 'string' ? currentPassword : '';
  if (!current) {
    const err = new Error('Current password is required.');
    err.code = 'CURRENT_PASSWORD_REQUIRED';
    throw err;
  }

  if (!verifyPasswordSync(current, details.passwordHash)) {
    const err = new Error('Current password is incorrect.');
    err.code = 'INVALID_CURRENT_PASSWORD';
    throw err;
  }

  const nextUsername = normalizeUsername(username) || details.username;
  const proposedPassword = typeof newPassword === 'string' ? newPassword : '';
  let passwordHash = details.passwordHash;

  if (proposedPassword) {
    if (proposedPassword.trim().length < MIN_PASSWORD_LENGTH) {
      const err = new Error(
        `New password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
      );
      err.code = 'PASSWORD_TOO_WEAK';
      throw err;
    }
    passwordHash = hashPasswordSync(proposedPassword);
  }

  persistCredentials({
    username: nextUsername,
    passwordHash,
    twoFactor: details.twoFactor,
  });

  return {
    username: nextUsername,
    passwordChanged: Boolean(proposedPassword),
  };
}

function enableAdminTwoFactor(secret) {
  const details = ensureCache();
  const normalizedSecret =
    typeof secret === 'string' ? secret.trim().toUpperCase() : '';
  if (!normalizedSecret) {
    const err = new Error('A two-factor secret is required.');
    err.code = 'TWO_FACTOR_SECRET_REQUIRED';
    throw err;
  }

  persistCredentials({
    username: details.username,
    passwordHash: details.passwordHash,
    twoFactor: {
      enabled: true,
      secret: normalizedSecret,
      setupCompletedAt: new Date().toISOString(),
      setupSkippedAt: '',
    },
  });

  return getAdminTwoFactorStatus();
}

function skipAdminTwoFactorSetup() {
  const details = ensureCache();
  persistCredentials({
    username: details.username,
    passwordHash: details.passwordHash,
    twoFactor: {
      enabled: false,
      secret: '',
      setupCompletedAt: details.twoFactor && details.twoFactor.setupCompletedAt,
      setupSkippedAt: new Date().toISOString(),
    },
  });

  return getAdminTwoFactorStatus();
}

function disableAdminTwoFactor() {
  const details = ensureCache();
  persistCredentials({
    username: details.username,
    passwordHash: details.passwordHash,
    twoFactor: {
      enabled: false,
      secret: '',
      setupCompletedAt: details.twoFactor && details.twoFactor.setupCompletedAt,
      setupSkippedAt:
        (details.twoFactor && details.twoFactor.setupSkippedAt) ||
        new Date().toISOString(),
    },
  });

  return getAdminTwoFactorStatus();
}

module.exports = {
  disableAdminTwoFactor,
  enableAdminTwoFactor,
  getAdminTwoFactorSecret,
  getAdminTwoFactorStatus,
  initializeAdminCredentials,
  getAdminAccount,
  skipAdminTwoFactorSetup,
  verifyAdminCredentials,
  updateAdminCredentials,
  resetAdminCredentials,
};
