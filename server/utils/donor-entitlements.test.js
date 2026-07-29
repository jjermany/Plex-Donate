const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasActivePaidAccess,
  hasCourtesyAccess,
  hasActiveTrialAccess,
  hasAccessEntitlement,
  canSendReferralInvites,
} = require('./donor-entitlements');

test('courtesy access grants service entitlement independently of billing status', () => {
  const donor = {
    status: 'cancelled',
    courtesyAccess: true,
  };

  assert.equal(hasActivePaidAccess(donor), false);
  assert.equal(hasCourtesyAccess(donor), true);
  assert.equal(hasAccessEntitlement(donor), true);
});

test('only paid or courtesy Plex-linked accounts can send referrals', () => {
  assert.equal(
    canSendReferralInvites({
      status: 'active',
      plexAccountId: 'paid-user',
      courtesyAccess: false,
    }),
    true
  );
  assert.equal(
    canSendReferralInvites({
      status: 'pending',
      plexAccountId: 'courtesy-user',
      courtesyAccess: true,
    }),
    true
  );
  assert.equal(
    canSendReferralInvites({
      status: 'trial',
      plexAccountId: 'trial-user',
      courtesyAccess: false,
    }),
    false
  );
  assert.equal(
    canSendReferralInvites({
      status: 'active',
      plexAccountId: '',
      courtesyAccess: false,
    }),
    false
  );
});

test('trial entitlement respects its expiration', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  assert.equal(
    hasActiveTrialAccess(
      {
        status: 'trial',
        accessExpiresAt: '2026-07-29T12:00:00.000Z',
      },
      now
    ),
    true
  );
  assert.equal(
    hasActiveTrialAccess(
      {
        status: 'trial',
        accessExpiresAt: '2026-07-27T12:00:00.000Z',
      },
      now
    ),
    false
  );
});
