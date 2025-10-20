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
  paypal_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  last_payment_at TEXT,
  access_expires_at TEXT,
  password_hash TEXT,
  plex_account_id TEXT,
  plex_email TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  name TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  converted_at TEXT,
  converted_donor_id INTEGER,
  FOREIGN KEY (converted_donor_id) REFERENCES donors(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  wizarr_invite_code TEXT,
  wizarr_invite_url TEXT,
  plex_invite_id TEXT,
  plex_invite_url TEXT,
  plex_invited_at TEXT,
  plex_invite_status TEXT,
  plex_shared_libraries TEXT,
  recipient_email TEXT,
  note TEXT,
  email_sent_at TEXT,
  revoked_at TEXT,
  plex_revoked_at TEXT,
  plex_account_id TEXT,
  plex_email TEXT,
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
  donor_id INTEGER,
  prospect_id INTEGER,
  token TEXT NOT NULL UNIQUE,
  session_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  expires_at TEXT,
  used_at TEXT,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS support_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  donor_display_name TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  donor_id INTEGER,
  author_role TEXT NOT NULL,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES support_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS support_requests_donor_idx ON support_requests(donor_id);
CREATE INDEX IF NOT EXISTS support_messages_request_idx ON support_messages(request_id);
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

function ensureDonorEmailVerifiedColumn() {
  const columns = db.prepare("PRAGMA table_info('donors')").all();
  const hasEmailVerifiedAt = columns.some(
    (column) => column.name === 'email_verified_at'
  );
  if (!hasEmailVerifiedAt) {
    db.exec(`
      ALTER TABLE donors ADD COLUMN email_verified_at TEXT;

      UPDATE donors
         SET email_verified_at = CURRENT_TIMESTAMP
       WHERE password_hash IS NOT NULL
         AND TRIM(password_hash) <> '';
    `);
  }
}

function ensureDonorPlexColumns() {
  const columns = db.prepare("PRAGMA table_info('donors')").all();
  const hasPlexAccountId = columns.some(
    (column) => column.name === 'plex_account_id'
  );
  if (!hasPlexAccountId) {
    db.exec('ALTER TABLE donors ADD COLUMN plex_account_id TEXT');
  }
  const hasPlexEmail = columns.some((column) => column.name === 'plex_email');
  if (!hasPlexEmail) {
    db.exec('ALTER TABLE donors ADD COLUMN plex_email TEXT');
  }
}

function ensureDonorAccessExpirationColumn() {
  const columns = db.prepare("PRAGMA table_info('donors')").all();
  const hasAccessExpiresAt = columns.some(
    (column) => column.name === 'access_expires_at'
  );
  if (!hasAccessExpiresAt) {
    db.exec('ALTER TABLE donors ADD COLUMN access_expires_at TEXT');
  }
}

function ensureProspectsTableColumns() {
  const columns = db.prepare("PRAGMA table_info('prospects')").all();
  if (columns.length === 0) {
    return;
  }
  const hasConvertedAt = columns.some((column) => column.name === 'converted_at');
  if (!hasConvertedAt) {
    db.exec('ALTER TABLE prospects ADD COLUMN converted_at TEXT');
  }
  const hasConvertedDonorId = columns.some(
    (column) => column.name === 'converted_donor_id'
  );
  if (!hasConvertedDonorId) {
    db.exec('ALTER TABLE prospects ADD COLUMN converted_donor_id INTEGER');
  }
}

function ensureInvitePlexColumns() {
  const columns = db.prepare("PRAGMA table_info('invites')").all();
  const ensureColumn = (name, sqlType = 'TEXT') => {
    const exists = columns.some((column) => column.name === name);
    if (!exists) {
      db.exec(`ALTER TABLE invites ADD COLUMN ${name} ${sqlType}`);
    }
  };

  ensureColumn('plex_account_id');
  ensureColumn('plex_email');
  ensureColumn('plex_invite_id');
  ensureColumn('plex_invite_url');
  ensureColumn('plex_invited_at');
  ensureColumn('plex_invite_status');
  ensureColumn('plex_shared_libraries');

  db.exec(`
    UPDATE invites
       SET plex_invite_id = COALESCE(
             NULLIF(TRIM(plex_invite_id), ''),
             NULLIF(TRIM(wizarr_invite_code), '')
           )
     WHERE COALESCE(TRIM(plex_invite_id), '') = ''
       AND COALESCE(TRIM(wizarr_invite_code), '') <> '';

    UPDATE invites
       SET plex_invite_url = COALESCE(
             NULLIF(TRIM(plex_invite_url), ''),
             NULLIF(TRIM(wizarr_invite_url), '')
           )
     WHERE COALESCE(TRIM(plex_invite_url), '') = ''
       AND COALESCE(TRIM(wizarr_invite_url), '') <> '';

    UPDATE invites
       SET plex_invited_at = COALESCE(
             NULLIF(TRIM(plex_invited_at), ''),
             created_at
           )
     WHERE COALESCE(TRIM(plex_invited_at), '') = '';
  `);
}

function createInviteLinkIndexes() {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS invite_links_donor_unique
      ON invite_links(donor_id)
      WHERE donor_id IS NOT NULL;
  `);

  const columns = db.prepare("PRAGMA table_info('invite_links')").all();
  const hasProspectId = columns.some((column) => column.name === 'prospect_id');
  if (!hasProspectId) {
    return;
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS invite_links_prospect_unique
      ON invite_links(prospect_id)
      WHERE prospect_id IS NOT NULL;
  `);
}

