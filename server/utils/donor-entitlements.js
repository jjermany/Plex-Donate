function normalizeStatus(donor) {
  return donor && donor.status ? String(donor.status).trim().toLowerCase() : '';
}

function hasActivePaidAccess(donor) {
  return normalizeStatus(donor) === 'active';
}

function hasCourtesyAccess(donor) {
  return Boolean(donor && donor.courtesyAccess);
}

function hasActiveTrialAccess(donor, now = Date.now()) {
  if (normalizeStatus(donor) !== 'trial') {
    return false;
  }
  if (!donor.accessExpiresAt) {
    return true;
  }
  const expiresAt = Date.parse(donor.accessExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function hasAccessEntitlement(donor, now = Date.now()) {
  return (
    hasCourtesyAccess(donor) ||
    hasActivePaidAccess(donor) ||
    hasActiveTrialAccess(donor, now)
  );
}

function canSendReferralInvites(donor) {
  return Boolean(
    donor &&
      donor.plexAccountId &&
      (hasActivePaidAccess(donor) || hasCourtesyAccess(donor))
  );
}

module.exports = {
  normalizeStatus,
  hasActivePaidAccess,
  hasCourtesyAccess,
  hasActiveTrialAccess,
  hasAccessEntitlement,
  canSendReferralInvites,
};
