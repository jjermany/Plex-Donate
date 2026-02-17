/**
 * Common validation utilities used across the application
 */

/**
 * Normalize email address to lowercase and trimmed
 * @param {string} email - Email address to normalize
 * @returns {string} Normalized email
 */
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
  // RFC 5322 compliant email regex (simplified)
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/**
 * Sanitize string input by trimming and limiting length
 * @param {string} input - String to sanitize
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} Sanitized string
 */
function sanitizeString(input, maxLength = 500) {
  if (typeof input !== 'string') {
    return '';
  }
  return input.trim().slice(0, maxLength);
}

/**
 * Validate and sanitize name field
 * @param {string} name - Name to validate
 * @returns {string|null} Sanitized name or null if invalid
 */
function validateName(name) {
  if (typeof name !== 'string') {
    return null;
  }
  const sanitized = name.trim();
  if (sanitized.length === 0 || sanitized.length > 100) {
    return null;
  }
  // Only allow letters, spaces, hyphens, and apostrophes
  if (!/^[a-zA-Z\s'-]+$/.test(sanitized)) {
    return null;
  }
  return sanitized;
}

/**
 * Validate URL format
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid URL
 */
function isValidUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate PayPal subscription ID format
 * @param {string} subscriptionId - Subscription ID to validate
 * @returns {boolean} True if valid format
 */
function isValidSubscriptionId(subscriptionId) {
  if (!subscriptionId || typeof subscriptionId !== 'string') {
    return false;
  }
  // PayPal subscription IDs are typically alphanumeric with hyphens
  return /^[A-Z0-9-]+$/i.test(subscriptionId) && subscriptionId.length >= 10;
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (typeof text !== 'string') {
    return '';
  }
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Validate integer within range
 * @param {any} value - Value to validate
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {number|null} Parsed integer or null if invalid
 */
function validateInteger(value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

/**
 * Validate ISO date string
 * @param {string} dateString - Date string to validate
 * @returns {Date|null} Parsed Date object or null if invalid
 */
function validateISODate(dateString) {
  if (!dateString || typeof dateString !== 'string') {
    return null;
  }
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

module.exports = {
  normalizeEmail,
  isAppleRelayEmail,
  getRelayEmailWarning,
  getInviteEmailDiagnostics,
  isValidEmail,
  sanitizeString,
  validateName,
  isValidUrl,
  isValidSubscriptionId,
  escapeHtml,
  validateInteger,
  validateISODate,
};
