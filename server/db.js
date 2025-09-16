const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

const db = new Database(config.databaseFile);
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  paypal_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  last_payment_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  wizarr_invite_code TEXT,
  wizarr_invite_url TEXT,
  note TEXT,
  email_sent_at TEXT,
  revoked_at TEXT,
  plex_revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  paypal_payment_id TEXT,
  amount REAL,
  currency TEXT,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const statements = {
  getDonorBySubscriptionId: db.prepare(
    'SELECT * FROM donors WHERE paypal_subscription_id = ?'
  ),
  getDonorById: db.prepare('SELECT * FROM donors WHERE id = ?'),
  insertDonor: db.prepare(
    `INSERT INTO donors (email, name, paypal_subscription_id, status, last_payment_at)
     VALUES (@email, @name, @subscriptionId, @status, @lastPaymentAt)`
  ),
  updateDonor: db.prepare(
    `UPDATE donors
     SET email = @email,
         name = @name,
         status = @status,
         last_payment_at = @lastPaymentAt,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  updateDonorStatusBySubscription: db.prepare(
    `UPDATE donors
     SET status = @status,
         last_payment_at = COALESCE(@lastPaymentAt, last_payment_at),
         updated_at = CURRENT_TIMESTAMP
     WHERE paypal_subscription_id = @subscriptionId`
  ),
  listDonors: db.prepare('SELECT * FROM donors ORDER BY created_at DESC'),
  listInvitesForDonor: db.prepare(
    'SELECT * FROM invites WHERE donor_id = ? ORDER BY created_at DESC'
  ),
  listPaymentsForDonor: db.prepare(
    'SELECT * FROM payments WHERE donor_id = ? ORDER BY paid_at DESC'
  ),
  insertInvite: db.prepare(
    `INSERT INTO invites (donor_id, wizarr_invite_code, wizarr_invite_url, note, email_sent_at)
     VALUES (@donorId, @code, @url, @note, @emailSentAt)`
  ),
  updateInviteEmailSent: db.prepare(
    `UPDATE invites
     SET email_sent_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ),
  revokeInvite: db.prepare(
    `UPDATE invites
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE id = ? AND revoked_at IS NULL`
  ),
  markPlexRevoked: db.prepare(
    `UPDATE invites
     SET plex_revoked_at = CURRENT_TIMESTAMP
     WHERE id = ? AND plex_revoked_at IS NULL`
  ),
  getInviteById: db.prepare('SELECT * FROM invites WHERE id = ?'),
  getLatestActiveInviteForDonor: db.prepare(
    `SELECT * FROM invites
     WHERE donor_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  ),
  insertPayment: db.prepare(
    `INSERT INTO payments (donor_id, paypal_payment_id, amount, currency, paid_at)
     VALUES (@donorId, @paypalPaymentId, @amount, @currency, @paidAt)`
  ),
  insertEvent: db.prepare(
    `INSERT INTO events (event_type, payload)
     VALUES (@eventType, @payload)`
  ),
  listEvents: db.prepare(
    'SELECT * FROM events ORDER BY created_at DESC LIMIT ?'
  ),
  listSettings: db.prepare('SELECT key, value FROM settings'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  upsertSetting: db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (@key, @value, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`
  ),
};

