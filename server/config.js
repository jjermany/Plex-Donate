const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, 'data');
const secretsFile = path.join(dataDir, '.secrets');

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
};

/**
 * Generate or load persisted session secret
 * @returns {string} Session secret
 */
function getOrCreateSessionSecret() {
  // If explicitly provided in env, use it
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  // Try to load from persisted file
  try {
    if (fs.existsSync(secretsFile)) {
      const data = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
      if (data.sessionSecret) {
        return data.sessionSecret;
      }
    }
  } catch (err) {
    // File doesn't exist or is corrupted, will create new one
  }

  // Generate new secret and persist it
  const newSecret = crypto.randomBytes(48).toString('hex');

  try {
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save secret to file
    const secrets = { sessionSecret: newSecret };
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), {
      mode: 0o600, // Readable/writable only by owner
    });

    console.warn(
      'WARNING: SESSION_SECRET not provided in environment. Generated and saved to',
      secretsFile
    );
    console.warn(
      'For production deployments, please set SESSION_SECRET environment variable.'
    );
  } catch (err) {
    console.error('Failed to persist session secret:', err);
    console.warn('Using ephemeral session secret. Sessions will be invalidated on restart.');
  }

  return newSecret;
}

/**
 * Validate configuration
 * @param {Object} config - Configuration object
 */
function validateConfig(config) {
  const warnings = [];
  const errors = [];

  // Port validation
  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    errors.push(`Invalid PORT: ${config.port}. Must be between 1 and 65535.`);
  }

  // Production-specific validations
  if (config.isProduction) {
    if (!process.env.SESSION_SECRET) {
      warnings.push(
        'SESSION_SECRET not set in production. Using persisted secret from disk.'
      );
    }

    if (!config.sessionCookieSecure) {
      warnings.push(
        'SESSION_COOKIE_SECURE is false in production. Cookies will not be secure-only.'
      );
    }

    if (!process.env.DATABASE_FILE) {
      warnings.push(
        `DATABASE_FILE not set. Using default: ${config.databaseFile}`
      );
    }
  }

  // Log warnings and errors
  if (warnings.length > 0) {
    console.warn('\n⚠️  Configuration Warnings:');
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
    console.warn('');
  }

  if (errors.length > 0) {
    console.error('\n❌ Configuration Errors:');
    errors.forEach((error) => console.error(`  - ${error}`));
    console.error('');
    throw new Error('Invalid configuration. Please fix the errors above.');
  }
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  sessionSecret: getOrCreateSessionSecret(),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  databaseFile: process.env.DATABASE_FILE
    ? path.resolve(process.env.DATABASE_FILE)
    : path.join(dataDir, 'plex-donate.db'),
  sessionCookieSecure: parseBoolean(process.env.SESSION_COOKIE_SECURE, false),
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  logDir: process.env.LOG_DIR || path.join(rootDir, 'logs'),
};

config.isProduction = config.env === 'production';
config.dataDir = dataDir;

// Validate configuration on load
if (config.env !== 'test') {
  validateConfig(config);
}

module.exports = config;
