process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');

function createLegacyDatabase(filePath) {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE donors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT,
      paypal_subscription_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      last_payment_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE invite_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donor_id INTEGER NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      session_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE
    );
  `);

  db.prepare(
    `INSERT INTO donors (email, name, paypal_subscription_id, status)
     VALUES ('legacy@example.com', 'Legacy Donor', 'I-LEGACY123', 'active')`
  ).run();

  db.prepare(
    `INSERT INTO invite_links (donor_id, token, session_token)
     VALUES (1, 'legacy-token', 'legacy-session')`
  ).run();

  db.close();
}

test('legacy databases migrate invite links and donors', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-'));
  const legacyDbFile = path.join(tempDir, 'legacy.db');
  createLegacyDatabase(legacyDbFile);
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const script = `
    const { db } = require('./server/db');
    const payload = {
      inviteColumns: db.prepare("PRAGMA table_info('invite_links')").all(),
      donorColumns: db.prepare("PRAGMA table_info('donors')").all(),
      inviteForeignKeys: db.prepare("PRAGMA foreign_key_list('invite_links')").all(),
      indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invite_links'").all(),
      inviteRow: db.prepare('SELECT donor_id, prospect_id, token, session_token FROM invite_links WHERE id = 1').get(),
    };
    console.log(JSON.stringify(payload));
    db.close();
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: legacyDbFile },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);

  const inviteColumns = new Map(payload.inviteColumns.map((column) => [column.name, column]));
  assert.ok(inviteColumns.has('prospect_id'), 'prospect_id column should be added to invite_links');
  assert.equal(inviteColumns.get('donor_id').notnull, 0, 'donor_id column should allow null values');

  const donorColumns = new Map(payload.donorColumns.map((column) => [column.name, column]));
  assert.equal(donorColumns.get('paypal_subscription_id').notnull, 0);
  assert.ok(donorColumns.has('password_hash'));

  const indexNames = new Set(payload.indexes.map((row) => row.name));
  assert.ok(indexNames.has('invite_links_donor_unique'));
  assert.ok(indexNames.has('invite_links_prospect_unique'));

  assert.equal(payload.inviteForeignKeys.length, 2);
  const donorForeignKey = payload.inviteForeignKeys.find((fk) => fk.from === 'donor_id');
  assert.ok(donorForeignKey);
  assert.equal(donorForeignKey.table, 'donors');

  assert.deepEqual(payload.inviteRow, {
    donor_id: 1,
    prospect_id: null,
    token: 'legacy-token',
    session_token: 'legacy-session',
  });
});
