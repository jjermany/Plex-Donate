function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

const APPLE_RELAY_DOMAIN = 'privaterelay.appleid.com';

function isAppleRelayEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith(`@${APPLE_RELAY_DOMAIN}`);
}

function getRelayEmailWarning(email) {
  if (!isAppleRelayEmail(email)) {
    return '';
  }
  return "Heads up: If you use Apple ‘Hide My Email’, Plex invites may not map to your expected address in some identity-mapping cases. Use your real Plex account email when possible.";
}

function getInviteEmailDiagnostics(donorEmail, plexEmail) {
  const normalizedDonorEmail = normalizeEmail(donorEmail);
  const normalizedPlexEmail = normalizeEmail(plexEmail);
  return {
    donorEmailIsRelay: isAppleRelayEmail(normalizedDonorEmail),
    plexEmailIsRelay: isAppleRelayEmail(normalizedPlexEmail),
    emailsDiffer:
      Boolean(normalizedDonorEmail) &&
      Boolean(normalizedPlexEmail) &&
      normalizedDonorEmail !== normalizedPlexEmail,
  };
}

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid email format
 */
function isValidEmail(email) {
  if (!email) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

module.exports = {
  normalizeEmail,
  isAppleRelayEmail,
  getRelayEmailWarning,
  getInviteEmailDiagnostics,
  isValidEmail,
};