function mapDonor(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    subscriptionId: row.paypal_subscription_id,
    status: row.status,
    lastPaymentAt: row.last_payment_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvite(row) {
  if (!row) return null;
  return {
    id: row.id,
    donorId: row.donor_id,
    wizarrInviteCode: row.wizarr_invite_code,
    wizarrInviteUrl: row.wizarr_invite_url,
    note: row.note,
    emailSentAt: row.email_sent_at,
    revokedAt: row.revoked_at,
    plexRevokedAt: row.plex_revoked_at,
    createdAt: row.created_at,
  };
}

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    donorId: row.donor_id,
    paypalPaymentId: row.paypal_payment_id,
    amount: row.amount,
    currency: row.currency,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

function upsertDonor({ subscriptionId, email, name, status, lastPaymentAt }) {
  if (!subscriptionId) {
    throw new Error('Subscription ID is required to upsert donor');
  }

  const existing = statements.getDonorBySubscriptionId.get(subscriptionId);
  if (existing) {
    const updated = {
      id: existing.id,
      email: email || existing.email,
      name: name || existing.name,
      status: status || existing.status,
      lastPaymentAt: lastPaymentAt || existing.last_payment_at,
    };
    statements.updateDonor.run(updated);
    return mapDonor(statements.getDonorById.get(existing.id));
  }

  const newDonor = {
    email: email || '',
    name: name || '',
    subscriptionId,
    status: status || 'pending',
    lastPaymentAt: lastPaymentAt || null,
  };
  const info = statements.insertDonor.run(newDonor);
  return mapDonor(statements.getDonorById.get(info.lastInsertRowid));
}

function updateDonorStatus(subscriptionId, status, lastPaymentAt = null) {
  if (!subscriptionId) {
    throw new Error('Subscription ID is required to update donor status');
  }
  statements.updateDonorStatusBySubscription.run({
    subscriptionId,
    status,
    lastPaymentAt,
  });
  return mapDonor(statements.getDonorBySubscriptionId.get(subscriptionId));
}

function getDonorBySubscriptionId(subscriptionId) {
  return mapDonor(statements.getDonorBySubscriptionId.get(subscriptionId));
}

function getDonorById(id) {
  return mapDonor(statements.getDonorById.get(id));
}

function listDonorsWithDetails() {
  const donors = statements.listDonors.all().map(mapDonor);
  return donors.map((donor) => ({
    ...donor,
    invites: statements
      .listInvitesForDonor.all(donor.id)
      .map(mapInvite),
    payments: statements
      .listPaymentsForDonor.all(donor.id)
      .map(mapPayment),
  }));
}

function createInvite({ donorId, code, url, note = '', emailSentAt = null }) {
  if (!donorId) {
    throw new Error('donorId is required to create invite');
  }
  const info = statements.insertInvite.run({
    donorId,
    code: code || null,
    url: url || null,
    note,
    emailSentAt,
  });
  return mapInvite(statements.getInviteById.get(info.lastInsertRowid));
}

function markInviteEmailSent(inviteId) {
  statements.updateInviteEmailSent.run(inviteId);
  return mapInvite(statements.getInviteById.get(inviteId));
}

function revokeInvite(inviteId) {
  statements.revokeInvite.run(inviteId);
  return mapInvite(statements.getInviteById.get(inviteId));
}

function markPlexRevoked(inviteId) {
  statements.markPlexRevoked.run(inviteId);
  return mapInvite(statements.getInviteById.get(inviteId));
}

function getLatestActiveInviteForDonor(donorId) {
  return mapInvite(statements.getLatestActiveInviteForDonor.get(donorId));
}

function recordPayment({ donorId, paypalPaymentId, amount, currency, paidAt }) {
  if (!donorId) {
    throw new Error('donorId is required to record payment');
  }
  statements.insertPayment.run({
    donorId,
    paypalPaymentId: paypalPaymentId || null,
    amount: amount != null ? Number(amount) : null,
    currency: currency || null,
    paidAt,
  });
}

function logEvent(eventType, payload) {
  statements.insertEvent.run({
    eventType,
    payload: JSON.stringify(payload || {}),
  });
}

function getRecentEvents(limit = 50) {
  return statements.listEvents.all(limit).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

function parseSettingsValue(value) {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (err) {
    // ignore malformed JSON and fall through to empty object
  }
  return {};
}

function getAllSettings() {
  const rows = statements.listSettings.all();
  return rows.reduce((acc, row) => {
    acc[row.key] = parseSettingsValue(row.value);
    return acc;
  }, {});
}

function getSetting(key) {
  const row = statements.getSetting.get(key);
  if (!row) {
    return undefined;
  }
  return parseSettingsValue(row.value);
}

const saveSettingsTransaction = db.transaction((entries) => {
  entries.forEach((entry) => {
    statements.upsertSetting.run(entry);
  });
});

function saveSettings(updates) {
  if (!updates || typeof updates !== 'object') {
    return;
  }

  const entries = Object.entries(updates)
    .filter(([key]) => typeof key === 'string' && key.length > 0)
    .map(([key, value]) => ({
      key,
      value: JSON.stringify(value == null ? {} : value),
    }));

  if (entries.length === 0) {
    return;
  }

  saveSettingsTransaction(entries);
}

module.exports = {
  db,
  upsertDonor,
  updateDonorStatus,
  getDonorBySubscriptionId,
  getDonorById,
  listDonorsWithDetails,
  createInvite,
  markInviteEmailSent,
  revokeInvite,
  markPlexRevoked,
  getLatestActiveInviteForDonor,
  recordPayment,
  logEvent,
  getRecentEvents,
  getAllSettings,
  getSetting,
  saveSettings,
};
