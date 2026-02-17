const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAppleRelayEmail,
  getRelayEmailWarning,
  getInviteEmailDiagnostics,
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


test('getInviteEmailDiagnostics reports relay and mismatch flags', () => {
  assert.deepEqual(
    getInviteEmailDiagnostics('donor@privaterelay.appleid.com', 'plex@example.com'),
    {
      donorEmailIsRelay: true,
      plexEmailIsRelay: false,
      emailsDiffer: true,
    }
  );

  assert.deepEqual(getInviteEmailDiagnostics('same@example.com', 'same@example.com'), {
    donorEmailIsRelay: false,
    plexEmailIsRelay: false,
    emailsDiffer: false,
  });
});
