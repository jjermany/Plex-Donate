const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, 'data');

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

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  sessionSecret:
    process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  databaseFile: process.env.DATABASE_FILE
    ? path.resolve(process.env.DATABASE_FILE)
    : path.join(dataDir, 'plex-donate.db'),
  sessionCookieSecure: parseBoolean(process.env.SESSION_COOKIE_SECURE, false),
};

config.isProduction = config.env === 'production';
config.dataDir = dataDir;

module.exports = config;