function ensureInviteLinksSupportsProspects() {
  const columns = db.prepare("PRAGMA table_info('invite_links')").all();
  if (columns.length === 0) {
    return;
  }

  const hasProspectId = columns.some((column) => column.name === 'prospect_id');
  const donorColumn = columns.find((column) => column.name === 'donor_id');
  const donorNotNull = donorColumn && donorColumn.notnull === 1;
  const hasSessionToken = columns.some((column) => column.name === 'session_token');

  if (hasProspectId && !donorNotNull) {
    createInviteLinkIndexes();
    return;
  }

  const sessionTokenSelect = hasSessionToken ? 'session_token' : "''";

  db.exec(`
    ALTER TABLE invite_links RENAME TO invite_links_legacy;

    CREATE TABLE invite_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donor_id INTEGER,
      prospect_id INTEGER,
      token TEXT NOT NULL UNIQUE,
      session_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
      FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE SET NULL
    );

    INSERT INTO invite_links (id, donor_id, token, session_token, created_at, last_used_at)
      SELECT id, donor_id, token, ${sessionTokenSelect}, created_at, last_used_at
      FROM invite_links_legacy;

    DROP TABLE invite_links_legacy;
  `);

  createInviteLinkIndexes();
}

function ensureSupportTables() {
  const requestsColumns = db.prepare("PRAGMA table_info('support_requests')").all();
  const hasRequestsTable = requestsColumns.length > 0;
  if (hasRequestsTable) {
    const hasDisplayName = requestsColumns.some(
      (column) => column.name === 'donor_display_name'
    );
    if (!hasDisplayName) {
      db.exec('ALTER TABLE support_requests ADD COLUMN donor_display_name TEXT');
    }
    const hasResolvedAt = requestsColumns.some(
      (column) => column.name === 'resolved_at'
    );
    if (!hasResolvedAt) {
      db.exec('ALTER TABLE support_requests ADD COLUMN resolved_at TEXT');
    }
  }

  const messagesColumns = db.prepare("PRAGMA table_info('support_messages')").all();
  const hasMessagesTable = messagesColumns.length > 0;
  if (hasMessagesTable) {
    const hasAuthorName = messagesColumns.some(
      (column) => column.name === 'author_name'
    );
    if (!hasAuthorName) {
      db.exec('ALTER TABLE support_messages ADD COLUMN author_name TEXT');
    }
  }
}

function ensureInviteLinkExpirationColumns() {
  const columns = db.prepare("PRAGMA table_info('invite_links')").all();
  if (columns.length === 0) {
    return;
  }

  const hasExpiresAt = columns.some((column) => column.name === 'expires_at');
  const hasUsedAt = columns.some((column) => column.name === 'used_at');

  if (!hasExpiresAt) {
    db.exec("ALTER TABLE invite_links ADD COLUMN expires_at TEXT");
  }

  if (!hasUsedAt) {
    db.exec("ALTER TABLE invite_links ADD COLUMN used_at TEXT");
  }

  db.exec(`
    UPDATE invite_links
       SET expires_at = COALESCE(
         CASE
           WHEN expires_at IS NOT NULL AND TRIM(expires_at) <> '' THEN expires_at
           ELSE DATETIME(COALESCE(created_at, CURRENT_TIMESTAMP), '+7 days')
         END,
         DATETIME(CURRENT_TIMESTAMP, '+7 days')
       )
     WHERE expires_at IS NULL OR TRIM(expires_at) = '';
  `);
}

function ensureDonorSubscriptionOptional() {
  const columns = db.prepare("PRAGMA table_info('donors')").all();
  if (columns.length === 0) {
    return;
  }
  const subscriptionColumn = columns.find(
    (column) => column.name === 'paypal_subscription_id'
  );
  if (subscriptionColumn && subscriptionColumn.notnull === 0) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`
      DROP TABLE IF EXISTS donors_new;

      CREATE TABLE donors_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        name TEXT,
        paypal_subscription_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        last_payment_at TEXT,
        access_expires_at TEXT,
        password_hash TEXT,
        plex_account_id TEXT,
        plex_email TEXT,
        email_verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO donors_new (id, email, name, paypal_subscription_id, status, last_payment_at, access_expires_at, password_hash, plex_account_id, plex_email, email_verified_at, created_at, updated_at)
        SELECT id, email, name, paypal_subscription_id, status, last_payment_at, access_expires_at, password_hash, plex_account_id, plex_email, email_verified_at, created_at, updated_at
        FROM donors;

      DROP TABLE donors;

      ALTER TABLE donors_new RENAME TO donors;
    `);
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

ensureInviteRecipientColumn();
ensureProspectsTableColumns();
ensureDonorPasswordColumn();
ensureDonorEmailVerifiedColumn();
ensureDonorPlexColumns();
ensureDonorAccessExpirationColumn();
ensureDonorSubscriptionOptional();
ensureInviteLinksSupportsProspects();
ensureInviteLinkSessionTokens();
ensureInviteLinkExpirationColumns();
ensureInvitePlexColumns();
ensureSupportTables();

function normalizeEmail(email) {
  if (!email) {
    return '';
  }
  return String(email).trim().toLowerCase();
}

