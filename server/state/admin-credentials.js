const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const logger = require('../utils/logger');
const { hashPasswordSync, verifyPasswordSync } = require('../utils/passwords');

const CREDENTIALS_FILE = path.join(config.dataDir, 'admin-credentials.json');
const MIN_PASSWORD_LENGTH = 12;

let cache = null;

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
    const passwordHash = typeof parsed.passwordHash === 'string' ? parsed.passwordHash : '';
    if (!passwordHash) {
      return null;
    }
    return { username, passwordHash };
  } catch (err) {
    return null;
  }
}

function writeCredentialsFile({ username, passwordHash }) {
  const payload = {
    username,
    passwordHash,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
  });
}

function generateRandomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(aBuffer, bBuffer);
  } catch (err) {
    return false;
  }
}

function ensureCache() {
  if (cache) {
    return cache;
  }

  const envPassword = config.adminPassword ? String(config.adminPassword) : '';
  const envUsername = normalizeUsername(config.adminUsername) || 'admin';

  if (envPassword) {
    cache = {
      username: envUsername,
      password: envPassword,
      source: 'env',
    };
    return cache;
  }

  const stored = readCredentialsFile();
  if (stored) {
    cache = {
      username: stored.username,
      passwordHash: stored.passwordHash,
      source: 'file',
    };
    return cache;
  }

  const username = envUsername;
  const password = generateRandomPassword();
  const passwordHash = hashPasswordSync(password);

  writeCredentialsFile({ username, passwordHash });
  cache = {
    username,
    passwordHash,
    source: 'file',
  };

  logger.info(
    `Generated admin credentials for first-time setup. Username: ${username}, Temporary password: ${password}`
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
    credentialsManagedExternally: details.source === 'env',
  };
}

function isManagedExternally() {
  const details = ensureCache();
  return details.source === 'env';
}

function verifyAdminCredentials(username, password) {
  const details = ensureCache();
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || normalizedUsername !== details.username) {
    return false;
  }
  if (details.source === 'env') {
    return safeEqual(String(password || ''), details.password);
  }
  return verifyPasswordSync(String(password || ''), details.passwordHash);
}

function updateAdminCredentials({ currentPassword, username, newPassword }) {
  const details = ensureCache();

  if (details.source === 'env') {
    const err = new Error('Admin credentials are managed via environment variables.');
    err.code = 'EXTERNALLY_MANAGED';
    throw err;
  }

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

  writeCredentialsFile({ username: nextUsername, passwordHash });
  cache = {
    username: nextUsername,
    passwordHash,
    source: 'file',
  };

  return {
    username: nextUsername,
    passwordChanged: Boolean(proposedPassword),
  };
}

module.exports = {
  initializeAdminCredentials,
  getAdminAccount,
  isManagedExternally,
  verifyAdminCredentials,
  updateAdminCredentials,
};
