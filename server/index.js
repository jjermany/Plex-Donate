const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const config = require('./config');
const adminRouter = require('./routes/admin');
const webhookRouter = require('./routes/webhook');
const shareRouter = require('./routes/share');
const customerRouter = require('./routes/customer');
const logger = require('./utils/logger');
const SqliteSessionStore = require('./session-store');
const { initializeAdminCredentials } = require('./state/admin-credentials');
const { clearSessionToken } = require('./utils/session-tokens');
const {
  db,
  listDonorsWithExpiredAccess,
  setDonorAccessExpirationById,
  setDonorStatusById,
  logEvent,
} = require('./db');

const app = express();

const SESSION_COOKIE_NAME = 'plex-donate.sid';
const SESSION_TTL_MS = 1000 * 60 * 15;
const ACCESS_REVOCATION_CHECK_INTERVAL_MS = 1000 * 60 * 5;

fs.mkdirSync(config.dataDir, { recursive: true });

try {
  initializeAdminCredentials();
} catch (err) {
  logger.error('Failed to initialize admin credentials', err);
  process.exit(1);
}

const sessionStore = new SqliteSessionStore({
  db,
  ttl: SESSION_TTL_MS,
});

app.set('trust proxy', 1);

app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure,
      maxAge: SESSION_TTL_MS,
    },
  })
);

app.use(bodyParser.urlencoded({ extended: false }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/paypal/webhook', webhookRouter);
app.use('/api/admin', adminRouter);
app.use('/api/share', shareRouter);
app.use('/api/customer', customerRouter);

app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/share.html'));
});

app.get(/^\/dashboard(?:\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    if (req.session && typeof req.session.destroy === 'function') {
      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          logger.warn('Failed to destroy session after invalid CSRF token', destroyErr);
        }
      });
    }

    clearSessionToken(req);

    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure,
    });

    return res
      .status(403)
      .json({ error: 'Invalid CSRF token', sessionToken: null });
  }
  logger.error('Unhandled error', err);
  return res.status(500).json({ error: 'Internal server error' });
});

let isProcessingAccessExpirations = false;

async function processAccessExpirations() {
  if (isProcessingAccessExpirations) {
    return;
  }

  if (typeof webhookRouter.revokeDonorAccess !== 'function') {
    return;
  }

  isProcessingAccessExpirations = true;
  try {
    const donors = listDonorsWithExpiredAccess();
    if (!donors || donors.length === 0) {
      return;
    }

    for (const donor of donors) {
      try {
        let donorForRevocation = donor;
        let statusForEvent = donor.status;

        if ((donor.status || '').toLowerCase() === 'trial') {
          const updatedDonor = setDonorStatusById(donor.id, 'trial_expired');
          if (updatedDonor) {
            donorForRevocation = updatedDonor;
            statusForEvent = updatedDonor.status;
          } else {
            statusForEvent = 'trial_expired';
          }
        }

        await webhookRouter.revokeDonorAccess(donorForRevocation);
        setDonorAccessExpirationById(donor.id, null);
        logEvent('donor.access.expiration.reached', {
          donorId: donor.id,
          subscriptionId: donor.subscriptionId,
          status: statusForEvent,
          source: 'scheduled-job',
        });
      } catch (err) {
        logger.warn('Failed to process donor access expiration', {
          donorId: donor.id,
          message: err.message,
        });
      }
    }
  } catch (err) {
    logger.error('Access expiration sweep failed', err);
  } finally {
    isProcessingAccessExpirations = false;
  }
}

function scheduleAccessExpirationJob() {
  const run = () => {
    processAccessExpirations().catch((err) => {
      logger.error('Unhandled error while processing access expirations', err);
    });
  };

  run();
  setInterval(run, ACCESS_REVOCATION_CHECK_INTERVAL_MS);
}

if (config.env !== 'test') {
  scheduleAccessExpirationJob();

  app.listen(config.port, () => {
    logger.info(`Plex Donate server listening on port ${config.port}`);
  });
}

module.exports = app;
module.exports.processAccessExpirations = processAccessExpirations;
