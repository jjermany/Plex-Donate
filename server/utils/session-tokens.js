'use strict';

const { nanoid } = require('./nanoid-shim');

const SESSION_TOKEN_QUERY_PARAM = 'session';
const SESSION_TOKEN_HEADER = 'x-session-token';

function normalizeToken(token) {
  if (typeof token !== 'string') {
    return '';
  }
  const trimmed = token.trim();
  return trimmed;
}

function getSessionTokenFromRequest(req) {
  if (!req) {
    return '';
  }

  let token = '';

  if (typeof req.get === 'function') {
    token = normalizeToken(req.get(SESSION_TOKEN_HEADER));
    if (token) {
      return token;
    }
  } else if (req.headers && req.headers[SESSION_TOKEN_HEADER]) {
    token = normalizeToken(req.headers[SESSION_TOKEN_HEADER]);
    if (token) {
      return token;
    }
  }

  if (req.query && typeof req.query[SESSION_TOKEN_QUERY_PARAM] === 'string') {
    token = normalizeToken(req.query[SESSION_TOKEN_QUERY_PARAM]);
    if (token) {
      return token;
    }
  }

  if (req.body && typeof req.body.sessionToken === 'string') {
    token = normalizeToken(req.body.sessionToken);
    if (token) {
      return token;
    }
  }

  return '';
}

function ensureSessionToken(req) {
  if (!req || !req.session) {
    return '';
  }

  if (!req.session.sessionToken || typeof req.session.sessionToken !== 'string') {
    req.session.sessionToken = nanoid(48);
  }

  return req.session.sessionToken;
}

function hasValidSessionToken(req) {
  if (!req || !req.session || !req.session.sessionToken) {
    return false;
  }

  const provided = getSessionTokenFromRequest(req);
  if (!provided) {
    return false;
  }

  return provided === req.session.sessionToken;
}

function clearSessionToken(req) {
  if (req && req.session && req.session.sessionToken) {
    delete req.session.sessionToken;
  }
}

module.exports = {
  ensureSessionToken,
  hasValidSessionToken,
  clearSessionToken,
  getSessionTokenFromRequest,
  SESSION_TOKEN_QUERY_PARAM,
  SESSION_TOKEN_HEADER,
};
