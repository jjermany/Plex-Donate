const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  buildOtpAuthUrl,
  generateSecret,
  normalizeBase32,
  totp,
  verifyTotp,
} = require('./totp');

test('generateSecret creates a base32 secret', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.ok(secret.length >= 16);
});

test('totp generates and verifies a valid code', () => {
  const secret = normalizeBase32('JBSWY3DPEHPK3PXP');
  const timestamp = Date.UTC(2026, 2, 10, 12, 0, 0);
  const code = totp(secret, { timestamp });

  assert.equal(code.length, 6);
  assert.equal(verifyTotp(code, secret, { timestamp }), true);
  assert.equal(verifyTotp('000000', secret, { timestamp }), false);
});

test('buildOtpAuthUrl includes issuer and account name', () => {
  const url = buildOtpAuthUrl({
    secret: 'JBSWY3DPEHPK3PXP',
    accountName: 'admin',
    issuer: 'Plex Donate',
  });

  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(url, /issuer=Plex\+Donate/);
});
