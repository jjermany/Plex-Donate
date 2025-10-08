'use strict';

const INVITE_COOLDOWN_DAYS = 30;
const INVITE_COOLDOWN_MS = INVITE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function parseInviteTimestamp(value) {
  if (!value) {
    return NaN;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? NaN : time;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }

  const stringValue = String(value).trim();
  if (!stringValue) {
    return NaN;
  }

  let parsed = Date.parse(stringValue);
  if (Number.isNaN(parsed)) {
    const withT = stringValue.includes('T')
      ? stringValue
      : stringValue.replace(' ', 'T');
    parsed = Date.parse(withT);
    if (Number.isNaN(parsed)) {
      const hasTimezone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(withT);
      const withTimezone = hasTimezone ? withT : `${withT}Z`;
      parsed = Date.parse(withTimezone);
    }
  }

  return Number.isNaN(parsed) ? NaN : parsed;
}

function getInviteCreatedAtMs(invite) {
  if (!invite || typeof invite !== 'object') {
    return NaN;
  }

  if (Object.prototype.hasOwnProperty.call(invite, 'createdAt')) {
    const ms = parseInviteTimestamp(invite.createdAt);
    if (Number.isFinite(ms)) {
      return ms;
    }
  }

  if (Object.prototype.hasOwnProperty.call(invite, 'created_at')) {
    const ms = parseInviteTimestamp(invite.created_at);
    if (Number.isFinite(ms)) {
      return ms;
    }
  }

  return NaN;
}

function evaluateInviteCooldown(
  invite,
  { now = Date.now(), cooldownMs = INVITE_COOLDOWN_MS } = {}
) {
  const createdAtMs = getInviteCreatedAtMs(invite);
  if (!Number.isFinite(createdAtMs)) {
    return {
      nextInviteAvailableAt: null,
      cooldownActive: false,
    };
  }

  const nextInviteAvailableAtMs = createdAtMs + cooldownMs;
  const nextInviteAvailableAt = new Date(nextInviteAvailableAtMs).toISOString();

  return {
    nextInviteAvailableAt,
    cooldownActive: now < nextInviteAvailableAtMs,
  };
}

module.exports = {
  INVITE_COOLDOWN_DAYS,
  INVITE_COOLDOWN_MS,
  evaluateInviteCooldown,
  getInviteCreatedAtMs,
};
