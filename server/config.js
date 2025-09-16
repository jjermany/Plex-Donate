const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, 'data');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  databaseFile: process.env.DATABASE_FILE
    ? path.resolve(process.env.DATABASE_FILE)
    : path.join(dataDir, 'plex-donate.db'),
};

config.isProduction = config.env === 'production';
config.dataDir = dataDir;

module.exports = config;