function normalizeAccessExpiresAt(value) {
  if (value == null || value === '') {
    return null;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return value.toISOString();
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  }

  const stringValue = String(value).trim();
  if (!stringValue) {
    return null;
  }

  const parsed = new Date(stringValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeInviteTimestamp(value) {
  if (value == null || value === '') {
    return null;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return value.toISOString();
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  }

  const stringValue = String(value).trim();
  if (!stringValue) {
    return null;
  }

  const parsed = new Date(stringValue);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return stringValue;
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
    `INSERT INTO donors (email, name, paypal_subscription_id, status, last_payment_at, access_expires_at, password_hash, plex_account_id, plex_email, email_verified_at)
     VALUES (@email, @name, @subscriptionId, @status, @lastPaymentAt, @accessExpiresAt, @passwordHash, @plexAccountId, @plexEmail, @emailVerifiedAt)`
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
  updateDonorAccessExpirationBySubscription: db.prepare(
    `UPDATE donors
     SET access_expires_at = @accessExpiresAt,
         updated_at = CURRENT_TIMESTAMP
     WHERE paypal_subscription_id = @subscriptionId`
  ),
  updateDonorAccessExpirationById: db.prepare(
    `UPDATE donors
     SET access_expires_at = @accessExpiresAt,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  listDonors: db.prepare('SELECT * FROM donors ORDER BY created_at DESC'),
  listDonorsWithExpiredAccess: db.prepare(
    `SELECT * FROM donors
     WHERE lower(status) IN ('cancelled', 'expired', 'suspended')
       AND access_expires_at IS NOT NULL
       AND DATETIME(access_expires_at) <= DATETIME('now')
     ORDER BY access_expires_at ASC`
  ),
  listInvitesForDonor: db.prepare(
    'SELECT * FROM invites WHERE donor_id = ? ORDER BY created_at DESC'
  ),
  listPaymentsForDonor: db.prepare(
    'SELECT * FROM payments WHERE donor_id = ? ORDER BY paid_at DESC'
  ),
  deleteDonorById: db.prepare('DELETE FROM donors WHERE id = ?'),
  getInviteLinkByDonorId: db.prepare(
    'SELECT * FROM invite_links WHERE donor_id = ?'
  ),
  getInviteLinkByProspectId: db.prepare(
    'SELECT * FROM invite_links WHERE prospect_id = ?'
  ),
  getInviteLinkByToken: db.prepare(
    'SELECT * FROM invite_links WHERE token = ?'
  ),
  getInviteLinkById: db.prepare('SELECT * FROM invite_links WHERE id = ?'),
  listInviteLinks: db.prepare(`
    SELECT invite_links.*, 
           donors.email AS donor_email,
           donors.name AS donor_name,
           donors.paypal_subscription_id AS donor_subscription_id,
           donors.status AS donor_status,
           prospects.email AS prospect_email,
           prospects.name AS prospect_name
      FROM invite_links
      LEFT JOIN donors ON donors.id = invite_links.donor_id
      LEFT JOIN prospects ON prospects.id = invite_links.prospect_id
     ORDER BY invite_links.created_at DESC
  `),
  insertInviteLink: db.prepare(
    `INSERT INTO invite_links (donor_id, prospect_id, token, session_token, expires_at)
     VALUES (
       @donorId,
       @prospectId,
       @token,
       @sessionToken,
       DATETIME('now', '+7 days')
     )`
  ),
  replaceInviteLink: db.prepare(
    `UPDATE invite_links
     SET donor_id = @donorId,
         prospect_id = @prospectId,
         token = @token,
         session_token = @sessionToken,
         created_at = CURRENT_TIMESTAMP,
         last_used_at = NULL,
         used_at = NULL,
         expires_at = DATETIME('now', '+7 days')
     WHERE id = @id`
  ),
  deleteInviteLinkById: db.prepare('DELETE FROM invite_links WHERE id = ?'),
  assignInviteLinkOwner: db.prepare(
    `UPDATE invite_links
     SET donor_id = @donorId,
         prospect_id = @prospectId,
         last_used_at = CASE WHEN @clearLastUsed THEN NULL ELSE last_used_at END
     WHERE id = @id`
  ),
  setInviteLinkSessionToken: db.prepare(
    `UPDATE invite_links
     SET session_token = @sessionToken
     WHERE id = @id`
  ),
  touchInviteLink: db.prepare(
    `UPDATE invite_links
     SET last_used_at = CURRENT_TIMESTAMP,
         used_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ),
  insertInvite: db.prepare(
    `INSERT INTO invites (
       donor_id,
       wizarr_invite_code,
       wizarr_invite_url,
       plex_invite_id,
       plex_invite_url,
       plex_invited_at,
       plex_invite_status,
       plex_shared_libraries,
       note,
       recipient_email,
       email_sent_at,
       plex_account_id,
       plex_email
     )
     VALUES (
       @donorId,
       @legacyCode,
       @legacyUrl,
       @plexInviteId,
       @plexInviteUrl,
       @plexInvitedAt,
       @plexInviteStatus,
       @plexSharedLibraries,
       @note,
       @recipientEmail,
       @emailSentAt,
       @plexAccountId,
       @plexEmail
     )`
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
  updateInvitePlexDetailsStatement: db.prepare(
    `UPDATE invites
     SET plex_account_id = @plexAccountId,
         plex_email = @plexEmail,
         plex_invite_id = @plexInviteId,
         plex_invite_url = @plexInviteUrl,
         plex_invited_at = @plexInvitedAt,
         plex_invite_status = @plexInviteStatus,
         plex_shared_libraries = @plexSharedLibraries
     WHERE id = @id`
  ),
  getInviteById: db.prepare('SELECT * FROM invites WHERE id = ?'),
  getLatestInviteForDonor: db.prepare(
    `SELECT * FROM invites
     WHERE donor_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ),
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
  markDonorEmailVerified: db.prepare(
    `UPDATE donors
     SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  clearDonorEmailVerification: db.prepare(
    `UPDATE donors
     SET email_verified_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  updateDonorPlexIdentity: db.prepare(
    `UPDATE donors
     SET plex_account_id = @plexAccountId,
         plex_email = @plexEmail,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  insertProspect: db.prepare(
    `INSERT INTO prospects (email, name, note)
     VALUES (@email, @name, @note)`
  ),
  updateProspect: db.prepare(
    `UPDATE prospects
     SET email = COALESCE(@email, email),
         name = COALESCE(@name, name),
         note = COALESCE(@note, note),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  getProspectById: db.prepare('SELECT * FROM prospects WHERE id = ?'),
  markProspectConverted: db.prepare(
    `UPDATE prospects
     SET converted_at = CURRENT_TIMESTAMP,
         converted_donor_id = @donorId,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  updateDonorSubscriptionById: db.prepare(
    `UPDATE donors
     SET paypal_subscription_id = @subscriptionId,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  deleteVerificationTokensForDonor: db.prepare(
    'DELETE FROM email_verification_tokens WHERE donor_id = ?'
  ),
  insertVerificationToken: db.prepare(
    `INSERT INTO email_verification_tokens (donor_id, token, expires_at)
     VALUES (@donorId, @token, @expiresAt)`
  ),
  getVerificationTokenByToken: db.prepare(
    'SELECT * FROM email_verification_tokens WHERE token = ?'
  ),
  markVerificationTokenUsed: db.prepare(
    `UPDATE email_verification_tokens
     SET used_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  deleteVerificationTokenById: db.prepare(
    'DELETE FROM email_verification_tokens WHERE id = ?'
  ),
  insertSupportRequest: db.prepare(
    `INSERT INTO support_requests (donor_id, donor_display_name, subject)
     VALUES (@donorId, @donorDisplayName, @subject)`
  ),
  insertSupportMessage: db.prepare(
    `INSERT INTO support_messages (request_id, donor_id, author_role, author_name, body)
     VALUES (@requestId, @donorId, @authorRole, @authorName, @body)`
  ),
  updateSupportRequestAfterMessage: db.prepare(
    `UPDATE support_requests
     SET updated_at = CURRENT_TIMESTAMP,
         status = COALESCE(@status, status),
         resolved = CASE WHEN @resolved IS NULL THEN resolved ELSE @resolved END,
         resolved_at = CASE
           WHEN @resolved IS NULL THEN resolved_at
           WHEN @resolved = 1 THEN COALESCE(resolved_at, CURRENT_TIMESTAMP)
           ELSE NULL
         END
     WHERE id = @id`
  ),
  listSupportRequests: db.prepare(`
    SELECT sr.*, d.email AS donor_email, d.name AS donor_name
      FROM support_requests sr
      LEFT JOIN donors d ON d.id = sr.donor_id
     ORDER BY sr.updated_at DESC, sr.created_at DESC
  `),
  listSupportRequestsForDonor: db.prepare(`
    SELECT sr.*, d.email AS donor_email, d.name AS donor_name
      FROM support_requests sr
      LEFT JOIN donors d ON d.id = sr.donor_id
     WHERE sr.donor_id = ?
     ORDER BY sr.updated_at DESC, sr.created_at DESC
  `),
  listOpenSupportRequests: db.prepare(`
    SELECT sr.*, d.email AS donor_email, d.name AS donor_name
      FROM support_requests sr
      LEFT JOIN donors d ON d.id = sr.donor_id
     WHERE sr.resolved = 0
     ORDER BY sr.updated_at DESC, sr.created_at DESC
  `),
  getSupportRequestById: db.prepare(`
    SELECT sr.*, d.email AS donor_email, d.name AS donor_name
      FROM support_requests sr
      LEFT JOIN donors d ON d.id = sr.donor_id
     WHERE sr.id = ?
  `),
  getSupportRequestForDonor: db.prepare(`
    SELECT sr.*, d.email AS donor_email, d.name AS donor_name
      FROM support_requests sr
      LEFT JOIN donors d ON d.id = sr.donor_id
     WHERE sr.id = @id
       AND sr.donor_id = @donorId
  `),
  listSupportMessagesForRequest: db.prepare(
    `SELECT * FROM support_messages WHERE request_id = ? ORDER BY created_at ASC, id ASC`
  ),
  updateSupportRequestResolution: db.prepare(
    `UPDATE support_requests
     SET status = @status,
         resolved = @resolved,
         resolved_at = CASE WHEN @resolved = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ),
  deleteSupportRequestById: db.prepare(
    'DELETE FROM support_requests WHERE id = ?'
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
    accessExpiresAt: row.access_expires_at,
    hasPassword: Boolean(row.password_hash && row.password_hash.length > 0),
    plexAccountId: row.plex_account_id,
    plexEmail: row.plex_email,
    emailVerifiedAt: row.email_verified_at,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvite(row) {
  if (!row) return null;
  let sharedLibraries = [];
  if (row.plex_shared_libraries) {
    try {
      const parsed = JSON.parse(row.plex_shared_libraries);
      if (Array.isArray(parsed)) {
        sharedLibraries = parsed;
      }
    } catch (err) {
      sharedLibraries = [];
    }
  }
  return {
    id: row.id,
    donorId: row.donor_id,
    plexInviteId: row.plex_invite_id || null,
    inviteUrl: row.plex_invite_url || row.wizarr_invite_url || null,
    plexInvitedAt: row.plex_invited_at || null,
    plexInviteStatus: row.plex_invite_status || null,
    plexSharedLibraries: sharedLibraries,
    recipientEmail: row.recipient_email,
    note: row.note,
    emailSentAt: row.email_sent_at,
    revokedAt: row.revoked_at,
    plexRevokedAt: row.plex_revoked_at,
    plexAccountId: row.plex_account_id,
    plexEmail: row.plex_email,
    createdAt: row.created_at,
  };
}

function mapInviteLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    donorId: row.donor_id,
    prospectId: row.prospect_id,
    token: row.token,
    sessionToken: row.session_token,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

function mapSupportRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    donorId: row.donor_id,
    donorDisplayName: row.donor_display_name || null,
    subject: row.subject,
    status: row.status,
    resolved: Boolean(row.resolved),
    resolvedAt: row.resolved_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    donorEmail: row.donor_email || null,
    donorName: row.donor_name || null,
  };
}

function mapSupportMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    donorId: row.donor_id,
    authorRole: row.author_role,
    authorName: row.author_name || null,
    body: row.body,
    createdAt: row.created_at,
  };
}

function mapEmailVerificationToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    donorId: row.donor_id,
    token: row.token,
    createdAt: row.created_at,
    usedAt: row.used_at,
    expiresAt: row.expires_at,
  };
}

function mapProspect(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    convertedAt: row.converted_at,
    convertedDonorId: row.converted_donor_id,
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

function mapSupportThread(requestRow, messageRows) {
  const request = mapSupportRequest(requestRow);
  const messages = Array.isArray(messageRows)
    ? messageRows.map(mapSupportMessage).filter(Boolean)
    : [];
  return { request, messages };
}

function normalizeSupportSubject(subject) {
  if (subject === undefined || subject === null) {
    return '';
  }
  return String(subject).trim();
}

function normalizeSupportBody(body) {
  if (body === undefined || body === null) {
    return '';
  }
  return String(body).trim();
}

function normalizeSupportAuthorName(name) {
  if (name === undefined || name === null) {
    return '';
  }
  return String(name).trim();
}

const createSupportRequestTransaction = db.transaction(
  ({ donorId, donorDisplayName, subject, body, authorName }) => {
    const info = statements.insertSupportRequest.run({
      donorId,
      donorDisplayName: donorDisplayName || null,
      subject,
    });
    const requestId = info.lastInsertRowid;
    statements.insertSupportMessage.run({
      requestId,
      donorId,
      authorRole: 'donor',
      authorName: authorName || donorDisplayName || null,
      body,
    });
    statements.updateSupportRequestAfterMessage.run({
      id: requestId,
      status: 'open',
      resolved: 0,
    });
    return requestId;
  }
);

const addSupportMessageTransaction = db.transaction(
  ({ requestId, donorId, authorRole, authorName, body }) => {
    statements.insertSupportMessage.run({
      requestId,
      donorId: donorId || null,
      authorRole,
      authorName: authorName || null,
      body,
    });
    statements.updateSupportRequestAfterMessage.run({
      id: requestId,
      status: 'open',
      resolved: 0,
    });
  }
);

function getSupportRequestRecord(requestId) {
  if (!requestId) {
    return null;
  }
  return statements.getSupportRequestById.get(requestId);
}

function getSupportRequestForDonorRecord(requestId, donorId) {
  if (!requestId || !donorId) {
    return null;
  }
  return statements.getSupportRequestForDonor.get({ id: requestId, donorId });
}

function listSupportMessagesRows(requestId) {
  if (!requestId) {
    return [];
  }
  return statements.listSupportMessagesForRequest.all(requestId);
}

function upsertDonor({
  subscriptionId,
  email,
  name,
  status,
  lastPaymentAt,
  accessExpiresAt = null,
}) {
  if (!subscriptionId) {
    throw new Error('Subscription ID is required to upsert donor');
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedAccessExpiresAt = normalizeAccessExpiresAt(accessExpiresAt);

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
    accessExpiresAt: normalizedAccessExpiresAt,
    passwordHash: null,
    plexAccountId: null,
    plexEmail: null,
    emailVerifiedAt: null,
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

function getDonorByEmailAddress(email) {
  if (!email) {
    return null;
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }
  return mapDonor(statements.getDonorByEmail.get(normalizedEmail));
}

function getDonorAuthByEmail(email) {
  if (!email) {
    return null;
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }
  const row = statements.getDonorByEmail.get(normalizedEmail);
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

function listShareLinks() {
  return statements.listInviteLinks.all().map((row) => {
    const shareLink = ensureShareLinkHasSessionToken(mapInviteLink(row));
    const donor = row.donor_id
      ? {
          id: row.donor_id,
          email: row.donor_email || '',
          name: row.donor_name || '',
          subscriptionId: row.donor_subscription_id || '',
          status: row.donor_status || '',
        }
      : null;
    const prospect = row.prospect_id
      ? {
          id: row.prospect_id,
          email: row.prospect_email || '',
          name: row.prospect_name || '',
        }
      : null;
    return {
      ...shareLink,
      donor,
      prospect,
    };
  });
}

function createInvite({
  donorId,
  code,
  url,
  inviteId,
  inviteUrl,
  inviteStatus = null,
  invitedAt = null,
  sharedLibraries = null,
  note = '',
  recipientEmail = null,
  emailSentAt = null,
  plexAccountId = null,
  plexEmail = null,
} = {}) {
  if (!donorId) {
    throw new Error('donorId is required to create invite');
  }
  const finalInviteId = inviteId || code || null;
  const finalInviteUrl = inviteUrl || url || null;
  const serializedLibraries = Array.isArray(sharedLibraries)
    ? JSON.stringify(sharedLibraries)
    : sharedLibraries && typeof sharedLibraries === 'string'
    ? sharedLibraries
    : null;
  const normalizedInvitedAt = normalizeInviteTimestamp(invitedAt);
  const info = statements.insertInvite.run({
    donorId,
    legacyCode: null,
    legacyUrl: null,
    plexInviteId: finalInviteId || null,
    plexInviteUrl: finalInviteUrl || null,
    plexInvitedAt: normalizedInvitedAt,
    plexInviteStatus: inviteStatus || null,
    plexSharedLibraries: serializedLibraries,
    note,
    recipientEmail,
    emailSentAt,
    plexAccountId: plexAccountId || null,
    plexEmail: plexEmail || null,
  });
  return mapInvite(statements.getInviteById.get(info.lastInsertRowid));
}

function updateInvitePlexDetails(
  inviteId,
  {
    plexAccountId,
    plexEmail,
    plexInviteId,
    plexInviteUrl,
    plexInvitedAt,
    plexInviteStatus,
    plexSharedLibraries,
  } = {}
) {
  if (!inviteId) {
    throw new Error('inviteId is required to update invite');
  }

  const existing = statements.getInviteById.get(inviteId);
  if (!existing) {
    return null;
  }

  const merged = {
    id: inviteId,
    plexAccountId:
      plexAccountId !== undefined ? plexAccountId : existing.plex_account_id,
    plexEmail: plexEmail !== undefined ? plexEmail : existing.plex_email,
    plexInviteId:
      plexInviteId !== undefined ? plexInviteId : existing.plex_invite_id,
    plexInviteUrl:
      plexInviteUrl !== undefined ? plexInviteUrl : existing.plex_invite_url,
    plexInvitedAt:
      plexInvitedAt !== undefined
        ? normalizeInviteTimestamp(plexInvitedAt)
        : existing.plex_invited_at,
    plexInviteStatus:
      plexInviteStatus !== undefined
        ? plexInviteStatus
        : existing.plex_invite_status,
    plexSharedLibraries:
      plexSharedLibraries !== undefined
        ? Array.isArray(plexSharedLibraries)
          ? JSON.stringify(plexSharedLibraries)
          : plexSharedLibraries && typeof plexSharedLibraries === 'string'
          ? plexSharedLibraries
          : null
        : existing.plex_shared_libraries,
  };

  statements.updateInvitePlexDetailsStatement.run({
    id: merged.id,
    plexAccountId: merged.plexAccountId || null,
    plexEmail: merged.plexEmail || null,
    plexInviteId: merged.plexInviteId || null,
    plexInviteUrl: merged.plexInviteUrl || null,
    plexInvitedAt: merged.plexInvitedAt || null,
    plexInviteStatus: merged.plexInviteStatus || null,
    plexSharedLibraries: merged.plexSharedLibraries,
  });

  return mapInvite(statements.getInviteById.get(inviteId));
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

function getLatestInviteForDonor(donorId) {
  return mapInvite(statements.getLatestInviteForDonor.get(donorId));
}

function getLatestActiveInviteForDonor(donorId) {
  return mapInvite(statements.getLatestActiveInviteForDonor.get(donorId));
}

function createOrUpdateShareLink({
  donorId = null,
  prospectId = null,
  token,
  sessionToken,
}) {
  if (!donorId && !prospectId) {
    throw new Error('A donorId or prospectId is required to create share link');
  }
  if (donorId && prospectId) {
    throw new Error('Provide either donorId or prospectId when creating share link');
  }
  if (!token) {
    throw new Error('token is required to create share link');
  }

  const existingRow = donorId
    ? statements.getInviteLinkByDonorId.get(donorId)
    : statements.getInviteLinkByProspectId.get(prospectId);

  const payload = {
    donorId: donorId || null,
    prospectId: prospectId || null,
    token,
    sessionToken: sessionToken || generateShareSessionToken(),
  };

  if (existingRow) {
    statements.replaceInviteLink.run({ id: existingRow.id, ...payload });
    return ensureShareLinkHasSessionToken(
      mapInviteLink(statements.getInviteLinkById.get(existingRow.id))
    );
  }

  const info = statements.insertInviteLink.run(payload);
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkById.get(info.lastInsertRowid))
  );
}

function getShareLinkByDonorId(donorId) {
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkByDonorId.get(donorId))
  );
}

function getShareLinkByProspectId(prospectId) {
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkByProspectId.get(prospectId))
  );
}

function getShareLinkByToken(token) {
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkByToken.get(token))
  );
}

function getShareLinkById(linkId) {
  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkById.get(linkId))
  );
}

function assignShareLinkToDonor(shareLinkId, donorId, { clearLastUsed = false } = {}) {
  if (!shareLinkId) {
    throw new Error('shareLinkId is required to assign ownership');
  }
  if (!donorId) {
    throw new Error('donorId is required to assign ownership');
  }

  statements.assignInviteLinkOwner.run({
    id: shareLinkId,
    donorId,
    prospectId: null,
    clearLastUsed: clearLastUsed ? 1 : 0,
  });

  return ensureShareLinkHasSessionToken(
    mapInviteLink(statements.getInviteLinkById.get(shareLinkId))
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

function updateDonorPlexIdentity(donorId, { plexAccountId, plexEmail } = {}) {
  if (!donorId) {
    throw new Error('donorId is required to update Plex identity');
  }

  statements.updateDonorPlexIdentity.run({
    id: donorId,
    plexAccountId: plexAccountId || null,
    plexEmail:
      plexEmail == null || plexEmail === ''
        ? null
        : normalizeEmail(typeof plexEmail === 'string' ? plexEmail : String(plexEmail)),
  });

  return mapDonor(statements.getDonorById.get(donorId));
}

function clearDonorPlexIdentity(donorId) {
  return updateDonorPlexIdentity(donorId, { plexAccountId: null, plexEmail: null });
}

function setDonorAccessExpirationBySubscription(subscriptionId, accessExpiresAt = null) {
  if (!subscriptionId) {
    throw new Error('subscriptionId is required to update access expiration');
  }

  const normalizedAccessExpiresAt = normalizeAccessExpiresAt(accessExpiresAt);

  statements.updateDonorAccessExpirationBySubscription.run({
    subscriptionId,
    accessExpiresAt: normalizedAccessExpiresAt,
  });

  return mapDonor(statements.getDonorBySubscriptionId.get(subscriptionId));
}

function setDonorAccessExpirationById(donorId, accessExpiresAt = null) {
  if (!donorId) {
    throw new Error('donorId is required to update access expiration');
  }

  const normalizedAccessExpiresAt = normalizeAccessExpiresAt(accessExpiresAt);

  statements.updateDonorAccessExpirationById.run({
    id: donorId,
    accessExpiresAt: normalizedAccessExpiresAt,
  });

  return mapDonor(statements.getDonorById.get(donorId));
}

function listDonorsWithExpiredAccess() {
  return statements.listDonorsWithExpiredAccess.all().map(mapDonor);
}

function createProspect({ email, name, note } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const info = statements.insertProspect.run({
    email: normalizedEmail || null,
    name: name ? String(name).trim() : null,
    note: note ? String(note).trim() : null,
  });
  return mapProspect(statements.getProspectById.get(info.lastInsertRowid));
}

function updateProspect(prospectId, { email, name, note } = {}) {
  if (!prospectId) {
    throw new Error('prospectId is required to update prospect');
  }

  statements.updateProspect.run({
    id: prospectId,
    email:
      email == null || email === ''
        ? null
        : normalizeEmail(typeof email === 'string' ? email : String(email)),
    name: name == null || name === '' ? null : String(name).trim(),
    note: note == null || note === '' ? null : String(note).trim(),
  });

  return mapProspect(statements.getProspectById.get(prospectId));
}

function getProspectById(prospectId) {
  return mapProspect(statements.getProspectById.get(prospectId));
}

function markProspectConverted(prospectId, donorId) {
  if (!prospectId) {
    return null;
  }
  statements.markProspectConverted.run({ id: prospectId, donorId: donorId || null });
  return mapProspect(statements.getProspectById.get(prospectId));
}

function clearDonorEmailVerificationTokens(donorId) {
  if (!donorId) {
    return;
  }
  statements.deleteVerificationTokensForDonor.run(donorId);
}

function createDonorEmailVerificationToken(
  donorId,
  { expiresInHours = 48 } = {}
) {
  if (!donorId) {
    throw new Error('donorId is required to create verification token');
  }

  const hours = Number.isFinite(expiresInHours) && expiresInHours > 0
    ? expiresInHours
    : 48;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const expiresAtIso = Number.isNaN(expiresAt.getTime())
    ? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    : expiresAt.toISOString();

  clearDonorEmailVerificationTokens(donorId);

  const token = nanoid(48);
  statements.insertVerificationToken.run({
    donorId,
    token,
    expiresAt: expiresAtIso,
  });

  return mapEmailVerificationToken(
    statements.getVerificationTokenByToken.get(token)
  );
}

function getDonorEmailVerificationToken(token) {
  if (!token) {
    return null;
  }
  return mapEmailVerificationToken(
    statements.getVerificationTokenByToken.get(token)
  );
}

function markEmailVerificationTokenUsed(tokenId) {
  if (!tokenId) {
    return false;
  }
  const result = statements.markVerificationTokenUsed.run({ id: tokenId });
  return result.changes > 0;
}

function deleteEmailVerificationTokenById(tokenId) {
  if (!tokenId) {
    return false;
  }
  const result = statements.deleteVerificationTokenById.run(tokenId);
  return result.changes > 0;
}

function markDonorEmailVerified(donorId) {
  if (!donorId) {
    throw new Error('donorId is required to mark verification');
  }
  statements.markDonorEmailVerified.run({ id: donorId });
  return mapDonor(statements.getDonorById.get(donorId));
}

function resetDonorEmailVerification(donorId) {
  if (!donorId) {
    throw new Error('donorId is required to reset verification');
  }
  statements.clearDonorEmailVerification.run({ id: donorId });
  clearDonorEmailVerificationTokens(donorId);
  return mapDonor(statements.getDonorById.get(donorId));
}

function createDonor({
  email,
  name,
  subscriptionId,
  status = 'pending',
  lastPaymentAt = null,
  accessExpiresAt = null,
  passwordHash = null,
  plexAccountId = null,
  plexEmail = null,
  emailVerifiedAt = null,
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedAccessExpiresAt = normalizeAccessExpiresAt(accessExpiresAt);
  const info = statements.insertDonor.run({
    email: normalizedEmail || '',
    name: name ? String(name).trim() : '',
    subscriptionId:
      subscriptionId == null || subscriptionId === ''
        ? null
        : String(subscriptionId).trim(),
    status: status || 'pending',
    lastPaymentAt: lastPaymentAt || null,
    accessExpiresAt: normalizedAccessExpiresAt,
    passwordHash: passwordHash || null,
    plexAccountId: plexAccountId || null,
    plexEmail: plexEmail
      ? normalizeEmail(typeof plexEmail === 'string' ? plexEmail : String(plexEmail))
      : null,
    emailVerifiedAt:
      emailVerifiedAt == null || emailVerifiedAt === ''
        ? null
        : normalizeAccessExpiresAt(emailVerifiedAt) || null,
  });
  return mapDonor(statements.getDonorById.get(info.lastInsertRowid));
}

function updateDonorSubscriptionId(donorId, subscriptionId) {
  if (!donorId) {
    throw new Error('donorId is required to update subscription');
  }

  statements.updateDonorSubscriptionById.run({
    id: donorId,
    subscriptionId:
      subscriptionId == null || subscriptionId === ''
        ? null
        : String(subscriptionId).trim(),
  });

  return mapDonor(statements.getDonorById.get(donorId));
}

function deleteDonorById(donorId) {
  if (!donorId) {
    return false;
  }

  const result = statements.deleteDonorById.run(donorId);
  return result.changes > 0;
}

function deleteShareLinkById(linkId) {
  if (!linkId) {
    return false;
  }

  const result = statements.deleteInviteLinkById.run(linkId);
  return result.changes > 0;
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

function listSupportRequests({ includeResolved = true, donorId = null } = {}) {
  let rows;
  if (donorId) {
    rows = statements.listSupportRequestsForDonor.all(donorId);
  } else if (includeResolved) {
    rows = statements.listSupportRequests.all();
  } else {
    rows = statements.listOpenSupportRequests.all();
  }
  if (!includeResolved) {
    rows = rows.filter((row) => !row.resolved);
  }
  return rows.map(mapSupportRequest);
}

function getSupportRequestById(requestId) {
  const row = getSupportRequestRecord(requestId);
  if (!row) {
    return null;
  }
  return mapSupportRequest(row);
}

function getSupportThreadById(requestId) {
  const row = getSupportRequestRecord(requestId);
  if (!row) {
    return null;
  }
  const messages = listSupportMessagesRows(requestId);
  return mapSupportThread(row, messages);
}

function getSupportThreadForDonor(requestId, donorId) {
  const row = getSupportRequestForDonorRecord(requestId, donorId);
  if (!row) {
    return null;
  }
  const messages = listSupportMessagesRows(requestId);
  return mapSupportThread(row, messages);
}

function createSupportRequest({
  donorId,
  subject,
  message,
  donorDisplayName,
  authorName,
}) {
  if (!donorId) {
    throw new Error('donorId is required to create support request');
  }
  const normalizedSubject = normalizeSupportSubject(subject);
  if (!normalizedSubject) {
    throw new Error('Subject is required to create support request');
  }
  const normalizedBody = normalizeSupportBody(message);
  if (!normalizedBody) {
    throw new Error('Message body is required to create support request');
  }
  const normalizedDisplayName = normalizeSupportAuthorName(donorDisplayName);
  const normalizedAuthorName =
    normalizeSupportAuthorName(authorName) || normalizedDisplayName || null;
  const requestId = createSupportRequestTransaction({
    donorId,
    donorDisplayName: normalizedDisplayName || null,
    subject: normalizedSubject,
    body: normalizedBody,
    authorName: normalizedAuthorName,
  });
  return getSupportThreadById(requestId);
}

function addSupportMessageToRequest({
  requestId,
  donorId = null,
  authorRole,
  authorName,
  message,
}) {
  const normalizedRequestId = requestId;
  const normalizedRole = normalizeSupportAuthorName(authorRole).toLowerCase();
  if (!normalizedRequestId) {
    throw new Error('requestId is required to add support message');
  }
  if (!['donor', 'admin'].includes(normalizedRole)) {
    throw new Error('Invalid support message author role');
  }
  const row = getSupportRequestRecord(normalizedRequestId);
  if (!row) {
    return null;
  }
  const normalizedBody = normalizeSupportBody(message);
  if (!normalizedBody) {
    throw new Error('Message body is required to add support message');
  }
  const normalizedAuthorName = normalizeSupportAuthorName(authorName);
  let effectiveAuthorName = normalizedAuthorName;
  if (!effectiveAuthorName && normalizedRole === 'donor') {
    effectiveAuthorName =
      normalizeSupportAuthorName(row.donor_display_name) ||
      normalizeSupportAuthorName(row.donor_name) ||
      normalizeSupportAuthorName(row.donor_email);
  }
  addSupportMessageTransaction({
    requestId: normalizedRequestId,
    donorId,
    authorRole: normalizedRole,
    authorName: effectiveAuthorName || null,
    body: normalizedBody,
  });
  return getSupportThreadById(normalizedRequestId);
}

function markSupportRequestResolved(requestId, resolved = true) {
  if (!requestId) {
    throw new Error('requestId is required to update support request');
  }
  const row = getSupportRequestRecord(requestId);
  if (!row) {
    return null;
  }
  const resolvedFlag = resolved ? 1 : 0;
  statements.updateSupportRequestResolution.run({
    id: requestId,
    resolved: resolvedFlag,
    status: resolvedFlag ? 'resolved' : 'open',
  });
  return getSupportThreadById(requestId);
}

function deleteSupportRequestById(requestId) {
  if (!requestId) {
    return false;
  }
  const result = statements.deleteSupportRequestById.run(requestId);
  return result.changes > 0;
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
  getDonorByEmailAddress,
  getDonorAuthByEmail,
  createDonor,
  updateDonorSubscriptionId,
  deleteDonorById,
  createProspect,
  updateProspect,
  getProspectById,
  markProspectConverted,
  createDonorEmailVerificationToken,
  getDonorEmailVerificationToken,
  markDonorEmailVerified,
  resetDonorEmailVerification,
  markEmailVerificationTokenUsed,
  clearDonorEmailVerificationTokens,
  deleteEmailVerificationTokenById,
  listDonorsWithDetails,
  listShareLinks,
  createInvite,
  markInviteEmailSent,
  revokeInvite,
  markPlexRevoked,
  getLatestInviteForDonor,
  getLatestActiveInviteForDonor,
  createOrUpdateShareLink,
  getShareLinkByDonorId,
  getShareLinkByProspectId,
  getShareLinkByToken,
  getShareLinkById,
  deleteShareLinkById,
  assignShareLinkToDonor,
  markShareLinkUsed,
  recordPayment,
  logEvent,
  updateDonorContact,
  updateDonorPassword,
  updateDonorPlexIdentity,
  clearDonorPlexIdentity,
  setDonorAccessExpirationBySubscription,
  setDonorAccessExpirationById,
  listDonorsWithExpiredAccess,
  getRecentEvents,
  getAllSettings,
  getSetting,
  saveSettings,
  updateInvitePlexDetails,
  listSupportRequests,
  getSupportRequestById,
  getSupportThreadById,
  getSupportThreadForDonor,
  createSupportRequest,
  addSupportMessageToRequest,
  markSupportRequestResolved,
  deleteSupportRequestById,
};
