'use strict';

const session = require('express-session');

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function resolveCallback(callback) {
  if (typeof callback === 'function') {
    return callback;
  }
  return () => {};
}

function computeExpiration(sessionData, fallbackTtl) {
  const now = Date.now();

  if (sessionData && sessionData.cookie) {
    const { cookie } = sessionData;

    if (cookie.expires) {
      const expires = new Date(cookie.expires).getTime();
      if (!Number.isNaN(expires)) {
        return expires;
      }
    }

    if (cookie.maxAge) {
      const maxAge = Number(cookie.maxAge);
      if (!Number.isNaN(maxAge)) {
        return now + maxAge;
      }
    }
  }

  return now + fallbackTtl;
}

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super();

    const { db, ttl } = options;

    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('SqliteSessionStore requires a better-sqlite3 database instance.');
    }

    this.db = db;
    this.ttl = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;

    this.statements = {
      get: this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?'),
      set: this.db.prepare(
        `INSERT INTO sessions (sid, sess, expired)
         VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired`
      ),
      destroy: this.db.prepare('DELETE FROM sessions WHERE sid = ?'),
      cleanup: this.db.prepare('DELETE FROM sessions WHERE expired <= ?'),
      updateExpiration: this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?'),
    };

    this.cleanupExpired();
  }

  cleanupExpired() {
    this.statements.cleanup.run(Date.now());
  }

  get(sid, callback) {
    const cb = resolveCallback(callback);

    try {
      const row = this.statements.get.get(sid);

      if (!row) {
        return cb(null, null);
      }

      if (row.expired <= Date.now()) {
        this.statements.destroy.run(sid);
        return cb(null, null);
      }

      const sessionData = JSON.parse(row.sess);
      return cb(null, sessionData);
    } catch (error) {
      return cb(error);
    }
  }

  set(sid, sessionData, callback) {
    const cb = resolveCallback(callback);

    try {
      const expires = computeExpiration(sessionData, this.ttl);
      this.cleanupExpired();
      this.statements.set.run(sid, JSON.stringify(sessionData), expires);
      return cb(null);
    } catch (error) {
      return cb(error);
    }
  }

  touch(sid, sessionData, callback) {
    const cb = resolveCallback(callback);

    try {
      const expires = computeExpiration(sessionData, this.ttl);
      this.cleanupExpired();
      const result = this.statements.updateExpiration.run(expires, sid);

      if (result.changes === 0) {
        this.statements.set.run(sid, JSON.stringify(sessionData), expires);
      }

      return cb(null);
    } catch (error) {
      return cb(error);
    }
  }

  destroy(sid, callback) {
    const cb = resolveCallback(callback);

    try {
      this.statements.destroy.run(sid);
      return cb(null);
    } catch (error) {
      return cb(error);
    }
  }
}

module.exports = SqliteSessionStore;
