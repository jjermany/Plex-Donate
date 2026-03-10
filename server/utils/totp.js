const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_ISSUER = 'Plex Donate';

function normalizeBase32(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
}

function encodeBase32(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return '';
  }

  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(value) {
  const normalized = normalizeBase32(value);
  if (!normalized) {
    return Buffer.alloc(0);
  }

  let bits = 0;
  let current = 0;
  const bytes = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      continue;
    }

    current = (current << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateSecret(size = 20) {
  return encodeBase32(crypto.randomBytes(size));
}

function hotp(secret, counter, digits = DEFAULT_DIGITS) {
  const key = decodeBase32(secret);
  if (!key.length) {
    return null;
  }

  const counterBuffer = Buffer.alloc(8);
  let movingCounter = Number(counter);
  for (let index = 7; index >= 0; index -= 1) {
    counterBuffer[index] = movingCounter & 0xff;
    movingCounter = Math.floor(movingCounter / 256);
  }

  const digest = crypto
    .createHmac('sha1', key)
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, '0');
}

function totp(secret, options = {}) {
  const period = Number(options.period) || DEFAULT_PERIOD;
  const digits = Number(options.digits) || DEFAULT_DIGITS;
  const timestamp =
    options.timestamp instanceof Date
      ? options.timestamp.getTime()
      : Number(options.timestamp) || Date.now();
  const counter = Math.floor(timestamp / 1000 / period);
  return hotp(secret, counter, digits);
}

function verifyTotp(code, secret, options = {}) {
  const normalizedCode = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(normalizedCode)) {
    return false;
  }

  const period = Number(options.period) || DEFAULT_PERIOD;
  const digits = Number(options.digits) || DEFAULT_DIGITS;
  const window = Number.isInteger(options.window) ? options.window : 1;
  const timestamp =
    options.timestamp instanceof Date
      ? options.timestamp.getTime()
      : Number(options.timestamp) || Date.now();
  const counter = Math.floor(timestamp / 1000 / period);

  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(secret, counter + offset, digits) === normalizedCode) {
      return true;
    }
  }

  return false;
}

function buildOtpAuthUrl({
  secret,
  accountName,
  issuer = DEFAULT_ISSUER,
  digits = DEFAULT_DIGITS,
  period = DEFAULT_PERIOD,
} = {}) {
  const normalizedSecret = normalizeBase32(secret);
  const normalizedIssuer = String(issuer || DEFAULT_ISSUER).trim() || DEFAULT_ISSUER;
  const normalizedAccount = String(accountName || 'admin').trim() || 'admin';
  const label = `${normalizedIssuer}:${normalizedAccount}`;
  const params = new URLSearchParams({
    secret: normalizedSecret,
    issuer: normalizedIssuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

module.exports = {
  DEFAULT_DIGITS,
  DEFAULT_ISSUER,
  DEFAULT_PERIOD,
  buildOtpAuthUrl,
  generateSecret,
  normalizeBase32,
  totp,
  verifyTotp,
};
