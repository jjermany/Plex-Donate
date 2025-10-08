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

function ensureCache() {
  if (cache) {
    return cache;
  }

  const stored = readCredentialsFile();
  if (stored) {
    cache = {
      username: stored.username,
      passwordHash: stored.passwordHash,
    };
    return cache;
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
};
