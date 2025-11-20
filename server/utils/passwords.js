const crypto = require('crypto');

const PBKDF2_DIGEST = 'sha512';
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PASSWORD_PREFIX = 'pbkdf2';
const MIN_PASSWORD_LENGTH = 12;

function serializeHash(iterations, salt, derivedKey) {
  return [
    PASSWORD_PREFIX,
    String(iterations),
    salt.toString('hex'),
    derivedKey.toString('hex'),
  ].join('$');
}

function parseHash(serialized) {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    return null;
  }
  const parts = serialized.split('$');
  if (parts.length !== 4) {
    return null;
  }
  const [prefix, iterationPart, saltHex, keyHex] = parts;
  if (prefix !== PASSWORD_PREFIX) {
    return null;
  }
  const iterations = Number.parseInt(iterationPart, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return null;
  }
  if (!saltHex || !keyHex) {
    return null;
  }
  let salt;
  let key;
  try {
    salt = Buffer.from(saltHex, 'hex');
    key = Buffer.from(keyHex, 'hex');
  } catch (err) {
    return null;
  }
  if (salt.length === 0 || key.length === 0) {
    return null;
  }
  return { iterations, salt, key };
}

function isSerializedHash(serialized) {
  return Boolean(parseHash(serialized));
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (typeof password !== 'string' || password.length === 0) {
      return reject(new Error('Password must be a non-empty string'));
    }
    const salt = crypto.randomBytes(SALT_LENGTH);
    crypto.pbkdf2(
      password,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEY_LENGTH,
      PBKDF2_DIGEST,
      (err, derivedKey) => {
        if (err) {
          return reject(err);
        }
        resolve(serializeHash(PBKDF2_ITERATIONS, salt, derivedKey));
      }
    );
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    if (typeof password !== 'string' || password.length === 0) {
      return resolve(false);
    }
    const parsed = parseHash(storedHash);
    if (!parsed) {
      return resolve(false);
    }
    crypto.pbkdf2(
      password,
      parsed.salt,
      parsed.iterations,
      parsed.key.length,
      PBKDF2_DIGEST,
      (err, derivedKey) => {
        if (err) {
          return resolve(false);
        }
        try {
          resolve(crypto.timingSafeEqual(parsed.key, derivedKey));
        } catch (timingError) {
          resolve(false);
        }
      }
    );
  });
}

function hashPasswordSync(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST
  );
  return serializeHash(PBKDF2_ITERATIONS, salt, derivedKey);
}

function verifyPasswordSync(password, storedHash) {
  if (typeof password !== 'string' || password.length === 0) {
    return false;
  }
  const parsed = parseHash(storedHash);
  if (!parsed) {
    return false;
  }
  let derivedKey;
  try {
    derivedKey = crypto.pbkdf2Sync(
      password,
      parsed.salt,
      parsed.iterations,
      parsed.key.length,
      PBKDF2_DIGEST
    );
  } catch (err) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(parsed.key, derivedKey);
  } catch (err) {
    return false;
  }
}

/**
 * Validates password strength with comprehensive requirements
 * @param {string} password - The password to validate
 * @returns {boolean} True if password meets strength requirements
 */
function isPasswordStrong(password) {
  if (typeof password !== 'string') {
    return false;
  }
  const trimmed = password.trim();

  // Minimum length check
  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    return false;
  }

  // Complexity requirements
  const hasUpperCase = /[A-Z]/.test(trimmed);
  const hasLowerCase = /[a-z]/.test(trimmed);
  const hasNumber = /[0-9]/.test(trimmed);
  const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(trimmed);

  // Require at least 3 of the 4 character types
  const typesPresent = [hasUpperCase, hasLowerCase, hasNumber, hasSpecialChar].filter(Boolean).length;

  if (typesPresent < 3) {
    return false;
  }

  return true;
}

/**
 * Gets detailed password strength feedback
 * @param {string} password - The password to validate
 * @returns {Object} Object with isStrong boolean and array of missing requirements
 */
function getPasswordStrengthFeedback(password) {
  const feedback = {
    isStrong: true,
    missingRequirements: [],
  };

  if (typeof password !== 'string') {
    feedback.isStrong = false;
    feedback.missingRequirements.push('Password must be a string');
    return feedback;
  }

  const trimmed = password.trim();

  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    feedback.isStrong = false;
    feedback.missingRequirements.push(`At least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const hasUpperCase = /[A-Z]/.test(trimmed);
  const hasLowerCase = /[a-z]/.test(trimmed);
  const hasNumber = /[0-9]/.test(trimmed);
  const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(trimmed);

  const missing = [];
  if (!hasUpperCase) missing.push('uppercase letter');
  if (!hasLowerCase) missing.push('lowercase letter');
  if (!hasNumber) missing.push('number');
  if (!hasSpecialChar) missing.push('special character');

  const typesPresent = [hasUpperCase, hasLowerCase, hasNumber, hasSpecialChar].filter(Boolean).length;

  if (typesPresent < 3) {
    feedback.isStrong = false;
    feedback.missingRequirements.push(`At least 3 of: ${missing.join(', ')}`);
  }

  return feedback;
}

module.exports = {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyPasswordSync,
  isPasswordStrong,
  getPasswordStrengthFeedback,
  MIN_PASSWORD_LENGTH,
  isSerializedHash,
};
