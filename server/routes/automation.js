const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { webhookLimiter } = require('../middleware/rate-limit');
const {
  getSetting,
  saveSettings,
  listDonorsWithDetails,
  logEvent,
} = require('../db');
const emailService = require('../services/email');
const settingsStore = require('../state/settings');
const logger = require('../utils/logger');

const router = express.Router();
const AUTOMATION_STATE_KEY = 'automation_state';
const UPS_EVENT_TYPES = new Set([
  'power_outage',
  'power_restored',
  'shutdown_imminent',
]);
const UPS_POWER_STATES = {
  power_outage: 'outage',
  power_restored: 'normal',
  shutdown_imminent: 'outage',
};

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getAutomationState() {
  const stored = getSetting(AUTOMATION_STATE_KEY);
  const currentPowerState =
    stored && typeof stored.currentPowerState === 'string'
      ? stored.currentPowerState.trim().toLowerCase()
      : '';

  return {
    currentPowerState:
      currentPowerState === 'outage' ? 'outage' : 'normal',
    lastAcceptedEventType:
      stored && typeof stored.lastAcceptedEventType === 'string'
        ? stored.lastAcceptedEventType.trim()
        : '',
    lastAcceptedEventAt:
      stored && typeof stored.lastAcceptedEventAt === 'string'
        ? stored.lastAcceptedEventAt.trim()
        : '',
  };
}

function saveAutomationState(state) {
  saveSettings({
    [AUTOMATION_STATE_KEY]: {
      currentPowerState: state.currentPowerState,
      lastAcceptedEventType: state.lastAcceptedEventType,
      lastAcceptedEventAt: state.lastAcceptedEventAt,
    },
  });
}

function getBearerToken(req) {
  const header = (req.get('authorization') || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return header.slice(7).trim();
}

function tokensMatch(expected, provided) {
  if (!expected || !provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(String(expected));
  const providedBuffer = Buffer.from(String(provided));
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeOccurredAt(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toISOString();
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric;
}

function shouldDeduplicateUpsEvent(currentState, event) {
  if (event === 'shutdown_imminent') {
    return currentState.lastAcceptedEventType === 'shutdown_imminent';
  }

  return currentState.currentPowerState === UPS_POWER_STATES[event];
}

function normalizeEmail(value) {
  if (!value) {
    return '';
  }

  const raw = String(value).trim().toLowerCase();
  const angleMatch = raw.match(/<([^>]+)>/);
  if (angleMatch && angleMatch[1]) {
    return angleMatch[1].trim().toLowerCase();
  }

  return raw;
}

function getUpsAdminRecipient(smtpConfig) {
  let notifications = null;
  try {
    notifications = settingsStore.getNotificationSettings();
  } catch (err) {
    notifications = null;
  }

  const explicit =
    notifications && notifications.adminEmail
      ? String(notifications.adminEmail).trim()
      : '';
  if (explicit) {
    return {
      email: explicit,
      name: 'Server owner',
      type: 'admin',
    };
  }

  const fallback =
    (smtpConfig && smtpConfig.supportNotificationEmail
      ? String(smtpConfig.supportNotificationEmail).trim()
      : '') ||
    (smtpConfig && smtpConfig.from ? String(smtpConfig.from).trim() : '');

  if (!fallback) {
    return null;
  }

  return {
    email: fallback,
    name: 'Server owner',
    type: 'admin',
  };
}

function listUpsRecipients() {
  const recipients = listDonorsWithDetails()
    .filter((donor) => {
      const email = donor && donor.email ? String(donor.email).trim() : '';
      const status =
        donor && donor.status ? String(donor.status).trim().toLowerCase() : '';
      return Boolean(email) && ['active', 'trial'].includes(status);
    })
    .map((donor) => ({
      email: String(donor.email).trim(),
      name: donor && donor.name ? String(donor.name).trim() : '',
      status: donor && donor.status ? String(donor.status).trim().toLowerCase() : '',
      donorId: donor && donor.id ? donor.id : null,
      type: 'donor',
    }));

  return recipients;
}

function buildUpsRecipients(smtpConfig) {
  const combined = listUpsRecipients();
  const adminRecipient = getUpsAdminRecipient(smtpConfig);
  if (adminRecipient) {
    combined.push(adminRecipient);
  }

  const seen = new Set();
  return combined.filter((recipient) => {
    const normalized = normalizeEmail(recipient && recipient.email);
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

router.use(webhookLimiter);
router.use(express.json());

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!config.upsWebhookToken) {
      return res.status(503).json({
        error: 'UPS automation webhook is not configured.',
      });
    }

    const providedToken = getBearerToken(req);
    if (!tokensMatch(config.upsWebhookToken, providedToken)) {
      return res.status(401).json({
        error: 'Invalid automation token.',
      });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const event =
      typeof payload.event === 'string' ? payload.event.trim().toLowerCase() : '';

    if (!UPS_EVENT_TYPES.has(event)) {
      return res.status(400).json({
        error: 'A valid UPS event is required.',
      });
    }

    const occurredAt = normalizeOccurredAt(payload.occurredAt);
    if (!occurredAt) {
      return res.status(400).json({
        error: 'occurredAt must be a valid ISO timestamp when provided.',
      });
    }

    const upsName =
      typeof payload.upsName === 'string' && payload.upsName.trim()
        ? payload.upsName.trim()
        : '';
    const batteryChargePercent = normalizeOptionalNumber(payload.batteryChargePercent);
    const runtimeSeconds = normalizeOptionalNumber(payload.runtimeSeconds);

    const currentState = getAutomationState();
    const nextPowerState = UPS_POWER_STATES[event];
    if (shouldDeduplicateUpsEvent(currentState, event)) {
      logEvent('automation.ups.event.deduped', {
        event,
        currentPowerState: currentState.currentPowerState,
        occurredAt,
        upsName: upsName || null,
      });
      return res.json({
        success: true,
        event,
        deduped: true,
        sent: 0,
        skipped: 0,
      });
    }

    let smtpConfig;
    try {
      smtpConfig = emailService.getSmtpConfig();
    } catch (err) {
      return res.status(400).json({
        error: err && err.message ? err.message : 'SMTP configuration is missing',
      });
    }

    const recipients = buildUpsRecipients(smtpConfig);
    let sentCount = 0;

    try {
      for (const recipient of recipients) {
        // eslint-disable-next-line no-await-in-loop
        await emailService.sendUpsStatusEmail(
          {
            to: recipient.email,
            name: recipient.name,
            event,
            upsName,
            batteryChargePercent,
            runtimeSeconds,
            occurredAt,
          },
          smtpConfig
        );
        sentCount += 1;
      }
    } catch (err) {
      logger.error('Failed to send UPS notification email batch', err);
      return res.status(500).json({
        error: err && err.message ? err.message : 'Failed to send UPS notification email.',
      });
    }

    saveAutomationState({
      currentPowerState: nextPowerState,
      lastAcceptedEventType: event,
      lastAcceptedEventAt: occurredAt,
    });

    logEvent('automation.ups.event.accepted', {
      event,
      currentPowerState: nextPowerState,
      lastAcceptedEventAt: occurredAt,
      recipientCount: sentCount,
      skippedCount: 0,
      upsName: upsName || null,
      batteryChargePercent,
      runtimeSeconds,
    });

    return res.json({
      success: true,
      event,
      deduped: false,
      sent: sentCount,
      skipped: 0,
    });
  })
);

module.exports = router;
