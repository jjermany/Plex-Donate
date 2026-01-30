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
    if (passwordHash) {
      return { username, passwordHash };
    }

    const legacyPassword =
      typeof parsed.password === 'string' && parsed.password.trim()
        ? parsed.password
        : '';
    if (legacyPassword) {
      return { username, legacyPassword };
    }

    return null;
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
  writeCredentialsFile({ username: nextUsername, passwordHash });
  cache = {
    username: nextUsername,
    passwordHash,
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
      };
      return cache;
    }

    if (stored.legacyPassword) {
      const passwordHash = hashPasswordSync(stored.legacyPassword);
      writeCredentialsFile({ username: stored.username, passwordHash });
      cache = {
        username: stored.username,
        passwordHash,
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

  writeCredentialsFile({ username, passwordHash });
  cache = {
    username,
    passwordHash,
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
  };
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

  writeCredentialsFile({ username: nextUsername, passwordHash });
  cache = {
    username: nextUsername,
    passwordHash,
  };

  return {
    username: nextUsername,
    passwordChanged: Boolean(proposedPassword),
  };
}

module.exports = {
  initializeAdminCredentials,
  getAdminAccount,
  verifyAdminCredentials,
  updateAdminCredentials,
  resetAdminCredentials,
};
