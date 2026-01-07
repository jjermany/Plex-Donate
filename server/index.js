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
const { refreshDonorSubscription } = require('./utils/donor-subscriptions');
const emailService = require('./services/email');
const SqliteSessionStore = require('./session-store');
const { initializeAdminCredentials } = require('./state/admin-credentials');
const { clearSessionToken } = require('./utils/session-tokens');
const { apiLimiter } = require('./middleware/rate-limit');
const {
  db,
  listDonorsWithExpiredAccess,
  listDonorsWithSubscriptionId,
  listTrialDonorsNeedingReminder,
  setDonorAccessExpirationById,
  setDonorStatusById,
  markTrialReminderSent,
  logEvent,
} = require('./db');

const app = express();

const SESSION_COOKIE_NAME = 'plex-donate.sid';
const SESSION_TTL_MS = 1000 * 60 * 15;
const ACCESS_REVOCATION_CHECK_INTERVAL_MS = 1000 * 60 * 5;
const SUBSCRIPTION_REFRESH_INTERVAL_MS = 1000 * 60 * 5;
const TRIAL_REMINDER_CHECK_INTERVAL_MS = 1000 * 60 * 30;

function isRequestSecure(req) {
  if (!config.sessionCookieSecure) {
    return false;
  }

  if (req.secure) {
    return true;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0].trim() === 'https';
  }

  return false;
}

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
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure ? 'auto' : false,
      maxAge: SESSION_TTL_MS,
    },
  })
);

app.use(bodyParser.urlencoded({ extended: false }));

/**
 * Health check endpoint with database connectivity check
 */
app.get('/api/health', (req, res) => {
  try {
    // Test database connectivity
    const result = db.prepare('SELECT 1 as test').get();
    if (result && result.test === 1) {
      res.json({
        status: 'ok',
        database: 'connected',
        time: new Date().toISOString(),
      });
    } else {
      res.status(503).json({
        status: 'degraded',
        database: 'error',
        time: new Date().toISOString(),
      });
    }
  } catch (err) {
    logger.error('Health check failed', err);
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      time: new Date().toISOString(),
    });
  }
});

// Apply rate limiting to API routes (excluding health check)
app.use('/api', apiLimiter);

app.use('/api/paypal/webhook', webhookRouter);
app.use('/api/admin', adminRouter);
app.use('/api/share', shareRouter);
app.use('/api/customer', customerRouter);

app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/share.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/about.html'));
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
      secure: isRequestSecure(req),
    });

    return res
      .status(403)
      .json({ error: 'Invalid CSRF token', sessionToken: null });
  }
  logger.error('Unhandled error', err);
  return res.status(500).json({ error: 'Internal server error' });
});

let isProcessingAccessExpirations = false;
let isProcessingSubscriptionRefreshes = false;
let isProcessingTrialReminders = false;
const activeSubscriptionRefreshes = new Set();

// Store server and interval references for graceful shutdown
let server = null;
let accessExpirationInterval = null;
let subscriptionRefreshInterval = null;
let trialReminderInterval = null;

function getSubscriptionRefreshKey(donor) {
  if (!donor) {
    return '';
  }

  const subscriptionId = (donor.subscriptionId || '').toString().trim();
  if (subscriptionId) {
    return `subscription:${subscriptionId}`;
  }

  if (donor.id) {
    return `donor:${donor.id}`;
  }

  return '';
}

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

        const isTrial = (donor.status || '').toLowerCase() === 'trial';

        if (isTrial) {
          const updatedDonor = setDonorStatusById(donor.id, 'trial_expired');
          if (updatedDonor) {
            donorForRevocation = updatedDonor;
            statusForEvent = updatedDonor.status;
          } else {
            statusForEvent = 'trial_expired';
          }
        }

        await webhookRouter.revokeDonorAccess(donorForRevocation, {
          context: isTrial ? 'trial-expiration' : 'scheduled-job',
          reason: isTrial ? 'trial_expired' : 'access_expired',
        });
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
  accessExpirationInterval = setInterval(run, ACCESS_REVOCATION_CHECK_INTERVAL_MS);
}

