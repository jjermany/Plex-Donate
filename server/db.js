const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

const db = new Database(config.databaseFile);
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  paypal_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  last_payment_at TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  wizarr_invite_code TEXT,
  wizarr_invite_url TEXT,
  recipient_email TEXT,
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

CREATE TABLE IF NOT EXISTS invite_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  session_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE
);
`);

function generateShareSessionToken() {
  return nanoid(48);
}

function ensureInviteLinkSessionTokens() {
  const columns = db.prepare("PRAGMA table_info('invite_links')").all();
  const hasSessionToken = columns.some((column) => column.name === 'session_token');
  if (!hasSessionToken) {
    db.exec('ALTER TABLE invite_links ADD COLUMN session_token TEXT');
  }

  const missingTokens = db
    .prepare(
      "SELECT id FROM invite_links WHERE session_token IS NULL OR TRIM(session_token) = ''"
    )
    .all();

  if (missingTokens.length === 0) {
    return;
  }

  const updateToken = db.prepare('UPDATE invite_links SET session_token = ? WHERE id = ?');
  const assignTokens = db.transaction((rows) => {
    rows.forEach((row) => {
      updateToken.run(generateShareSessionToken(), row.id);
    });
  });

  assignTokens(missingTokens);
}

function ensureInviteRecipientColumn() {
  const columns = db.prepare("PRAGMA table_info('invites')").all();
  const hasRecipientEmail = columns.some((column) => column.name === 'recipient_email');
  if (!hasRecipientEmail) {
    db.exec('ALTER TABLE invites ADD COLUMN recipient_email TEXT');
  }
}

function ensureDonorPasswordColumn() {
  const columns = db.prepare("PRAGMA table_info('donors')").all();
  const hasPasswordHash = columns.some((column) => column.name === 'password_hash');
  if (!hasPasswordHash) {
    db.exec('ALTER TABLE donors ADD COLUMN password_hash TEXT');
  }
}

ensureInviteRecipientColumn();
ensureInviteLinkSessionTokens();
ensureDonorPasswordColumn();

function normalizeEmail(email) {
  if (!email) {
    return '';
  }
  return String(email).trim().toLowerCase();
}

const statements = {
  getDonorBySubscriptionId: db.prepare(
    'SELECT * FROM donors WHERE paypal_subscription_id = ?'
  ),
  getDonorById: db.prepare('SELECT * FROM donors WHERE id = ?'),
  getDonorByEmail: db.prepare(
    'SELECT * FROM donors WHERE lower(email) = lower(?) LIMIT 1'
  ),
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
  getInviteLinkByDonorId: db.prepare(
    'SELECT * FROM invite_links WHERE donor_id = ?'
  ),
  getInviteLinkByToken: db.prepare(
    'SELECT * FROM invite_links WHERE token = ?'
  ),
  getInviteLinkById: db.prepare('SELECT * FROM invite_links WHERE id = ?'),
  upsertInviteLink: db.prepare(
    `INSERT INTO invite_links (donor_id, token, session_token)
     VALUES (@donorId, @token, @sessionToken)
     ON CONFLICT(donor_id) DO UPDATE SET
       token = excluded.token,
       session_token = excluded.session_token,
       created_at = CURRENT_TIMESTAMP,
       last_used_at = NULL`
  ),
  setInviteLinkSessionToken: db.prepare(
    `UPDATE invite_links
     SET session_token = @sessionToken
     WHERE id = @id`
  ),
  touchInviteLink: db.prepare(
    `UPDATE invite_links
     SET last_used_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ),
  insertInvite: db.prepare(
    `INSERT INTO invites (donor_id, wizarr_invite_code, wizarr_invite_url, note, recipient_email, email_sent_at)
     VALUES (@donorId, @code, @url, @note, @recipientEmail, @emailSentAt)`
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
  updateDonorContact: db.prepare(
    `UPDATE donors
     SET email = COALESCE(@email, email),
         name = COALESCE(@name, name),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  updateDonorPassword: db.prepare(
    `UPDATE donors
     SET password_hash = @passwordHash,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
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
    hasPassword: Boolean(row.password_hash && row.password_hash.length > 0),
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
    recipientEmail: row.recipient_email,
    note: row.note,
    emailSentAt: row.email_sent_at,
    revokedAt: row.revoked_at,
    plexRevokedAt: row.plex_revoked_at,
    createdAt: row.created_at,
  };
}

function mapInviteLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    donorId: row.donor_id,
    token: row.token,
    sessionToken: row.session_token,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function ensureShareLinkHasSessionToken(shareLink) {
  if (!shareLink) {
    return null;
  }
  if (shareLink.sessionToken) {
    return shareLink;
  }
  const sessionToken = generateShareSessionToken();
  statements.setInviteLinkSessionToken.run({
    id: shareLink.id,
    sessionToken,
  });
  return { ...shareLink, sessionToken };
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

  const normalizedEmail = normalizeEmail(email);

  const existing = statements.getDonorBySubscriptionId.get(subscriptionId);
  if (existing) {
    const updated = {
      id: existing.id,
      email: normalizedEmail || existing.email,
      name: name || existing.name,
      status: status || existing.status,
      lastPaymentAt: lastPaymentAt || existing.last_payment_at,
    };
    statements.updateDonor.run(updated);
    return mapDonor(statements.getDonorById.get(existing.id));
  }

  const newDonor = {
    email: normalizedEmail || '',
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

function getDonorAuthByEmail(email) {
  if (!email) {
    return null;
  }
  const row = statements.getDonorByEmail.get(email);
  if (!row) {
    return null;
  }
  return {
    donor: mapDonor(row),
    passwordHash: row.password_hash || '',
  };
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
    shareLink: ensureShareLinkHasSessionToken(
      mapInviteLink(statements.getInviteLinkByDonorId.get(donor.id))
    ),
  }));
}

function createInvite({
  donorId,
  code,
  url,
  note = '',
  recipientEmail = null,
  emailSentAt = null,
}) {
  if (!donorId) {
    throw new Error('donorId is required to create invite');
  }
  const info = statements.insertInvite.run({
    donorId,
    code: code || null,
    url: url || null,
    note,
    recipientEmail,
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

function createOrUpdateShareLink({ donorId, token, sessionToken }) {
  if (!donorId) {
    throw new Error('donorId is required to create share link');
  }
  if (!token) {
    throw new Error('token is required to create share link');
  }
  statements.upsertInviteLink.run({
    donorId,
    token,
    sessionToken: sessionToken || generateShareSessionToken(),
  });
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkByDonorId.get(donorId))
  );
}

function getShareLinkByDonorId(donorId) {
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkByDonorId.get(donorId))
  );
}

function getShareLinkByToken(token) {
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkByToken.get(token))
  );
}

function markShareLinkUsed(linkId) {
  if (!linkId) {
    return null;
  }
  statements.touchInviteLink.run(linkId);
  return mapInviteLink(statements.getInviteLinkById.get(linkId));
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

function updateDonorContact(donorId, { email, name }) {
  if (!donorId) {
    throw new Error('donorId is required to update contact details');
  }

  statements.updateDonorContact.run({
    id: donorId,
    email:
      email == null || email === ''
        ? null
        : normalizeEmail(typeof email === 'string' ? email : String(email)),
    name:
      name == null || name === '' ? null : String(name).trim(),
  });

  return mapDonor(statements.getDonorById.get(donorId));
}

function updateDonorPassword(donorId, passwordHash) {
  if (!donorId) {
    throw new Error('donorId is required to update password');
  }

  statements.updateDonorPassword.run({
    id: donorId,
    passwordHash: passwordHash || null,
  });

  return mapDonor(statements.getDonorById.get(donorId));
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
  getDonorAuthByEmail,
  listDonorsWithDetails,
  createInvite,
  markInviteEmailSent,
  revokeInvite,
  markPlexRevoked,
  getLatestActiveInviteForDonor,
  createOrUpdateShareLink,
  getShareLinkByDonorId,
  getShareLinkByToken,
  markShareLinkUsed,
  recordPayment,
  logEvent,
  updateDonorContact,
  updateDonorPassword,
  getRecentEvents,
  getAllSettings,
  getSetting,
  saveSettings,
};
