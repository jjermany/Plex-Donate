const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAppleRelayEmail,
  getRelayEmailWarning,
} = require('./validation');

test('isAppleRelayEmail detects Apple relay addresses', () => {
  assert.equal(isAppleRelayEmail('abc@privaterelay.appleid.com'), true);
  assert.equal(isAppleRelayEmail(' ABC@PrivateRelay.AppleID.com '), true);
  assert.equal(isAppleRelayEmail('person@example.com'), false);
  assert.equal(isAppleRelayEmail(''), false);
});

test('getRelayEmailWarning returns advisory only for relay emails', () => {
  assert.match(getRelayEmailWarning('abc@privaterelay.appleid.com'), /Hide My Email/i);
  assert.equal(getRelayEmailWarning('person@example.com'), '');
});
