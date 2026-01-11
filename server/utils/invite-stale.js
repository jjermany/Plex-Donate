'use strict';

const { getInviteCreatedAtMs } = require('./invite-cooldown');

function parseTimestamp(value) {
  if (!value) {
    return NaN;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? NaN : ms;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? NaN : parsed;
}

function resolveInviteTimestamp(invite) {
  if (!invite || typeof invite !== 'object') {
    return null;
  }

  const candidates = [invite.plexInvitedAt, invite.invitedAt];
  for (const value of candidates) {
    const parsed = parseTimestamp(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const createdAtMs = getInviteCreatedAtMs(invite);
  if (Number.isFinite(createdAtMs)) {
    return createdAtMs;
  }

  return null;
}

function getInviteStaleThresholdMs(staleDaysValue = process.env.PLEX_INVITE_STALE_DAYS) {
  const staleDays = Number.parseInt(staleDaysValue || '0', 10);
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    return 0;
  }
  return staleDays * 24 * 60 * 60 * 1000;
}

function isInviteStale(invite, { now = Date.now() } = {}) {
  const staleMs = getInviteStaleThresholdMs();
  if (!staleMs) {
    return false;
  }
  const timestamp = resolveInviteTimestamp(invite);
  if (!timestamp) {
    return false;
  }
  return now - timestamp > staleMs;
}

module.exports = {
  getInviteStaleThresholdMs,
  isInviteStale,
  resolveInviteTimestamp,
};