async function processSubscriptionRefreshes() {
  if (isProcessingSubscriptionRefreshes) {
    return;
  }

  isProcessingSubscriptionRefreshes = true;
  try {
    const donors = listDonorsWithSubscriptionId();
    if (!Array.isArray(donors) || donors.length === 0) {
      return;
    }

    for (const donor of donors) {
      const refreshKey = getSubscriptionRefreshKey(donor);
      if (!refreshKey) {
        continue;
      }

      if (activeSubscriptionRefreshes.has(refreshKey)) {
        continue;
      }

      activeSubscriptionRefreshes.add(refreshKey);
      try {
        await refreshDonorSubscription(donor, {
          onError: (refreshErr) =>
            logger.warn(
              'Failed to refresh PayPal subscription from scheduled job',
              {
                donorId: donor.id,
                subscriptionId: donor.subscriptionId,
                error: refreshErr && refreshErr.message,
              }
            ),
        });
      } catch (err) {
        logger.warn('Failed to process scheduled donor subscription refresh', {
          donorId: donor.id,
          subscriptionId: donor.subscriptionId,
          error: err && err.message,
        });
      } finally {
        activeSubscriptionRefreshes.delete(refreshKey);
      }
    }
  } catch (err) {
    logger.error('Subscription refresh sweep failed', err);
  } finally {
    isProcessingSubscriptionRefreshes = false;
  }
}

function scheduleSubscriptionRefreshJob() {
  const run = () => {
    processSubscriptionRefreshes().catch((err) => {
      logger.error('Unhandled error while refreshing donor subscriptions', err);
    });
  };

  run();
  subscriptionRefreshInterval = setInterval(run, SUBSCRIPTION_REFRESH_INTERVAL_MS);
}

async function processTrialEndingReminders() {
  if (isProcessingTrialReminders) {
    return;
  }

  isProcessingTrialReminders = true;
  try {
    const donors = listTrialDonorsNeedingReminder();
    if (!Array.isArray(donors) || donors.length === 0) {
      return;
    }

    for (const donor of donors) {
      try {
        await emailService.sendTrialEndingReminderEmail({
          to: donor.email,
          name: donor.name,
          accessExpiresAt: donor.accessExpiresAt,
        });

        markTrialReminderSent(donor.id);
        logEvent('donor.trial.reminder.sent', {
          donorId: donor.id,
          accessExpiresAt: donor.accessExpiresAt,
          source: 'scheduled-job',
        });
      } catch (err) {
        logger.warn('Failed to send trial ending reminder', {
          donorId: donor.id,
          message: err && err.message,
        });
      }
    }
  } catch (err) {
    logger.error('Trial ending reminder sweep failed', err);
  } finally {
    isProcessingTrialReminders = false;
  }
}

function scheduleTrialReminderJob() {
  const run = () => {
    processTrialEndingReminders().catch((err) => {
      logger.error('Unhandled error while processing trial reminders', err);
    });
  };

  run();
  trialReminderInterval = setInterval(run, TRIAL_REMINDER_CHECK_INTERVAL_MS);
}

/**
 * Graceful shutdown handler
 * Cleans up resources and closes connections properly
 */
async function gracefulShutdown(signal) {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Clear scheduled jobs
  if (accessExpirationInterval) {
    clearInterval(accessExpirationInterval);
    logger.info('Access expiration job stopped');
  }

  if (subscriptionRefreshInterval) {
    clearInterval(subscriptionRefreshInterval);
    logger.info('Subscription refresh job stopped');
  }

  if (trialReminderInterval) {
    clearInterval(trialReminderInterval);
    logger.info('Trial reminder job stopped');
  }

  // Wait for ongoing operations to complete (with timeout)
  const shutdownTimeout = setTimeout(() => {
    logger.warn('Shutdown timeout reached, forcing exit');
    process.exit(1);
  }, 30000); // 30 second timeout

  try {
    // Wait for ongoing processing to complete
    let waitCount = 0;
    const maxWaits = 60; // 30 seconds max (500ms * 60)

    while (
      (isProcessingAccessExpirations ||
        isProcessingSubscriptionRefreshes ||
        isProcessingTrialReminders ||
        activeSubscriptionRefreshes.size > 0) &&
      waitCount < maxWaits
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      waitCount++;
    }

    if (waitCount >= maxWaits) {
      logger.warn('Some operations did not complete in time');
    } else {
      logger.info('All operations completed successfully');
    }

    // Close database connection
    if (db && typeof db.close === 'function') {
      db.close();
      logger.info('Database connection closed');
    }

    clearTimeout(shutdownTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during graceful shutdown', err);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

if (config.env !== 'test') {
  scheduleAccessExpirationJob();
  scheduleSubscriptionRefreshJob();
  scheduleTrialReminderJob();

  server = app.listen(config.port, () => {
    logger.info(`Plex Donate server listening on port ${config.port}`);
    logger.info(`Environment: ${config.env}`);
    logger.info(`Admin username: ${config.adminUsername}`);
  });

  // Register graceful shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err);
    gracefulShutdown('uncaughtException');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', { reason, promise });
  });
}

module.exports = app;
module.exports.processAccessExpirations = processAccessExpirations;
module.exports.processSubscriptionRefreshes = processSubscriptionRefreshes;
module.exports.processTrialEndingReminders = processTrialEndingReminders;
